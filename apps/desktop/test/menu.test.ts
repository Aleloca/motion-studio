import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale, t } from '@motion-studio/core';
import { menuTemplate } from '../src/menu.ts';

const labels = (locale: 'en' | 'it', mac = false) => (setLocale(locale), menuTemplate(t(), { mac, openRepo: vi.fn() })).map((i) => i.label);

describe('menuTemplate', () => {
  beforeEach(() => setLocale('en'));
  it('is English in en', () => expect(labels('en')).toEqual(['Edit', 'View', 'Window', 'Help']));
  it('is Italian in it', () => expect(labels('it')).toEqual(['Modifica', 'Vista', 'Finestra', 'Aiuto']));
  it('adds the app menu on macOS only', () => {
    expect(menuTemplate(t(), { mac: true, openRepo: vi.fn() })[0]).toEqual({ role: 'appMenu' });
    expect(labels('en', true)).toEqual([undefined, 'Edit', 'View', 'Window', 'Help']);
  });
  it('enables the restart entry only with a restart callback', () => {
    const help = (restart?: () => void) => (menuTemplate(t(), { mac: false, ...(restart ? { restart } : {}), openRepo: vi.fn() })[3]!.submenu as { label?: string; enabled?: boolean }[])[0]!;
    expect(help()).toMatchObject({ label: 'Restart to Update', enabled: false });
    expect(help(() => {})).toMatchObject({ enabled: true });
  });
  it('decision 1055: with a zoom handler the View menu\'s zoom items call it (same labels and keys), never the window roles', () => {
    const zoom = vi.fn();
    const view = (menuTemplate(t(), { mac: true, openRepo: vi.fn(), zoom })[2]!.submenu as Array<{ label?: string; role?: string; accelerator?: string; visible?: boolean; click?: () => void }>);
    expect(view.some((i) => i.role === 'zoomIn' || i.role === 'zoomOut' || i.role === 'resetZoom')).toBe(false);
    const shown = view.filter((i) => i.accelerator && i.visible !== false);
    expect(shown.map((i) => [i.label, i.accelerator])).toEqual([['Actual Size', 'CommandOrControl+0'], ['Zoom In', 'CommandOrControl+Plus'], ['Zoom Out', 'CommandOrControl+-']]);
    // ⌘= (no Shift) zooms in too, from a hidden item.
    const alias = view.find((i) => i.accelerator === 'CommandOrControl+=')!;
    expect(alias.visible).toBe(false);
    for (const i of [...shown, alias]) i.click!();
    expect(zoom.mock.calls.map((c) => c[0])).toEqual(['reset', 'in', 'out', 'in']);
  });
  it('without a zoom handler it keeps the Electron roles', () => {
    const view = (menuTemplate(t(), { mac: false, openRepo: vi.fn() })[1]!.submenu as Array<{ role?: string }>);
    expect(view.map((i) => i.role).filter(Boolean)).toEqual(['reload', 'togglefullscreen', 'resetZoom', 'zoomIn', 'zoomOut']);
  });
});
