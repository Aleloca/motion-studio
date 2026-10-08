import { afterEach, describe, expect, it } from 'vitest';
import { desktop } from '../src/desktop.ts';

afterEach(() => { delete (window as unknown as { motionStudio?: unknown }).motionStudio; });

describe('desktop()', () => {
  it('is null in the browser and returns the bridge in the app', () => {
    expect(desktop()).toBeNull();
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => '/x', revealPath: async () => {} };
    expect(desktop()?.platform).toBe('darwin');
  });
  it('ignores a malformed bridge', () => {
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true };
    expect(desktop()).toBeNull();
  });
});
