import { act, renderHook } from '@testing-library/react';
import { EMPTY_BRAND_KIT, type BrandKit } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetToasts, getToasts, TOAST_MS } from '../src/ui/toast.tsx';

const api = { saveBrandKit: vi.fn(), saveGuidelines: vi.fn() };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { useBrandSaver, TYPING_MS } = await import('../src/screens/brandSave.ts');
const { deferRemoval } = await import('../src/screens/deferred.ts');

const manual = { kind: 'manual' as const, ref: null };
const base: BrandKit = { ...EMPTY_BRAND_KIT, colors: [{ id: 'a', name: 'A', hex: '#111111', role: 'primary', source: manual }] };
const named = (k: BrandKit, name: string): BrandKit => ({ ...k, colors: k.colors.map((c) => ({ ...c, name })) });

beforeEach(() => { vi.useFakeTimers(); __resetToasts(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); __resetToasts(); });

describe('brand saver', () => {
  it('a second edit while the first save is unresolved goes out after it, with the latest kit', async () => {
    const resolvers: Array<() => void> = [];
    api.saveBrandKit.mockImplementation(() => new Promise<void>((r) => { resolvers.push(r); }));
    const { result } = renderHook(() => useBrandSaver('acme', base, () => {}));
    act(() => { result.current.edit((k) => named(k, 'First')); });
    expect(api.saveBrandKit).toHaveBeenCalledTimes(1);
    act(() => { result.current.edit((k) => named(k, 'Second')); });
    act(() => { result.current.edit((k) => ({ ...k, colors: k.colors.map((c) => ({ ...c, role: 'accent' as const })) })); });
    expect(api.saveBrandKit).toHaveBeenCalledTimes(1); // one save in flight at a time
    expect(result.current.status.saving).toBe(true);
    await act(async () => { resolvers[0]!(); });
    expect(api.saveBrandKit).toHaveBeenCalledTimes(2);
    expect((api.saveBrandKit.mock.calls[0]![1] as BrandKit).colors[0]!.name).toBe('First');
    expect((api.saveBrandKit.mock.calls[1]![1] as BrandKit).colors[0]).toMatchObject({ name: 'Second', role: 'accent' });
    await act(async () => { resolvers[1]!(); });
    expect(api.saveBrandKit).toHaveBeenCalledTimes(2);
    expect(result.current.status).toMatchObject({ saving: false, saved: true, error: null });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current.status.saved).toBe(false);
  });

  it('debounces typed edits and flushes on demand', async () => {
    api.saveBrandKit.mockResolvedValue(undefined);
    const { result } = renderHook(() => useBrandSaver('acme', base, () => {}));
    act(() => { result.current.edit((k) => named(k, 'T'), TYPING_MS); });
    act(() => { result.current.edit((k) => named(k, 'Ty'), TYPING_MS); });
    expect(api.saveBrandKit).not.toHaveBeenCalled();
    expect(result.current.pending()).toBe(true);
    await act(async () => { vi.advanceTimersByTime(TYPING_MS); });
    expect(api.saveBrandKit).toHaveBeenCalledTimes(1);
    expect((api.saveBrandKit.mock.calls[0]![1] as BrandKit).colors[0]!.name).toBe('Ty');
  });

  it('a server kit that arrived during a save is reconciled afterwards (refetch), never dropped', async () => {
    let resolve!: () => void;
    api.saveBrandKit.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
    const onStale = vi.fn();
    const { result, rerender } = renderHook(({ server }) => useBrandSaver('acme', server, onStale), { initialProps: { server: base } });
    act(() => { result.current.edit((k) => named(k, 'Mine')); });
    rerender({ server: named(base, 'Theirs') }); // skipped: an edit is in flight
    expect(result.current.kit!.colors[0]!.name).toBe('Mine');
    await act(async () => { resolve(); });
    expect(onStale).toHaveBeenCalledTimes(1);
    rerender({ server: named(base, 'Fresh') }); // the refetch: nothing pending now, so it is taken
    expect(result.current.kit!.colors[0]!.name).toBe('Fresh');
  });

  it('rebase: with nothing pending the server kit is adopted; with a pending edit both are saved', async () => {
    api.saveBrandKit.mockResolvedValue(undefined);
    const { result } = renderHook(() => useBrandSaver('acme', base, () => {}));
    const server = { ...base, dos: [{ id: 'd', text: 'Do', source: manual }] };
    act(() => { result.current.rebase(server, (k) => ({ ...k, dos: server.dos })); });
    expect(result.current.kit).toEqual(server);
    expect(api.saveBrandKit).not.toHaveBeenCalled();
    act(() => { result.current.edit((k) => named(k, 'Typing'), TYPING_MS); });
    const server2 = { ...server, donts: [{ id: 'x', text: 'No', source: manual }] };
    act(() => { result.current.rebase(server2, (k) => ({ ...k, donts: server2.donts })); });
    await act(async () => { vi.advanceTimersByTime(TYPING_MS); });
    const sent = api.saveBrandKit.mock.calls.at(-1)![1] as BrandKit;
    expect(sent.colors[0]!.name).toBe('Typing');
    expect(sent.donts.map((d) => d.id)).toEqual(['x']);
  });
});

describe('deferred removal (timer path)', () => {
  it('sends the delete when the Undo time is over and takes the Undo toast away', async () => {
    const commit = vi.fn(async () => {});
    const restore = vi.fn();
    deferRemoval({ text: 'acme.example removed', undoLabel: 'Undo', commit, restore });
    expect(getToasts().find((t) => t.text === 'acme.example removed')?.action?.label).toBe('Undo');
    await act(async () => { vi.advanceTimersByTime(TOAST_MS); });
    expect(commit).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(getToasts().filter((t) => t.text === 'acme.example removed' && !t.leaving)).toHaveLength(0);
    expect(restore).not.toHaveBeenCalled();
  });

  it('Undo before the time is over restores and never sends the delete', async () => {
    const commit = vi.fn(async () => {});
    const restore = vi.fn();
    deferRemoval({ text: 'b removed', undoLabel: 'Undo', commit, restore });
    getToasts().find((t) => t.text === 'b removed')!.action!.run();
    await act(async () => { vi.advanceTimersByTime(TOAST_MS + 1000); });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('a failed delete puts the item back and reports the error', async () => {
    const restore = vi.fn();
    const onError = vi.fn();
    deferRemoval({ text: 'c removed', undoLabel: 'Undo', commit: () => Promise.reject(new Error('nope')), restore, onError });
    await act(async () => { vi.advanceTimersByTime(TOAST_MS + 400); });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'nope' }));
  });
});
