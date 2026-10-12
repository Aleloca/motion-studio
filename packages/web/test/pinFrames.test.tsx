import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The pin frames' signed URLs (Task 8, fix round 1): asked again before they expire, a failed read retried with a backoff.
const api = { getPinFrames: vi.fn() };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { usePinFrames } = await import('../src/screens/pinFrames.ts');
const { MAX_REFRESH_RETRIES } = await import('../src/components/compositionPreview.ts');

const view = (n: number, exp: number, tag: string) => ({ n, expiresAt: new Date(Date.now() + exp).toISOString(), frames: [{ file: `${n}-1.jpg`, url: `/pf/${n}-1.jpg?${tag}` }] });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); api.getPinFrames.mockReset(); });

describe('usePinFrames', () => {
  it('refreshes before expiry, and retries a failed refresh until it works', async () => {
    api.getPinFrames.mockResolvedValueOnce(view(2, 2 * 60_000, 'a')).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(view(2, 10 * 60_000, 'b'));
    const h = renderHook(() => usePinFrames('acme', 'c', [2]));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(h.result.current[2]).toEqual({ '2-1.jpg': '/pf/2-1.jpg?a' });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000 + 1000 + 10); });
    expect(api.getPinFrames).toHaveBeenCalledTimes(3);
    expect(h.result.current[2]).toEqual({ '2-1.jpg': '/pf/2-1.jpg?b' });
  });
  it('gives up after a bounded number of failures in a row', async () => {
    api.getPinFrames.mockRejectedValue(new Error('offline'));
    renderHook(() => usePinFrames('acme', 'c', [3]));
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(api.getPinFrames).toHaveBeenCalledTimes(1 + MAX_REFRESH_RETRIES);
  });
});
