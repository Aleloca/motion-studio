import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  COMPOSITION_LIMITS, creativeJobKey, effectiveServices, formatDisplayName, localizableEntries, messages, SUPPORTED_LOCALES,
  EMPTY_BRAND_KIT, type BrandKit, type Composition, type FormatPreset, type JobSummary, type Locale, type LocaleTag, type Localization,
  type LocalizationIssue, type LocalizationRow, type ServerMessage, type VersionEntry,
} from '@motion-studio/shared';
import type { AgentLauncher } from '../agent/launcher.ts';
import { CREATIVE_CORE_FILES, detachLinksUnder } from '../agent/protected-links.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { VoiceBatchContext, VoiceBatchItem, VoiceBatchResult, VoiceUnavailable } from '../bridge/provider-tools.ts';
import { earlierOutputDirs, snapshotChanges, snapshotOutputs, withoutCoreWrites } from '../creatives/carry-over.ts';
import { CreativeStore } from '../creatives/creative-store.ts';
import type { CreativeRef, CreativeTurnService } from '../creatives/creative-turns.ts';
import { checkedPreviewTimes, type PreviewService } from '../creatives/previews.ts';
import { buildLocalizePrompt, type LocalizeRequestEntry } from '../creatives/prompt.ts';
import { currentLocale, t } from '../i18n.ts';
import type { JobQueue } from '../jobs/job-queue.ts';
import type { MediaTools } from '../media/media-tools.ts';
import type { InstallIo } from '../providers/google-fonts.ts';
import type { HttpDeps } from '../providers/http.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';
import {
  emptyOverlay, finishOverlay, instanceComposition, knownVoiceScripts, localizedComposition, readOverlay, resolveFallbackFont, setLocalizationRow,
  attachedFontHashes, rowAssetHashes, voiceRootsOf, writeOverlay, type FallbackResult, type InstanceComposition,
} from './store.ts';
import { issueFields } from './issues.ts';
import { checkedInstance, checkedLocale, clipLabel } from './validate.ts';

/**
 * The `localize` turn (Phase 12, Task 4, spec §3.2): an agent turn on an EXISTING version that translates the missing or
 * stale entries of the chosen languages and formats. The agent writes nothing itself: its only writing tool is
 * `submit_localization`, which validates and merges into the overlay under the creative's lock and answers with the problems
 * at once; the version folder (overlays included) is protected for the turn. At the end of an attempt the core checks every
 * language and format again (missing entries, a text out of its box: the browser's measure when a renderer can run it, else
 * the estimate) and the existing repair loop (3 attempts) asks for what is still open, with the user's words (F4). Voices are
 * made by the core after the texts are final: one `paid-batch` confirmation, the brief's voice service (F5), the brand voice;
 * a voice longer than its clip is a problem with both durations and its repair regenerates only that voice, in a new batch.
 */

/** `POST …/versions/:n/localize`. */
export const localizeBodySchema = z.strictObject({
  locales: z.array(z.string().max(40)).min(1).max(10),
  formats: z.array(z.string().max(200)).min(1).max(60).optional(),
  voice: z.record(z.string().max(40), z.enum(['translate', 'original', 'muted'])).optional(),
  text: z.string().max(4000).optional(),
});
export type LocalizeBody = z.infer<typeof localizeBodySchema>;

/** `submit_localization` arguments: strict, the overlay's own limits. */
const submitSchema = z.strictObject({
  locale: z.string().max(40),
  instanceId: z.string().max(200),
  // A translation is never blank (an empty title would pass every box check).
  texts: z.record(z.string().max(COMPOSITION_LIMITS.id), z.string().max(COMPOSITION_LIMITS.text).refine((x) => x.trim() !== '', 'issue.textRequired')).default({}),
  params: z.record(z.string().max(200), z.string().max(COMPOSITION_LIMITS.text).refine((x) => x.trim() !== '', 'issue.textRequired')).default({}),
  voiceScripts: z.record(z.string().max(COMPOSITION_LIMITS.id), z.string().trim().min(1).max(5000)).default({}),
  fit: z.record(z.string().max(COMPOSITION_LIMITS.id), z.number().min(0.7).max(1)).default({}),
});

type VoiceChoice = 'translate' | 'original' | 'muted';
type Fallback = NonNullable<LocalizationRow['voiceFallback']>;

export interface LocalizeDeps {
  turns: CreativeTurnService; queue: JobQueue; launcher: AgentLauncher; media: MediaTools;
  presets: () => Promise<FormatPreset[]>; model: () => Promise<string | null>; broadcast: (msg: ServerMessage) => void;
  /** The voices of the turn (`voiceAvailability` / `voiceBatch` of provider-tools, over the turn's network). */
  voices: { available: (c: { projectDir: string; services?: VoiceBatchContext['services'] }) => Promise<VoiceUnavailable | null>; batch: (c: VoiceBatchContext, items: VoiceBatchItem[]) => Promise<VoiceBatchResult> };
  /** The Google Fonts network of the fallback fonts (as the localization routes). */
  fonts: { http: HttpDeps; io?: InstallIo };
  previews?: PreviewService;
  /** What was changed in a project by others while a run went on (the server's event stream); absent: nothing is known. */
  activity?: ProjectActivity;
  previewFramesPerTurn?: number;
  maxAttempts?: number;
}

/**
 * When each area of a project last changed by something the server announced (a library or brand change, a project edit, a
 * creative's change): fed by every `ServerMessage` broadcast, read by the localize turn's stray-write check (fix round 2).
 */
export class ProjectActivity {
  private readonly last = new Map<string, number>();
  note(msg: ServerMessage): void {
    const at = Date.now();
    if (msg.type === 'library' || msg.type === 'brand' || msg.type === 'project') this.mark(msg.project, msg.type, at);
    else if (msg.type === 'creative') this.mark(msg.project, `creative:${msg.creative}`, at);
  }
  /** The areas of `project` changed at or after `t` (`library`, `brand`, `project`, `creative:<slug>`). */
  since(project: string, t: number): Set<string> {
    const out = new Set<string>();
    for (const [k, at] of this.last) if (at >= t && k.startsWith(`${project}\u0000`)) out.add(k.slice(project.length + 1));
    return out;
  }
  private mark(project: string, area: string, at: number) {
    this.last.set(`${project}\u0000${area}`, at);
    if (this.last.size > 2000) this.last.delete(this.last.keys().next().value!);
  }
}

/** The instances of a version that show one composition (a primary and its followers): translated once, written for each. */
interface Group { rep: string; members: string[]; ic: InstanceComposition; scripts: Map<string, string>; label: string }

