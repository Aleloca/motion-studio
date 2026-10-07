import { describe, expect, it } from 'vitest';
import { fitFrame } from '../src/frameSize.ts';

describe('fitFrame', () => {
  it('fits portrait, landscape and extreme banners', () => {
    expect(fitFrame(1080, 1920, 260, 170)).toEqual({ width: 96, height: 170 });
    expect(fitFrame(1920, 1080, 260, 170)).toEqual({ width: 260, height: 146 });
    expect(fitFrame(728, 90, 260, 170)).toEqual({ width: 260, height: 32 });
    expect(fitFrame(160, 600, 260, 170)).toEqual({ width: 45, height: 170 });
  });
  it('never goes below 8px', () => {
    expect(fitFrame(10000, 10, 100, 100)).toEqual({ width: 100, height: 8 });
  });
});
