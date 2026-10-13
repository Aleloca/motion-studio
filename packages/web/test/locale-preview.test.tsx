import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Composition, LocalizationRow } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
const base = { $schema: 'motion-studio/composition@1', width: 1080, height: 1920, fps: 30, duration: 6, background: '#000000', fonts: [], scenes: [], tracks: [
  { id: 't', kind: 'text', clips: [{ id: 'title', type: 'text', name: 'Title', start: 0, duration: 3, props: { text: 'Welcome' } }, { id: 'sub', type: 'text', start: 0, duration: 3, props: { text: 'Fresh' } }] },
] } as unknown as Composition;
const localized = (texts: Record<string, string>) => ({ ...base, tracks: [{ id: 't', kind: 'text', clips: [
  { id: 'title', type: 'text', name: 'Title', start: 0, duration: 3, props: { text: texts.title } }, { id: 'sub', type: 'text', start: 0, duration: 3, props: { text: texts.sub } }] }] }) as unknown as Composition;
let view: { composition: Composition; localization: { locale: string; stale: string[]; problems: string[]; voice: string } };
const api = {
  getLocalizedComposition: vi.fn(async (..._a: unknown[]) => ({ ...view, n: 3, format: 'reel', primaryFormat: 'reel', hash: 'h', files: [], fonts: [] })),
  attachLocalePreview: vi.fn(async (..._a: unknown[]) => ({ files: ['assets/fonts/NotoSansJP-400.woff2'] })),
  getEditorComposition: vi.fn(async (..._a: unknown[]) => ({ composition: base })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { useLocalePreview } = await import('../src/screens/creative/useLocalePreview.ts');
const { LocaleOutline, LocaleSwitcher } = await import('../src/screens/creative/LocaleSwitcher.tsx');
type Player = Parameters<typeof useLocalePreview>[0]['player'];

class FakePlayer extends EventTarget {
  clipBounds: { clipId: string | null; bounds: { x: number; y: number; width: number; height: number } | null; scale: number } | null = null;
  setComposition = vi.fn((_c: Composition) => 1);
  select = vi.fn((id: string | null) => {
    this.clipBounds = id ? { clipId: id, bounds: { x: 10, y: 20, width: 300, height: 80 }, scale: 0.5 } : null;
    this.dispatchEvent(new Event('clipbounds'));
  });
}
const row = (locale: LocalizationRow['locale'], over: Partial<LocalizationRow> = {}): LocalizationRow => ({ locale, instanceId: 'reel', hash: 'a'.repeat(64), origin: 'agent', stale: [], voice: 'original', ...over });

function Harness({ player, rows, token = 'T'.repeat(43), brief = { locales: { primary: 'en', extra: ['de', 'ja', 'fr'] } } as const, original }: {
  player: FakePlayer; rows: LocalizationRow[]; token?: string | null; brief?: { locales?: { primary: 'en'; extra: Array<'de' | 'ja' | 'fr'> } }; original?: () => Composition | null;
}) {
  const preview = useLocalePreview({ slug: 'acme', creative: 'c1', n: 3, format: 'reel', rows, player: player as unknown as Player, token, ...(original ? { original } : {}) });
  return (
    <I18nProvider locale="en">
      <div style={{ position: 'relative' }}>
        <LocaleOutline player={player as unknown as Player} preview={preview} />
      </div>
      <LocaleSwitcher brief={brief} preview={preview} />
    </I18nProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  view = { composition: localized({ title: 'Willkommen', sub: 'Frisch' }), localization: { locale: 'de', stale: [], problems: [], voice: 'original' } };
});

describe('the language switcher of the preview', () => {
  it('offers the original and only the languages that have a translation of the format', () => {
    render(<Harness player={new FakePlayer()} rows={[row('de'), row('ja')]} />);
    const group = screen.getByRole('radiogroup', { name: 'Language of the preview' });
    expect(within(group).getByRole('radio', { name: 'Original (English)' }).getAttribute('aria-checked')).toBe('true');
    expect((within(group).getByRole('radio', { name: 'German' }) as HTMLButtonElement).disabled).toBe(false);
    const fr = within(group).getByRole('radio', { name: 'French' }) as HTMLButtonElement;
    expect(fr.disabled).toBe(true);
    expect(fr.title).toBe('Not translated');
  });

  it('shows nothing for a creative without languages (old briefs)', () => {
    const { container } = render(<Harness player={new FakePlayer()} rows={[]} brief={{}} />);
    expect(container.querySelector('.ms-loc')).toBeNull();
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('loads the localized composition, lets the session serve its fonts and voices, then sends it to the player', async () => {
    const player = new FakePlayer();
    render(<Harness player={player} rows={[row('de')]} />);
    await userEvent.click(screen.getByRole('radio', { name: 'German' }));
    await waitFor(() => expect(player.setComposition).toHaveBeenCalledOnce());
    expect(api.getLocalizedComposition).toHaveBeenCalledWith('acme', 'c1', 3, 'reel', 'de');
    expect(api.attachLocalePreview).toHaveBeenCalledWith('acme', 'c1', 3, 'de', 'reel', 'T'.repeat(43));
    // The files are attached before the composition reaches the frame.
    expect(api.attachLocalePreview.mock.invocationCallOrder[0]!).toBeLessThan(player.setComposition.mock.invocationCallOrder[0]!);
    expect(player.setComposition.mock.calls[0]![0]).toBe(view.composition);
    expect(screen.getByRole('radio', { name: 'German' }).getAttribute('aria-checked')).toBe('true');
  });

  it('goes back to the original: the base composition (the draft) is sent again', async () => {
    const player = new FakePlayer();
    const draft = { ...base, duration: 9 } as Composition;
    render(<Harness player={player} rows={[row('de')]} original={() => draft} />);
    await userEvent.click(screen.getByRole('radio', { name: 'German' }));
    await waitFor(() => expect(player.setComposition).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole('radio', { name: 'Original (English)' }));
    expect(player.setComposition).toHaveBeenLastCalledWith(draft);
    // Without a draft the base composition is read from the core.
    const second = new FakePlayer();
    render(<Harness player={second} rows={[row('ja')]} />);
    await userEvent.click(screen.getAllByRole('radio', { name: 'Japanese' }).at(-1)!);
    await waitFor(() => expect(second.setComposition).toHaveBeenCalledOnce());
    await userEvent.click(screen.getAllByRole('radio', { name: 'Original (English)' }).at(-1)!);
    await waitFor(() => expect(second.setComposition).toHaveBeenLastCalledWith(base));
  });

  it('outlines the outdated clips with the "outdated" label, and the clips that overflow', async () => {
    view = { composition: localized({ title: 'Willkommen', sub: 'Frisch' }), localization: {
      locale: 'de', stale: ['title'], problems: ['The translation of "sub" does not fit its box, even at 70% size'], voice: 'original' } };
    const player = new FakePlayer();
    const { container } = render(<Harness player={player} rows={[row('de', { stale: ['title'] })]} />);
    await userEvent.click(screen.getByRole('radio', { name: 'German' }));
    const flags = await screen.findByRole('list', { name: 'Clips to check' });
    const items = within(flags).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Titleoutdated', 'suboutside the box']);
    // The first flagged clip is outlined at once, with its label.
    await waitFor(() => expect(player.select).toHaveBeenCalledWith('title'));
    const outline = container.querySelector('.ms-loc-outline') as HTMLElement;
    expect(outline.dataset.clip).toBe('title');
    expect(outline.className).toContain('ms-stale');
    expect(outline.textContent).toBe('outdated');
    expect(outline.style.left).toBe('10px');
    expect(outline.style.width).toBe('300px');
    // Another flagged clip is outlined when chosen from the list.
    await userEvent.click(within(flags).getByRole('button', { name: /sub/ }));
    await waitFor(() => expect((container.querySelector('.ms-loc-outline') as HTMLElement).dataset.clip).toBe('sub'));
    expect(container.querySelector('.ms-loc-outline')!.textContent).toBe('outside the box');
  });

  it('an up-to-date translation flags nothing and outlines nothing', async () => {
    const player = new FakePlayer();
    const { container } = render(<Harness player={player} rows={[row('de')]} />);
    await userEvent.click(screen.getByRole('radio', { name: 'German' }));
    await waitFor(() => expect(player.setComposition).toHaveBeenCalled());
    expect(screen.queryByRole('list', { name: 'Clips to check' })).toBeNull();
    expect(container.querySelector('.ms-loc-outline')).toBeNull();
  });

  it('says why a translation cannot be shown', async () => {
    api.getLocalizedComposition.mockRejectedValueOnce(new ApiError(409, 'The German translation no longer fits its composition', 'localization-unusable'));
    const player = new FakePlayer();
    render(<Harness player={player} rows={[row('de')]} />);
    await userEvent.click(screen.getByRole('radio', { name: 'German' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The translation cannot be shown: The German translation no longer fits its composition');
    expect(player.setComposition).not.toHaveBeenCalled();
  });

  it('a renewed session serves the translation again: the files are attached to the new token and the composition sent once more', async () => {
    const player = new FakePlayer();
    const r = render(<Harness player={player} rows={[row('de')]} token={'A'.repeat(43)} />);
    await userEvent.click(screen.getByRole('radio', { name: 'German' }));
    await waitFor(() => expect(player.setComposition).toHaveBeenCalledOnce());
    await act(async () => { r.rerender(<Harness player={player} rows={[row('de')]} token={'B'.repeat(43)} />); });
    await waitFor(() => expect(player.setComposition).toHaveBeenCalledTimes(2));
    expect(api.attachLocalePreview).toHaveBeenLastCalledWith('acme', 'c1', 3, 'de', 'reel', 'B'.repeat(43));
  });
});