/** One language and group of the turn. */
interface Pair {
  key: string; locale: LocaleTag; group: Group; choice: VoiceChoice;
  /** The request named the voice choice of this language (otherwise `translate` is the default). */
  explicit: boolean;
  /** Voices are translated for this language in this turn (asked and the service available); false after a declined batch. */
  voices: boolean;
  /** `voices` when the turn started: voice scripts are part of this language's request. */
  voicesAsked: boolean;
  fallback?: Fallback;
  /** Entries asked (missing or stale when the turn started). */
  asked: { texts: string[]; params: string[]; voices: string[] };
  noScript: string[];
  /** Translated scripts waiting for their voice. */
  pending: Map<string, string>;
  /** Voice problems: the text, and whether a shorter script can fix it. */
  voiceProblems: Map<string, { text: string; fixable: boolean; code: 'voiceTooLong' | 'voiceFailed' | 'voiceDurationUnknown' }>;
  /** The browser's measure of the overlay with this hash (clip ids that overflow). */
  measured?: { hash: string; ids: string[] };
  submitted: boolean;
}

const now = () => new Date().toISOString();

/** Top-level project entries the stray-write check never looks at (git, the core's own state, tool caches). */
const UNWATCHED = new Set(['.git', '.studio', '.cache', 'node_modules']);
/** At most this many entries are fingerprinted; a larger project is compared on what fits (deepest entries last). */
const MAX_WATCHED = 50_000;

/** The library's index files (`LibraryStore`): rewritten by every library change. */
const LIBRARY_INDEX = 'assets/assets.json';
const REFERENCES_INDEX = 'references/references.json';
/** The brand store's own files (`BrandStore`), besides its analysis proposals. */
const BRAND_FILES = new Set(['brand', 'brand/brand-kit.json', 'brand/guidelines.md', 'brand/sources.json']);
/** How deep the project is walked; a folder at this depth is fingerprinted with its mtime (its entries are not compared). */
const MAX_DEPTH = 12;

/**
 * Path (project-relative) → fingerprint of the project's entries, without `UNWATCHED`, the creative's `outputs/` (compared on
 * its own, core writes left out) and its records (`CREATIVE_CORE_FILES`, written by the core while the agent runs):
 * - a file or link: type, size, mtime, inode (each one compared on its own);
 * - a folder that is walked: type and inode only. Its mtime moves whenever an entry is created, renamed or removed in it,
 *   which the core's own atomic writes do (versions.json, the conversation: temp file, then rename) although those entries
 *   are left out; its entries are compared one by one instead (final review I3, live F1: a warning on every turn);
 * - a folder at `MAX_DEPTH`, whose entries are not walked: with its mtime, the only trace of a change below it.
 */
function entryStamp(info: { isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number; ino: number }, walked: boolean): string {
  return walked ? `d:${info.ino}` : `${info.isDirectory() ? 'd' : info.isSymbolicLink() ? 'l' : 'f'}:${info.size}:${info.mtimeMs}:${info.ino}`;
}

/**
 * The core's own writes in the project during a localize turn (fallback fonts, voices, the library entries they get), by
 * project-relative path → the fingerprint the core left (`entryStamp`), with their folders: the stray-write check leaves an
 * entry out only while it is still exactly what the core wrote (final review I3).
 */
class OwnWrites {
  private readonly stamps = new Map<string, string>();
  constructor(private readonly projectDir: string) {}
  async note(rels: Iterable<string>): Promise<void> {
    for (const rel of rels) {
      const parts = rel.split('/');
      for (let i = parts.length; i >= 1; i--) {
        const sub = parts.slice(0, i).join('/');
        const info = await lstat(join(this.projectDir, ...parts.slice(0, i))).catch(() => null);
        if (info) this.stamps.set(sub, entryStamp(info, info.isDirectory() && i - 1 < MAX_DEPTH));
      }
    }
  }
  has(rel: string, stamp: string | undefined): boolean { return stamp !== undefined && this.stamps.get(rel) === stamp; }
}

async function snapshotProject(projectDir: string, creativeRel: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const skip = new Set([`${creativeRel}/outputs`, ...CREATIVE_CORE_FILES.map((f) => `${creativeRel}/${f}`)]);
  const walk = async (rel: string, depth: number): Promise<void> => {
    const names = await readdir(rel ? join(projectDir, ...rel.split('/')) : projectDir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (out.size >= MAX_WATCHED) return;
      const child = rel ? `${rel}/${name}` : name;
      if ((!rel && UNWATCHED.has(name)) || skip.has(child)) continue;
      const info = await lstat(join(projectDir, ...child.split('/'))).catch(() => null);
      if (!info) continue;
      const walked = info.isDirectory() && depth < MAX_DEPTH;
      out.set(child, entryStamp(info, walked));
      if (walked) await walk(child, depth + 1);
    }
  };
  await walk('', 0);
  return out;
}
const localeName = (tag: string) => SUPPORTED_LOCALES.find((x) => x.tag === tag)?.name ?? tag;
/** Estimated lines a box holds at a size (the prompt's "about N lines at most"). */
const maxLines = (box: { h: number }, size: number) => Math.max(1, Math.floor(box.h / (size * 1.2) + 0.05));

export class LocalizeService {
  private readonly maxAttempts: number;
  constructor(private readonly deps: LocalizeDeps) { this.maxAttempts = deps.maxAttempts ?? 3; }

