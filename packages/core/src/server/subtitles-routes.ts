import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  isSupportedLocale, issuesText, SUBTITLE_LIMITS, subtitleSetHash, subtitleSetSchema, subtitleSetText, subtitlesJobKey, toSrt, toVtt, transcriptionChoiceSchema,
  type FormatPreset, type JobSummary, type LocaleTag, type ServerMessage, type SubtitleSet, type SubtitlesSummary, type TranscriptionPending,
} from '@motion-studio/shared';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef } from '../creatives/creative-turns.ts';
import { currentLocale, t } from '../i18n.ts';
import { instanceComposition } from '../localization/store.ts';
import { audioFingerprint, listSubtitleSets, readSubtitleSet, type SubtitleCommits, subtitleSetLocks, writeSubtitleSet } from '../subtitles/store.ts';
import { subtitleSourceFormat, type SubtitlesService } from '../subtitles/subtitles-job.ts';
import { CodedError, type WorkspaceStore } from '../workspace-store.ts';

const startSchema = z.strictObject({ mode: z.enum(['new', 'retime']).optional(), lang: z.string().refine(isSupportedLocale, { message: 'not a supported language' }).optional() });
const choiceSchema = transcriptionChoiceSchema.omit({ file: true });
/** The editor's save: the whole cue list, checked against the stored set's fields with `subtitleSetSchema`. */
const saveSchema = z.strictObject({ baseHash: z.string().regex(/^[0-9a-f]{64}$/), cues: z.array(z.unknown()).max(SUBTITLE_LIMITS.cues) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new CodedError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }), 'invalid-request');
  return r.data;
}

/**
 * The latest version's main format (the one the subtitles are timed on, `subtitleSourceFormat`): its duration (ms) and the
 * fingerprint of its audio. Null when the latest version has no video format.
 */
export async function subtitleTimingNow(projectDir: string, creativeSlug: string, presets: readonly FormatPreset[]): Promise<{ durationMs: number; fingerprint: string } | null> {
  const store = new CreativeStore(projectDir);
  const latest = (await store.readVersions(creativeSlug)).at(-1);
  if (!latest) return null;
  const format = subtitleSourceFormat(latest, (await store.get(creativeSlug)).brief, presets);
  const ic = format ? await instanceComposition(store.dir(creativeSlug), latest, format, presets).catch(() => null) : null;
  return ic ? { durationMs: Math.round(ic.composition.duration * 1000), fingerprint: audioFingerprint(ic.composition) } : null;
}

/**
 * The creative's subtitle sets as the UI lists them. `timingChanged`: the audio the set was timed on differs from the latest
 * version's main format (false when that version has no video); `staleCues` comes with the translations (Phase 4).
 */
export async function subtitleSummaries(projectDir: string, creativeSlug: string, presets: () => Promise<FormatPreset[]>): Promise<SubtitlesSummary[]> {
  const sets = await listSubtitleSets(new CreativeStore(projectDir).dir(creativeSlug));
  if (sets.length === 0) return [];
  const now = await subtitleTimingNow(projectDir, creativeSlug, await presets());
  return sets.map((s) => ({
    lang: s.lang, origin: s.origin, ...(s.sourceLang ? { sourceLang: s.sourceLang } : {}),
    cues: s.cues.length, edited: s.cues.filter((c) => c.edited).length, hash: subtitleSetHash(s),
    timing: s.timing, timingChanged: now !== null && now.fingerprint !== s.timing.fingerprint, staleCues: 0,
  }));
}

/**
 * Decisions 1636-1640 (spec §6.1-§6.2): the subtitles of a creative (`/api/projects/:slug/creatives/:c/subtitles`): the
 * overview (sets, the job, its transcription question), Fai i sottotitoli, the answer to the transcription dialog and
 * "Ricontrolla", one set, its save from the editor (decision 1654) and its `.srt` / `.vtt` download. A language outside the
 * supported ones answers 400, one without a set 404.
 */
export function registerSubtitlesRoutes(app: FastifyInstance, ctx: {
  requireWorkspace: () => WorkspaceStore; subtitles: SubtitlesService; jobs: () => JobSummary[]; presets: () => Promise<FormatPreset[]>;
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
    return r;
  };
  const activeJob = (ref: CreativeRef): JobSummary | null => {
    const key = subtitlesJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    return ctx.jobs().find((j) => j.key === key && (j.state === 'queued' || j.state === 'running')) ?? null;
  };
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
