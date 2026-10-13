import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type Brief, type BriefServices, type CreativeDetail, type JobSummary, type SecretStatus } from '@motion-studio/shared';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

let secrets: SecretStatus[];
let keyChecks: Record<string, unknown>;
const secret = (provider: SecretStatus['provider'], configured: boolean): SecretStatus => ({ provider, configured, source: configured ? 'keychain' : null });
const api = {
  getSecrets: vi.fn(async () => secrets),
  getKeyChecks: vi.fn(async () => keyChecks),
  updateCreative: vi.fn(async (_s: string, _c: string, _b: unknown) => ({})),
  sendCreativeTurn: vi.fn(async () => ({})),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  decideApproval: vi.fn(async () => ({})),
};
class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ServicesSelector, servicesSummary } = await import('../src/components/ServicesSelector.tsx');
const { Conversation } = await import('../src/components/Conversation.tsx');
const { BriefEditor } = await import('../src/components/BriefEditor.tsx');
const { messages } = await import('@motion-studio/shared');

const brief: Brief = { goal: 'Launch', message: '', formats: ['instagram-post-1x1'], durationSec: 6, assets: [], notes: '' };
const detail = (b: Brief = brief): CreativeDetail => ({
  slug: 'c1', jobKey: 'k', versions: [],
  creative: { schemaVersion: 1, title: 'Launch', brief: b, status: 'draft', error: null, resumeFrom: null, linkedCodebases: [], createdAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:00:00.000Z' },
});
const en = (node: ReactNode) => <I18nProvider locale="en">{node}</I18nProvider>;
const group = (name: string) => screen.getByRole('radiogroup', { name: `${name}: service` });
const option = (g: string, name: string) => within(group(g)).getByRole('radio', { name }) as HTMLButtonElement;
const lastSaved = () => api.updateCreative.mock.calls.at(-1)![2] as { brief: Brief };
const lastBody = () => api.updateCreative.mock.calls.at(-1)![2] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  secrets = [secret('openai', true), secret('elevenlabs', false), secret('pexels', false), secret('unsplash', false)];
  keyChecks = { openai: null, elevenlabs: null, pexels: null, unsplash: null };
});

