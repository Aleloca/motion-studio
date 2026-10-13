import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_LEAD_MS, useRefreshBefore } from '../src/screens/brand/useRefreshBefore.ts';

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
