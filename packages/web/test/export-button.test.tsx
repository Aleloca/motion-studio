/**
 * Report 50: the top bar's Export is a normal button at rest (its icon and "Esporta", no room kept for the progress); while an
 * export or a render runs it widens, with its own animation (the motion system's `stretch`), to show the progress inside
 * itself, and shrinks back when it ends. Under reduced motion it changes size without animating.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { ExportButton } from '../src/screens/ExportButton.tsx';

const at = '2026-10-08T10:00:00.000Z';
const KEY = 'creative:/w:acme:lancio';
const exportJob = (pct: number) => ({ id: 'e1', key: 'export:/w:acme:lancio:0a1b2c3d', kind: 'export', label: 'Export', state: 'running', createdAt: at, export: { stage: 'rendering', pct, destination: '/d', renders: ['r1'] } });
const view = (jobs: unknown[]) => <I18nProvider locale="it"><ExportButton jobs={jobs as never} jobKey={KEY} onClick={() => {}} /></I18nProvider>;

/** A fake width animation: live until finished or cancelled; while live the control measures its in-flight width. */
type Fake = { frames: Keyframe[]; live: boolean; cancel(): void; finish(): void; finished: Promise<void>; effect: { getKeyframes(): Keyframe[] } };
let anims: Fake[];
let animate: ReturnType<typeof vi.fn>;
let reduced = false;
/** The width a running animation shows (between the two sizes). */
const MID = 130;
const origAnimate = Element.prototype.animate;
const origGetAnimations = Element.prototype.getAnimations;
const origMatchMedia = window.matchMedia;
const origRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  reduced = false;
  anims = [];
  animate = vi.fn((frames: Keyframe[]) => {
    const f: Fake = { frames, live: true, cancel() { f.live = false; }, finish() { f.live = false; }, finished: new Promise(() => {}), effect: { getKeyframes: () => frames } };
    anims.push(f);
    return f;
  });
  Element.prototype.animate = animate as never;
  Element.prototype.getAnimations = function () { return anims.filter((a) => a.live) as never; } as never;
  window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  // The control's laid-out width: wide while it works, normal at rest; the in-flight width while a stretch runs.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const w = !this.classList.contains('ms-cv-export') ? 0 : anims.some((a) => a.live) ? MID : this.classList.contains('ms-working') ? 168 : 96;
    return { left: 0, top: 0, right: w, bottom: 32, width: w, height: 32, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});
afterEach(() => {
  Element.prototype.animate = origAnimate; Element.prototype.getAnimations = origGetAnimations;
  window.matchMedia = origMatchMedia; Element.prototype.getBoundingClientRect = origRect;
});

describe('Export button (report 50)', () => {
  it('at rest: icon and "Esporta", nothing that keeps room for the progress', () => {
    render(view([]));
    const b = screen.getByRole('button', { name: 'Esporta' });
    expect(b.classList.contains('ms-working')).toBe(false);
    expect(b.querySelectorAll('.ms-exp-ctl-sizer')).toHaveLength(0);
    expect(b.querySelector('.ms-exp-ctl-fill')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it('an export starts: it widens with its animation and shows the progress; it ends: it shrinks back', () => {
    const { rerender } = render(view([]));
    rerender(view([exportJob(26)]));
    const b = screen.getByRole('button', { name: 'Esportazione 26%' });
    expect(b.classList.contains('ms-working')).toBe(true);
    expect((b.querySelector('.ms-exp-ctl-fill') as HTMLElement).style.width).toBe('26%');
    // While it works the percent never makes it jitter: the widest working texts set its width ("Esporta" is not one).
    const sizers = [...b.querySelectorAll('.ms-exp-ctl-sizer')].map((e) => e.textContent);
    expect(sizers).toEqual(expect.arrayContaining(['Esportazione 100%', 'Render 100%']));
    expect(sizers).not.toContain('Esporta');
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0]![0]).toEqual([{ width: '96px' }, { width: '168px' }]);
    // A new percent is not a new size.
    rerender(view([exportJob(60)]));
    expect(animate).toHaveBeenCalledTimes(1);
    anims[0]!.finish();
    rerender(view([]));
    expect(screen.getByRole('button', { name: 'Esporta' }).classList.contains('ms-working')).toBe(false);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[1]![0]).toEqual([{ width: '168px' }, { width: '96px' }]);
  });

  it('decision 1335: after a finished grow, an end with no other render shrinks from the full width, not an in-flight one', () => {
    const { rerender } = render(view([]));
    rerender(view([exportJob(26)]));
    anims[0]!.finish();
    rerender(view([]));
    expect(animate.mock.calls[1]![0]).toEqual([{ width: '168px' }, { width: '96px' }]);
  });

  it('decision 1335: a failure arriving mid-grow cancels the grow and shrinks from where it was', () => {
    const { rerender } = render(view([]));
    rerender(view([exportJob(26)]));
    // A new percent mid-grow neither restarts nor records the in-flight width.
    rerender(view([exportJob(30)]));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(anims[0]!.live).toBe(true);
    rerender(view([]));
    expect(anims[0]!.live).toBe(false);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[1]![0]).toEqual([{ width: `${MID}px` }, { width: '96px' }]);
  });

  it('under reduced motion it changes size without animating', () => {
    reduced = true;
    const { rerender } = render(view([]));
    rerender(view([exportJob(26)]));
    expect(screen.getByRole('button', { name: 'Esportazione 26%' })).toBeTruthy();
    expect(animate).not.toHaveBeenCalled();
  });
});
