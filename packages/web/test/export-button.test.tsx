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

let animate: ReturnType<typeof vi.fn>;
let reduced = false;
const origAnimate = Element.prototype.animate;
const origMatchMedia = window.matchMedia;
const origRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  reduced = false;
  animate = vi.fn(() => ({ finished: Promise.resolve(), cancel() {} }));
  Element.prototype.animate = animate as never;
  window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  // The control's laid-out width: wide while it works, normal at rest.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const w = this.classList.contains('ms-cv-export') ? (this.classList.contains('ms-working') ? 168 : 96) : 0;
    return { left: 0, top: 0, right: w, bottom: 32, width: w, height: 32, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});
afterEach(() => { Element.prototype.animate = origAnimate; window.matchMedia = origMatchMedia; Element.prototype.getBoundingClientRect = origRect; });

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
    rerender(view([]));
    expect(screen.getByRole('button', { name: 'Esporta' }).classList.contains('ms-working')).toBe(false);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[1]![0]).toEqual([{ width: '168px' }, { width: '96px' }]);
  });

  it('under reduced motion it changes size without animating', () => {
    reduced = true;
    const { rerender } = render(view([]));
    rerender(view([exportJob(26)]));
    expect(screen.getByRole('button', { name: 'Esportazione 26%' })).toBeTruthy();
    expect(animate).not.toHaveBeenCalled();
  });
});
