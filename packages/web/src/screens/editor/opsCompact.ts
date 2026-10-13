// Compacts the edit log before a save (Phase 10b): the composition is authoritative and the ops only feed the summary, so
// repeated edits of the same object and field collapse into one op, the last value winning. The order is that of the first
// edit of each object, which keeps the summary's order of items. The count of edits never limits a save.
import type { EditOp } from '@motion-studio/shared';

export function compactOps(ops: EditOp[]): EditOp[] {
  const slots = new Map<string, number>();
  const out: EditOp[] = [];
  for (const op of ops) {
    let key: string;
    switch (op.kind) {
      case 'clipProps': case 'clipMedia': case 'clipFlags': key = `${op.kind}:${op.clipId}`; break;
      case 'trackFlags': key = `trackFlags:${op.trackId}`; break;
      case 'clipTiming': key = `clipTiming:${op.clipId}`; break;
      case 'sceneDuration': key = `sceneDuration:${op.sceneId}`; break;
      case 'sceneOrder': key = 'sceneOrder'; break;
      case 'animationPreset': key = `animationPreset:${op.clipId}:${op.slot}`; break;
      case 'htmlParam': key = `htmlParam:${op.clipId}:${op.key}`; break;
      case 'addFont': key = `addFont:${op.font.family}`; break;
    }
    const at = slots.get(key);
    if (at === undefined) { slots.set(key, out.length); out.push(op); continue; }
    const prev = out[at]!;
    // Objects whose ops carry independent fields merge field by field; the others are replaced whole.
    if (prev.kind === 'clipProps' && op.kind === 'clipProps') out[at] = { ...prev, props: { ...prev.props, ...op.props } };
    else if (prev.kind === 'clipMedia' && op.kind === 'clipMedia') out[at] = { ...prev, ...op };
    else if (prev.kind === 'clipFlags' && op.kind === 'clipFlags') out[at] = { ...prev, ...op };
    else if (prev.kind === 'trackFlags' && op.kind === 'trackFlags') out[at] = { ...prev, ...op };
    else out[at] = op;
  }
  return out;
}
