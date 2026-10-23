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
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { Conversation } = await import('../src/components/Conversation.tsx');

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
});
