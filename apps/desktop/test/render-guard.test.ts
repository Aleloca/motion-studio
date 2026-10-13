import { describe, expect, it, vi } from 'vitest';
import { setLocale, t } from '@motion-studio/core';
import { CONFIRM_TTL_MS, DRAFTS_UNSAVED, createRenderGuard, registerRenderGuard, rendersArg, renderRunningPrompt } from '../src/render-guard.ts';

// Closing the UI window (or quitting) while a render runs asks first (Task 8, carry 11): the quit itself cancels the
// renders cleanly (render-window.ts shutdownForQuit), this is only the confirmation.

describe('render guard IPC', () => {
  const setup = (trusted = true) => {
    const handlers: Record<string, (e: unknown, arg: unknown) => unknown> = {};
    const guard = createRenderGuard({ ask: vi.fn(async () => true) });
    registerRenderGuard({ handle: (ch, fn) => { handlers[ch] = fn as never; } }, { trusted: () => trusted, guard, invalid: () => new Error('Invalid request') });
    return { call: (arg: unknown) => handlers['ms:renders-running']!({ sender: 'win' }, arg), guard };
  };
  it('accepts a whole count from 0 to 1000 only', () => {
    expect(rendersArg(0)).toBe(0);
    expect(rendersArg(3)).toBe(3);
    for (const bad of [-1, 1.5, 1001, Number.NaN, '2', null, undefined, {}, [2], true]) expect(rendersArg(bad)).toBeNull();
  });
  it('records the count from the app page, refuses others', () => {
    const s = setup();
    s.call(2);
    expect(s.guard.running()).toBe(2);
    expect(() => s.call('9')).toThrow('Invalid request');
    expect(s.guard.running()).toBe(2);
    const u = setup(false);
    expect(() => u.call(4)).toThrow('Invalid request');
    expect(u.guard.running()).toBe(0);
  });
});

describe('createRenderGuard', () => {
  it('no render: closes without asking', async () => {
    const ask = vi.fn(async () => true);
    const g = createRenderGuard({ ask });
    expect(await g.mayClose()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
  it('a render running: asks, and remembers a yes for the rest of the quit', async () => {
    const ask = vi.fn(async () => true);
    const g = createRenderGuard({ ask });
    g.set(1);
    expect(g.confirmed()).toBe(false);
    expect(await g.mayClose()).toBe(true);
    expect(ask).toHaveBeenCalledWith(1, 0);
    expect(g.confirmed()).toBe(true);
    expect(await g.mayClose()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it('a no keeps the window, and asks again next time', async () => {
    const ask = vi.fn(async () => false);
    const g = createRenderGuard({ ask });
    g.set(2);
    expect(await g.mayClose()).toBe(false);
    expect(await g.mayClose()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });
  it('one question at a time (a close and a quit together)', async () => {
    let answer: (v: boolean) => void = () => {};
    const ask = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
    const g = createRenderGuard({ ask });
    g.set(1);
    const a = g.mayClose();
    const b = g.mayClose();
    answer(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it('renders that ended while the question was open: the window closes whatever the answer', async () => {
    let answer: (v: boolean) => void = () => {};
    const g = createRenderGuard({ ask: () => new Promise<boolean>((r) => { answer = r; }) });
    g.set(1);
    const closing = g.mayClose();
    g.set(0);
    answer(false);
    expect(await closing).toBe(true);
    expect(g.confirmed()).toBe(false);
  });
  it('a yes is forgotten when the quit did not happen: a new render, or after a minute', async () => {
    let t = 1000;
    const ask = vi.fn(async () => true);
    const g = createRenderGuard({ ask, now: () => t });
    g.set(1);
    expect(await g.mayClose()).toBe(true);
    expect(g.confirmed()).toBe(true);
    g.set(2);
    expect(g.confirmed()).toBe(false);
    expect(await g.mayClose()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
    t += CONFIRM_TTL_MS;
    expect(g.confirmed()).toBe(false);
    expect(await g.mayClose()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(3);
  });
  it('the prompt names the renders and keeps rendering as the default', () => {
    setLocale('en');
    const p = renderRunningPrompt(t().desktop, 2);
    expect(p.message).toContain('2');
    expect(p.buttons).toHaveLength(2);
    expect(p.defaultId).toBe(1);
    expect(p.cancelId).toBe(1);
  });
});

// The editor's unsaved drafts (Phase 10b) use the same guard and dialog path as running renders.
describe('unsaved editor drafts', () => {
  it('the page reports a whole count over its own channel, from the app page only', () => {
    const handlers: Record<string, (e: unknown, arg: unknown) => unknown> = {};
    const guard = createRenderGuard({ ask: vi.fn(async () => true) });
    let trusted = true;
    registerRenderGuard({ handle: (ch, fn) => { handlers[ch] = fn as never; } }, { trusted: () => trusted, guard, invalid: () => new Error('Invalid request') });
    handlers[DRAFTS_UNSAVED]!({ sender: 'win' }, 2);
    expect(guard.drafts()).toBe(2);
    expect(guard.pending()).toBe(2);
    expect(guard.running()).toBe(0);
    expect(() => handlers[DRAFTS_UNSAVED]!({ sender: 'win' }, -1)).toThrow('Invalid request');
    trusted = false;
    expect(() => handlers[DRAFTS_UNSAVED]!({ sender: 'x' }, 0)).toThrow('Invalid request');
    expect(guard.drafts()).toBe(2);
  });
  it('a draft alone makes the close ask, with the draft question', async () => {
    const ask = vi.fn(async () => false);
    const g = createRenderGuard({ ask });
    g.setDrafts(1);
    expect(await g.mayClose()).toBe(false);
    expect(ask).toHaveBeenCalledWith(0, 1);
    g.setDrafts(0);
    expect(await g.mayClose()).toBe(true);
  });
  it('a yes is forgotten when another draft appears', async () => {
    const ask = vi.fn(async () => true);
    const g = createRenderGuard({ ask });
    g.setDrafts(1);
    await g.mayClose();
    expect(g.confirmed()).toBe(true);
    g.setDrafts(2);
    expect(g.confirmed()).toBe(false);
  });
  it('the prompt: drafts only asks about the edits, keeping the editor as the default; with renders it names both', () => {
    setLocale('en');
    const only = renderRunningPrompt(t().desktop, 0, 2);
    expect(only.message).toContain('2');
    expect(only.buttons).toEqual([t().desktop.draftUnsavedQuit, t().desktop.draftUnsavedKeep]);
    expect(only.defaultId).toBe(1);
    expect(only.cancelId).toBe(1);
    const both = renderRunningPrompt(t().desktop, 1, 1);
    expect(both.message).toBe(t().desktop.renderRunningMessage({ count: 1 }));
    expect(both.detail).toContain(t().desktop.draftUnsavedMessage({ count: 1 }));
    expect(both.buttons).toEqual([t().desktop.renderRunningQuit, t().desktop.renderRunningKeep]);
  });
});
