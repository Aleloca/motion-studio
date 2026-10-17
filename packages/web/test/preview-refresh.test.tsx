import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshDelay } from '../src/components/compositionPreview.ts';
import { REFRESH_LEAD_MS, useRefreshBefore } from '../src/screens/brand/useRefreshBefore.ts';
import { MAX_TIMER_MS } from '../src/timers.ts';

describe('useRefreshBefore (T1: picker previews refresh before previewExpiresAt)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('goes up one lead before the URLs expire, and again for the next expiry', () => {
    const now = () => Date.now();
    const { result, rerender } = renderHook(({ exp }: { exp: number }) => useRefreshBefore(exp, now), { initialProps: { exp: Date.now() + 10 * 60_000 } });
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(10 * 60_000 - REFRESH_LEAD_MS - 1); });
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(2); });
    expect(result.current).toBe(1);
    // The refreshed list carries a later expiry: the next refresh is scheduled for it.
    rerender({ exp: Date.now() + 10 * 60_000 });
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(result.current).toBe(2);
  });

  it('does nothing without an expiry (OpenAI voices have no previews) and never loops on a nearly expired one', () => {
    const none = renderHook(() => useRefreshBefore(0));
    act(() => { vi.advanceTimersByTime(60 * 60_000); });
    expect(none.result.current).toBe(0);
    const soon = renderHook(() => useRefreshBefore(Date.now() + 1_000));
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(soon.result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(soon.result.current).toBe(1);
  });
});

describe('a far-future expiry never makes a timer overflow (TimeoutOverflowWarning: the timer would fire after 1 ms, over and over)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('refreshDelay caps at what a timer takes, and keeps its floor', () => {
    const now = Date.UTC(2026, 9, 17);
    expect(refreshDelay(Date.UTC(2099, 0, 1), now)).toBe(MAX_TIMER_MS);
    expect(refreshDelay(now + 10 * 60_000, now)).toBe(10 * 60_000 - 60_000);
    expect(refreshDelay(now - 5_000, now)).toBe(5_000);
  });

  it('useRefreshBefore sets a timer of at most MAX_TIMER_MS', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    renderHook(() => useRefreshBefore(Date.UTC(2099, 0, 1)));
    const delays = spy.mock.calls.map((c) => c[1] as number).filter((d) => typeof d === 'number' && d > 1_000_000);
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_MS);
  });
});
