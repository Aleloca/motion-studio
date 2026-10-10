import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

let finish: (ok: boolean) => void = () => {};
const api = {
  restoreVersion: vi.fn(() => new Promise((resolve, reject) => { finish = (ok) => (ok ? resolve({}) : reject(new Error('gone'))); })),
};
vi.mock('../src/api.ts', () => ({ api }));
const { useVersionActions } = await import('../src/screens/FormatVersions.tsx');
const { __resetToasts, getToasts } = await import('../src/ui/toast.tsx');

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider locale="en">{children}</I18nProvider>;
const mount = () => {
  __resetToasts();
  const onChanged = vi.fn();
  const onError = vi.fn();
  const view = renderHook(() => useVersionActions({ slug: 'acme', creative: 'c1', states: {}, labelOf: (id) => id, resumeFrom: null, onChanged, onError }), { wrapper });
  return { ...view, onChanged, onError };
};

describe('useVersionActions · restore after the page is gone (M3)', () => {
  it('a restart that succeeds late reloads nothing and calls nothing back', async () => {
    const m = mount();
    await act(async () => { m.result.current.restart(2); await new Promise((r) => setTimeout(r, 0)); });
    expect(api.restoreVersion).toHaveBeenCalled();
    m.unmount();
    m.onError.mockClear();
    await act(async () => { finish(true); await new Promise((r) => setTimeout(r, 0)); });
    expect(m.onChanged).not.toHaveBeenCalled();
    expect(getToasts()).toEqual([]);
  });
  it('a restart that fails late shows no message', async () => {
    const m = mount();
    await act(async () => { m.result.current.restart(2); await new Promise((r) => setTimeout(r, 0)); });
    expect(api.restoreVersion).toHaveBeenCalled();
    m.unmount();
    m.onError.mockClear();
    await act(async () => { finish(false); await new Promise((r) => setTimeout(r, 0)); });
    expect(m.onError).not.toHaveBeenCalled();
  });
  it('while mounted, a restart reloads and calls back', async () => {
    const m = mount();
    await act(async () => { m.result.current.restart(2); await new Promise((r) => setTimeout(r, 0)); });
    expect(api.restoreVersion).toHaveBeenCalled();
    await act(async () => { finish(true); await new Promise((r) => setTimeout(r, 0)); });
    expect(m.onChanged).toHaveBeenCalledOnce();
    expect(getToasts()).toHaveLength(1);
  });
});
