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
});
