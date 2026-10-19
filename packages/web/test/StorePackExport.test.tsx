import { DEFAULT_FORMATS, storePackFormats, type LocaleTag, type StorePack, type VersionEntry } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

type Result = { folder: string; written: string[]; failed: Array<{ file: string; reason: string }>; rendered?: unknown[] };
const exportStorePack = vi.fn(async (_s: string, _c: string, _n: number, _b: unknown): Promise<Result> => ({ folder: '/out/fotonica-store-pack', written: [], failed: [] }));
const fileUrl = (slug: string, c: string, rel: string) => `/files/${slug}/${c}/${rel}`;
const exportStorePackGroup = vi.fn(async (_s: string, _c: string, _b: unknown): Promise<Result> => ({ folder: '/out/fotonica-store-pack', written: [], failed: [] }));
const groupExportPlan = vi.fn(async () => ({ items: [{ format: 'playstore-feature', slug: 'c1~b', letter: 'b', version: 4, source: 'pick', file: 'playstore-feature.png', width: 1, height: 1, state: 'ready' }] }));
// Decision 1333: a group's pack files come from the core (the host's brief), here with a third screenshot the open member lacks.
const storePackGroupFiles = vi.fn(async (_s: string, _c: string) => ({ formats: [...made.formats.slice(0, 2), 'appstore-iphone-69@3', ...made.formats.slice(2)], labels: { ...made.formatLabels, 'appstore-iphone-69@3': '3 · Share' } }));
const api = { exportStorePack, exportStorePackGroup, groupExportPlan, storePackGroupFiles, fileUrl };
class ApiError extends Error { constructor(public status: number, msg: string, public code?: string) { super(msg); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { StorePackExport } = await import('../src/screens/creative/StorePackExport.tsx');

const onClose = vi.fn();
// Report 48: the pack's files (iPhone ×2, App Preview, Phone ×2, Feature graphic, Promo video), each with its render in version 3.
const pack: StorePack = {
  app: { name: 'Fotonica', tagline: '' }, stores: ['appstore', 'playstore'],
  devices: { appstore: ['iphone-69'], playstore: ['phone', 'feature'] },
  screenshots: [{ caption: 'Sort', screen: null }, { caption: 'Find', screen: null }], preview: true,
};
const made = storePackFormats(pack);
const entry = { n: 3, outputs: made.formats.map((f) => ({ format: f, file: `${f}.png`, width: 10, height: 20, durationSec: null, verified: true, preview: null })) } as unknown as VersionEntry;
type Extra = { locales?: { primary: LocaleTag; extra: LocaleTag[] }; untranslated?: LocaleTag[]; needsReview?: LocaleTag[]; formats?: string[] };
const open = (extra: Extra = {}) => render(
  <I18nProvider locale="en">
    <StorePackExport open onClose={onClose} slug="acme" creative="c1" title="Fotonica" version={3} formats={made.formats} presets={DEFAULT_FORMATS} labels={made.formatLabels} entry={entry} {...extra} />
  </I18nProvider>,
);
const run = () => screen.getByRole('button', { name: /^Export \d+ files?$/ });

beforeEach(() => { vi.clearAllMocks(); localStorage.removeItem('ms.exportFolder'); });

describe('StorePackExport · request', () => {
  it('needs a destination; sends it for version n without languages when the brief has no extras', async () => {
    open();
    const dlg = screen.getByRole('dialog', { name: 'Export the store pack of “Fotonica”' });
    expect(within(dlg).queryByRole('group', { name: 'Languages' })).toBeNull();
    expect(run().hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(run());
    await waitFor(() => expect(exportStorePack).toHaveBeenCalledWith('acme', 'c1', 3, { destination: '/out' }));
    expect(localStorage.getItem('ms.exportFolder')).toBe('/out');
  });

  it('starts from the last destination of the export dialog', () => {
    localStorage.setItem('ms.exportFolder', '/last');
    open();
    expect((screen.getByLabelText('Destination folder') as HTMLInputElement).value).toBe('/last');
  });

  it('with extra languages shows the multiselect (all on) and sends the chosen ones', async () => {
    open({ locales: { primary: 'en', extra: ['it', 'de'] } });
    const group = screen.getByRole('group', { name: 'Languages' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(group).getByRole('checkbox', { name: 'English (original)' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(group).getByRole('checkbox', { name: 'Italian' }));
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(run());
    await waitFor(() => expect(exportStorePack).toHaveBeenCalledTimes(1));
    expect(exportStorePack.mock.calls[0]![3]).toEqual({ destination: '/out', locales: ['en', 'de'] });
  });

  it('cannot export with no language chosen', async () => {
    open({ locales: { primary: 'en', extra: ['it'] } });
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(screen.getByRole('checkbox', { name: 'English (original)' }));
    expect(run().hasAttribute('disabled')).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Italian' }));
    expect(run().hasAttribute('disabled')).toBe(true);
  });
});

describe('StorePackExport · reports 48 and 54, the files to export in a gallery', () => {
  const files = () => screen.getByRole('group', { name: 'Files' });
  const box = (name: string) => within(files()).getByRole('checkbox', { name });
  const tile = (name: string) => within(files()).getByRole('button', { name });
  const pressed = (name: string) => tile(name).getAttribute('aria-pressed');

  it('a gallery per store: the store\'s and the devices\' checkboxes with n/m, a pressed thumbnail per file; the button counts them', () => {
    open();
    expect(within(files()).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['App Store', 'iPhone 6.9″', 'Google Play', 'Phone']);
    expect(within(files()).getAllByRole('checkbox').every((c) => c.getAttribute('aria-checked') === 'true')).toBe(true);
    // No checkbox per file: every file is a toggle button, all pressed (in the export).
    const tiles = within(files()).getAllByRole('button', { pressed: true });
    expect(tiles.map((b) => b.getAttribute('aria-label'))).toEqual([
      'iPhone 6.9″ · 1 · Sort', 'iPhone 6.9″ · 2 · Find', 'App Preview', 'Phone · 1 · Sort', 'Phone · 2 · Find', 'Feature graphic', 'Promo video 16:9',
    ]);
    expect(within(files()).queryAllByRole('button', { pressed: false })).toEqual([]);
    expect(within(files()).getAllByRole('heading').map((h) => h.textContent)).toEqual(['App Store3/3', 'Google Play4/4']);
    // The name under each thumbnail is the formats column's label, whole in the tooltip.
    expect(tile('iPhone 6.9″ · 2 · Find').textContent).toBe('2 · Find');
    expect(tile('iPhone 6.9″ · 2 · Find').getAttribute('title')).toBe('2 · Find');
    expect(run().textContent).toBe('Export 7 files');
    const thumb = tile('Phone · 1 · Sort').querySelector('img')!;
    expect(thumb.getAttribute('src')).toMatch(/outputs\/v3\/playstore-phone-9x16\.png/);
    // Each thumbnail keeps the file's aspect ratio (the row sets the height).
    expect(tile('Feature graphic').style.getPropertyValue('--spx-a')).toBe(String(1024 / 500));
  });

  it('a click on a thumbnail leaves it out (dimmed, marked) and a second puts it back; Space and Enter do the same', async () => {
    open();
    await userEvent.click(tile('iPhone 6.9″ · 1 · Sort'));
    expect(pressed('iPhone 6.9″ · 1 · Sort')).toBe('false');
    expect(tile('iPhone 6.9″ · 1 · Sort').classList.contains('ms-off')).toBe(true);
    expect(within(tile('iPhone 6.9″ · 1 · Sort')).getByTitle('Excluded')).toBeTruthy();
    expect(box('iPhone 6.9″').getAttribute('aria-checked')).toBe('mixed');
    expect(box('App Store').getAttribute('aria-checked')).toBe('mixed');
    expect(within(files()).getAllByRole('heading')[0]!.textContent).toBe('App Store2/3');
    expect(run().textContent).toBe('Export 6 files');
    await userEvent.click(tile('iPhone 6.9″ · 1 · Sort'));
    expect(pressed('iPhone 6.9″ · 1 · Sort')).toBe('true');
    expect(within(tile('iPhone 6.9″ · 1 · Sort')).queryByTitle('Excluded')).toBeNull();
    tile('Feature graphic').focus();
    await userEvent.keyboard(' ');
    expect(pressed('Feature graphic')).toBe('false');
    await userEvent.keyboard('{Enter}');
    expect(pressed('Feature graphic')).toBe('true');
  });

  it('a device checkbox turns its screenshots off and on, not the single files at the end of its row; the store checkbox is mixed meanwhile', async () => {
    open();
    await userEvent.click(box('iPhone 6.9″'));
    expect(pressed('iPhone 6.9″ · 1 · Sort')).toBe('false');
    expect(pressed('iPhone 6.9″ · 2 · Find')).toBe('false');
    expect(pressed('App Preview')).toBe('true');
    expect(box('App Store').getAttribute('aria-checked')).toBe('mixed');
    expect(run().textContent).toBe('Export 5 files');
    await userEvent.click(tile('iPhone 6.9″ · 2 · Find'));
    expect(box('iPhone 6.9″').getAttribute('aria-checked')).toBe('mixed');
    // A mixed group turns all on.
    await userEvent.click(box('App Store'));
    expect(box('iPhone 6.9″').getAttribute('aria-checked')).toBe('true');
    expect(run().textContent).toBe('Export 7 files');
    await userEvent.click(box('Google Play'));
    expect(pressed('Phone · 2 · Find')).toBe('false');
    expect(pressed('Feature graphic')).toBe('false');
    expect(run().textContent).toBe('Export 3 files');
  });

  it('sends the selection when it is not the whole pack, in the brief\'s order; nothing chosen, no export', async () => {
    open();
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(box('Google Play'));
    await userEvent.click(tile('iPhone 6.9″ · 1 · Sort'));
    await userEvent.click(run());
    await waitFor(() => expect(exportStorePack).toHaveBeenCalledTimes(1));
    expect(exportStorePack.mock.calls[0]![3]).toEqual({ destination: '/out', formats: ['appstore-iphone-69@2', 'appstore-preview'] });
  });

  it('cannot export with no file chosen', async () => {
    open();
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(box('App Store'));
    await userEvent.click(box('Google Play'));
    expect(run().textContent).toBe('Export 0 files');
    expect(run().hasAttribute('disabled')).toBe(true);
  });

  it('while the export runs the thumbnails do not toggle', async () => {
    let finish!: (r: Result) => void;
    exportStorePack.mockImplementationOnce(() => new Promise<Result>((res) => { finish = res; }));
    open();
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(run());
    expect(tile('Phone · 1 · Sort').hasAttribute('disabled')).toBe(true);
    finish({ folder: '/out/x', written: ['a.png'], failed: [] });
    await screen.findByRole('status');
  });

  it('a variant group: thumbnails from its selection, the selection sent to the group\'s pack export', async () => {
    render(
      <I18nProvider locale="en">
        <StorePackExport open onClose={onClose} slug="acme" creative="c1" title="Fotonica" version={0} group presets={DEFAULT_FORMATS} />
      </I18nProvider>,
    );
    // The host's list (three iPhone screenshots), not a member's lagging brief.
    expect(await within(await screen.findByRole('group', { name: 'Files' })).findByRole('button', { name: 'iPhone 6.9″ · 3 · Share' })).toBeTruthy();
    expect(storePackGroupFiles).toHaveBeenCalledWith('acme', 'c1');
    expect(run().textContent).toBe('Export 8 files');
    await waitFor(() => expect(tile('Feature graphic').querySelector('img')?.getAttribute('src')).toMatch(/c1~b\/outputs\/v4\/playstore-feature\.png/));
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(box('App Store'));
    await userEvent.click(run());
    await waitFor(() => expect(exportStorePackGroup).toHaveBeenCalledWith('acme', 'c1', { destination: '/out', formats: ['playstore-phone-9x16', 'playstore-phone-9x16@2', 'playstore-feature', 'playstore-promo-16x9'] }));
  });

  it('decision 1333: a group whose files cannot be read says so and cannot export', async () => {
    storePackGroupFiles.mockRejectedValueOnce(new Error('offline'));
    render(
      <I18nProvider locale="en">
        <StorePackExport open onClose={onClose} slug="acme" creative="c1" title="Fotonica" version={0} group presets={DEFAULT_FORMATS} />
      </I18nProvider>,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('offline');
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    expect(run().hasAttribute('disabled')).toBe(true);
  });

  it('with languages the count is files × languages', async () => {
    open({ locales: { primary: 'en', extra: ['it', 'de'] } });
    expect(run().textContent).toBe('Export 21 files');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Italian' }));
    expect(run().textContent).toBe('Export 14 files');
  });
});

describe('StorePackExport · untranslated languages', () => {
  it('marks the languages without a translation and leaves them selectable', async () => {
    open({ locales: { primary: 'en', extra: ['it', 'de'] }, untranslated: ['de'] });
    const group = screen.getByRole('group', { name: 'Languages' });
    expect(within(group).getAllByText('not translated: will fail')).toHaveLength(1);
    const de = within(group).getByRole('checkbox', { name: 'German' });
    expect(de.hasAttribute('disabled')).toBe(false);
    expect(de.closest('label')!.textContent).toContain('not translated: will fail');
    expect(within(group).getByRole('checkbox', { name: 'Italian' }).closest('label')!.textContent).not.toContain('not translated');
  });
});

describe('StorePackExport · languages to review', () => {
  it('marks a language with an outdated or problem translation, apart from the untranslated ones', () => {
    open({ locales: { primary: 'en', extra: ['it', 'de'] }, untranslated: ['de'], needsReview: ['it'] });
    const group = screen.getByRole('group', { name: 'Languages' });
    expect(within(group).getByRole('checkbox', { name: 'Italian' }).closest('label')!.textContent).toContain('outdated or with problems: may fail');
    expect(within(group).getByRole('checkbox', { name: 'German' }).closest('label')!.textContent).toContain('not translated: will fail');
  });
});

describe('StorePackExport · result', () => {
  const go = async () => { await userEvent.type(screen.getByLabelText('Destination folder'), '/out'); await userEvent.click(run()); };

  it('lists the files written and the files that failed, each with its reason', async () => {
    exportStorePack.mockResolvedValueOnce({
      folder: '/out/fotonica-store-pack',
      written: ['AppStore/en/iphone-69/01-sort.png', 'AppStore/en/iphone-69/02-find.png'],
      failed: [{ file: 'AppStore/en/iphone-69/03-share.png', reason: '1290×2796 instead of 1320×2868' }, { file: 'AppStore/it/preview.mp4', reason: 'no it translation' }],
      rendered: [{ version: 3, formats: ['appstore-iphone-69'] }],
    });
    open();
    await go();
    const done = await screen.findByRole('status');
    expect(within(done).getByText('/out/fotonica-store-pack')).toBeTruthy();
    const written = within(done).getByRole('list', { name: '2 files written' });
    expect(within(written).getAllByRole('listitem').map((x) => x.textContent)).toEqual(['AppStore/en/iphone-69/01-sort.png', 'AppStore/en/iphone-69/02-find.png']);
    const failed = within(done).getByRole('list', { name: '2 files not exported' });
    expect(within(failed).getAllByRole('listitem').map((x) => x.textContent)).toEqual([
      'AppStore/en/iphone-69/03-share.png: 1290×2796 instead of 1320×2868', 'AppStore/it/preview.mp4: no it translation',
    ]);
    expect(within(done).getByText('1 format was rendered first')).toBeTruthy();
    await userEvent.click(within(done).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a result with only failures says nothing was written, in an alert, with the reasons', async () => {
    exportStorePack.mockResolvedValueOnce({
      folder: '/out/fotonica-store-pack', written: [],
      failed: [{ file: 'AppStore/en/iphone-69/01-sort.png', reason: 'not in version 3' }],
    });
    open();
    await go();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Nothing was written: every file failed its check.');
    expect(within(alert).getByText('AppStore/en/iphone-69/01-sort.png: not in version 3')).toBeTruthy();
    expect(screen.queryByRole('list', { name: /files written/ })).toBeNull();
  });

  it('a 409 (not a store pack) is shown clearly and the dialog stays open for another try', async () => {
    exportStorePack.mockRejectedValueOnce(new ApiError(409, 'This creative is not an App store pack', 'not-store-pack'));
    open();
    await go();
    expect((await screen.findByRole('alert')).textContent).toContain('This creative has no store pack to export.');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(run().hasAttribute('disabled')).toBe(false);
  });

  it('another refusal shows the core’s translated text', async () => {
    exportStorePack.mockRejectedValueOnce(new ApiError(400, 'The destination is inside the project', 'export-invalid-destination'));
    open();
    await go();
    expect((await screen.findByRole('alert')).textContent).toContain('The export failed:');
  });
});