  /** Starts a localize turn on version `n` (checked under the creative's lock); 202 with the job. */
  async start(ref: CreativeRef, n: number, raw: unknown): Promise<JobSummary> {
    const ui = currentLocale();
    const va = messages(ui).variants;
    const parsed = localizeBodySchema.safeParse(raw ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CodedError(400, va.localizationInvalid({ detail: `${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim().slice(0, 300) }), 'localize-invalid');
    }
    const body = parsed.data;
    const store = new CreativeStore(ref.projectDir);
    return this.deps.turns.runLocked(ref, async () => {
      if (this.deps.turns.turnActive(ref)) throw new WorkspaceError(409, t().errors.generationRunning);
      const creative = await store.get(ref.creativeSlug);
      const version = n > 0 ? (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n) : undefined;
      if (!version) throw new WorkspaceError(404, t().errors.versionNotFound);
      const locales = [...new Set(body.locales.map((l) => checkedLocale(l, ui)))];
      for (const l of locales) if (!creative.brief.locales?.extra.includes(l)) throw new CodedError(409, va.localeNotInBrief({ tag: l }), 'locale-not-in-brief');
      if (!version.compositions?.length) throw new CodedError(409, va.localizeNoCompositions({ n }), 'localize-no-compositions');
      const formats = body.formats ? [...new Set(body.formats.map((f) => checkedInstance(f, version, ui)))] : version.compositions.map((c) => c.format);
      const voice: Partial<Record<LocaleTag, VoiceChoice>> = {};
      for (const [k, c] of Object.entries(body.voice ?? {})) {
        const tag = checkedLocale(k, ui);
        if (!locales.includes(tag)) throw new CodedError(400, va.localizationInvalid({ detail: `voice.${tag.slice(0, 20)}` }), 'localize-invalid');
        voice[tag] = c;
      }
      await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.localizeStarted({ n, locales: locales.map(localeName).join(', ') }) });
      this.deps.turns.changed(ref);
      const plan = { n, locales, formats, voice, text: body.text?.trim() ? body.text : undefined };
      return this.deps.queue.enqueue({
        key: creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug),
        kind: 'localize',
        label: t().jobs.localizeLabel({ title: creative.title }),
        run: (signal, jobId) => this.run(ref, plan, signal, jobId),
      });
    });
  }

  private async run(ref: CreativeRef, plan: { n: number; locales: LocaleTag[]; formats: string[]; voice: Partial<Record<LocaleTag, VoiceChoice>>; text?: string },
    signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const ui: Locale = currentLocale();
    const m = messages(ui);
    const va = m.variants;
    const j = t().jobs;
    const slug = ref.creativeSlug;
    const store = new CreativeStore(ref.projectDir);
    const creativeDir = store.dir(slug);
    const { n } = plan;
    const say = (level: 'info' | 'warning' | 'error', text: string) => store.appendConversation(slug, { type: 'system', at: now(), level, text });
    let lastWrite: Promise<void> = Promise.resolve();
    try {
      const creative = await store.get(slug);
      const presets = await this.deps.presets();
      const version = (await store.readVersions(slug)).find((v) => v.n === n);
      if (!version) throw new Error(t().errors.versionNotFound);
      const label = (id: string) => formatDisplayName(presets, id, ui, creative.brief.formatLabels);

      // The groups: instances showing the same composition are translated once (the follower gets the same overlay).
      const groups: Group[] = [];
      for (const id of plan.formats) {
        const ic = await instanceComposition(creativeDir, version, id, presets);
        if (!ic) { await say('warning', m.errors.compositionUnusable({ format: label(id), n })); continue; }
        const g = groups.find((x) => x.ic.entry.dir === ic.entry.dir && x.ic.entry.hash === ic.entry.hash);
        if (g) g.members.push(id);
        else groups.push({ rep: id, members: [id], ic, scripts: await knownVoiceScripts(ic, ref.projectDir, this.deps.media), label: label(id) });
      }

      // Voices: the brief's service decides before anything is asked (F5; `none` means no call and no confirmation).
      const services = creative.brief.services;
      const wantsVoices = plan.locales.some((l) => (plan.voice[l] ?? 'translate') === 'translate');
      const unavailable = wantsVoices ? await this.deps.voices.available({ projectDir: ref.projectDir, ...(services ? { services } : {}) }) : null;

      const pairs = new Map<string, Pair>();
      for (const locale of plan.locales) {
        for (const group of groups) {
          const choice = plan.voice[locale] ?? 'translate';
          const current = await this.current(creativeDir, n, locale, group.rep);
          const stale = new Set(current?.row.stale ?? []);
          const has = (r: Record<string, unknown> | undefined, id: string) => Boolean(r && Object.hasOwn(r, id)) && !stale.has(id);
          const e = localizableEntries(group.ic.composition);
          const voicesOn = choice === 'translate' && unavailable === null;
          // The voices this language would need (translatable, missing or stale): only they make a fallback.
          const wanted = choice === 'translate' ? e.voices.filter((x) => group.scripts.has(x.clipId) && !has(current?.overlay.voices, x.clipId)).map((x) => x.clipId) : [];
          const pair: Pair = {
            key: `${locale}|${group.rep}`, locale, group, choice, explicit: plan.voice[locale] !== undefined, voices: voicesOn, voicesAsked: voicesOn,
            ...(unavailable && wanted.length > 0 ? { fallback: unavailable.reason } : {}),
            asked: {
              texts: e.texts.filter((x) => !has(current?.overlay.texts, x.clipId)).map((x) => x.clipId),
              params: e.params.filter((x) => !has(current?.overlay.params, x.key)).map((x) => x.key),
              voices: voicesOn ? wanted : [],
            },
            noScript: e.voices.filter((x) => !group.scripts.has(x.clipId)).map((x) => x.clipId),
            pending: new Map(), voiceProblems: new Map(), submitted: false,
          };
          pairs.set(pair.key, pair);
        }
      }
      const pairOf = (locale: unknown, instanceId: unknown) => {
        if (typeof locale !== 'string' || typeof instanceId !== 'string') return undefined;
        const g = groups.find((x) => x.members.includes(instanceId));
        return g ? pairs.get(`${locale}|${g.rep}`) : undefined;
      };
      const active = () => [...pairs.values()].filter((p) => p.asked.texts.length + p.asked.params.length + p.asked.voices.length > 0);

      // "Can't translate voice": clips with no known script, said once per format when its voices are asked.
      const noScriptLines = [...new Set([...pairs.values()].filter((p) => p.choice === 'translate').flatMap((p) => p.noScript.map((id) => va.voiceNoScript({ clip: clipLabel(p.group.ic.composition, id), format: p.group.rep }))))];
      for (const line of noScriptLines) await say('warning', line);
      if (noScriptLines.length) this.deps.queue.patch(jobId, { notes: noScriptLines });

      const own = new OwnWrites(ref.projectDir);
      const fallbackFonts = new Map<LocaleTag, FallbackResult>();
      const fontOf = async (locale: LocaleTag) => {
        if (!fallbackFonts.has(locale)) {
          const font = await resolveFallbackFont({ projectDir: ref.projectDir, http: this.deps.fonts.http, media: this.deps.media, ...(this.deps.fonts.io ? { io: this.deps.fonts.io } : {}) }, locale, signal);
          fallbackFonts.set(locale, font);
          // A font fetched while the agent runs (a language it submits that was not asked) is the core's write, not a stray one.
          if (font && 'files' in font) await own.note([...font.files, LIBRARY_INDEX]);
        }
        return fallbackFonts.get(locale)!;
      };

      // ---- submit_localization ----
      const submit = async (raw: Record<string, unknown>) => {
        const parsedArgs = submitSchema.safeParse(raw);
        if (!parsedArgs.success) {
          const issue = parsedArgs.error.issues[0];
          return { ok: false, errors: [va.localizationInvalid({ detail: `${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim().slice(0, 300) })] };
        }
        const a = parsedArgs.data;
        const pair = pairOf(a.locale, a.instanceId);
        if (!pair) return { ok: false, errors: [va.submitNotInTurn({ locale: a.locale.slice(0, 20), format: a.instanceId.slice(0, 100) })] };
        const fallback = await fontOf(pair.locale);
        return this.deps.turns.runLocked(ref, async () => {
          const v = (await store.readVersions(slug)).find((x) => x.n === n);
          const ic = v ? await instanceComposition(creativeDir, v, pair.group.rep, presets) : null;
          if (!v || !ic) return { ok: false, errors: [m.errors.compositionUnusable({ format: pair.group.rep, n })] };
          const e = localizableEntries(ic.composition);
          const texts = new Map(e.texts.map((x) => [x.clipId, x.text] as const));
          const params = new Map(e.params.map((x) => [x.key, x.text] as const));
          const current = await this.current(creativeDir, n, pair.locale, pair.group.rep);
          const base = current?.overlay ?? emptyOverlay(pair.locale, pair.group.rep);
          const out: Localization = { ...base, texts: { ...base.texts }, params: { ...base.params }, fit: { ...base.fit } };
          const errors: string[] = [];
          const chooseFit = new Set<string>();
          for (const [id, text] of Object.entries(a.texts)) {
            if (!texts.has(id)) { errors.push(va.localizationMismatch({ entry: id.slice(0, 100) })); continue; }
            out.texts[id] = { source: texts.get(id)!, text };
            if (!Object.hasOwn(a.fit, id)) { chooseFit.add(id); delete out.fit[id]; }
          }
          for (const [key, text] of Object.entries(a.params)) {
            if (!params.has(key)) { errors.push(va.localizationMismatch({ entry: key.slice(0, 100) })); continue; }
            out.params[key] = { source: params.get(key)!, text };
          }
          for (const [id, f] of Object.entries(a.fit)) {
            if (!texts.has(id)) errors.push(va.localizationMismatch({ entry: id.slice(0, 100) }));
            else if (!Object.hasOwn(out.texts, id)) errors.push(va.fitWithoutText({ clip: id.slice(0, 100) }));
            else out.fit[id] = f;
          }
          // Voice scripts were never part of this language's request: refused. After a declined or failed batch they are ignored
          // (the language keeps its fallback; the texts of the call still count).
          const scripts = pair.voices ? Object.entries(a.voiceScripts) : [];
          if (Object.keys(a.voiceScripts).length > 0 && !pair.voicesAsked) errors.push(va.voicesNotInTurn({ locale: pair.locale }));
          else for (const [id] of scripts) if (!pair.group.scripts.has(id)) errors.push(va.voiceNotTranslatable({ clip: id.slice(0, 100) }));
          if (errors.length) return { ok: false, errors };
          const row = current?.row;
          const done = await finishOverlay({
            overlay: out, base: ic, voice: row?.voice ?? 'original', chooseFit, uiLocale: ui, projectDir: ref.projectDir,
            voiceRoots: voiceRootsOf(ic, ref.projectDir), fallback, scripts: pair.group.scripts,
          });
          // A script already voiced as it is (and current) is not voiced again: it would last as long.
          for (const [id, script] of scripts) {
            const had = done.overlay.voices[id];
            if (had && had.script === script && !done.stale.includes(id)) { pair.pending.delete(id); continue; }
            pair.pending.set(id, script);
            // Its earlier problem (too long, too long to send) is answered by this script: the voice is made again in this
            // attempt's batch, never left for a later attempt (fix I2).
            pair.voiceProblems.delete(id);
          }
          // The fallback font the core attached now is hashed now (Ruling L); a recorded hash is kept.
          const fresh = await attachedFontHashes(ref.projectDir, fallback, row?.assetHashes);
          await this.writeRows(store, creativeDir, n, pair, done.overlay, { origin: 'agent', stale: done.stale, issues: done.issues, fresh });
          pair.submitted = true;
          this.deps.turns.changed(ref);
          const missing = this.missing(pair, done.overlay, done.stale).map((id) => va.notTranslated({ clip: clipLabel(ic.composition, id) }));
          return { ok: true, problems: [...done.problems, ...missing] };
        });
      };

