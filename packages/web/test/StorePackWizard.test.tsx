import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssetEntry } from '@motion-studio/shared';
import { storePackSchema } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const at = '2026-10-08T10:00:00.000Z';
const asset = (file: string, over: Partial<AssetEntry> = {}): AssetEntry => ({
  file, kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 100, height: 100, addedAt: at, attribution: null, ...over,
});
const api = {
  listAssets: vi.fn(async () => ({ assets: [asset('home.png'), asset('logo.svg', { kind: 'svg' }), asset('Inter.woff2', { kind: 'font' })], error: null as string | null, unregistered: [] as string[] })),
  uploadFiles: vi.fn(async (_s: string, _k: string, _f: File[]): Promise<unknown> => ({ assets: [asset('settings.png')] })),
  registerAssets: vi.fn(async () => ({ assets: [] as AssetEntry[] })),
  projectFileUrl: (s: string, rel: string) => `/files/${s}/${rel}`,
  createStorePack: vi.fn(async (_s: string, _b: unknown) => ({ slug: '2026-10-14-pack', creative: {}, job: null })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { StorePackWizard, storeBounds, buildStorePack } = await import('../src/screens/new-creative/StorePackWizard.tsx');

const onClose = vi.fn();
const open = () => render(<I18nProvider locale="en"><StorePackWizard open onClose={onClose} slug="acme" /></I18nProvider>);
const next = () => screen.getByRole('button', { name: 'Next' });
const back = () => screen.getByRole('button', { name: 'Back' });
const dialog = () => screen.getByRole('dialog', { name: 'App store pack' });
const toStores = async (name = 'Fotonica') => {
  await userEvent.type(screen.getByLabelText('App name'), name);
  await userEvent.click(next());
};
const toScreens = async () => { await toStores(); await userEvent.click(next()); };
const count = () => screen.getByRole('spinbutton', { name: 'Number of screenshots' });
const checkbox = (name: string) => screen.getByRole('checkbox', { name });

beforeEach(() => { vi.clearAllMocks(); location.hash = ''; });

describe('storeBounds', () => {
  it('App Store 1–10, Google Play 2–8, both: the narrower range', () => {
    expect(storeBounds(['appstore'])).toEqual({ min: 1, max: 10 });
    expect(storeBounds(['playstore'])).toEqual({ min: 2, max: 8 });
    expect(storeBounds(['appstore', 'playstore'])).toEqual({ min: 2, max: 8 });
  });
});

describe('StorePackWizard · steps', () => {
  it('the app name is required to leave the first step; the draft stays when going back', async () => {
    open();
    expect(next().hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText('App name'), 'Fotonica');
    await userEvent.type(screen.getByLabelText(/One line about the app/), 'Photos, tidy');
    await userEvent.click(next());
    expect(within(dialog()).getByRole('heading', { name: 'Stores and devices' })).toBeTruthy();
    await userEvent.click(back());
    expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Fotonica');
    expect((screen.getByLabelText(/One line about the app/) as HTMLInputElement).value).toBe('Photos, tidy');
  });

  it('shows the store marks and locks the required devices on', async () => {
    open();
    await toStores();
    const dlg = dialog();
    expect(within(dlg).getAllByRole('img', { name: 'App Store' }).length).toBeGreaterThan(0);
    const iphone = checkbox('iPhone 6.9″');
    expect(iphone.getAttribute('aria-checked')).toBe('true');
    expect(iphone.hasAttribute('disabled')).toBe(true);
    // The optional iPad can be switched on and off.
    const ipad = checkbox('iPad 13″');
    expect(ipad.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(ipad);
    expect(checkbox('iPad 13″').getAttribute('aria-checked')).toBe('true');
    // Google Play: its phone is required too.
    await userEvent.click(checkbox('Google Play'));
    expect(checkbox('Phone').getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Phone').hasAttribute('disabled')).toBe(true);
    expect(checkbox('Tablet').hasAttribute('disabled')).toBe(false);
    expect(checkbox('Feature graphic').hasAttribute('disabled')).toBe(false);
  });

  it('needs at least one store', async () => {
    open();
    await toStores();
    await userEvent.click(checkbox('App Store'));
    expect(next().hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Choose at least one store')).toBeTruthy();
    await userEvent.click(checkbox('Google Play'));
    expect(next().hasAttribute('disabled')).toBe(false);
  });

  it('the screenshot count stays within the bounds of the chosen stores', async () => {
    open();
    await toScreens();
    expect(count().getAttribute('aria-valuemin')).toBe('1');
    expect(count().getAttribute('aria-valuemax')).toBe('10');
    await userEvent.click(back());
    await userEvent.click(checkbox('App Store'));
    await userEvent.click(checkbox('Google Play'));
    await userEvent.click(next());
    expect(count().getAttribute('aria-valuemin')).toBe('2');
    expect(count().getAttribute('aria-valuemax')).toBe('8');
    // Arrows past the end stop at the bound.
    count().focus();
    for (let i = 0; i < 12; i++) await userEvent.keyboard('{ArrowUp}');
    expect(count().getAttribute('aria-valuenow')).toBe('8');
    expect(screen.getAllByLabelText(/^Caption of screenshot/)).toHaveLength(8);
    // Both stores: the narrower range still applies; with the App Store alone the wider one comes back.
    await userEvent.click(back());
    await userEvent.click(checkbox('App Store'));
    await userEvent.click(next());
    expect(count().getAttribute('aria-valuemin')).toBe('2');
    expect(count().getAttribute('aria-valuemax')).toBe('8');
    await userEvent.click(back());
    await userEvent.click(checkbox('Google Play'));
    await userEvent.click(next());
    expect(count().getAttribute('aria-valuemin')).toBe('1');
    expect(count().getAttribute('aria-valuemax')).toBe('10');
  });

  it('captions are optional and may be long; every row still needs an app screen or "No app screen" (decision 1221)', async () => {
    open();
    await toScreens();
    expect(next().hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Every screenshot needs a caption')).toBeNull();
    expect(screen.getByText(/Captions are optional/)).toBeTruthy();
    const caps = screen.getAllByLabelText(/^Caption of screenshot/);
    expect(caps).toHaveLength(3);
    const long = `Messaggi › Tutte, casella piena | **Tutti i clienti, un solo posto** | ${'x'.repeat(60)}`;
    await userEvent.click(caps[0]!);
    await userEvent.paste(long);
    expect((caps[0] as HTMLInputElement).value).toBe(long);
    // Captions are not asked for: an app screen or an explicit "No app screen" per row is.
    for (const n of [1, 2, 3]) await userEvent.click(screen.getByRole('button', { name: `Screenshot ${n}: no app screen` }));
    expect(next().hasAttribute('disabled')).toBe(false);
  });

  it('names the rows still missing a screen, and clears them as each is decided or picked', async () => {
    open();
    await toScreens();
    for (const [i, c] of screen.getAllByLabelText(/^Caption of screenshot/).entries()) await userEvent.type(c, `C${i + 1}`);
    expect(screen.getByText('Choose an app screen, or “No app screen”, for: 1, 2, 3')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Screenshot 2: no app screen' }));
    expect(screen.getByRole('button', { name: 'Screenshot 2: no app screen' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Choose an app screen, or “No app screen”, for: 1, 3')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose the app screen of screenshot 1' }));
    const picker = await screen.findByRole('dialog', { name: 'App screen from the library' });
    await userEvent.click(await within(picker).findByRole('button', { name: /home\.png/ }));
    await waitFor(() => expect(screen.getByText('Choose an app screen, or “No app screen”, for: 3')).toBeTruthy());
    // Picking a screen on a row marked "No app screen" takes the mark off; toggling the mark again undoes it.
    await userEvent.click(screen.getByRole('button', { name: 'Screenshot 2: no app screen' }));
    expect(screen.getByText('Choose an app screen, or “No app screen”, for: 2, 3')).toBeTruthy();
  });
});

describe('StorePackWizard · app screens', () => {
  const fillCaptions = async () => {
    for (const [i, c] of screen.getAllByLabelText(/^Caption of screenshot/).entries()) await userEvent.type(c, `Caption ${i + 1}`);
  };
  /** Marks every row that has no screen yet as "No app screen". */
  const decideRest = async () => {
    for (const b of screen.getAllByRole('button', { name: /^Screenshot \d+: no app screen$/ })) if (b.getAttribute('aria-pressed') !== 'true' && !b.closest('li')!.querySelector('img')) await userEvent.click(b);
  };

  it('picks an app screen from the library (images only) and can remove it', async () => {
    open();
    await toScreens();
    await userEvent.click(screen.getByRole('button', { name: 'Choose the app screen of screenshot 1' }));
    const picker = await screen.findByRole('dialog', { name: 'App screen from the library' });
    const list = await within(picker).findByRole('list', { name: 'Library images' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['home.png']);
    await userEvent.click(within(list).getByRole('button', { name: /home\.png/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'App screen from the library' })).toBeNull());
    expect(screen.getByText('home.png')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove the screen of screenshot 1' }));
    expect(screen.queryByText('home.png')).toBeNull();
  });

  it('uploads an image inline (into assets/ through the library upload) and picks it', async () => {
    open();
    await toScreens();
    await userEvent.click(screen.getByRole('button', { name: 'Choose the app screen of screenshot 2' }));
    const picker = await screen.findByRole('dialog', { name: 'App screen from the library' });
    const file = new File(['x'], 'settings.png', { type: 'image/png' });
    fireEvent.change(within(picker).getByLabelText('Image file to upload'), { target: { files: [file] } });
    await waitFor(() => expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'assets', [file]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'App screen from the library' })).toBeNull());
    expect(screen.getByText('settings.png')).toBeTruthy();
  });

  it('a failed upload shows the core’s own error and keeps the picker open', async () => {
    api.uploadFiles.mockRejectedValueOnce(new Error('settings.png is a symbolic link: not accepted'));
    open();
    await toScreens();
    await userEvent.click(screen.getByRole('button', { name: 'Choose the app screen of screenshot 1' }));
    const picker = await screen.findByRole('dialog', { name: 'App screen from the library' });
    fireEvent.change(within(picker).getByLabelText('Image file to upload'), { target: { files: [new File(['x'], 'settings.png')] } });
    expect((await within(picker).findByRole('alert')).textContent).toContain('settings.png is a symbolic link: not accepted');
    expect(screen.getByRole('dialog', { name: 'App screen from the library' })).toBeTruthy();
  });

  it('review shows the choices and Generate sends the validated pack', async () => {
    open();
    await toStores('Fotonica');
    await userEvent.click(checkbox('iPad 13″'));
    await userEvent.click(next());
    await fillCaptions();
    await userEvent.click(screen.getByRole('button', { name: 'Choose the app screen of screenshot 1' }));
    const picker = await screen.findByRole('dialog', { name: 'App screen from the library' });
    await userEvent.click(await within(picker).findByRole('button', { name: /home\.png/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'App screen from the library' })).toBeNull());
    await decideRest();
    await userEvent.click(next());
    // Step 4: the preview.
    expect(within(dialog()).getByRole('heading', { name: 'Preview video' })).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    await userEvent.click(next());
    const dlg = dialog();
    expect(within(dlg).getByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(within(dlg).getByText('Fotonica')).toBeTruthy();
    // 3 screenshots on 2 devices + the preview video.
    expect(within(dlg).getByText('7 formats will be created')).toBeTruthy();
    expect(within(dlg).getByText(/1 · Caption 1/)).toBeTruthy();
    expect(within(dlg).getByText('Without an app screen: screenshots 2, 3')).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(api.createStorePack).toHaveBeenCalledTimes(1));
    const [slug, body] = api.createStorePack.mock.calls[0]! as [string, { title: string; storePack: unknown; generate: boolean }];
    expect(slug).toBe('acme');
    expect(body.title).toBe('Fotonica · App store pack');
    expect(body.generate).toBe(true);
    expect(body.storePack).toEqual({
      app: { name: 'Fotonica', tagline: '' },
      stores: ['appstore'],
      devices: { appstore: ['iphone-69', 'ipad-13'] },
      screenshots: [{ caption: 'Caption 1', screen: 'assets/home.png' }, { caption: 'Caption 2', screen: null }, { caption: 'Caption 3', screen: null }],
      preview: true,
    });
    expect(storePackSchema.safeParse(body.storePack).success).toBe(true);
    expect(location.hash).toContain('2026-10-14-pack');
  });

  it('a refusal of the core stays on the review with its text; the draft is kept', async () => {
    api.createStorePack.mockRejectedValueOnce(new Error('assets/home.png is a symbolic link: not accepted'));
    open();
    await toScreens();
    await fillCaptions();
    await decideRest();
    await userEvent.click(next());
    await userEvent.click(next());
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect((await screen.findByRole('alert')).textContent).toContain('assets/home.png is a symbolic link: not accepted');
    expect(api.createStorePack.mock.calls[0]![1]).toMatchObject({ generate: false });
    expect(within(dialog()).getByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(false);
  });

  it('the steps are reachable from the step list with the keyboard, only when the earlier ones are done', async () => {
    open();
    const nav = screen.getByRole('list', { name: 'Steps' });
    const steps = within(nav).getAllByRole('button');
    expect(steps).toHaveLength(5);
    expect(steps[0]!.getAttribute('aria-current')).toBe('step');
    expect(steps[2]!.hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByLabelText('App name'), 'Fotonica');
    expect(steps[2]!.hasAttribute('disabled')).toBe(false);
    steps[1]!.focus();
    await userEvent.keyboard('{Enter}');
    expect(within(dialog()).getByRole('heading', { name: 'Stores and devices' })).toBeTruthy();
    expect(document.activeElement?.tagName).toBe('H3');
  });
});

describe('StorePackWizard · picker types and closing', () => {
  it('lists only the image types the core accepts (PNG, JPEG, WebP), not SVG or GIF', async () => {
    api.listAssets.mockResolvedValueOnce({ assets: [asset('a.png'), asset('b.JPG'), asset('c.webp'), asset('d.gif'), asset('e.svg'), asset('f.svg', { kind: 'svg' })], error: null, unregistered: [] });
    open();
    await toScreens();
    await userEvent.click(screen.getByRole('button', { name: 'Choose the app screen of screenshot 1' }));
    const list = await screen.findByRole('list', { name: 'Library images' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual(['a.png', 'b.JPG', 'c.webp']);
  });

  it('an inline upload of another type says why in the picker of that row and keeps it open', async () => {
    api.uploadFiles.mockResolvedValueOnce({ assets: [asset('anim.gif')] });
    open();
    await toScreens();
    await userEvent.click(screen.getByRole('button', { name: 'Choose the app screen of screenshot 2' }));
    const picker = await screen.findByRole('dialog', { name: 'App screen from the library' });
    fireEvent.change(within(picker).getByLabelText('Image file to upload'), { target: { files: [new File(['x'], 'anim.gif')] } });
    expect((await within(picker).findByRole('alert')).textContent).toBe('Only images (PNG, JPEG or WebP) can be an app screen');
    expect(screen.queryByText('anim.gif', { selector: '.ms-spw-file' })).toBeNull();
  });

  it('closing an empty wizard needs no confirmation', async () => {
    open();
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Discard this pack?' })).toBeNull();
  });

  it('closing with a draft asks first: Keep editing keeps it, Discard closes', async () => {
    open();
    await userEvent.type(screen.getByLabelText('App name'), 'Fotonica');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    const ask = await screen.findByRole('dialog', { name: 'Discard this pack?' });
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard this pack?' })).toBeNull());
    expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Fotonica');
    await userEvent.keyboard('{Escape}');
    const again = await screen.findByRole('dialog', { name: 'Discard this pack?' });
    await userEvent.click(within(again).getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('buildStorePack', () => {
  it('builds the pack with only the chosen stores’ devices and trimmed texts', () => {
    const pack = buildStorePack({
      name: ' Fotonica ', tagline: ' hi ', stores: ['playstore'], devices: { appstore: ['iphone-69'], playstore: ['phone', 'feature'] },
      count: 2, shots: [{ caption: ' a ', screen: null }, { caption: 'b', screen: 'assets/x.png' }, { caption: 'ignored', screen: null }], preview: false,
    });
    expect(pack).toEqual({
      app: { name: 'Fotonica', tagline: 'hi' }, stores: ['playstore'], devices: { playstore: ['phone', 'feature'] },
      screenshots: [{ caption: 'a', screen: null }, { caption: 'b', screen: 'assets/x.png' }], preview: false,
    });
  });
});
