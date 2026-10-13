// Which problems belong under which field of the inspector. `validateComposition` reports a problem either with the path of
// the value (`params.path`, e.g. `tracks[1].clips[0].props.x`) or with the clip (`params.clip`); a refusal of `applyEdit`
// is shown by the field that caused it (Inspector.tsx). A field is named by its last path segment (`x`, `src`, `fontFamily`).
import { compositionProblemText, type Composition, type CompositionProblem, type Locale } from '@motion-studio/shared';

/** Problems keyed by clip (no path) and the fields they are about. */
const CLIP_FIELDS: Record<string, string[]> = {
  'composition.unknownFont': ['fontFamily'],
  'composition.fontMissing': ['fontFamily'],
  'composition.clipOutside': ['start', 'duration'],
  'composition.clipOutsideScene': ['start', 'duration'],
  'composition.clipZero': ['duration'],
  'composition.clipStill': ['start'],
  'composition.mediaNotAsset': ['src'],
};

/** `tracks[t].clips[k]` of a clip, as validation paths spell it. */
export function clipPathOf(c: Composition, clipId: string): string | null {
  for (let t = 0; t < c.tracks.length; t++) {
    const k = c.tracks[t]!.clips.findIndex((x) => x.id === clipId);
    if (k >= 0) return `tracks[${t}].clips[${k}]`;
  }
  return null;
}

/** The texts of the problems about `fields` of the clip. */
export function fieldProblems(problems: readonly CompositionProblem[], c: Composition, clipId: string, fields: readonly string[], locale: Locale): string[] {
  const base = clipPathOf(c, clipId);
  const out: string[] = [];
  for (const p of problems) {
    const path = typeof p.params.path === 'string' ? p.params.path : null;
    let hit = false;
    if (path !== null && base !== null && path.startsWith(base) && (path[base.length] === '.' || path[base.length] === '[')) {
      const rest = path.slice(base.length + 1);
      // `props.x`, `src`, `params.title.value`, `animations[0].duration`: the field is the segment after props / params.
      const segs = rest.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
      const name = segs[0] === 'props' || segs[0] === 'params' ? segs[1] : segs[0];
      hit = name !== undefined && fields.includes(name);
    } else if (p.params.clip === clipId) {
      hit = (CLIP_FIELDS[p.key] ?? []).some((f) => fields.includes(f));
    }
    if (hit) {
      const text = compositionProblemText(p, locale);
      if (!out.includes(text)) out.push(text);
    }
  }
  return out;
}
