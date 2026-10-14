import type { LocaleTag } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

type Result = { folder: string; written: string[]; failed: Array<{ file: string; reason: string }>; rendered?: unknown[] };
const exportStorePack = vi.fn(async (_s: string, _c: string, _n: number, _b: unknown): Promise<Result> => ({ folder: '/out/fotonica-store-pack', written: [], failed: [] }));
const api = { exportStorePack };
class ApiError extends Error { constructor(public status: number, msg: string, public code?: string) { super(msg); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { StorePackExport } = await import('../src/screens/creative/StorePackExport.tsx');

const onClose = vi.fn();
const open = (extra: { locales?: { primary: LocaleTag; extra: LocaleTag[] }; untranslated?: LocaleTag[]; needsReview?: LocaleTag[] } = {}) => render(
  <I18nProvider locale="en">
    <StorePackExport open onClose={onClose} slug="acme" creative="c1" title="Fotonica" version={3} {...extra} />
  </I18nProvider>,
);
const run = () => screen.getByRole('button', { name: 'Export the pack' });

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
