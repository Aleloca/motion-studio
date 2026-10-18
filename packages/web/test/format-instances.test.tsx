import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, workspaceSettingsSchema, type Brief, type CreativeDetail, type VersionEntry } from '@motion-studio/shared';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import type { FormatState } from '../src/screens/versionModel.ts';

const POST = 'instagram-post-1x1';
const POST2 = 'instagram-post-1x1@2';
const BANNER = 'web-banner-300x250';
let serverBrief: Brief;
const api = {
  getSecrets: vi.fn(async () => []),
  getKeyChecks: vi.fn(async () => ({})),
  updateCreative: vi.fn(async (_s: string, _c: string, body: { formats?: string[]; formatLabels?: Record<string, string | null>; brief?: Brief }) => {
    if (body.brief) serverBrief = body.brief;
    if (body.formats) serverBrief = { ...serverBrief, formats: body.formats };
    if (body.formatLabels) {
      const m: Record<string, string> = { ...(serverBrief.formatLabels ?? {}) };
      for (const [k, v] of Object.entries(body.formatLabels)) { if (v) m[k] = v; else delete m[k]; }
      serverBrief = { ...serverBrief, formatLabels: m };
    }
    return { brief: serverBrief };
  }),
  sendCreativeTurn: vi.fn(async () => ({})),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  // Decision 974: the dialog starts the export as a background job.
  exportPicksJob: vi.fn(async () => ({ job: { id: 'e1', key: 'export:/w:acme:lancio:0a1b2c3d', kind: 'export' as const, label: 'Export', state: 'queued' as const, createdAt: '2026-10-08T10:00:00.000Z' } })),
  updateSettings: vi.fn(async (patch: object) => workspaceSettingsSchema.parse({ schemaVersion: 1, ...patch })),
};
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { BriefEditor } = await import('../src/components/BriefEditor.tsx');
const { ExportDialog } = await import('../src/screens/ExportDialog.tsx');
const { boardLabel, boardName } = await import('../src/screens/CanvasBoard.tsx');
const { boardsWith } = await import('../src/screens/canvasModel.ts');
const { parseRoute, href } = await import('../src/routes.ts');

