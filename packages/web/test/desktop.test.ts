import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktop } from '../src/desktop.ts';
import { useRenderCloseGuard } from '../src/shell/useAttention.ts';

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

describe('render close guard (Task 8, carry 11)', () => {
  it('tells the desktop app how many renders are queued or running, and 0 when the page goes', () => {
    const setRendersRunning = vi.fn(async () => {});
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {}, setRendersRunning };
    const job = (id: string, kind: string, state: string) => ({ id, key: id, kind, label: id, state, createdAt: '2026-10-08T10:00:00.000Z' });
    const jobs = (list: ReturnType<typeof job>[]) => Object.fromEntries(list.map((j) => [j.id, j])) as never;
    const h = renderHook(({ j }) => useRenderCloseGuard(j), { initialProps: { j: jobs([job('a', 'render', 'running'), job('b', 'render', 'queued'), job('c', 'creative', 'running'), job('d', 'render', 'succeeded')]) } });
    expect(setRendersRunning).toHaveBeenLastCalledWith(2);
    h.rerender({ j: jobs([job('a', 'render', 'succeeded')]) });
    expect(setRendersRunning).toHaveBeenLastCalledWith(0);
    h.rerender({ j: jobs([job('a', 'render', 'running')]) });
    expect(setRendersRunning).toHaveBeenLastCalledWith(1);
    h.unmount();
    expect(setRendersRunning).toHaveBeenLastCalledWith(0);
  });
});
