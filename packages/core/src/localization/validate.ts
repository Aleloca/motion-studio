import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  applyLocalization, compositionProblemText, INSTANCE_ID_RE, isRtlLocale, isSupportedLocale, localizableEntries, LocalizationMismatch, localizationSchema,
  messages, type Composition, type FormatPreset, type Locale, type LocaleTag, type Localization, type VersionEntry,
} from '@motion-studio/shared';
import type { CompositionFolder } from '../compositions/composition-files.ts';
import { checkCompositionObject } from '../creatives/composition-contract.ts';
import { CodedError } from '../workspace-store.ts';

/**
 * Localization overlays (Phase 12, spec §3): the checks of the path segments, of an overlay against its composition, and of
 * the localized composition (the composition checks, plus the text-box estimate of Review Focus 1).
 */

/** Longest raw path segment looked at (a locale tag or an instance id); anything longer is refused before any lookup. */
const SEGMENT_MAX = 200;

/**
 * A `:locale` path segment, checked before it reaches any path: one of the curated tags, else 400 with the translated reason
 * (`locale-rtl` for a right-to-left language, `locale-unsupported` for anything else).
 */
export function checkedLocale(raw: unknown, locale: Locale): LocaleTag {
  const v = messages(locale).variants;
  const tag = typeof raw === 'string' ? raw.slice(0, SEGMENT_MAX) : '';
  if (isSupportedLocale(tag)) return tag;
  const shown = tag.replace(/[^A-Za-z0-9-]/g, '?').slice(0, 20);
  if (tag !== '' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag) && isRtlLocale(tag)) throw new CodedError(400, v.localeRtl({ tag: shown }), 'locale-rtl');
  throw new CodedError(400, v.localeUnsupported({ tag: shown }), 'locale-unsupported');
}

/**
 * An `:instanceId` path segment, checked before it reaches any path: an instance id (`INSTANCE_ID_RE`) that version `v` has
 * a composition for, else 404 `instance-unknown`.
 */
export function checkedInstance(raw: unknown, v: VersionEntry, locale: Locale): string {
  const id = typeof raw === 'string' && raw.length <= SEGMENT_MAX ? raw : '';
  if (!INSTANCE_ID_RE.test(id) || !v.compositions?.some((c) => c.format === id)) {
    throw new CodedError(404, messages(locale).variants.instanceUnknown({ format: id.slice(0, 100).replace(/[^\w@-]/g, '?'), n: v.n }), 'instance-unknown');
  }
  return id;
}

/**
 * Where a voice file of an overlay may live: a regular file (never a link, checked with lstat at every level) under
 * `assets/` of one of `roots` (the version's composition folder, or a staging folder of the core), with no `..`.
 */
export async function voiceFileOk(roots: readonly string[], src: string): Promise<boolean> {
  if (!src.startsWith('assets/') || src.split('/').some((s) => s === '..' || s === '.' || s === '') || src.includes('\\')) return false;
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => null);
    if (!realRoot) continue;
    let ok = true;
    let cur = root;
    const segs = src.split('/');
    for (const [i, s] of segs.entries()) {
      cur = join(cur, s);
      const st = await lstat(cur).catch(() => null);
      if (!st || st.isSymbolicLink() || (i < segs.length - 1 ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) { ok = false; break; }
    }
    if (!ok) continue;
    const real = await realpath(cur).catch(() => null);
    if (real && real === join(realRoot, ...segs) && real.startsWith(realRoot + sep)) return true;
  }
  return false;
}

/** An overlay checked against its composition: the parsed overlay, or the problems (translated) that refuse it. */
export type OverlayCheck = { ok: true; overlay: Localization } | { ok: false; problems: string[] };

/**
 * Checks a raw overlay (strict schema: only texts, params, voices, fit and fonts), that it names `locale` and `instanceId`,
 * that every id is a translatable entry of the composition (`applyLocalization` throws otherwise) and that every voice file
 * is a file of `voiceRoots` (`voiceFileOk`). Nothing else of the composition can be reached by an overlay.
 */
