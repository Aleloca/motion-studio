import { ADD_FONT_MAX_WEIGHTS, type StagedAsset } from '@motion-studio/shared';

const STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/**
 * The weights to declare for a brand font file just staged (decisions log 261), from what the core's font probe read:
 * - a variable font (`fontWeights.min < max`): the brand kit's weights inside the range, else 100–900 in steps of 100 inside
 *   it (else the range's weight nearest 400, for a narrow range between two steps);
 * - a static font (`min === max`): its own weight (`OS/2`);
 * - unread: the kit's weight when it lists exactly one, else 400 (the rule before the probe).
 */
export function weightsToDeclare(staged: Pick<StagedAsset, 'fontWeights'>, kitWeights: readonly number[]): number[] {
  const r = staged.fontWeights;
  if (!r) return [kitWeights.length === 1 ? kitWeights[0]! : 400];
  if (r.min >= r.max) return [r.min];
  const inside = (w: number) => Number.isInteger(w) && w >= r.min && w <= r.max;
  const kit = [...new Set(kitWeights.filter(inside))].sort((a, b) => a - b);
  if (kit.length > 0) return kit.slice(0, ADD_FONT_MAX_WEIGHTS);
  const steps = STEPS.filter(inside);
  return steps.length > 0 ? steps : [Math.min(r.max, Math.max(r.min, 400))];
}