const baseBrief = (over: Partial<Brief> = {}): Brief => ({ goal: 'Launch', message: '', formats: [POST, POST2, BANNER], durationSec: 6, assets: [], notes: '', ...over });
const detail = (b: Brief): CreativeDetail => ({
  slug: 'c1', jobKey: 'k', versions: [],
  creative: { schemaVersion: 1, title: 'Launch', brief: b, status: 'draft', error: null, resumeFrom: null, linkedCodebases: [], createdAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:00:00.000Z' },
});
const en = (node: ReactNode) => <I18nProvider locale="en">{node}</I18nProvider>;
const mount = (b: Brief = baseBrief(), onRefresh = vi.fn()) => {
  serverBrief = b;
  render(en(<BriefEditor slug="acme" detail={detail(b)} presets={DEFAULT_FORMATS} disabled={false} onChanged={() => {}} onRefresh={onRefresh} />));
  return { onRefresh };
};
const rows = () => within(screen.getByRole('list', { name: 'Formats of this creative' })).getAllByRole('listitem');
const names = () => rows().map((r) => r.querySelector('b')!.textContent);
const lastBody = () => api.updateCreative.mock.calls.at(-1)![2];

beforeEach(() => { vi.clearAllMocks(); });

describe('format instances · names', () => {
  it('shows the label, else Name #k, else Name', () => {
    mount(baseBrief({ formatLabels: { [POST2]: 'Summer promo' } }));
    expect(names()).toEqual(['Post 1:1', 'Summer promo', 'Banner 300×250']);
    expect(screen.queryByText('Post 1:1 #2')).toBeNull();
  });

  it('a second instance without a label is Name #2', () => {
    mount();
    expect(names()).toEqual(['Post 1:1', 'Post 1:1 #2', 'Banner 300×250']);
  });

  it('boards and labels of the canvas follow the same rule', () => {
    const boards = boardsWith([POST, POST2], DEFAULT_FORMATS, [], () => ({ format: POST, n: null }), { [POST2]: 'Promo' });
    expect(boards.map((b) => boardName(b, 'en'))).toEqual(['Post 1:1', 'Promo']);
    expect(boardLabel(boards[1]!, 'en')).toBe('Instagram · Promo');
    expect(boards[1]!.preset?.id).toBe(POST2);
  });

  it('the route reads an instance id, raw or as %40', () => {
    expect(parseRoute(href.format('acme', 'c', POST2))).toEqual({ name: 'format', slug: 'acme', creative: 'c', format: POST2 });
    expect(parseRoute('#/p/acme/c/c/f/instagram-post-1x1%402')).toMatchObject({ format: POST2 });
    expect(parseRoute(`${href.format('acme', 'c', POST2)}/edit`)).toMatchObject({ name: 'format', format: POST2 });
    // Only the instance pattern: no encoded slash, no @1 or @21.
    for (const bad of ['x%2Fy', 'x@1', 'x@21', 'x%40001']) expect(parseRoute(`#/p/acme/c/c/f/${bad}`).name).not.toBe('format');
  });
});

describe('format instances · project cards', () => {
  it('a card names its instances by their labels, else Name #k', async () => {
    const { ProjectCreatives } = await import('../src/screens/ProjectCreatives.tsx');
    (api as unknown as Record<string, unknown>).listCreatives = vi.fn(async () => [
      { ok: true, slug: 'c1', title: 'Launch', status: 'ready', formats: [POST, POST2, BANNER], formatLabels: { [POST2]: 'Summer promo' }, versions: 1, updatedAt: '2026-10-08T10:00:00.000Z', cover: null },
    ]);
    (api as unknown as Record<string, unknown>).getFormats = vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' }));
    render(en(<ProjectCreatives slug="acme" live={{ approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} } as never} />));
    const card = await screen.findByRole('article');
    await waitFor(() => expect(within(card).getByText('Summer promo')).toBeTruthy());
    expect(within(card).getByText('Post 1:1')).toBeTruthy();
  });
});