describe('ServicesSelector', () => {
  it('shows four rows with their choices; an old brief reads as all auto', () => {
    render(en(<ServicesSelector value={undefined} configured={null} onChange={() => {}} />));
    expect(screen.getAllByRole('radiogroup')).toHaveLength(4);
    expect(within(group('Images')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Auto', 'OpenAI', 'Stock only', 'Off']);
    expect(within(group('Voice')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Auto', 'OpenAI', 'ElevenLabs', 'Off']);
    expect(within(group('Music')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Auto', 'ElevenLabs', 'Off']);
    expect(within(group('Sound effects')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Auto', 'ElevenLabs', 'Off']);
    for (const g of ['Images', 'Voice', 'Music', 'Sound effects']) expect(option(g, 'Auto').getAttribute('aria-checked')).toBe('true');
  });

  it('disables a provider without its key and says why, next to the row', () => {
    render(en(<ServicesSelector value={{ voice: 'openai' }} configured={new Set(['openai'])} onChange={() => {}} />));
    expect(option('Voice', 'ElevenLabs').disabled).toBe(true);
    expect(option('Voice', 'OpenAI').disabled).toBe(false);
    expect(option('Images', 'Stock only').disabled).toBe(true);
    expect(option('Music', 'Off').disabled).toBe(false);
    const why = 'ElevenLabs needs the ElevenLabs key: add it in Settings → Paid services.';
    expect(option('Voice', 'ElevenLabs').title).toBe(why);
    const note = document.getElementById(group('Voice').getAttribute('aria-describedby')!)!;
    expect(note.textContent).toBe(why);
    expect(document.getElementById(group('Images').getAttribute('aria-describedby')!)!.textContent).toBe('Stock only needs the Pexels or Unsplash key: add it in Settings → Paid services.');
  });

  it('a capability the key check found missing disables that provider with the permission; unverified and error stay available (F5)', () => {
    const checks = {
      elevenlabs: { provider: 'elevenlabs' as const, checkedAt: '', capabilities: [
        { capability: 'key' as const, status: 'ok' as const }, { capability: 'tts' as const, status: 'missing' as const, permission: 'text_to_speech' },
        { capability: 'music' as const, status: 'unverified' as const, permission: 'music_generation' }, { capability: 'sfx' as const, status: 'error' as const, detail: 'timeout' },
      ] },
      openai: { provider: 'openai' as const, checkedAt: '', capabilities: [{ capability: 'key' as const, status: 'missing' as const }, { capability: 'images' as const, status: 'missing' as const }, { capability: 'tts' as const, status: 'missing' as const }] },
    };
    render(en(<ServicesSelector value={undefined} configured={new Set(['openai', 'elevenlabs'])} checks={checks} onChange={() => {}} />));
    expect(option('Voice', 'ElevenLabs').disabled).toBe(true);
    expect(option('Voice', 'ElevenLabs').title).toBe('ElevenLabs is unavailable: the ElevenLabs key lacks the permission text_to_speech. Enable it at ElevenLabs, then test the key again in Settings → Paid services.');
    expect(option('Voice', 'OpenAI').disabled).toBe(true);
    expect(option('Voice', 'OpenAI').title).toBe('OpenAI is unavailable: OpenAI does not accept the saved key. Check or replace it in Settings → Paid services.');
    expect(option('Images', 'OpenAI').disabled).toBe(true);
    expect(option('Music', 'ElevenLabs').disabled).toBe(false);
    expect(option('Sound effects', 'ElevenLabs').disabled).toBe(false);
    expect(option('Voice', 'Auto').disabled).toBe(false);
    expect(document.getElementById(group('Voice').getAttribute('aria-describedby')!)!.textContent).toContain('text_to_speech');
  });
  it('the Services chip reads the key checks and disables a provider whose capability is missing (F5)', async () => {
    secrets = [secret('openai', true), secret('elevenlabs', true), secret('pexels', false), secret('unsplash', false)];
    keyChecks = { openai: null, elevenlabs: { provider: 'elevenlabs', checkedAt: '', capabilities: [{ capability: 'key', status: 'ok' }, { capability: 'tts', status: 'missing', permission: 'text_to_speech' }] }, pexels: null, unsplash: null };
    const { ServicesChip } = await import('../src/components/ServicesSelector.tsx');
    const user = userEvent.setup();
    render(en(<ServicesChip slug="acme" creative="c1" brief={brief} busy={false} onSaved={() => {}} />));
    await user.click(screen.getByRole('button', { name: /Services/ }));
    await waitFor(() => expect(option('Voice', 'ElevenLabs').disabled).toBe(true));
    expect(option('Voice', 'OpenAI').disabled).toBe(false);
  });
  it('under auto, says which provider is skipped for a missing permission and links to Settings; the chip says it too (fix round 2)', async () => {
    secrets = [secret('openai', true), secret('elevenlabs', true), secret('pexels', false), secret('unsplash', false)];
    keyChecks = { openai: null, elevenlabs: { provider: 'elevenlabs', checkedAt: '', capabilities: [{ capability: 'key', status: 'ok' }, { capability: 'tts', status: 'missing', permission: 'text_to_speech' }] }, pexels: null, unsplash: null };
    const { ServicesChip } = await import('../src/components/ServicesSelector.tsx');
    const user = userEvent.setup();
    render(en(<ServicesChip slug="acme" creative="c1" brief={brief} busy={false} onSaved={() => {}} />));
    await waitFor(() => expect(screen.getByRole('button', { name: /Services/ }).textContent).toContain('Voice: ElevenLabs unavailable'));
    await user.click(screen.getByRole('button', { name: /Services/ }));
    await waitFor(() => expect(option('Voice', 'ElevenLabs').disabled).toBe(true));
    const note = document.getElementById(group('Voice').getAttribute('aria-describedby')!)!;
    expect(note.textContent).toContain('ElevenLabs voice: missing permission text_to_speech · Auto skips it until the key is fixed.');
    const link = within(note).getByRole('link', { name: 'Test in Settings' });
    expect(link.getAttribute('href')).toBe('#/settings/paid');
    // The same reason is not repeated for the ElevenLabs choice.
    expect(note.textContent!.match(/text_to_speech/g)).toHaveLength(1);
  });
  it('nothing known, or unverified/error: no auto line and the plain summary', () => {
    const checks = { elevenlabs: { provider: 'elevenlabs' as const, checkedAt: '', capabilities: [{ capability: 'tts' as const, status: 'unverified' as const }] } };
    render(en(<ServicesSelector value={undefined} configured={new Set(['elevenlabs'])} checks={checks} onChange={() => {}} />));
    expect(group('Voice').getAttribute('aria-describedby') === null || !document.getElementById(group('Voice').getAttribute('aria-describedby')!)?.textContent?.includes('Auto skips')).toBe(true);
    expect(servicesSummary(undefined, messages('en'), () => [])).toBe('all auto');
  });
  it('changes one kind, keeping the others; arrows skip a disabled provider', async () => {
    const onChange = vi.fn();
    render(en(<ServicesSelector value={{ images: 'stock' }} configured={new Set(['openai', 'pexels'])} onChange={onChange} />));
    await userEvent.click(option('Voice', 'Off'));
    expect(onChange).toHaveBeenLastCalledWith({ images: 'stock', voice: 'none' });
    // Voice: Auto → (OpenAI) → ElevenLabs is disabled → Off.
    option('Voice', 'Auto').focus();
    fireEvent.keyDown(option('Voice', 'Auto'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ images: 'stock', voice: 'openai' });
    fireEvent.keyDown(option('Voice', 'OpenAI'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ images: 'stock', voice: 'none' });
  });

  it('a chosen provider whose key was removed stays shown, and the row stays reachable by Tab', () => {
    render(en(<ServicesSelector value={{ voice: 'elevenlabs' }} configured={new Set()} onChange={() => {}} />));
    expect(option('Voice', 'ElevenLabs').getAttribute('aria-checked')).toBe('true');
    expect(option('Voice', 'Auto').tabIndex).toBe(0);
  });
});

describe('servicesSummary', () => {
  it('lists the kinds that are not auto', () => {
    const t = messages('en');
    expect(servicesSummary(undefined, t)).toBe('all auto');
    expect(servicesSummary({ voice: 'none', images: 'stock', music: 'auto' } satisfies BriefServices, t)).toBe('Images Stock only · Voice Off');
  });
});

describe('the composer "Services" chip', () => {
  const props = { slug: 'acme', creative: 'c1', entries: [], approvals: [], job: undefined as JobSummary | undefined };
  it('shows the summary, opens the selector and saves the brief at once (a normal brief update)', async () => {
    const onBriefSaved = vi.fn();
    render(en(<Conversation {...props} brief={{ ...brief, services: { images: 'stock' } }} onBriefSaved={onBriefSaved} />));
    const chip = screen.getByRole('button', { name: /^Services: Images Stock only\./ });
    await userEvent.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'Services' });
    expect(within(dialog).getByText('Changes apply from the next message.')).toBeTruthy();
    await waitFor(() => expect(api.getSecrets).toHaveBeenCalled());
    await userEvent.click(within(within(dialog).getByRole('radiogroup', { name: 'Voice: service' })).getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(api.updateCreative.mock.calls[0]!.slice(0, 2)).toEqual(['acme', 'c1']);
    // Only `services` is sent (Q2): the server merges it into the brief it stores now, so a newer brief is never overwritten.
    expect(lastBody()).toEqual({ services: { images: 'stock', voice: 'none' } });
    await waitFor(() => expect(onBriefSaved).toHaveBeenCalledOnce());
  });

  it('cannot change the services while a turn runs', async () => {
    const running: JobSummary = { id: 'j1', key: 'creative:k', kind: 'creative', label: 'x', state: 'running', createdAt: '2026-10-08T10:00:00.000Z' };
    render(en(<Conversation {...props} job={running} brief={brief} onBriefSaved={() => {}} />));
    await userEvent.click(screen.getByRole('button', { name: /^Services: all auto\./ }));
    const dialog = await screen.findByRole('dialog', { name: 'Services' });
    expect(within(dialog).getAllByRole('radio').every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect(within(dialog).getByText('You can change the services when the generation ends.')).toBeTruthy();
  });

  it('shows the error and keeps the old choice when the save fails', async () => {
    api.updateCreative.mockRejectedValueOnce(new Error('disk full'));
    render(en(<Conversation {...props} brief={brief} onBriefSaved={() => {}} />));
    await userEvent.click(screen.getByRole('button', { name: /^Services: all auto\./ }));
    const dialog = await screen.findByRole('dialog', { name: 'Services' });
    await userEvent.click(within(within(dialog).getByRole('radiogroup', { name: 'Music: service' })).getByRole('radio', { name: 'Off' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', "Can't save the services: disk full");
    expect(within(within(dialog).getByRole('radiogroup', { name: 'Music: service' })).getByRole('radio', { name: 'Auto' }).getAttribute('aria-checked')).toBe('true');
  });

  it('is not shown without a brief', () => {
    render(en(<Conversation {...props} />));
    expect(screen.queryByRole('button', { name: /^Services:/ })).toBeNull();
  });
});

describe('composer footer layout (D1)', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/components/conversation.css'), 'utf8');
  const rule = (sel: string) => css.split('}').map((r) => r.trim()).find((r) => r.replace(/\/\*[\s\S]*?\*\//g, '').trim().startsWith(sel + ' {'))!.replace(/\/\*[\s\S]*?\*\//g, '');
  it('the hint stays on one line with an ellipsis and the Services chip shrinks first', () => {
    const hint = rule('.ms-composer-hint');
    expect(hint).toMatch(/white-space:\s*nowrap/); expect(hint).toMatch(/text-overflow:\s*ellipsis/); expect(hint).toMatch(/overflow:\s*hidden/);
    const shrink = (r: string) => Number(/flex:\s*\S+\s+(\d+)/.exec(r)![1]);
    expect(shrink(rule('.ms-composer-foot > .ms-services-chip'))).toBeGreaterThan(shrink(hint));
  });
  it('renders the chip and the hint as siblings in the footer', () => {
    const { container } = render(en(<Conversation slug="acme" creative="c1" entries={[]} approvals={[]} job={undefined} brief={brief} />));
    const foot = container.querySelector('.ms-composer-foot')!;
    expect(foot.querySelector(':scope > .ms-services-chip')).toBeTruthy();
    expect(foot.querySelector(':scope > .ms-composer-hint')).toBeTruthy();
  });
});

describe('BriefEditor services', () => {
  it('saves the chosen services with the brief', async () => {
    const onChanged = vi.fn();
    render(en(<BriefEditor slug="acme" detail={detail()} presets={DEFAULT_FORMATS} disabled={false} onChanged={onChanged} />));
    await userEvent.click(option('Images', 'Off'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastSaved().brief.services).toEqual({ images: 'none' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('an old brief saved without touching the services stays without them', async () => {
    render(en(<BriefEditor slug="acme" detail={detail()} presets={DEFAULT_FORMATS} disabled={false} onChanged={() => {}} />));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect('services' in lastSaved().brief).toBe(false);
  });

  it('keeps a change made from the chat meanwhile when its own services were not touched', async () => {
    const r = render(en(<BriefEditor slug="acme" detail={detail()} presets={DEFAULT_FORMATS} disabled={false} onChanged={() => {}} />));
    r.rerender(en(<BriefEditor slug="acme" detail={detail({ ...brief, services: { voice: 'none' } })} presets={DEFAULT_FORMATS} disabled={false} onChanged={() => {}} />));
    expect(option('Voice', 'Off').getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastSaved().brief.services).toEqual({ voice: 'none' });
  });
});