      // ---- preview_frames on the localized composition ----
      let previewCalls = 0;
      const previewLimit = this.deps.previewFramesPerTurn ?? 10;
      const previewFrames = async (a: { format: unknown; times: unknown; locale?: unknown }) => {
        const previews = this.deps.previews;
        if (!previews) throw new CodedError(503, t().errors.previewUnavailable, 'no-renderer');
        const pair = pairOf(a.locale, a.format);
        if (!pair) throw new CodedError(400, va.submitNotInTurn({ locale: String(a.locale).slice(0, 20), format: String(a.format).slice(0, 100) }), 'formats-not-in-turn');
        checkedPreviewTimes(a.times, ui);
        if (previewCalls >= previewLimit) throw new CodedError(429, t().errors.previewFramesLimit({ max: previewLimit }), 'preview-limit');
        previewCalls++;
        try {
          const composition = await this.localized(creativeDir, n, pair);
          return await previews.localizedAgentFrames({ ref: { projectDir: ref.projectDir, creativeDir, creativeSlug: slug, n }, format: a.format as string, folder: basename(pair.group.ic.compDir),
            preset: pair.group.ic.preset, composition, times: a.times, locale: ui, signal });
        } catch (e) {
          if (e instanceof CodedError && e.apiCode === 'preview-busy') previewCalls--;
          throw e;
        }
      };

