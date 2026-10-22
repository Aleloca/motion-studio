import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  isSupportedLocale, issuesText, SUBTITLE_LIMITS, staleCues, subtitleCuesHash, subtitleSetHash, subtitleSetSchema, subtitleSetText, subtitlesJobKey, toSrt, toVtt, transcriptionChoiceSchema,
  type FormatPreset, type JobSummary, type LocaleTag, type ServerMessage, type SubtitleSet, type SubtitlesSummary, type TranscriptionPending,
} from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef } from '../creatives/creative-turns.ts';
import { currentLocale, t } from '../i18n.ts';
import { addSubtitleLanguage, retranslateSubtitles } from '../subtitles/languages.ts';
import { followSource, listSubtitleSets, readSubtitleSet, removeSubtitleSet, speechSourceSet, type SubtitleCommits, subtitleSetLocks, writeSubtitleSet } from '../subtitles/store.ts';
import { languageName, subtitleTimingOf, type SubtitlesService } from '../subtitles/subtitles-job.ts';
import { type SubtitleTranslateService, subtitleTranslateJobKey } from '../subtitles/translate-job.ts';

export { SUBTITLE_WAVEFORM_PEAKS } from '../subtitles/subtitles-job.ts';
import { CodedError, type WorkspaceStore } from '../workspace-store.ts';

const startSchema = z.strictObject({ mode: z.enum(['new', 'retime']).optional(), lang: z.string().refine(isSupportedLocale, { message: 'not a supported language' }).optional() });
const waveformQuery = z.object({ version: z.coerce.number().int().positive(), lang: z.string().refine(isSupportedLocale, { message: 'not a supported language' }).optional() });
const choiceSchema = transcriptionChoiceSchema.omit({ file: true });
/** The editor's save: the whole cue list, checked against the stored set's fields with `subtitleSetSchema`. */
const saveSchema = z.strictObject({ baseHash: z.string().regex(/^[0-9a-f]{64}$/), cues: z.array(z.unknown()).max(SUBTITLE_LIMITS.cues) });
const checkedSchema = z.strictObject({ baseHash: z.string().regex(/^[0-9a-f]{64}$/) });
const addSchema = z.strictObject({ lang: z.string().refine(isSupportedLocale, { message: 'not a supported language' }) });
/** "Ritraduci": the lines asked for by id (absent: every stale line). */
const retranslateSchema = z.strictObject({ ids: z.array(z.string().min(1).max(64)).max(SUBTITLE_LIMITS.cues).optional() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new CodedError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }), 'invalid-request');
  return r.data;
}

/**
 * The latest version's main format (the one the subtitles are timed on, `subtitleSourceFormat`): its duration (ms) and the
 * fingerprint of its audio; with `locale`, of that language's own localized video (a set's `timing.locale`, Task 24). Null
 * when the latest version has no video format.
 */
export async function subtitleTimingNow(projectDir: string, creativeSlug: string, presets: readonly FormatPreset[], locale?: LocaleTag): Promise<{ durationMs: number; fingerprint: string } | null> {
  const store = new CreativeStore(projectDir);
  const latest = (await store.readVersions(creativeSlug)).at(-1);
  if (!latest) return null;
  const timing = await subtitleTimingOf(store.dir(creativeSlug), latest, (await store.get(creativeSlug)).brief, presets, locale);
  return timing ? { durationMs: Math.round(timing.ic.composition.duration * 1000), fingerprint: timing.fingerprint } : null;
}

/**
 * The creative's subtitle sets as the UI lists them. `timingChanged`: the audio the set was timed on differs from the latest
 * version's main format (false when that version has no video), each set against the video it was timed on (the original,
 * or its language's own: Task 24); for a translation, against its source's timing (Task 25: it follows its source, whose
 * writers carry their times over, `followSource`; a difference is a safety signal, never a retime of the translation). `staleCues`: a translation's lines whose source line changed since (`staleCues`
 * against the original speech set; 0 without one, and for a set made from speech).
 */