export async function checkOverlay(raw: unknown, o: { composition: Composition; locale: LocaleTag; instanceId: string; voiceRoots: readonly string[]; uiLocale: Locale }): Promise<OverlayCheck> {
  const v = messages(o.uiLocale).variants;
  const parsed = localizationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, problems: [v.localizationInvalid({ detail: `${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim().slice(0, 300) })] };
  }
  const overlay = parsed.data;
  if (overlay.locale !== o.locale || overlay.instanceId !== o.instanceId) return { ok: false, problems: [v.localizationInvalid({ detail: 'locale/instanceId' })] };
  try {
    applyLocalization(o.composition, overlay);
  } catch (e) {
    if (e instanceof LocalizationMismatch) {
      return { ok: false, problems: [e.reason === 'tooManyFonts' || e.reason === 'tooManyFallbacks' ? v.tooManyFonts : v.localizationMismatch({ entry: e.entry.slice(0, 100) })] };
    }
    throw e;
  }
  const bad: string[] = [];
  for (const [id, voice] of Object.entries(overlay.voices)) if (!(await voiceFileOk(o.voiceRoots, voice.src))) bad.push(v.voiceFileInvalid({ clip: id }));
  return bad.length ? { ok: false, problems: bad } : { ok: true, overlay };
}

/**
 * The ids of `overlay` whose source changed in `composition` (spec §3.3): a text or param whose current text is not the
 * overlay's `source`, a voice whose clip's script is not its `sourceScript`; `fit` follows its text. Entries whose clip is
 * gone are not listed here (`withoutGone` drops them).
 */
export function staleIds(overlay: Localization, composition: Composition, scripts?: ReadonlyMap<string, string>): string[] {
  const e = localizableEntries(composition);
  const texts = new Map(e.texts.map((t) => [t.clipId, t.text] as const));
  const params = new Map(e.params.map((p) => [p.key, p.text] as const));
  // A voice clip's script, or (Phase 12, Task 4) the known script the caller found for it (the tts asset's description).
  const voices = new Map(e.voices.map((x) => [x.clipId, x.script ?? scripts?.get(x.clipId) ?? null] as const));
  const out: string[] = [];
  for (const [id, t] of Object.entries(overlay.texts)) if (texts.has(id) && texts.get(id) !== t.source) out.push(id);
  for (const [key, t] of Object.entries(overlay.params)) if (params.has(key) && params.get(key) !== t.source) out.push(key);
  for (const [id, x] of Object.entries(overlay.voices)) if (voices.has(id) && voices.get(id) !== x.sourceScript && !out.includes(id)) out.push(id);
  return out;
}

/** `overlay` without the entries whose clip (or param) is no longer a translatable entry of the right kind in `composition`. */
export function withoutGone(overlay: Localization, composition: Composition): Localization {
  const e = localizableEntries(composition);
  const texts = new Set(e.texts.map((t) => t.clipId));
  const params = new Set(e.params.map((p) => p.key));
  const voices = new Set(e.voices.map((x) => x.clipId));
  const keep = <T>(r: Record<string, T>, has: (k: string) => boolean) => Object.fromEntries(Object.entries(r).filter(([k]) => has(k)));
  return {
    ...overlay,
    texts: keep(overlay.texts, (k) => texts.has(k)), params: keep(overlay.params, (k) => params.has(k)),
    voices: keep(overlay.voices, (k) => voices.has(k)), fit: keep(overlay.fit, (k) => texts.has(k) && Object.hasOwn(overlay.texts, k)),
  };
}

// ---------- the text-box estimate (Review Focus 1) ----------

/** Wide characters (CJK ideographs, kana, hangul, full-width forms): about one em each, and a line may break between any two. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const charEm = (c: string) => (WIDE.test(c) ? 1 : c === ' ' ? 0.28 : /[il.,:;'!|]/.test(c) ? 0.3 : /[MWmw@]/.test(c) ? 0.85 : 0.56);
const wordEm = (w: string) => [...w].reduce((n, c) => n + charEm(c), 0);

/**
 * The lines a text takes in a box `width` px wide at `size` px (greedy wrapping on spaces and explicit line breaks; wide
 * characters break anywhere), and whether a single word is wider than the box. An estimate (no font metrics in the core): it
 * is only ever compared with the same estimate of the source text.
 */
export function estimateLines(text: string, size: number, width: number): { lines: number; widest: number } {
  const room = width / size; // in em
  let lines = 0;
  let widest = 0;
  for (const para of text.split('\n')) {
    let line = 0;
    lines++;
    const tokens = para.split(/(\s+)/).flatMap((t) => (WIDE.test(t) ? [...t] : [t])).filter((t) => t !== '');
    for (const tok of tokens) {
      const w = /^\s+$/.test(tok) ? charEm(' ') : wordEm(tok);
      widest = Math.max(widest, /^\s+$/.test(tok) ? 0 : w);
      if (line > 0 && line + w > room + 1e-9 && !/^\s+$/.test(tok)) { lines++; line = w; } else line += w;
    }
  }
  return { lines, widest: widest * size };
}

/** Whether `text` at `size` needs more room than the box (or than the source text needed, whichever is larger). */
function overflows(text: string, size: number, source: { text: string; size: number }, box: { w: number; h: number }): boolean {
  const lineH = 1.2;
  const t = estimateLines(text, size, box.w);
  const s = estimateLines(source.text, source.size, box.w);
  const height = t.lines * size * lineH;
  const roomH = Math.max(box.h, s.lines * source.size * lineH);
  const roomW = Math.max(box.w, s.widest);
  return height > roomH + 0.5 || t.widest > roomW + 0.5;
}

/** The fit factors tried when the core chooses one (1 down to 0.7). */
export const FITS = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7];

/**
 * Whether the browser measures the text clip `id` of `c` (the runtime's render-mode measure, Ruling I): every text clip, in
 * the box it sets, and a dimension it leaves free within the frame or the format's safe zone (final wave P6).
 */
export function measuredByBrowser(c: Composition, id: string): boolean {
  for (const t of c.tracks) for (const clip of t.clips) if (clip.id === id) return clip.type === 'text';
  return false;
}

/**
 * For each translated text clip of `overlay` (not stale): whether it fits its box at its `fit`. `chooseFit`: clips whose
 * fit was not chosen get the largest fit from 1 down to 0.7 that fits (the core's choice), else 0.7. Returns the overlay with
 * those fits and the clips that still overflow (Review Focus 1: never cut, never silent).
 */
export function fitTexts(base: Composition, overlay: Localization, stale: readonly string[], chooseFit: ReadonlySet<string>): { overlay: Localization; overflowing: string[] } {
  const entries = new Map(localizableEntries(base).texts.map((t) => [t.clipId, t] as const));
  const fit = { ...overlay.fit };
  const overflowing: string[] = [];
  for (const [id, t] of Object.entries(overlay.texts)) {
    const e = entries.get(id);
    if (!e || stale.includes(id)) continue;
    const src = { text: e.text, size: e.size };
    if (chooseFit.has(id)) {
      const best = FITS.find((f) => !overflows(t.text, e.size * f, src, e.box));
      if (best === undefined) { fit[id] = 0.7; overflowing.push(id); } else if (best === 1) delete fit[id]; else fit[id] = best;
      continue;
    }
    if (overflows(t.text, e.size * (fit[id] ?? 1), src, e.box)) overflowing.push(id);
  }
  return { overlay: { ...overlay, fit }, overflowing };
}

/** A clip's name for messages: its `name`, else its id. */
export function clipLabel(c: Composition, id: string): string {
  for (const t of c.tracks) for (const clip of t.clips) if (clip.id === id) return (clip.name ?? id).slice(0, 100);
  return id.slice(0, 100);
}

/**
 * The composition checks of a localized composition (Ruling K: the same checks a turn runs, `checkCompositionObject`): the
 * problems and the advisory warnings (html layer static checks), as translated texts. The folder is the instance's composition
 * folder; `files` adds the overlay's font and voice files.
 */
export async function checkLocalizedComposition(localized: Composition, o: { preset: FormatPreset; compDir: string; folder: CompositionFolder;
  files: ReadonlyMap<string, { size: number }>; uiLocale: Locale }): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkCompositionObject(localized, { preset: o.preset, compDir: o.compDir, folder: o.folder, files: o.files });
  return { problems: r.problems.map((p) => compositionProblemText(p, o.uiLocale)), warnings: r.warnings.map((p) => compositionProblemText(p, o.uiLocale)) };
}

/**
 * The languages a request asks for must still be the creative's own (`brief.locales`): the primary or one of the extras, else
 * 400 `locale-not-in-brief` with the translated reason. One rule for the render, the export, the export preparation and the
 * store pack (a language removed from the brief keeps its stored translations, but nothing new is made from them).
 */
export function assertLocalesInBrief(brief: { locales?: { primary: string; extra: readonly string[] } }, tags: readonly string[], locale: Locale): void {
  const l = brief.locales;
  for (const tag of tags) {
    if (!l || (tag !== l.primary && !l.extra.includes(tag))) throw new CodedError(400, messages(locale).variants.localeNotInBrief({ tag }), 'locale-not-in-brief');
  }
}
