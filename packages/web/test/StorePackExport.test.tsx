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

describe('StorePackExport · reports 48 and 54 (variant A): the stores on the left, an item\'s files on the right', () => {
  const nav = () => screen.getByRole('navigation', { name: 'Stores and devices' });
  const box = (name: string) => within(nav()).getByRole('checkbox', { name });
  const item = (name: string) => within(nav()).getByRole('button', { name: new RegExp(`^${name}`) });
  const grid = () => screen.getByRole('group', { name: 'Files' });
  const tile = (name: string) => within(grid()).getByRole('button', { name });
  const pressed = (name: string) => tile(name).getAttribute('aria-pressed');

  it('lists the stores (a checkbox each) and their items with kind, size and n/m; the first device is shown, its files all in', () => {
    open();
    expect(within(nav()).getAllByRole('checkbox').map((c) => [c.getAttribute('aria-label'), c.getAttribute('aria-checked')])).toEqual([['App Store', 'true'], ['Google Play', 'true']]);
    const items = within(nav()).getAllByRole('button').filter((b) => b.classList.contains('ms-spx-item'));
    expect(items.map((b) => b.textContent)).toEqual([
      'iPhone 6.9″2 screenshots2/2', 'App Previewvideo · 886 × 19201/1', 'Phone2 screenshots2/2', 'Feature graphicimage · 1024 × 5001/1', 'Promo video 16:9video · 1920 × 10801/1',
    ]);
    expect(item('iPhone 6.9″').getAttribute('aria-current')).toBe('true');
    expect(within(nav()).getByText('7 of 7 files selected')).toBeTruthy();
    expect(screen.getByText('Version 3 · one folder per store, language and device')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'iPhone 6.9″' })).toBeTruthy();
    expect(screen.getByText('2 screenshots · 1320 × 2868')).toBeTruthy();
    expect(within(grid()).getAllByRole('button', { pressed: true }).map((b) => b.getAttribute('aria-label'))).toEqual(['iPhone 6.9″ · 1 · Sort', 'iPhone 6.9″ · 2 · Find']);
    // The name under each thumbnail is the formats column's label, whole in the tooltip; the thumbnail keeps the file's shape.
    expect(tile('iPhone 6.9″ · 2 · Find').textContent).toBe('2 · Find');
    expect(tile('iPhone 6.9″ · 2 · Find').getAttribute('title')).toBe('2 · Find');
    expect(tile('iPhone 6.9″ · 2 · Find').style.getPropertyValue('--spx-a')).toBe(String(1320 / 2868));
    expect((grid() as HTMLElement).style.getPropertyValue('--spx-cols')).toBe('4');
    expect(run().textContent).toBe('Export 7 files');
  });

  it('a click on an item shows it, without turning anything on or off; landscape files get two columns', async () => {
    open();
    await userEvent.click(item('Feature graphic'));
    expect(item('Feature graphic').getAttribute('aria-current')).toBe('true');
    expect(item('iPhone 6.9″').hasAttribute('aria-current')).toBe(false);
    expect(screen.getByRole('heading', { name: 'Feature graphic' })).toBeTruthy();
    expect(within(grid()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Feature graphic']);
    expect((grid() as HTMLElement).style.getPropertyValue('--spx-cols')).toBe('2');
    expect(tile('Feature graphic').querySelector('img')!.getAttribute('src')).toMatch(/outputs\/v3\/playstore-feature\.png/);
    expect(run().textContent).toBe('Export 7 files');
  });

  it('a click on a thumbnail leaves it out and a second puts it back; Space and Enter do the same; the counts follow', async () => {
    open();
    await userEvent.click(tile('iPhone 6.9″ · 1 · Sort'));
    expect(pressed('iPhone 6.9″ · 1 · Sort')).toBe('false');
    expect(tile('iPhone 6.9″ · 1 · Sort').classList.contains('ms-off')).toBe(true);
    expect(item('iPhone 6.9″').textContent).toContain('1/2');
    expect(box('App Store').getAttribute('aria-checked')).toBe('mixed');
    expect(within(nav()).getByText('6 of 7 files selected')).toBeTruthy();
    expect(run().textContent).toBe('Export 6 files');
    await userEvent.click(tile('iPhone 6.9″ · 1 · Sort'));
    expect(pressed('iPhone 6.9″ · 1 · Sort')).toBe('true');
    tile('iPhone 6.9″ · 2 · Find').focus();
    await userEvent.keyboard(' ');
    expect(pressed('iPhone 6.9″ · 2 · Find')).toBe('false');
    await userEvent.keyboard('{Enter}');
    expect(pressed('iPhone 6.9″ · 2 · Find')).toBe('true');
  });

  it('"Select all" and "None" act on the item shown only', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(within(grid()).queryAllByRole('button', { pressed: true })).toEqual([]);
    expect(item('iPhone 6.9″').textContent).toContain('0/2');
    expect(item('App Preview').textContent).toContain('1/1');
    expect(run().textContent).toBe('Export 5 files');
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(run().textContent).toBe('Export 7 files');
  });

  it('a store\'s checkbox, or a click on its name, turns the whole store off and on; mixed turns all on', async () => {
    open();
    await userEvent.click(box('Google Play'));
    expect(box('Google Play').getAttribute('aria-checked')).toBe('false');
    expect(item('Promo video 16:9').textContent).toContain('0/1');
    expect(run().textContent).toBe('Export 3 files');
    await userEvent.click(within(nav()).getByText('Google Play'));
    expect(box('Google Play').getAttribute('aria-checked')).toBe('true');
    await userEvent.click(tile('iPhone 6.9″ · 2 · Find'));
    await userEvent.click(box('App Store'));
    expect(box('App Store').getAttribute('aria-checked')).toBe('true');
    expect(run().textContent).toBe('Export 7 files');
  });

  it('arrow keys move along the items in the list', async () => {
    open();
    item('iPhone 6.9″').focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('App Preview'));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(item('Phone'));
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(item('iPhone 6.9″'));
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
    expect(tile('iPhone 6.9″ · 1 · Sort').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'None' }).hasAttribute('disabled')).toBe(true);
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
    await userEvent.click(item('Feature graphic'));
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

  it('with languages the count is files × languages; the languages sit under the stores in the list', async () => {
    open({ locales: { primary: 'en', extra: ['it', 'de'] } });
    expect(within(screen.getByRole('navigation', { name: 'Stores and devices' })).getByRole('group', { name: 'Languages' })).toBeTruthy();
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