export async function subtitleSummaries(projectDir: string, creativeSlug: string, presets: () => Promise<FormatPreset[]>): Promise<SubtitlesSummary[]> {
  const sets = await listSubtitleSets(new CreativeStore(projectDir).dir(creativeSlug));
  if (sets.length === 0) return [];
  const list = await presets();
  const nows = new Map<string, Promise<{ fingerprint: string } | null>>();
  const nowOf = (locale?: LocaleTag) => {
    if (!nows.has(locale ?? '')) nows.set(locale ?? '', subtitleTimingNow(projectDir, creativeSlug, list, locale));
    return nows.get(locale ?? '')!;
  };
  const source = speechSourceSet(sets);
  return Promise.all(sets.map(async (s) => {
    const translation = s.origin === 'translation';
    const now = translation ? source?.timing ?? null : await nowOf(s.timing.locale);
    return {
      lang: s.lang, origin: s.origin, ...(s.sourceLang ? { sourceLang: s.sourceLang } : {}),
      cues: s.cues.length, edited: s.cues.filter((c) => c.edited).length, hash: subtitleSetHash(s), cuesHash: subtitleCuesHash(s),
      timing: s.timing, timingChanged: now !== null && now.fingerprint !== s.timing.fingerprint,
      staleCues: translation && source ? staleCues(s, source).length : 0,
    };
  }));
}

/**
 * Decisions 1636-1640 (spec §6.1-§6.2): the subtitles of a creative (`/api/projects/:slug/creatives/:c/subtitles`): the
 * overview (sets, the job, its transcription question), Fai i sottotitoli, the answer to the transcription dialog and
 * "Ricontrolla", one set, its save from the editor (decision 1654) and its `.srt` / `.vtt` download. A language outside the
 * supported ones answers 400, one without a set 404.
 */
