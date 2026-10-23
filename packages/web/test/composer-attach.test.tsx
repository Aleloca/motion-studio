/**
 * Report 79: the creative chat's composer. The send button always says its shortcut (with a tooltip), and the "+" attaches
 * files from the computer (saved in the library) or from the library: removable chips in the box, sent with the message,
 * shown on the user's message afterwards.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentCapabilities, AssetEntry, ConversationEntry, JobSummary } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const caps: AgentCapabilities = { cliVersion: null, liveInput: false, interrupt: false, checkedAt: '2026-10-23T10:00:00.000Z' };
const entry = (file: string, kind: AssetEntry['kind'] = 'image'): AssetEntry => ({ file, kind, origin: 'upload', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-10-23T10:00:00.000Z', attribution: null });
const api = {
  sendCreativeTurn: vi.fn(async (_s: string, _c: string, _b: unknown) => ({ id: 'j9' })),
  uploadFiles: vi.fn(async (_s: string, _k: string, files: File[], _o?: unknown) => ({ assets: files.map((f) => entry(f.name)) })),
  listAssets: vi.fn(async (_s: string) => ({ assets: [entry('logo.png'), entry('clip.mp4', 'video')], error: null, unregistered: [] })),
  projectFileUrl: (_s: string, p: string) => `/files/${p}`,
  getAgentCapabilities: vi.fn(async () => caps),
  stopJob: vi.fn(), postLiveMessage: vi.fn(), redirectJob: vi.fn(), removeQueued: vi.fn(), editQueued: vi.fn(), reorderQueue: vi.fn(), runNext: vi.fn(), decideApproval: vi.fn(),
};
class ApiError extends Error { constructor(public status: number, m: string, public code?: string, public retryAfterSec?: number, public problems?: string[]) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { Conversation } = await import('../src/components/Conversation.tsx');
const { ICONS } = await import('../src/ui/icons.ts');
const { groupOf } = await import('./support/variants.ts');

const MAC = vi.spyOn(navigator, 'platform', 'get');
beforeEach(() => { MAC.mockReturnValue('MacIntel'); vi.clearAllMocks(); });
afterEach(() => MAC.mockReset());

const running: JobSummary = { id: 'j1', key: 'creative:k', kind: 'creative', label: 'x', state: 'running', createdAt: '2026-10-23T10:00:00.000Z' };
const props = { slug: 'acme', creative: 'c1', approvals: [], pins: [], entries: [] as ConversationEntry[], job: undefined as JobSummary | undefined, onSent: vi.fn() };
type Extra = Partial<Parameters<typeof Conversation>[0]>;
const view = (extra: Extra = {}) => <I18nProvider locale="en"><Conversation {...props} {...extra} /></I18nProvider>;
const box = () => screen.getByRole('textbox', { name: 'Request a change' });
const send = () => screen.getByRole('button', { name: 'Send' });

async function attachFromComputer(user: ReturnType<typeof userEvent.setup>, name = 'logo.png') {
  await user.click(screen.getByRole('button', { name: 'Attach files' }));
  await user.click(await screen.findByRole('menuitem', { name: /^From computer/ }));
  fireEvent.change(screen.getByTestId('attach-input'), { target: { files: [new File(['x'], name, { type: 'image/png' })] } });
  await screen.findByRole('button', { name: `Remove ${name}` });
}

describe('send button (report 79)', () => {
  it('shows the shortcut beside the paper plane and a tooltip "Send (⌘↵)"', () => {
    render(view());
    expect(send().textContent).toContain('⌘↵');
    const tip = document.getElementById(send().getAttribute('aria-describedby') ?? '');
    expect(tip?.textContent).toBe('Send (⌘↵)');
  });
  it('says Ctrl+↵ elsewhere', () => {
    MAC.mockReturnValue('Win32');
    render(view());
    expect(send().textContent).toContain('Ctrl+↵');
    expect(document.getElementById(send().getAttribute('aria-describedby') ?? '')?.textContent).toBe('Send (Ctrl+↵)');
  });
});

describe('attachments in the composer (report 79)', () => {
  it('the "+" opens a menu with "From computer" and "From library"', async () => {
    const user = userEvent.setup();
    render(view());
    await user.click(screen.getByRole('button', { name: 'Attach files' }));
    const menu = await screen.findByRole('menu', { name: 'Attach files to the message' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.querySelector('b')!.textContent)).toEqual(['From computer', 'From library']);
  });

  it('a file from the computer is saved in the library and attached as a chip', async () => {
    const user = userEvent.setup();
    render(view());
    await attachFromComputer(user);
    expect(api.uploadFiles).toHaveBeenCalledTimes(1);
    expect(api.uploadFiles.mock.calls[0]!.slice(0, 2)).toEqual(['acme', 'assets']);
    // A library asset, not a brief's reference (those go to the Trash when no brief uses them).
    expect(api.uploadFiles.mock.calls[0]![3]).toBeUndefined();
    expect(screen.getByTitle('assets/logo.png').textContent).toContain('logo.png');
  });

  it('a file picked in the library is attached; its chip removes it', async () => {
    const user = userEvent.setup();
    render(view());
    await user.click(screen.getByRole('button', { name: 'Attach files' }));
    await user.click(await screen.findByRole('menuitem', { name: /^From library/ }));
    await user.click(await screen.findByRole('button', { name: 'clip.mp4' }));
    expect(api.listAssets).toHaveBeenCalledWith('acme');
    await user.click(await screen.findByRole('button', { name: 'Remove clip.mp4' }));
    expect(screen.queryByRole('button', { name: 'Remove clip.mp4' })).toBeNull();
  });

  it('sends the attachments with the message, then clears them', async () => {
    const user = userEvent.setup();
    render(view());
    await attachFromComputer(user);
    await user.type(box(), 'Use the logo');
    await user.click(send());
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'Use the logo', pins: [], attachments: ['assets/logo.png'] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove logo.png' })).toBeNull());
  });

  it('a message with only attachments can be sent', async () => {
    const user = userEvent.setup();
    render(view());
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    await attachFromComputer(user);
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    await user.click(send());
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: '', pins: [], attachments: ['assets/logo.png'] }));
  });

  it('the sent message shows its attached files', () => {
    const entries: ConversationEntry[] = [{ type: 'user', at: '2026-10-23T10:01:00.000Z', text: 'Use these', pins: [], attachments: ['assets/logo.png', 'assets/clip.mp4'] }];
    render(view({ entries }));
    const files = screen.getByRole('list', { name: 'Attached files' });
    expect(within(files).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['logo.png', 'clip.mp4']);
  });

  it('while the agent works the "+" is off and attached files wait for the next request', async () => {
    const user = userEvent.setup();
    const { rerender } = render(view());
    await attachFromComputer(user);
    rerender(view({ job: running }));
    expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The attached files go with the next request, once the agent has finished.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove logo.png' })).toBeTruthy();
  });

  it('a chat with its own transport (the brief session) has no attach button', () => {
    render(view({ transport: { start: vi.fn(), post: vi.fn() } }));
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
  });

  it('round 1: the "+" has the row\'s 28 px size', () => {
    render(view());
    expect(screen.getByRole('button', { name: 'Attach files' }).className).toContain('ms-sm');
  });
});

describe('attachments, round 1', () => {
  const deferred = () => { let resolve!: (v: { assets: AssetEntry[] }) => void; let reject!: (e: unknown) => void; const promise = new Promise<{ assets: AssetEntry[] }>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const pick = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(screen.getByRole('button', { name: 'Attach files' }));
    await user.click(await screen.findByRole('menuitem', { name: /^From computer/ }));
    fireEvent.change(screen.getByTestId('attach-input'), { target: { files: [new File(['x'], name)] } });
  };

  it('an upload in progress shows as a pending chip and blocks the send until it lands; then the file goes with the message', async () => {
    const user = userEvent.setup();
    const d = deferred();
    api.uploadFiles.mockImplementationOnce(() => d.promise);
    render(view());
    await user.type(box(), 'Use this clip');
    await pick(user, 'clip.mp4');
    const pending = await screen.findByRole('status', { name: 'Uploading clip.mp4…' });
    expect(pending.textContent).toContain('clip.mp4');
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(api.sendCreativeTurn).not.toHaveBeenCalled();
    d.resolve({ assets: [entry('clip.mp4', 'video')] });
    await screen.findByRole('button', { name: 'Remove clip.mp4' });
    expect(screen.queryByRole('status', { name: 'Uploading clip.mp4…' })).toBeNull();
    await user.click(send());
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'Use this clip', pins: [], attachments: ['assets/clip.mp4'] }));
  });

  it('a failed upload drops its pending chip, says why and unblocks the send', async () => {
    const user = userEvent.setup();
    const d = deferred();
    api.uploadFiles.mockImplementationOnce(() => d.promise);
    render(view());
    await user.type(box(), 'Hi');
    await pick(user, 'big.mov');
    await screen.findByRole('status', { name: 'Uploading big.mov…' });
    d.reject(new Error('disk full'));
    expect((await screen.findByRole('alert')).textContent).toBe('Upload failed: disk full');
    expect(screen.queryByRole('status', { name: 'Uploading big.mov…' })).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it('a chip shows the picture of an image, the kind icon otherwise, and the icon when the picture does not load', async () => {
    const user = userEvent.setup();
    render(view());
    await pick(user, 'logo.png');
    await screen.findByRole('button', { name: 'Remove logo.png' });
    api.uploadFiles.mockImplementationOnce(async () => ({ assets: [entry('clip.mp4', 'video')] }));
    await pick(user, 'clip.mp4');
    await screen.findByRole('button', { name: 'Remove clip.mp4' });
    const chip = (path: string) => screen.getByTitle(path);
    const img = chip('assets/logo.png').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/files/assets/logo.png');
    expect(chip('assets/clip.mp4').querySelector('img')).toBeNull();
    expect(chip('assets/clip.mp4').querySelector('svg path')!.getAttribute('d')).toBe(ICONS.video);
    fireEvent.error(img);
    expect(chip('assets/logo.png').querySelector('img')).toBeNull();
    expect(chip('assets/logo.png').querySelector('svg path')!.getAttribute('d')).toBe(ICONS.image);
  });

  it('the same file twice is one chip', async () => {
    const user = userEvent.setup();
    render(view());
    await pick(user, 'logo.png');
    await screen.findByRole('button', { name: 'Remove logo.png' });
    await pick(user, 'logo.png');
    await waitFor(() => expect(api.uploadFiles).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole('button', { name: 'Remove logo.png' })).toHaveLength(1);
  });

  it('a failed send keeps the chips', async () => {
    const user = userEvent.setup();
    api.sendCreativeTurn.mockRejectedValueOnce(new ApiError(409, 'busy'));
    render(view());
    await pick(user, 'logo.png');
    await user.type(box(), 'Go');
    await user.click(send());
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Remove logo.png' })).toBeTruthy();
  });

  it('a file gone from the library is dropped from the attachments with a clear message; the rest and the words stay', async () => {
    const user = userEvent.setup();
    render(view());
    await pick(user, 'logo.png');
    await screen.findByRole('button', { name: 'Remove logo.png' });
    api.uploadFiles.mockImplementationOnce(async () => ({ assets: [entry('clip.mp4', 'video')] }));
    await pick(user, 'clip.mp4');
    await screen.findByRole('button', { name: 'Remove clip.mp4' });
    await user.type(box(), 'Go');
    api.sendCreativeTurn.mockRejectedValueOnce(new ApiError(400, 'assets/logo.png is not a file of the project library.', 'attachment-invalid', undefined, ['assets/logo.png']));
    await user.click(send());
    expect((await screen.findByRole('alert')).textContent).toBe('logo.png is no longer in the library: removed from the attachments. Send again.');
    expect(screen.queryByRole('button', { name: 'Remove logo.png' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove clip.mp4' })).toBeTruthy();
    expect((box() as HTMLTextAreaElement).value).toBe('Go');
  });

  it('switching to "Tutte" drops the attached files (they would not go to every variant), and the "+" is hidden there', async () => {
    const user = userEvent.setup();
    const variants = { group: groupOf(['a', 'b']), current: 'a', all: false, missing: [], onSelect: vi.fn(), runAll: vi.fn() };
    const { rerender } = render(view({ variants: variants as never }));
    await pick(user, 'logo.png');
    await screen.findByRole('button', { name: 'Remove logo.png' });
    rerender(view({ variants: { ...variants, all: true } as never }));
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    rerender(view({ variants: variants as never }));
    expect(screen.queryByRole('button', { name: 'Remove logo.png' })).toBeNull();
  });

  it('another creative in the same chat starts with no attachments', async () => {
    const user = userEvent.setup();
    const { rerender } = render(view());
    await pick(user, 'logo.png');
    await screen.findByRole('button', { name: 'Remove logo.png' });
    rerender(view({ creative: 'c2' }));
    expect(screen.queryByRole('button', { name: 'Remove logo.png' })).toBeNull();
  });

  it('round 2: an upload still running when the chat switches creative lands nowhere, and the new composer is not blocked', async () => {
    const user = userEvent.setup();
    const d = deferred();
    api.uploadFiles.mockImplementationOnce(() => d.promise);
    const { rerender } = render(view());
    await pick(user, 'big.mp4');
    await screen.findByRole('status', { name: 'Uploading big.mp4…' });
    rerender(view({ creative: 'c2' }));
    expect(screen.queryByRole('status', { name: 'Uploading big.mp4…' })).toBeNull();
    await user.type(box(), 'Hi');
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    d.resolve({ assets: [entry('big.mp4', 'video')] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Remove big.mp4' })).toBeNull();
    await user.click(send());
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c2', { text: 'Hi', pins: [] }));
  });

  it('round 2: a late error of an abandoned upload is not shown either', async () => {
    const user = userEvent.setup();
    const d = deferred();
    api.uploadFiles.mockImplementationOnce(() => d.promise);
    const { rerender } = render(view());
    await pick(user, 'big.mp4');
    await screen.findByRole('status', { name: 'Uploading big.mp4…' });
    rerender(view({ creative: 'c2' }));
    d.reject(new Error('disk full'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('round 2: the pending chip\'s close button abandons that upload; its late result is ignored', async () => {
    const user = userEvent.setup();
    const d = deferred();
    api.uploadFiles.mockImplementationOnce(() => d.promise);
    render(view());
    await user.type(box(), 'Hi');
    await pick(user, 'big.mp4');
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    await user.click(await screen.findByRole('button', { name: 'Cancel the upload of big.mp4' }));
    expect(screen.queryByRole('status', { name: 'Uploading big.mp4…' })).toBeNull();
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    d.resolve({ assets: [entry('big.mp4', 'video')] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Remove big.mp4' })).toBeNull();
  });
});
