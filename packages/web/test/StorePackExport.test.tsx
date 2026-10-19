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
const api = { exportStorePack, exportStorePackGroup, groupExportPlan, fileUrl };
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

describe('StorePackExport · report 48, the files to export', () => {
  const files = () => screen.getByRole('group', { name: 'Files' });
  const box = (name: string) => within(files()).getByRole('checkbox', { name });

  it('lists the files by store and device with their thumbnails, all checked; the button counts them', () => {
    open();
    expect(within(files()).getAllByRole('checkbox').filter((c) => c.getAttribute('aria-checked') !== 'true')).toEqual([]);
    expect(box('App Store').getAttribute('aria-checked')).toBe('true');
    expect(box('Google Play').getAttribute('aria-checked')).toBe('true');
    expect(box('iPhone 6.9″')).toBeTruthy();
    expect(box('iPhone 6.9″ · 2 · Find')).toBeTruthy();
    expect(box('Feature graphic')).toBeTruthy();
    expect(box('App Preview')).toBeTruthy();
    expect(run().textContent).toBe('Export 7 files');
    const thumb = box('Phone · 1 · Sort').closest('.ms-spx-file')!.querySelector('img')!;
    expect(thumb.getAttribute('src')).toMatch(/outputs\/v3\/playstore-phone-9x16\.png/);
  });

  it('a device checkbox turns its screenshots off and on; the store checkbox is mixed meanwhile', async () => {
    open();
    await userEvent.click(box('iPhone 6.9″'));
    expect(box('iPhone 6.9″ · 1 · Sort').getAttribute('aria-checked')).toBe('false');
    expect(box('iPhone 6.9″ · 2 · Find').getAttribute('aria-checked')).toBe('false');
    expect(box('App Store').getAttribute('aria-checked')).toBe('mixed');
    expect(run().textContent).toBe('Export 5 files');
    await userEvent.click(box('iPhone 6.9″ · 2 · Find'));
    expect(box('iPhone 6.9″').getAttribute('aria-checked')).toBe('mixed');
    // A mixed group turns all on.
    await userEvent.click(box('App Store'));
    expect(box('iPhone 6.9″').getAttribute('aria-checked')).toBe('true');
    expect(run().textContent).toBe('Export 7 files');
    await userEvent.click(box('Google Play'));
    expect(box('Phone · 2 · Find').getAttribute('aria-checked')).toBe('false');
    expect(box('Feature graphic').getAttribute('aria-checked')).toBe('false');
    expect(run().textContent).toBe('Export 3 files');
  });

  it('sends the selection when it is not the whole pack, in the brief\'s order; nothing chosen, no export', async () => {
    open();
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(box('Google Play'));
    await userEvent.click(box('iPhone 6.9″ · 1 · Sort'));
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

  it('a variant group: thumbnails from its selection, the selection sent to the group\'s pack export', async () => {
    render(
      <I18nProvider locale="en">
        <StorePackExport open onClose={onClose} slug="acme" creative="c1" title="Fotonica" version={0} group formats={made.formats} presets={DEFAULT_FORMATS} labels={made.formatLabels} />
      </I18nProvider>,
    );
    await waitFor(() => expect(box('Feature graphic').closest('.ms-spx-file')!.querySelector('img')?.getAttribute('src')).toMatch(/c1~b\/outputs\/v4\/playstore-feature\.png/));
    await userEvent.type(screen.getByLabelText('Destination folder'), '/out');
    await userEvent.click(box('App Store'));
    await userEvent.click(run());
    await waitFor(() => expect(exportStorePackGroup).toHaveBeenCalledWith('acme', 'c1', { destination: '/out', formats: ['playstore-phone-9x16', 'playstore-phone-9x16@2', 'playstore-feature', 'playstore-promo-16x9'] }));
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
