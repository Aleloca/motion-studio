import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, workspaceSettingsSchema, type Brief, type CreativeDetail, type JobSummary, type VersionEntry } from '@motion-studio/shared';
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
  updateCreative: vi.fn(async (_s: string, _c: string, body: { formats?: string[]; formatLabels?: Record<string, string>; brief?: Brief }) => {
    if (body.brief) serverBrief = body.brief;
    if (body.formats) serverBrief = { ...serverBrief, formats: body.formats };
    if (body.formatLabels) serverBrief = { ...serverBrief, formatLabels: body.formatLabels };
    return { brief: serverBrief };
  }),
  sendCreativeTurn: vi.fn(async () => ({})),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
  exportPicks: vi.fn(async () => ({ destination: '/d', files: [], skipped: [] as string[] })),
  updateSettings: vi.fn(async (patch: object) => workspaceSettingsSchema.parse({ schemaVersion: 1, ...patch })),
  prepareExport: vi.fn(async (): Promise<{ renders: Array<{ version: number; formats: string[]; job: JobSummary; covers: boolean }> }> => ({ renders: [] })),
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
    expect(parseRoute(href.edit('acme', 'c', POST2))).toMatchObject({ name: 'edit', format: POST2 });
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
    expect(lastBody()).toEqual({ formatLabels: {} });
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
    fireEvent.dragStart(first!);
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

  it('the preset chip adds the first instance and takes out every instance of it', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: /^Post 1:1/, pressed: true }));
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
