import type { Clip, Composition } from '../composition/schema.ts';
import type { Localization } from './schema.ts';

/** The overlay names a clip, param or voice that the composition does not have, or one of another kind. */
export class LocalizationMismatch extends Error {
  constructor(readonly entry: string, readonly reason: 'unknown' | 'wrongKind') {
    super(`localization entry "${entry}": ${reason === 'unknown' ? 'not found in the composition' : 'wrong kind of clip'}`);
    this.name = 'LocalizationMismatch';
  }
}

/** The size a text clip is drawn with when `props.fontSize` is absent (the runtime's default). */
export const DEFAULT_TEXT_SIZE = 48;

type TextClip = Extract<Clip, { type: 'text' }>;
type HtmlClip = Extract<Clip, { type: 'html' }>;
type AudioClip = Extract<Clip, { type: 'audio' }>;

function* clipsOf(c: Composition): Generator<Clip> {
  for (const t of c.tracks) yield* t.clips;
}
function find(c: Composition, id: string): Clip | undefined {
  for (const clip of clipsOf(c)) if (clip.id === id) return clip;
  return undefined;
}
const isVoice = (clip: Clip): clip is AudioClip => clip.type === 'audio' && clip.role === 'voice';

/**
 * Applies a localization overlay to a composition and returns a new one; the input is never changed (pure).
 *
 * Fields it may write, and only these (spec §3.1):
 * - `texts[clipId]` → `props.text` of that text clip;
 * - `params['<clipId>.<key>']` → `params[key].value` of that html clip, a param of type `text` only;
 * - `voices[clipId]` → `src` and `script` of that audio clip, `role: 'voice'` only;
 * - `fit[clipId]` → `props.fontSize` of that text clip, multiplied (the composition has no `props.size`: the text size is
 *   `props.fontSize`, `DEFAULT_TEXT_SIZE` when unset); 1 leaves it as it is;
 * - `fonts` → appended to `fonts[]` (one entry per file, no duplicate of family and file). A text clip's `fontFamily` stays
 *   a single declared family (the schema allows no fallback chain: a family with commas is refused), so the fallback is
 *   done by the runtime per character using the extra declared families; nothing else is written on the clips.
 * `opts.stale`: ids (clip ids, `<clipId>.<key>` for params) whose source changed since the translation; they keep the source
 * text, voice and size, and are not checked against the composition. `opts.voiceMode`: `translated` (default) applies the
 * voices; `original` ignores them; `muted` ignores them and sets `volume` 0 on every voice clip.
 * Throws `LocalizationMismatch` for an id that is not in the composition or is of the wrong kind.
 */
export function applyLocalization(
  c: Composition, l: Localization, opts: { stale?: readonly string[]; voiceMode?: 'translated' | 'original' | 'muted' } = {},
): Composition {
  const stale = new Set(opts.stale ?? []);
  const mode = opts.voiceMode ?? 'translated';
  const out = structuredClone(c);

  const textClip = (id: string): TextClip => {
    const clip = find(out, id);
    if (!clip) throw new LocalizationMismatch(id, 'unknown');
    if (clip.type !== 'text') throw new LocalizationMismatch(id, 'wrongKind');
    return clip;
  };

  for (const [id, t] of Object.entries(l.texts)) {
    if (stale.has(id)) continue;
    textClip(id).props.text = t.text;
  }

  for (const [key, t] of Object.entries(l.params)) {
    if (stale.has(key)) continue;
    const dot = key.indexOf('.');
    const id = key.slice(0, dot);
    const name = key.slice(dot + 1);
    const clip = find(out, id);
    if (!clip) throw new LocalizationMismatch(key, 'unknown');
    if (clip.type !== 'html') throw new LocalizationMismatch(key, 'wrongKind');
    const param = Object.hasOwn((clip as HtmlClip).params ?? {}, name) ? (clip as HtmlClip).params![name] : undefined;
    if (!param) throw new LocalizationMismatch(key, 'unknown');
    if (param.type !== 'text') throw new LocalizationMismatch(key, 'wrongKind');
    param.value = t.text;
  }

  for (const [id, v] of Object.entries(l.voices)) {
    if (stale.has(id)) continue;
    const clip = find(out, id);
    if (!clip) throw new LocalizationMismatch(id, 'unknown');
    if (!isVoice(clip)) throw new LocalizationMismatch(id, 'wrongKind');
    if (mode === 'translated') { clip.src = v.src; clip.script = v.script; }
  }
  if (mode === 'muted') for (const clip of clipsOf(out)) if (isVoice(clip)) clip.volume = 0;

  for (const [id, f] of Object.entries(l.fit)) {
    if (stale.has(id)) continue;
    const clip = textClip(id);
    if (f !== 1) clip.props.fontSize = (clip.props.fontSize ?? DEFAULT_TEXT_SIZE) * f;
  }

  for (const font of l.fonts) {
    for (const file of font.files) {
      if (!out.fonts.some((x) => x.family === font.family && x.src === file)) out.fonts.push({ family: font.family, src: file });
    }
  }
  return out;
}

export interface LocalizableText { clipId: string; name?: string; scene?: string; text: string; box: { w: number; h: number }; size: number }
export interface LocalizableParam { key: string; label?: string; text: string }
export interface LocalizableVoice { clipId: string; script: string | null; duration: number }

/**
 * What a composition offers to translate, in timeline order: text clips (with the box they must fit: `props.width`, else the
 * composition width; `props.height`, else 1.2 lines of the size), `text` params of html layers (key `<clipId>.<key>`), and
 * voice clips (`script` is null when unknown: such a clip cannot be translated).
 */
export function localizableEntries(c: Composition): { texts: LocalizableText[]; params: LocalizableParam[]; voices: LocalizableVoice[] } {
  const texts: LocalizableText[] = [];
  const params: LocalizableParam[] = [];
  const voices: LocalizableVoice[] = [];
  for (const clip of clipsOf(c)) {
    if (clip.type === 'text') {
      const size = clip.props.fontSize ?? DEFAULT_TEXT_SIZE;
      texts.push({
        clipId: clip.id, ...(clip.name !== undefined ? { name: clip.name } : {}), ...(clip.scene !== undefined ? { scene: clip.scene } : {}),
        text: clip.props.text, box: { w: clip.props.width ?? c.width, h: clip.props.height ?? Math.round(size * 1.2) }, size,
      });
    } else if (clip.type === 'html') {
      for (const [k, p] of Object.entries(clip.params ?? {})) {
        if (p.type === 'text') params.push({ key: `${clip.id}.${k}`, ...(p.label !== undefined ? { label: p.label } : {}), text: p.value });
      }
    } else if (isVoice(clip)) {
      voices.push({ clipId: clip.id, script: clip.script ?? null, duration: clip.duration });
    }
  }
  return { texts, params, voices };
}