describe('format instances · brief editor', () => {
  it('a label edit saves formatLabels only, merged by the core, and reloads the creative', async () => {
    const { onRefresh } = mount();
    const field = screen.getByLabelText('Label of Post 1:1 #2');
    await userEvent.type(field, 'Summer promo');
    expect(api.updateCreative).not.toHaveBeenCalled();
    await userEvent.tab();
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(api.updateCreative).toHaveBeenCalledWith('acme', 'c1', { formatLabels: { [POST2]: 'Summer promo' } });
    expect(onRefresh).toHaveBeenCalled();
    await waitFor(() => expect(names()[1]).toBe('Summer promo'));
  });

  it('Enter commits the label; an unchanged label saves nothing; clearing removes the key', async () => {
    mount(baseBrief({ formatLabels: { [POST2]: 'Promo' } }));
    const field = screen.getByLabelText('Label of Promo');
    await userEvent.type(field, '{Enter}');
    expect(api.updateCreative).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, '{Enter}');
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastBody()).toEqual({ formatLabels: { [POST2]: '' } });
  });

  it('move down and up reorder with the keyboard alternative and save formats only', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Move Post 1:1 down' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastBody()).toEqual({ formats: [POST2, POST, BANNER] });
    expect(names()).toEqual(['Post 1:1 #2', 'Post 1:1', 'Banner 300×250']);
    await userEvent.click(screen.getByRole('button', { name: 'Move Banner 300×250 up' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({ formats: [POST2, BANNER, POST] });
    expect((screen.getByRole('button', { name: 'Move Post 1:1 #2 up' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('dragging a row onto another reorders the same way', async () => {
    mount();
    const [first, , third] = rows();
    // Only the handle drags: the row itself is not a drag source.
    expect(first!.getAttribute('draggable')).toBeNull();
    fireEvent.dragStart(first!.querySelector('.ms-brief-inst-grip')!);
    fireEvent.dragOver(third!);
    fireEvent.drop(third!);
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastBody()).toEqual({ formats: [POST2, BANNER, POST] });
  });

  it('removing asks first, says the saved versions are kept, and saves the formats', async () => {
    mount(baseBrief({ formatLabels: { [POST2]: 'Promo' } }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Promo' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Promo?' });
    expect(within(dialog).getByText(/Saved versions are kept/)).toBeTruthy();
    expect(api.updateCreative).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(names()).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Promo' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Remove Promo?' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastBody()).toEqual({ formats: [POST, BANNER] });
    expect(names()).toEqual(['Post 1:1', 'Banner 300×250']);
  });

  it('Add another adds the next free instance of the same preset right after it', async () => {
    mount(baseBrief({ formats: [POST, BANNER] }));
    await userEvent.click(screen.getByRole('button', { name: 'Add another Post 1:1' }));
    expect(names()).toEqual(['Post 1:1', 'Post 1:1 #2', 'Banner 300×250']);
    await userEvent.click(screen.getByRole('button', { name: 'Add another Post 1:1' }));
    expect(names()).toEqual(['Post 1:1', 'Post 1:1 #2', 'Post 1:1 #3', 'Banner 300×250']);
    // Nothing is saved until Save: the instances do not exist on the server yet.
    expect(api.updateCreative).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect((lastBody().brief as Brief).formats).toEqual([POST, POST2, 'instagram-post-1x1@3', BANNER]);
  });

  it('a new instance reordered before Save is not sent as a partial save', async () => {
    mount(baseBrief({ formats: [POST, BANNER] }));
    await userEvent.click(screen.getByRole('button', { name: 'Add another Post 1:1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move Post 1:1 #2 down' }));
    expect(names()).toEqual(['Post 1:1', 'Banner 300×250', 'Post 1:1 #2']);
    expect(api.updateCreative).not.toHaveBeenCalled();
  });

  it('the preset chip takes out every saved instance only after a confirmation that names them and keeps saved versions', async () => {
    mount(baseBrief({ formatLabels: { [POST2]: 'Promo' } }));
    await userEvent.click(screen.getByRole('button', { name: /^Post 1:1/, pressed: true }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Post 1:1, Promo?' });
    expect(within(dialog).getByText(/Saved versions are kept/)).toBeTruthy();
    expect(names()).toHaveLength(3);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(names()).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: /^Post 1:1/, pressed: true }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastBody()).toEqual({ formats: [BANNER] });
    expect(names()).toEqual(['Banner 300×250']);
  });

  it('a chip that only holds unsaved instances turns off at once', async () => {
    mount(baseBrief({ formats: [BANNER] }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: /^Post 1:1/ }));
    expect(names()).toEqual(['Banner 300×250', 'Post 1:1']);
    await userEvent.click(screen.getByRole('button', { name: /^Post 1:1/, pressed: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(names()).toEqual(['Banner 300×250']);
  });

  it('a full save sends the labels of the formats it keeps', async () => {
    mount(baseBrief({ formatLabels: { [POST2]: 'Promo' } }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastBody().brief).toMatchObject({ formats: [POST, POST2, BANNER], formatLabels: { [POST2]: 'Promo' } });
  });

  it('a partial-save failure is shown', async () => {
    mount();
    api.updateCreative.mockRejectedValueOnce(new ApiError(409, 'Wait for the generation'));
    await userEvent.click(screen.getByRole('button', { name: 'Move Post 1:1 down' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't save the formats: Wait for the generation");
    // The list goes back to what the server has.
    expect(names()).toEqual(['Post 1:1', 'Post 1:1 #2', 'Banner 300×250']);
  });

  it('a failed partial save keeps the unsaved "Add another" rows (Q4)', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Add another Banner 300×250' }));
    expect(names()).toEqual(['Post 1:1', 'Post 1:1 #2', 'Banner 300×250', 'Banner 300×250 #2']);
    api.updateCreative.mockRejectedValueOnce(new ApiError(409, 'Wait for the generation'));
    await userEvent.click(screen.getByRole('button', { name: 'Move Post 1:1 down' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Wait for the generation');
    // Only the failed move is undone: the saved order is back and the new instance is still there.
    expect(names()).toEqual(['Post 1:1', 'Post 1:1 #2', 'Banner 300×250', 'Banner 300×250 #2']);
  });

  it('a failed label save undoes that label only and keeps other typed labels (Q4)', async () => {
    mount();
    const boxes = () => screen.getAllByRole('textbox', { name: /label/i }) as HTMLInputElement[];
    const first = boxes()[1]!, second = boxes()[2]!;
    fireEvent.change(second, { target: { value: 'Typed not saved' } });
    api.updateCreative.mockRejectedValueOnce(new ApiError(409, 'Wait for the generation'));
    await userEvent.type(first, 'Promo{Enter}');
    await screen.findByRole('alert');
    expect(boxes()[1]!.value).toBe('');
    expect(boxes()[2]!.value).toBe('Typed not saved');
  });

  it('a failed partial save goes back to the latest stored brief, not the one captured earlier (Q4)', async () => {
    mount();
    let release: (v: unknown) => void = () => {};
    let fail: (e: unknown) => void = () => {};
    api.updateCreative
      .mockImplementationOnce(() => new Promise((res) => { release = res; }) as never)
      .mockImplementationOnce(() => new Promise((_r, rej) => { fail = rej; }) as never);
    await userEvent.click(screen.getByRole('button', { name: 'Move Post 1:1 down' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move Banner 300×250 up' }));
    expect(names()).toEqual(['Post 1:1 #2', 'Banner 300×250', 'Post 1:1']);
    await act(async () => { release({ brief: { ...serverBrief, formats: [POST2, POST, BANNER] } }); });
    await act(async () => { fail(new ApiError(409, 'Wait for the generation')); });
    await screen.findByRole('alert');
    expect(names()).toEqual(['Post 1:1 #2', 'Post 1:1', 'Banner 300×250']);
  });

  it('a legacy brief with an odd format id says which one on save, and removing it fixes the brief', async () => {
    mount(baseBrief({ formats: [POST, 'Old Format_X'] }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    expect((await screen.findByRole('alert')).textContent).toContain('“Old Format_X”');
    expect(api.updateCreative).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Old Format_X' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledOnce());
    expect(lastBody()).toEqual({ formats: [POST] });
    await userEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
    await waitFor(() => expect(api.updateCreative).toHaveBeenCalledTimes(2));
  });
});

describe('format instances · export rows', () => {
  const out = (format: string, ext: string) => ({ format, file: `${format}.${ext}`, width: 1080, height: 1080, durationSec: null, verified: true, preview: null });
  const version: VersionEntry = { n: 3, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-08T10:00:00.000Z', request: '', outputs: [out(POST, 'png'), out(POST2, 'png')], problems: [], tools: [], renderCommand: null, basedOn: null };
  const st = (id: string): FormatState => ({ id, history: [3], star: { version: 3, manual: false, newer: null, follows: null }, defaultVersion: 3, exportVersion: 3, starFileMissing: false, linkable: [], follows: null });
  const open = (pattern: string, labels?: Record<string, string>) => render(en(
    <ExportDialog open onClose={() => {}} slug="acme" creative="c1" title="Summer" snapshot={{ versions: [version], states: { [POST]: st(POST), [POST2]: st(POST2) } }}
      presets={DEFAULT_FORMATS} labels={labels} pattern={pattern} />,
  ));

  it('rows carry the label, or Name #2, and the instance has its own file name', () => {
    open('{title}-{format}-v{v}', { [POST2]: 'Summer promo' });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Instagram · Post 1:1')).toBeTruthy();
    expect(within(dialog).getByText('Instagram · Summer promo')).toBeTruthy();
    expect(within(dialog).getByText('summer-instagram-post-1x1-2-v3.png')).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: 'Export Instagram · Summer promo' })).toBeTruthy();
  });

  it('without a label the row is Name #2', () => {
    open('{title}-{format}-v{v}');
    expect(within(screen.getByRole('dialog')).getByText('Instagram · Post 1:1 #2')).toBeTruthy();
  });

  it('a pattern without {format} keeps the instances apart as the core does, instead of a collision', () => {
    open('{title}-v{v}');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByText('summer-v3.png').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('summer-v3-instagram-post-1x1-2.png')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Export 2 files' })).toBeTruthy();
  });
});