      // ---- the agent's attempts ----
      const versionDir = store.outputsDir(slug, n);
      let resumeSessionId: string | undefined;
      let problems = new Map<string, { fixable: string[]; other: string[] }>();
      const asked = active();
      if (asked.length === 0) {
        await say('info', j.localizeNothingToDo({ n }));
      } else {
        const linked = await detachLinksUnder(versionDir, creativeDir);
        if (linked.length > 0) await say('warning', j.earlierLinksDetached({ list: linked.slice(0, 5).join(', ') + (linked.length > 5 ? ', …' : '') }));
        // The fallback fonts are fetched before the agent runs: during a run the core writes nothing in the project outside the
        // version's overlays and the creative's own records, so any other change there is the agent's (fix I1).
        for (const l of new Set(asked.map((p) => p.locale))) await fontOf(l);
        const strays = new Set<string>();
        const kit = await new BrandStore(ref.projectDir).readKit().catch(() => EMPTY_BRAND_KIT as BrandKit);
        const requests = asked.map((p) => this.requestOf(p, presets));
        const model = (await this.deps.model()) ?? undefined;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
          const fix = attempt > 1;
          // Languages whose voices are not translated (now): the service is unavailable, or a batch was declined or failed.
          const voicesOff = [...new Set([...pairs.values()].filter((p) => p.fallback).map((p) => `${localeName(p.locale)} (${p.locale})`))];
          const open = [...problems].filter(([, x]) => x.fixable.length + x.other.length > 0);
          const prompt = buildLocalizePrompt({
            kind: fix ? 'localize-fix' : 'localize', title: creative.title, version: n,
            locales: plan.locales.map((l) => `${localeName(l)} (${l})`),
            requests: fix ? requests.filter((r) => open.some(([k]) => k === `${r.locale}|${r.instanceId}`)) : requests,
            kit, brief: { goal: creative.brief.goal, message: creative.brief.message, notes: creative.brief.notes },
            ...(plan.text ? { userText: plan.text } : {}),
            ...(fix ? { problems: open.map(([k, x]) => { const p = pairs.get(k)!; return { locale: p.locale, localeName: localeName(p.locale), instanceId: p.group.rep, problems: [...x.fixable, ...x.other] }; }) } : {}),
            ...(voicesOff.length ? { voicesOff } : {}),
            locale: ui,
          });
          const sandboxed = await this.deps.launcher.sandboxed();
          const watch = await this.watchProject(ref, jobId, own);
          const run = await this.deps.launcher.start({
            kind: 'localize', jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: slug,
            // The version translated is not "earlier" for this turn: it and every other version folder are read-only for the agent.
            protectedDirs: [versionDir, join(creativeDir, 'outputs')],
            request: { prompt, ...(resumeSessionId ? { resumeSessionId } : {}), forkSession: false, ...(model ? { model } : {}) },
            usage: { version: n, attempt }, sandboxed,
            services: effectiveServices(creative.brief),
            onWarning: (text) => { lastWrite = lastWrite.then(() => say('warning', text)); return lastWrite; },
            onEvent: (event) => {
              this.deps.broadcast({ type: 'agent', jobId, event });
              if (event.kind === 'usage' && event.live) return;
              lastWrite = lastWrite.then(() => store.appendConversation(slug, { type: 'agent', at: now(), jobId, event }));
              lastWrite.catch(() => {});
              const sid = event.kind === 'session' || event.kind === 'result' ? event.sessionId : undefined;
              if (sid) this.deps.queue.patch(jobId, { sessionId: sid });
            },
            submitLocalization: submit,
            previewFrames,
          });
          const onAbort = () => run.cancel();
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
          const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
          run.killGroup?.();
          await lastWrite;
          for (const x of await watch()) strays.add(x);
          if (outcome.status === 'cancelled') return await this.cancelled(ref, store);
          if (outcome.status === 'failed') throw new Error(outcome.error ?? t().errors.turnFailed);
          resumeSessionId = outcome.sessionId ?? resumeSessionId;

          problems = await this.assess(ref, creativeDir, n, pairs, ui, signal);
          const textOpen = [...problems.values()].some((x) => x.fixable.length > 0);
          // Voices once the texts are final: nothing left to fix in them, or no attempt left.
          if (!textOpen || attempt === this.maxAttempts) {
            await this.voicePhase(ref, store, creativeDir, n, pairs, presets, ui, signal, jobId, services, say, own);
            problems = await this.assess(ref, creativeDir, n, pairs, ui, signal);
          }
          const fixable = [...problems.values()].reduce((s, x) => s + x.fixable.length, 0);
          if (fixable === 0 || attempt === this.maxAttempts) break;
          await say('info', j.localizeChecking({ count: fixable, attempt: attempt + 1, max: this.maxAttempts }));
          this.deps.turns.changed(ref);
        }
        if (strays.size > 0) {
          const list = [...strays].sort();
          const text = j.localizeVersionChanged({ list: list.slice(0, 5).join(', ') + (list.length > 5 ? ', …' : '') });
          await say('warning', text);
          const notes = this.deps.queue.list().find((x) => x.id === jobId)?.notes ?? [];
          this.deps.queue.patch(jobId, { notes: [...notes, text] });
        }
      }

      // ---- the rows' final state: voice choice and fallback, problems ----
      if (signal.aborted) return await this.cancelled(ref, store);
      await this.finish(ref, store, creativeDir, n, pairs, presets, ui, signal);
      problems = await this.assess(ref, creativeDir, n, pairs, ui, signal);
      const saved = [...new Set([...pairs.values()].filter((p) => p.submitted).map((p) => `${localeName(p.locale)} · ${p.group.label}`))];
      if (saved.length) await say('info', j.localizeDone({ n, list: saved.join(', ') }));
      const openLines = [...problems].filter(([, x]) => x.fixable.length + x.other.length > 0);
      for (const [k, x] of openLines) {
        const p = pairs.get(k)!;
        await say('warning', `${localeName(p.locale)} · ${p.group.label}: ${[...x.fixable, ...x.other].join('; ')}`);
      }
      const count = openLines.reduce((s, [, x]) => s + x.fixable.length + x.other.length, 0);
      if (count > 0) await say('info', j.localizeOpenProblems({ count }));
      await this.deps.turns.commitState(ref, j.localizeCommit({ title: creative.title, n }));
      this.deps.turns.changed(ref);
    } catch (err) {
      await lastWrite.catch(() => {});
      if (signal.aborted) return await this.cancelled(ref, store);
      const text = err instanceof Error ? err.message : String(err);
      await say('error', t().jobs.generationFailed({ text })).catch(() => {});
      await this.deps.turns.commitState(ref, t().jobs.stateCommit({ title: slug }));
      this.deps.turns.changed(ref);
      throw err;
    }
  }

  /**
   * Fingerprints the project before one agent run and returns the check to call after it: the paths (project-relative) the
   * run changed, added or removed (fix I1). The creative's `outputs/` leave out the core's own writes (overlays,
   * renders); the creative's records (conversation, versions, creative.json), `.git`, `.studio`, `.cache` and `node_modules`
   * are not looked at. What someone else may have written meanwhile is left out (fix round 2): with another job of the project
   * running (a turn, a render or a Generate of another creative, a brand analysis) only this creative's folder is compared, and
   * the areas a user action changed during the run (`activity`: a library upload, a brand edit, another creative's edit) are
   * left out. Attribution stays a best effort: the warning says files changed during the turn, never who wrote them.
   */
  private async watchProject(ref: CreativeRef, jobId: string, own: OwnWrites): Promise<() => Promise<string[]>> {
    const creativeRel = `creatives/${ref.creativeSlug}`;
    const creativeDir = join(ref.projectDir, 'creatives', ref.creativeSlug);
    const ownRender = `:${ref.projectSlug}:${ref.creativeSlug}:`;
    const othersBusy = () => this.deps.queue.list().some((x) => x.id !== jobId && (x.state === 'queued' || x.state === 'running')
      && (x.key.endsWith(`:${ref.projectSlug}`) || x.key.includes(`:${ref.projectSlug}:`))
      // This creative's own renders write only noted core files in its outputs/.
      && !(x.kind === 'render' && x.key.includes(ownRender)));
    const busyBefore = othersBusy();
    const since = Date.now();
    const outputsOf = async () => snapshotOutputs(creativeDir, await earlierOutputDirs(creativeDir, -1));
    const library = new LibraryStore(ref.projectDir, this.deps.media);
    // The library's files (registered in its index) before and after the run: what a library change may have touched.
    const registered = async () => {
      const [a, r] = await Promise.all([library.listAssets().catch(() => []), library.listReferences().catch(() => [])]);
      return [...a.map((x) => `assets/${x.file}`), ...r.map((x) => `references/${x.file}`)];
    };
    const [projBefore, outBefore, libBefore] = [await snapshotProject(ref.projectDir, creativeRel), await outputsOf(), await registered()];
    return async () => {
      const [projAfter, outAfter] = [await snapshotProject(ref.projectDir, creativeRel), await outputsOf()];
      const busy = busyBefore || othersBusy();
      const touched = this.deps.activity?.since(ref.projectSlug, since) ?? new Set<string>();
      // A library or brand change during the run explains only the entries that area writes (Task 4 minor): the library's
      // index files and the files it registers (and their folders); the brand store's own files. Any other entry of
      // `assets/`, `references/` or `brand/` is still compared.
      const libraryFiles = touched.has('library') ? new Set([...libBefore, ...(await registered())]) : new Set<string>();
      const libraryEntry = (p: string) => p === LIBRARY_INDEX || p === REFERENCES_INDEX || libraryFiles.has(p)
        || [...libraryFiles].some((f) => f.startsWith(`${p}/`));
      const brandEntry = (p: string) => BRAND_FILES.has(p) || p === 'brand/proposals' || p.startsWith('brand/proposals/');
      const someoneElse = (p: string) => {
        const top = p.split('/')[0]!;
        if (touched.has('library') && (top === 'assets' || top === 'references') && libraryEntry(p)) return true;
        if (touched.has('brand') && top === 'brand' && brandEntry(p)) return true;
        if (touched.has('project') && !p.includes('/')) return true;
        const other = top === 'creatives' ? p.split('/')[1] : undefined;
        return other !== undefined && other !== ref.creativeSlug && touched.has(`creative:${other}`);
      };
      const proj = snapshotChanges(projBefore, projAfter).filter((p) => (!busy || p === creativeRel || p.startsWith(`${creativeRel}/`)) && !someoneElse(p)
        && !own.has(p, projAfter.get(p)));
      const outs = withoutCoreWrites(creativeDir, snapshotChanges(outBefore, outAfter), outAfter).map((p) => `${creativeRel}/${p}`);
      return [...proj, ...outs];
    };
  }

  private async cancelled(ref: CreativeRef, store: CreativeStore): Promise<'cancelled'> {
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: t().jobs.cancelledNote }).catch(() => {});
    await this.deps.turns.commitState(ref, t().jobs.stateCommit({ title: ref.creativeSlug }));
    this.deps.turns.changed(ref);
    return 'cancelled';
  }

  /** The row and overlay of `locale` and `instanceId` in version `n`, when the overlay is still the recorded one. */
  private async current(creativeDir: string, n: number, locale: LocaleTag, instanceId: string): Promise<{ row: LocalizationRow; overlay: Localization; hash: string } | null> {
    // `<project>/creatives/<slug>`: the store of the project, the creative's slug.
    const versions = await new CreativeStore(dirname(dirname(creativeDir))).readVersions(basename(creativeDir)).catch(() => [] as VersionEntry[]);
    const row = versions.find((v) => v.n === n)?.localizations?.find((r) => r.locale === locale && r.instanceId === instanceId);
    if (!row) return null;
    const read = await readOverlay(creativeDir, n, locale, instanceId);
    return read && read.hash === row.hash ? { row, overlay: read.overlay, hash: read.hash } : null;
  }

  /** The localized composition of a pair as stored now (the base composition when nothing is translated yet). */
  private async localized(creativeDir: string, n: number, pair: Pair): Promise<Composition> {
    const cur = await this.current(creativeDir, n, pair.locale, pair.group.rep);
    if (!cur) return pair.group.ic.composition;
    return localizedComposition(pair.group.ic.composition, cur.overlay, cur.row) ?? pair.group.ic.composition;
  }

  /** Writes the overlay and the row of every instance of the pair's group (the caller holds the creative's lock). */
  private async writeRows(store: CreativeStore, creativeDir: string, n: number, pair: Pair, overlay: Localization,
    o: { origin: LocalizationRow['origin']; stale: string[]; issues: LocalizationIssue[]; voice?: LocalizationRow['voice']; final?: boolean; fresh?: Record<string, string> }): Promise<void> {
    const versions = await store.readVersions(basename(creativeDir));
    const rows = versions.find((v) => v.n === n)?.localizations ?? [];
    for (const member of pair.group.members) {
      const old = rows.find((r) => r.locale === pair.locale && r.instanceId === member);
      const hash = await writeOverlay(creativeDir, n, { ...overlay, instanceId: member });
      const voice = o.voice ?? old?.voice ?? 'original';
      const assetHashes = rowAssetHashes({ overlay, ...(old?.assetHashes ? { old: old.assetHashes } : {}), ...(o.fresh ? { fresh: o.fresh } : {}) });
      const row: LocalizationRow = {
        locale: pair.locale, instanceId: member, hash, origin: o.origin, stale: o.stale, voice,
        ...issueFields(o.issues),
        ...(old?.render ? { render: old.render } : {}),
        ...(assetHashes ? { assetHashes } : {}),
        ...(o.final ? {
          ...(pair.fallback && pair.choice === 'translate' ? { voiceFallback: pair.fallback } : {}),
          ...(pair.choice === 'translate' && pair.noScript.length ? { noScript: pair.noScript } : {}),
        } : {
          ...(old?.voiceFallback ? { voiceFallback: old.voiceFallback } : {}), ...(old?.noScript ? { noScript: old.noScript } : {}),
        }),
      };
      await setLocalizationRow(store, basename(creativeDir), n, row);
    }
  }

  /** The asked entries still not translated (absent, or stale); voices waiting for their audio are not missing. */
  private missing(pair: Pair, overlay: Localization | null, stale: readonly string[]): string[] {
    const has = (r: Record<string, unknown> | undefined, id: string) => Boolean(r && Object.hasOwn(r, id)) && !stale.includes(id);
    return [
      ...pair.asked.texts.filter((id) => !has(overlay?.texts, id)),
      ...pair.asked.params.filter((id) => !has(overlay?.params, id)),
      ...(pair.voices ? pair.asked.voices.filter((id) => !pair.pending.has(id) && !has(overlay?.voices, id)) : []),
    ];
  }

  /** The request of a pair for the prompt. */
  private requestOf(pair: Pair, presets: FormatPreset[]): LocalizeRequestEntry {
    const e = localizableEntries(pair.group.ic.composition);
    const preset = pair.group.ic.preset;
    return {
      locale: pair.locale, localeName: localeName(pair.locale), instanceId: pair.group.rep, also: pair.group.members.slice(1),
      format: { name: formatDisplayName(presets, pair.group.rep, 'en'), width: preset.width, height: preset.height },
      texts: e.texts.filter((x) => pair.asked.texts.includes(x.clipId)).map((x) => ({
        clipId: x.clipId, ...(x.name !== undefined ? { name: x.name } : {}), ...(x.scene !== undefined ? { scene: x.scene } : {}),
        text: x.text, box: x.box, size: x.size, maxLines: maxLines(x.box, x.size),
      })),
      params: e.params.filter((x) => pair.asked.params.includes(x.key)).map((x) => ({ key: x.key, ...(x.label !== undefined ? { label: x.label } : {}), text: x.text })),
      voices: e.voices.filter((x) => pair.asked.voices.includes(x.clipId)).map((x) => {
        const clip = pair.group.ic.composition.tracks.flatMap((tr) => tr.clips).find((c) => c.id === x.clipId);
        return { clipId: x.clipId, ...(clip?.name !== undefined ? { name: clip.name } : {}), script: pair.group.scripts.get(x.clipId)!, durationSec: x.duration };
      }),
    };
  }

  /**
   * The open problems of every pair, split into those a translation can fix (missing entries, a text out of its box, a voice
   * longer than its clip) and the others. Overflow: for a clip with an explicit box (width or height), the browser's measure
   * of the localized composition when the preview renderer can run it (Ruling I), else the glyph-width estimate stored with the
   * overlay; clips without an explicit box keep the estimate (the runtime does not measure them).
   */
  private async assess(ref: CreativeRef, creativeDir: string, n: number, pairs: Map<string, Pair>, ui: Locale, signal: AbortSignal):
    Promise<Map<string, { fixable: string[]; other: string[] }>> {
    const va = messages(ui).variants;
    const out = new Map<string, { fixable: string[]; other: string[] }>();
    for (const pair of pairs.values()) {
      const cur = await this.current(creativeDir, n, pair.locale, pair.group.rep);
      const comp = pair.group.ic.composition;
      const fixable: string[] = [];
      const other: string[] = [];
      const missing = this.missing(pair, cur?.overlay ?? null, cur?.row.stale ?? []);
      fixable.push(...missing.map((id) => va.notTranslated({ clip: clipLabel(comp, id) })));
      if (cur) {
        const estimates = new Map(Object.keys(cur.overlay.texts).map((id) => [va.textOverflow({ clip: clipLabel(comp, id) }), id] as const));
        const boxed = (id: string) => {
          const clip = comp.tracks.flatMap((tr) => tr.clips).find((c) => c.id === id);
          return clip?.type === 'text' && (clip.props.width !== undefined || clip.props.height !== undefined);
        };
        let measured: string[] | null = null;
        if (this.deps.previews && Object.keys(cur.overlay.texts).length > 0 && !signal.aborted) {
          if (pair.measured?.hash === cur.hash) measured = pair.measured.ids;
          else {
            const localized = localizedComposition(comp, cur.overlay, cur.row);
            measured = localized ? await this.deps.previews.measureTextOverflow({ ref: { projectDir: ref.projectDir, creativeDir, creativeSlug: ref.creativeSlug, n },
              folder: basename(pair.group.ic.compDir), preset: pair.group.ic.preset, composition: localized, signal }) : null;
            if (measured) pair.measured = { hash: cur.hash, ids: measured };
          }
        }
        const measuredTexts = new Set(Object.keys(cur.overlay.texts).map((id) => va.textOverflowMeasured({ clip: clipLabel(comp, id), fit: Math.round((cur.overlay.fit[id] ?? 1) * 100) })));
        for (const p of cur.row.problems ?? []) {
          const id = estimates.get(p);
          // The estimate stands only where the browser did not measure.
          if (id !== undefined) { if (!(measured && boxed(id))) fixable.push(p); continue; }
          // A measure recorded earlier (a render, an earlier attempt) is replaced by this one when there is one.
          if (measuredTexts.has(p)) { if (!measured) fixable.push(p); continue; }
          if (!other.includes(p)) other.push(p);
        }
        if (measured) {
          for (const id of measured) {
            if (!Object.hasOwn(cur.overlay.texts, id) || cur.row.stale.includes(id) || !boxed(id)) continue;
            fixable.push(va.textOverflowMeasured({ clip: clipLabel(comp, id), fit: Math.round((cur.overlay.fit[id] ?? 1) * 100) }));
          }
        }
      }
      for (const vp of pair.voiceProblems.values()) (vp.fixable ? fixable : other).push(vp.text);
      out.set(pair.key, { fixable: [...new Set(fixable)], other: [...new Set(other.filter((x) => !fixable.includes(x)))] });
    }
    return out;
  }

  /**
   * The voices waiting in every pair, in ONE batch (one confirmation): generated by the core, measured with the probe, written
   * into the overlays. Unavailable, declined or failed: the languages keep their fallback (`original`), with the reason, and no
   * voice is asked again in this turn.
   */
  private async voicePhase(ref: CreativeRef, store: CreativeStore, creativeDir: string, n: number, pairs: Map<string, Pair>, presets: FormatPreset[], ui: Locale,
    signal: AbortSignal, jobId: string, services: VoiceBatchContext['services'], say: (level: 'info' | 'warning', text: string) => Promise<void>, own: OwnWrites): Promise<void> {
    const va = messages(ui).variants;
    const waiting = [...pairs.values()].filter((p) => p.voices && p.pending.size > 0);
    if (waiting.length === 0) return;
    const items: VoiceBatchItem[] = [];
    const rand = Math.random().toString(16).slice(2, 8);
    for (const p of waiting) {
      for (const [clipId, script] of p.pending) {
        items.push({ key: `${p.key}|${clipId}`, label: `${localeName(p.locale)} · ${p.group.label} · ${clipLabel(p.group.ic.composition, clipId)}`, text: script, name: `${ref.creativeSlug}-${p.locale}-${clipId}-${rand}` });
      }
    }
    const result = await this.deps.voices.batch({ jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: ref.creativeSlug, signal, ...(services ? { services } : {}) }, items);
    if (result.status !== 'done') {
      const reason: Fallback = result.status === 'unavailable' ? result.reason : result.status === 'declined' ? 'declined' : 'failed';
      for (const p of waiting) { p.voices = false; p.fallback = reason; p.pending.clear(); p.asked.voices = []; }
      await say('warning', t().jobs.voicesNotGenerated({ locales: [...new Set(waiting.map((p) => localeName(p.locale)))].join(', '), reason: va.voiceFallbackReason[reason] }));
      return;
    }
    for (const p of waiting) {
      const made: Array<{ clipId: string; src: string; script: string; sha256: string }> = [];
      const entries = new Map(localizableEntries(p.group.ic.composition).voices.map((x) => [x.clipId, x] as const));
      for (const [clipId, script] of [...p.pending]) {
        p.pending.delete(clipId);
        const r = result.files.get(`${p.key}|${clipId}`);
        const clip = clipLabel(p.group.ic.composition, clipId);
        // A script over the provider's limit is the agent's to shorten; any other failure is not.
        if (!r || 'error' in r) { p.voiceProblems.set(clipId, { text: va.voiceFailed({ clip, reason: r && 'error' in r ? r.error.slice(0, 200) : '?' }), fixable: Boolean(r && 'error' in r && r.tooLong), code: 'voiceFailed' }); continue; }
        const file = join(ref.projectDir, ...r.file.split('/'));
        const probed = this.deps.media.probeAudio ? await this.deps.media.probeAudio(file).catch(() => null) : await this.deps.media.probe(file).then((x) => (x ? { durationSec: x.durationSec } : null)).catch(() => null);
        const d = probed?.durationSec ?? null;
        const clipSec = entries.get(clipId)?.duration ?? 0;
        if (d === null) p.voiceProblems.set(clipId, { text: va.voiceDurationUnknown({ clip }), fixable: false, code: 'voiceDurationUnknown' });
        // Never cut: a long voice is kept and reported with both durations (Review Focus 4).
        else if (d > clipSec + 0.05) p.voiceProblems.set(clipId, { text: va.voiceTooLong({ clip, voice: Math.round(d * 10) / 10, clipSec: Math.round(clipSec * 10) / 10 }), fixable: true, code: 'voiceTooLong' });
        else p.voiceProblems.delete(clipId);
        made.push({ clipId, src: r.file, script, sha256: r.sha256 });
      }
      if (made.length === 0) continue;
      await own.note([...made.map((x) => x.src), LIBRARY_INDEX]);
      await this.deps.turns.runLocked(ref, async () => {
        const v = (await store.readVersions(ref.creativeSlug)).find((x) => x.n === n);
        const ic = v ? await instanceComposition(creativeDir, v, p.group.rep, presets) : null;
        if (!ic) return;
        const cur = await this.current(creativeDir, n, p.locale, p.group.rep);
        const base = cur?.overlay ?? emptyOverlay(p.locale, p.group.rep);
        const overlay: Localization = { ...base, voices: { ...base.voices } };
        for (const x of made) overlay.voices[x.clipId] = { src: x.src, script: x.script, sourceScript: p.group.scripts.get(x.clipId)! };
        const done = await finishOverlay({ overlay, base: ic, voice: 'translated', chooseFit: new Set(), uiLocale: ui, projectDir: ref.projectDir,
          voiceRoots: voiceRootsOf(ic, ref.projectDir), scripts: p.group.scripts });
        await this.writeRows(store, creativeDir, n, p, done.overlay, { origin: 'agent', stale: done.stale, issues: done.issues, fresh: Object.fromEntries(made.map((x) => [x.src, x.sha256])) });
      });
      this.deps.turns.changed(ref);
    }
  }

  /** Every pair's row as the turn leaves it: the voice choice (or its fallback), the voice clips without script, the problems. */
  private async finish(ref: CreativeRef, store: CreativeStore, creativeDir: string, n: number, pairs: Map<string, Pair>, presets: FormatPreset[], ui: Locale, signal: AbortSignal): Promise<void> {
    const va = messages(ui).variants;
    for (const pair of pairs.values()) {
      await this.deps.turns.runLocked(ref, async () => {
        const cur = await this.current(creativeDir, n, pair.locale, pair.group.rep);
        if (!cur) return;
        // A language this turn neither asked nor touched keeps its row, unless the request named its voice choice.
        const asked = pair.asked.texts.length + pair.asked.params.length + pair.asked.voices.length > 0;
        if (!asked && !pair.submitted && !pair.explicit) return;
        const v = (await store.readVersions(ref.creativeSlug)).find((x) => x.n === n);
        const ic = v ? await instanceComposition(creativeDir, v, pair.group.rep, presets) : null;
        if (!ic) return;
        const hasVoices = Object.keys(cur.overlay.voices).some((id) => !cur.row.stale.includes(id));
        // `translate`: the translated voices when there are some, else the fallback (`original`); a composition without voice
        // clips keeps the row's choice.
        const voice: LocalizationRow['voice'] = pair.choice !== 'translate' ? pair.choice
          : hasVoices && !pair.fallback ? 'translated' : pair.fallback || cur.row.voice === 'translated' ? 'original' : cur.row.voice;
        const done = await finishOverlay({ overlay: cur.overlay, base: ic, voice, chooseFit: new Set(), uiLocale: ui, projectDir: ref.projectDir,
          voiceRoots: voiceRootsOf(ic, ref.projectDir), scripts: pair.group.scripts });
        // The estimate's overflow stands only where the browser did not measure (see `assess`); the measured one is added.
        const comp = ic.composition;
        const boxed = (id: string) => { const c = comp.tracks.flatMap((tr) => tr.clips).find((x) => x.id === id); return c?.type === 'text' && (c.props.width !== undefined || c.props.height !== undefined); };
        const measured = pair.measured;
        const issues: LocalizationIssue[] = done.issues.filter((i) => !(measured && i.code === 'textOverflow' && i.clipId !== undefined && boxed(i.clipId)));
        if (measured) {
          for (const id of measured.ids) if (Object.hasOwn(done.overlay.texts, id) && !done.stale.includes(id) && boxed(id)) issues.push({ code: 'textOverflowMeasured', clipId: id, message: va.textOverflowMeasured({ clip: clipLabel(comp, id), fit: Math.round((done.overlay.fit[id] ?? 1) * 100) }) });
        }
        for (const id of this.missing(pair, done.overlay, done.stale)) issues.push({ code: 'notTranslated', clipId: id, message: va.notTranslated({ clip: clipLabel(comp, id) }) });
        for (const [id, vp] of pair.voiceProblems) issues.push({ code: vp.code, clipId: id, message: vp.text });
        await this.writeRows(store, creativeDir, n, pair, done.overlay, { origin: pair.submitted ? 'agent' : cur.row.origin, stale: done.stale, issues, voice, final: true });
      });
      if (signal.aborted) return;
    }
  }
}
