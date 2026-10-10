import { describe, expect, it } from 'vitest';
import { legacyProblemsOf, mentionsName } from '../src/creatives/legacy-problems.ts';

describe('mentionsName', () => {
  it.each([
    ['reel.mp4: duration 99.0s', 'reel.mp4', true],
    ['the file reel.mp4.', 'reel.mp4', true],
    ['"reel.mp4" is too large', 'reel.mp4', true],
    ['reel-x.mp4: duration 99.0s', 'reel.mp4', false],
    ['x-reel.mp4: duration 99.0s', 'reel.mp4', false],
    ['reel.mp4.bak is not a video', 'reel.mp4', false],
    ['reel-x: missing', 'reel', false],
    ['the reel.', 'reel', true],
    ['reel_2 failed', 'reel', false],
    ['', 'reel', false],
    ['reel', '', false],
  ] as const)('%s / %s', (text, name, expected) => {
    expect(mentionsName(text, name)).toBe(expected);
  });
  it('stays fast on long repetitive text', () => {
    const text = 'a'.repeat(200_000);
    const t0 = performance.now();
    expect(mentionsName(text, 'a'.repeat(50) + 'b')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('legacyProblemsOf with overlapping ids', () => {
  const problems = [
    'story-9x16.mp4: duration 99.0s, about 10s requested',
    'story-9x16-long.mp4: duration 99.0s, about 10s requested',
    'story-9x16-long: extension .mp4 not allowed (story-9x16-long.mp4)',
    'Story B 9:16: missing file',
  ];
  it('takes only the problems naming the format as whole tokens', () => {
    expect(legacyProblemsOf(problems, 'story-9x16', 'story-9x16.mp4', 'Story A 9:16')).toEqual([problems[0]]);
    expect(legacyProblemsOf(problems, 'story-9x16-long', 'story-9x16-long.mp4', 'Story B 9:16')).toEqual(problems.slice(1));
  });
  it('keeps the bare id when the file name does not cover it', () => {
    expect(legacyProblemsOf(['custom: bad size', 'custom-2: bad size'], 'custom', 'render.mp4', 'Custom')).toEqual(['custom: bad size']);
  });
});
