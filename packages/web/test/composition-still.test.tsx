// Reports 45/47: the stills of never-rendered versions are asked lazily, a few at a time, once per page, and degrade to none.
import type { StoryboardView } from '@motion-studio/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class ApiError extends Error { constructor(public readonly status: number) { super(`HTTP ${status}`); } }
const api = { getStoryboard: vi.fn() };
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { __resetStills, fetchStill, MAX_STILLS_AT_ONCE, useCompositionStill } = await import('../src/components/compositionStill.ts');

const H = 'a'.repeat(64);
const view = (format: string, url = `/sb/${format}/f-1.jpg`): StoryboardView => ({
  format, hash: H, width: 270, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  frames: [{ t: 0, kind: 'scene', url: `/sb/${format}/f-0.jpg`, width: 270, height: 480 }, { t: 3, kind: 'poster', url, width: 270, height: 480 }],
} as StoryboardView);
const still = (format: string) => ({ slug: 'acme', creative: 'lancio', n: 1, format, hash: H });

beforeEach(() => { __resetStills(); api.getStoryboard.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('composition stills', () => {
  it('runs at most MAX_STILLS_AT_ONCE requests at a time and shares one per key', async () => {
    const resolvers: Array<() => void> = [];
    api.getStoryboard.mockImplementation((_s: string, _c: string, _n: number, f: string) => new Promise((r) => { resolvers.push(() => r(view(f))); }));
    const all = ['a', 'b', 'c', 'd'].map((f) => fetchStill(still(f)));
    const again = fetchStill(still('a'));
    await Promise.resolve();
    expect(api.getStoryboard).toHaveBeenCalledTimes(MAX_STILLS_AT_ONCE);
    while (resolvers.length) { resolvers.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    const got = await Promise.all([...all, again]);
    expect(got.map((v) => v?.format)).toEqual(['a', 'b', 'c', 'd', 'a']);
    expect(api.getStoryboard).toHaveBeenCalledTimes(4);
    // Kept: asked again later, no new request.
    await fetchStill(still('c'));
    expect(api.getStoryboard).toHaveBeenCalledTimes(4);
  });

  it('no renderer (404) is none, and is not asked again at once', async () => {
    api.getStoryboard.mockRejectedValue(new ApiError(404));
    expect(await fetchStill(still('x'))).toBeNull();
    expect(await fetchStill(still('x'))).toBeNull();
    expect(api.getStoryboard).toHaveBeenCalledTimes(1);
  });

  it('a busy core (429) is asked again with a backoff', async () => {
    vi.useFakeTimers();
    api.getStoryboard.mockRejectedValueOnce(new ApiError(429)).mockResolvedValueOnce(view('y'));
    const p = fetchStill(still('y'));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await p)?.format).toBe('y');
    expect(api.getStoryboard).toHaveBeenCalledTimes(2);
  });

  it('the hook gives the poster frame once enabled, nothing before', async () => {
    api.getStoryboard.mockResolvedValue(view('z', '/sb/poster.jpg'));
    function Probe({ on }: { on: boolean }) {
      const r = useCompositionStill(still('z'), on);
      return <span data-testid="p">{r.state}:{r.url ?? '-'}</span>;
    }
    const { rerender } = render(<Probe on={false} />);
    expect(screen.getByTestId('p').textContent).toBe('idle:-');
    expect(api.getStoryboard).not.toHaveBeenCalled();
    rerender(<Probe on />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getByTestId('p').textContent).toBe('ready:/sb/poster.jpg');
  });
});
