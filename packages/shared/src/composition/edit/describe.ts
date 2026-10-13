import { messages, type Locale } from '../../i18n/index.ts';
import { compositionProblemText, type CompositionProblem } from '../problems.ts';
import type { Composition } from '../schema.ts';
import type { EditOp } from './ops.ts';

/** Most items a summary lists before "and N more". */
export const DESCRIBE_MAX_ITEMS = 3;

const TEXT_KEYS = new Set(['text']);
const STYLE_KEYS = new Set(['fontFamily', 'fontSize', 'fontWeight', 'color', 'align', 'fill', 'radius']);
const LAYOUT_KEYS = new Set(['x', 'y', 'width', 'height', 'rotation', 'scale', 'opacity']);

/**
 * The request line of a direct-edit version: "Direct edits: title text, scene 2 duration, intro animation and 2 more". Items are
 * in the order of the ops, without repeats; at most `DESCRIBE_MAX_ITEMS` are named. `c` is the composition the ops start from
 * (it supplies the names).
 */
export function describeEdits(ops: EditOp[], c: Composition, locale: Locale): string {
  const t = messages(locale).editor;
  const clipName = (id: string) => {
    for (const track of c.tracks) for (const k of track.clips) if (k.id === id) return k.name ?? k.id;
    return id;
  };
  const items: string[] = [];
  const add = (s: string) => { if (!items.includes(s)) items.push(s); };
  for (const op of ops) {
    switch (op.kind) {
      case 'clipProps': {
        const name = clipName(op.clipId);
        const keys = Object.keys(op.props);
        if (keys.some((k) => TEXT_KEYS.has(k))) add(t.itemText({ name }));
        if (keys.some((k) => STYLE_KEYS.has(k))) add(t.itemStyle({ name }));
        if (keys.some((k) => LAYOUT_KEYS.has(k))) add(t.itemLayout({ name }));
        break;
      }
      case 'clipTiming': add(t.itemTiming({ name: clipName(op.clipId) })); break;
      case 'clipMedia': add(t.itemMedia({ name: clipName(op.clipId) })); break;
      case 'clipFlags': add(t.itemFlags({ name: clipName(op.clipId) })); break;
      case 'trackFlags': add(t.itemFlags({ name: c.tracks.find((x) => x.id === op.trackId)?.name ?? op.trackId })); break;
      case 'sceneDuration': {
        const index = c.scenes.findIndex((s) => s.id === op.sceneId);
        add(t.itemSceneDuration({ n: index < 0 ? op.sceneId : index + 1 }));
        break;
      }
      case 'sceneOrder': add(t.itemSceneOrder); break;
      case 'animationPreset': add(t.itemAnimation({ name: clipName(op.clipId) })); break;
      case 'htmlParam': add(t.itemParam({ name: clipName(op.clipId), key: op.key })); break;
      case 'addFont': add(t.itemFont({ family: op.font.family })); break;
    }
  }
  return t.summary({ items: items.slice(0, DESCRIBE_MAX_ITEMS).join(', '), more: Math.max(0, items.length - DESCRIBE_MAX_ITEMS) });
}

/** Text of a refusal from `applyEdit`, whether its key is `editor.*` or `composition.*`. */
export function editProblemText(problem: CompositionProblem, locale: Locale): string {
  if (!problem.key.startsWith('editor.')) return compositionProblemText(problem, locale);
  const table = messages(locale).editor as unknown as Record<string, string | ((p: never) => string)>;
  const name = problem.key.slice('editor.'.length);
  if (!Object.hasOwn(table, name)) return problem.key;
  const entry = table[name]!;
  return typeof entry === 'string' ? entry : entry(problem.params as never);
}