export function registerSubtitlesRoutes(app: FastifyInstance, ctx: {
  requireWorkspace: () => WorkspaceStore; subtitles: SubtitlesService; translate: Pick<SubtitleTranslateService, 'start'>; jobs: () => JobSummary[]; presets: () => Promise<FormatPreset[]>;
  commits: Pick<SubtitleCommits, 'touch'>; broadcast: (m: ServerMessage) => void;
}) {
  const refOf = async (slug: string, creativeSlug: string): Promise<CreativeRef> => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    const projectDir = ws.projectDir(slug);
    const store = new CreativeStore(projectDir);
    await store.assertOpenable(creativeSlug);
    await store.get(creativeSlug);
    return { root: ws.root, projectSlug: slug, projectDir, creativeSlug };
  };
  const langOf = (lang: string): LocaleTag => {
    if (!isSupportedLocale(lang)) throw new CodedError(400, t().errors.invalidRequestDetail({ detail: `lang: ${lang}` }), 'invalid-request');
    return lang;
  };
  const setOf = async (ref: CreativeRef, lang: LocaleTag): Promise<{ set: SubtitleSet; hash: string }> => {
    const r = await readSubtitleSet(new CreativeStore(ref.projectDir).dir(ref.creativeSlug), lang);
    if (!r) throw new CodedError(404, t().errors.notFound, 'subtitles-not-found');
    // The set file's hash only: the editor's saves compare it (the lines' hash is the summaries', final review M3).
    return { set: r.set, hash: r.hash };
  };
  const jobOf = (key: string): JobSummary | null => ctx.jobs().find((j) => j.key === key && (j.state === 'queued' || j.state === 'running')) ?? null;
  const activeJob = (ref: CreativeRef): JobSummary | null => jobOf(subtitlesJobKey(ref.root, ref.projectSlug, ref.creativeSlug));
  type PC = { Params: { slug: string; c: string } };
  type PL = { Params: { slug: string; c: string; lang: string } };

  app.get<PC>('/api/projects/:slug/creatives/:c/subtitles', async (req): Promise<{ sets: SubtitlesSummary[]; job: JobSummary | null; pending: TranscriptionPending | null }> => {
    const ref = await refOf(req.params.slug, req.params.c);
    return { sets: await subtitleSummaries(ref.projectDir, ref.creativeSlug, ctx.presets), job: activeJob(ref), pending: ctx.subtitles.pending(ref) };
  });
  app.post<PC>('/api/projects/:slug/creatives/:c/subtitles', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(startSchema, req.body);
    const job = await ctx.subtitles.start(ref, { mode: body.mode ?? 'new', ...(body.lang ? { lang: body.lang as LocaleTag } : {}) });
    return { job };
  });
  // The answer to the job's transcription dialog (409 when nothing asks; a choice that cannot be honoured keeps the dialog).
  app.post<PC>('/api/projects/:slug/creatives/:c/subtitles/transcription-choice', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(choiceSchema, req.body);
    if (!ctx.subtitles.pending(ref)) throw new CodedError(409, t().errors.transcriptionNothingAsks, 'transcription-not-asked');
    await ctx.subtitles.choose(ref, body);
    return { job: activeJob(ref), pending: ctx.subtitles.pending(ref) };
  });
  app.post<PC>('/api/projects/:slug/creatives/:c/subtitles/transcription-recheck', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const pending = await ctx.subtitles.recheck(ref);
    if (!pending) throw new CodedError(409, t().errors.transcriptionNothingAsks, 'transcription-not-asked');
    return { job: activeJob(ref), pending };
  });
  // Task 25 (spec §6.5, U8): a new subtitle language, from its own voices or translated (`addSubtitleLanguage`); the brief's
  // languages stay as they are. Before `/:lang`.
  app.post<PC>('/api/projects/:slug/creatives/:c/subtitles/languages', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(addSchema, req.body);
    const { job } = await addSubtitleLanguage({ subtitles: ctx.subtitles, translate: ctx.translate }, ref, body.lang as LocaleTag);
    return { job };
  });
  // Task 13: the timeline's waveform of a version's main format (before `/:lang`, which would take `waveform` as a language);
  // with `lang`, the audio that language's set is timed on (its own localized video, Task 24).
  app.get<PC & { Querystring: { version?: string; lang?: string } }>('/api/projects/:slug/creatives/:c/subtitles/waveform', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const q = parse(waveformQuery, req.query);
    return ctx.subtitles.waveform(ref, q.version, q.lang as LocaleTag | undefined);
  });
  app.get<PL>('/api/projects/:slug/creatives/:c/subtitles/:lang', async (req) => {
    const lang = langOf(req.params.lang);
    return setOf(await refOf(req.params.slug, req.params.c), lang);
  });
  // Decision 1654: the editor's save. The cues replace the stored ones (every other field kept); `baseHash` is the hash of the
  // set the editor loaded, 409 `subtitles-conflict` with the stored hash when the set changed since. Allowed while a job runs:
  // the read, the check and the write hold the creative's set lock, as the job's final merge does.
  app.put<PL>('/api/projects/:slug/creatives/:c/subtitles/:lang', async (req, reply) => {
    const lang = langOf(req.params.lang);
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(saveSchema, req.body);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const saved = await subtitleSetLocks.run(creativeDir, async () => {
      const stored = await setOf(ref, lang);
      if (stored.hash !== body.baseHash) return { conflict: stored.hash };
      const set = parse(subtitleSetSchema, { ...stored.set, cues: body.cues });
      if (Buffer.byteLength(subtitleSetText(set)) > SUBTITLE_LIMITS.fileBytes) {
        throw new CodedError(413, t().errors.subtitlesTooLarge({ maxMB: SUBTITLE_LIMITS.fileBytes / 1_048_576 }), 'subtitles-too-large');
      }
      return { hash: await writeSubtitleSet(creativeDir, set) };
    });
    if ('conflict' in saved) return reply.status(409).send({ error: t().errors.subtitlesConflict, code: 'subtitles-conflict', hash: saved.conflict });
    ctx.commits.touch(ref, t().subtitles.commit({ title: (await store.get(ref.creativeSlug)).title, lang }));
    try { ctx.broadcast({ type: 'subtitles', project: ref.projectSlug, creative: ref.creativeSlug, lang }); } catch { /* a faulty listener */ }
    return { hash: saved.hash };
  });
  // "Tempi controllati" (final review, M3): the user looked at the timing after the video changed and keeps it. The set's
  // timing becomes the latest version's main format and audio fingerprint (so "Il video è cambiato" goes), of the video it is
  // timed on (the original, or its language's own: Task 24, `timing.locale` kept); the cues are not touched. Over `baseHash` and under the set lock, as the save: 409 `subtitles-conflict` with the stored hash when the set
  // changed since; 409 `subtitles-no-video` when the latest version has no video format.
  app.post<PL>('/api/projects/:slug/creatives/:c/subtitles/:lang/timing-checked', async (req, reply) => {
    const lang = langOf(req.params.lang);
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(checkedSchema, req.body);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const done = await subtitleSetLocks.run(creativeDir, async () => {
      const stored = await setOf(ref, lang);
      if (stored.hash !== body.baseHash) return { conflict: stored.hash };
      const latest = (await store.readVersions(ref.creativeSlug)).at(-1);
      const locale = stored.set.timing.locale;
      const now = latest ? await subtitleTimingOf(creativeDir, latest, (await store.get(ref.creativeSlug)).brief, await ctx.presets(), locale) : null;
      if (!latest || !now) throw new CodedError(409, t().errors.subtitlesNoVideo, 'subtitles-no-video');
      const set: SubtitleSet = { ...stored.set, timing: { version: latest.n, format: now.format, fingerprint: now.fingerprint, ...(locale ? { locale } : {}) } };
      const hash = await writeSubtitleSet(creativeDir, set);
      // The original speech set's translations follow it (Task 25): its timing, and its lines' times.
      return { hash, timing: set.timing, followed: await followSource(creativeDir, set) };
    });
    if ('conflict' in done) return reply.status(409).send({ error: t().errors.subtitlesConflict, code: 'subtitles-conflict', hash: done.conflict });
    ctx.commits.touch(ref, t().subtitles.commit({ title: (await store.get(ref.creativeSlug)).title, lang }));
    for (const l of [lang, ...done.followed]) {
      try { ctx.broadcast({ type: 'subtitles', project: ref.projectSlug, creative: ref.creativeSlug, lang: l }); } catch { /* a faulty listener */ }
    }
    return { hash: done.hash, timing: done.timing };
  });
  // Task 25, "Ritraduci": the lines asked for, or every stale one the user did not correct, the lines whose source is gone
  // dropped (`retranslateSubtitles`): `{ job, dropped? }`, `job: null` when only dropping was left to do.
  app.post<PL>('/api/projects/:slug/creatives/:c/subtitles/:lang/retranslate', async (req) => {
    const lang = langOf(req.params.lang);
    const ref = await refOf(req.params.slug, req.params.c);
    const body = parse(retranslateSchema, req.body);
    return retranslateSubtitles({ translate: ctx.translate, commits: ctx.commits, broadcast: ctx.broadcast }, ref, lang, body.ids);
  });
  // Task 25: a language's set deleted, under the set lock, committed and told to the clients; a render that drew it turns stale
  // (its hash is no longer the creative's). Never the original video's speech set, the source of the translations (409
  // `subtitles-source-set`); nor a set a job is about to write: its translation (409 `subtitles-translating`) or, for a set
  // made from speech, the creative's subtitles job (409 `subtitles-running`). A file that is not a valid set is left: 404.
  app.delete<PL>('/api/projects/:slug/creatives/:c/subtitles/:lang', async (req) => {
    const lang = langOf(req.params.lang);
    const ref = await refOf(req.params.slug, req.params.c);
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(ref.creativeSlug);
    const name = languageName(lang);
    await subtitleSetLocks.run(creativeDir, async () => {
      const sets = await listSubtitleSets(creativeDir);
      const set = sets.find((s) => s.lang === lang);
      if (!set) throw new CodedError(404, t().errors.subtitlesNoLang({ lang: name }), 'subtitles-not-found');
      if (speechSourceSet(sets) === set) throw new CodedError(409, t().errors.subtitlesSourceSet, 'subtitles-source-set');
      if (jobOf(subtitleTranslateJobKey(ref, lang))) throw new CodedError(409, t().errors.subtitlesTranslating({ lang: name }), 'subtitles-translating');
      if (set.origin === 'speech' && activeJob(ref)) throw new CodedError(409, t().errors.subtitlesRunning, 'subtitles-running');
      await removeSubtitleSet(creativeDir, lang);
    });
    ctx.commits.touch(ref, t().subtitles.commitDeleted({ title: (await store.get(ref.creativeSlug)).title, lang }));
    try { ctx.broadcast({ type: 'subtitles', project: ref.projectSlug, creative: ref.creativeSlug, lang }); } catch { /* a faulty listener */ }
    return { deleted: lang };
  });
  // The cues clamped to the latest version's main format (a cue past its end is left out); no video: as they are.
  const download = async (req: { params: PL['Params'] }, reply: FastifyReply, ext: 'srt' | 'vtt') => {
    const lang = langOf(req.params.lang);
    const ref = await refOf(req.params.slug, req.params.c);
    const { set } = await setOf(ref, lang);
    const now = await subtitleTimingNow(ref.projectDir, ref.creativeSlug, await ctx.presets());
    const durationMs = now?.durationMs ?? Number.POSITIVE_INFINITY;
    const body = ext === 'srt' ? toSrt(set.cues, { durationMs }) : toVtt(set.cues, { durationMs });
    return reply
      .header('content-type', ext === 'srt' ? 'text/plain; charset=utf-8' : 'text/vtt; charset=utf-8')
      .header('content-disposition', `attachment; filename="${ref.creativeSlug}.${lang}.${ext}"`)
      .send(body);
  };
  app.get<PL>('/api/projects/:slug/creatives/:c/subtitles/:lang/file.srt', (req, reply) => download(req, reply, 'srt'));
  app.get<PL>('/api/projects/:slug/creatives/:c/subtitles/:lang/file.vtt', (req, reply) => download(req, reply, 'vtt'));
}
