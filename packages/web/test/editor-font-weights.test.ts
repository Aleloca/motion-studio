import { describe, expect, it } from 'vitest';
import { weightsToDeclare } from '../src/screens/editor/inspector/fontWeights.ts';

describe('weightsToDeclare (decisions log 261)', () => {
  it('a variable font: the kit weights inside the range', () => {
    expect(weightsToDeclare({ fontWeights: { min: 100, max: 700 } }, [800, 700, 400, 400])).toEqual([400, 700]);
  });
  it('a variable font: 100–900 in steps of 100 inside the range when no kit weight is', () => {
    expect(weightsToDeclare({ fontWeights: { min: 250, max: 650 } }, [900])).toEqual([300, 400, 500, 600]);
    expect(weightsToDeclare({ fontWeights: { min: 1, max: 1000 } }, [])).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });
  it('a narrow range between two steps: the weight nearest 400 inside it', () => {
    expect(weightsToDeclare({ fontWeights: { min: 420, max: 480 } }, [])).toEqual([420]);
    expect(weightsToDeclare({ fontWeights: { min: 310, max: 390 } }, [])).toEqual([390]);
  });
  it('a static font: its own weight, whatever the kit says', () => {
    expect(weightsToDeclare({ fontWeights: { min: 700, max: 700 } }, [400])).toEqual([700]);
  });
  it('unread: the kit weight when it lists one, else 400', () => {
    expect(weightsToDeclare({}, [600])).toEqual([600]);
    expect(weightsToDeclare({}, [400, 700])).toEqual([400]);
  });
});
