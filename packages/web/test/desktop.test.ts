import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktop, showExported } from '../src/desktop.ts';
import { I18nProvider } from '../src/i18n.tsx';
import { useExportNotice, useRenderCloseGuard } from '../src/shell/useAttention.ts';
import { __resetToasts, getToasts } from '../src/ui/toast.tsx';
import { exportRegistry } from '../src/screens/exportModel.ts';

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

describe('Show in Finder of exported files (user report 21)', () => {
  it('one file is selected in its folder; several open the folder itself; an older app selects the first file', async () => {
    const revealPath = vi.fn(async () => {});
    const openFolder = vi.fn(async () => {});
    const b = { isDesktop: true as const, platform: 'darwin', pickFolder: async () => null, revealPath, openFolder };
    await showExported(b, '/Users/me/Desktop', ['/Users/me/Desktop/a.mp4']);
    expect(revealPath).toHaveBeenLastCalledWith('/Users/me/Desktop/a.mp4');
    await showExported(b, '/Users/me/Desktop', ['/Users/me/Desktop/a.mp4', '/Users/me/Desktop/b.mp4']);
    expect(openFolder).toHaveBeenCalledWith('/Users/me/Desktop');
    await showExported({ ...b, openFolder: undefined }, '/Users/me/Desktop', ['/Users/me/Desktop/a.mp4', '/Users/me/Desktop/b.mp4']);
    expect(revealPath).toHaveBeenLastCalledWith('/Users/me/Desktop/a.mp4');
  });
});

describe('export notice (decision 974, user report 20)', () => {
  const job = (state: string, over: Record<string, unknown> = {}) => ({ e1: { id: 'e1', key: 'export:/w:acme:lancio:0a1b2c3d', kind: 'export', label: 'Export · Lancio', state, createdAt: '2026-10-08T10:00:00.000Z', ...over } }) as never;
  const wrapper = ({ children }: { children: ReactNode }) => createElement(I18nProvider, { locale: 'en', children });
  afterEach(() => __resetToasts());

  it('an export it saw running that ends: a toast with the files and Show in Finder (one file: the file is selected)', () => {
    const revealPath = vi.fn(async () => {});
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath };
    const h = renderHook(({ jobs }) => useExportNotice(jobs), { initialProps: { jobs: job('running') }, wrapper });
    h.rerender({ jobs: job('succeeded', { export: { stage: 'done', pct: 100, destination: '/Users/me/Desktop', files: ['/Users/me/Desktop/a.mp4'] } }) });
    h.rerender({ jobs: job('succeeded', { export: { stage: 'done', pct: 100, destination: '/Users/me/Desktop', files: ['/Users/me/Desktop/a.mp4'] } }) });
    const toasts = getToasts();
    expect(toasts.map((t) => t.text)).toEqual(['1 file exported to /Users/me/Desktop']);
    expect(toasts[0]!.action?.label).toMatch(/^Show in (Finder|folder)$/);
    toasts[0]!.action!.run();
    expect(revealPath).toHaveBeenCalledWith('/Users/me/Desktop/a.mp4');
  });

  it('a failed export says why; a cancelled one, or one this window never saw running, says nothing', () => {
    const h = renderHook(({ jobs }) => useExportNotice(jobs), { initialProps: { jobs: job('succeeded', { export: { stage: 'done', pct: 100, destination: '/d', files: [] } }) }, wrapper });
    expect(getToasts()).toEqual([]);
    h.rerender({ jobs: job('running') });
    h.rerender({ jobs: job('cancelled') });
    expect(getToasts()).toEqual([]);
    h.rerender({ jobs: job('running') });
    h.rerender({ jobs: job('failed', { error: 'Render failed: boom' }) });
    expect(getToasts().map((t) => t.text)).toEqual(['Export failed: Render failed: boom']);
  });

  it('review #9: what was left out is said, with what to do', () => {
    const h = renderHook(({ jobs }) => useExportNotice(jobs), { initialProps: { jobs: job('running') }, wrapper });
    h.rerender({ jobs: job('succeeded', { export: { stage: 'done', pct: 100, destination: '/d', files: ['/d/a.mp4'], skipped: ['x.mov'], excluded: [{ format: 'f', version: 1, problems: ['p'] }] } }) });
    expect(getToasts().map((t) => t.text)).toEqual(['1 file exported to /d. 2 not exported: open Export again to see why.']);
  });

  it('review #9: translations that need "Render anyway", with the dialog closed: the toast offers it (or opens the creative)', () => {
    const retry = vi.fn(async () => {});
    const refused = { export: { stage: 'rendering', pct: null, destination: '/d', refusal: { code: 'localization-needs-force', problems: ['Wide (de)'] } }, error: 'raw' };
    exportRegistry.setRetry('e1', retry);
    const h = renderHook(({ jobs }) => useExportNotice(jobs), { initialProps: { jobs: job('running') }, wrapper });
    h.rerender({ jobs: job('failed', refused) });
    const t1 = getToasts()[0]!;
    expect(t1.text).toBe('Export stopped: these translations have open problems or outdated texts: Wide (de)');
    expect(t1.action?.label).toBe('Render anyway');
    t1.action!.run();
    expect(retry).toHaveBeenCalled();
    __resetToasts();
    // No retry known (another window started it): the action opens the creative, where Export can be run again.
    h.rerender({ jobs: job('running') });
    h.rerender({ jobs: job('failed', refused) });
    expect(getToasts()[0]!.action?.label).toBe('Open');
    __resetToasts();
    // The dialog that started it is open: it shows the list itself, no toast.
    const stop = exportRegistry.watch('e1');
    h.rerender({ jobs: job('running') });
    h.rerender({ jobs: job('failed', refused) });
    expect(getToasts()).toEqual([]);
    stop();
  });

  it('a running export keeps the desktop app from closing without asking, like a render', () => {
    const setRendersRunning = vi.fn(async () => {});
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => null, revealPath: async () => {}, setRendersRunning };
    renderHook(() => useRenderCloseGuard(job('running')));
    expect(setRendersRunning).toHaveBeenLastCalledWith(1);
  });
});
