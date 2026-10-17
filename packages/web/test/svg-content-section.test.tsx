// SVG inner editor, Task 3: the inspector's "SVG content" section of an svg clip. Colours (with their counts), texts and
// elements edit a copy of the clip's checked SVG text; each change is staged through the core (`stageSvg`, mocked here)
// and the clip's `src` then points at the staged file, one undo step per change.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_FORMATS, type Composition, type EditorCompositionView, type StagedSvgEdit } from '@motion-studio/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LOGO = 'identity-logo';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="mark"><rect width="50" height="50" fill="#ff0000"/>'
  + '<path d="M0 0L10 10" stroke="#FF0000" fill="#00ff00"/></g><text x="1" y="90">Acme</text></svg>';

const api = vi.hoisted(() => ({ getBrand: vi.fn(), listAssets: vi.fn(), getEditorSvg: vi.fn() }));
class FakeApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string, public readonly retryAfterSec?: number, public readonly problems?: string[]) { super(message); }
}
vi.mock('../src/api.ts', () => ({ api, ApiError: FakeApiError }));

const { EditorContext } = await import('../src/screens/editor/editorContext.ts');
const { __resetDrafts, draftKey, isDirty, peekDraft, useDraft } = await import('../src/screens/editor/draftStore.ts');
const { Inspector } = await import('../src/screens/editor/Inspector.tsx');
const { LayersPanel } = await import('../src/screens/editor/LayersPanel.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
type EditorState = import('../src/screens/editor/editorContext.ts').EditorState;

const KEY = draftKey('acme', 'marchio', LOGO);
const preset = DEFAULT_FORMATS.find((p) => p.id === LOGO)!;
const stageSvg = vi.fn<(from: { kind: 'svgEdit'; clipId: string; baseSrc: string; content: string }) => Promise<StagedSvgEdit>>();
let readOnly: string | null = null;
let acts: import('../src/screens/editor/draftStore.ts').DraftActions | null = null;
const undo = () => acts!.undo();
const redo = () => acts!.redo();

const svgClip = (id: string, src: string, hidden = false) => ({ id, type: 'svg', src, start: 0, duration: 0, ...(hidden ? { hidden: true } : {}), props: { fit: 'contain' } });
function comp(): Composition {
  return {
    $schema: 'motion-studio/composition@1', width: 1024, height: 1024, fps: 30, duration: 0, background: '#ffffff', fonts: [], scenes: [],
    tracks: [{ id: 't', kind: 'visual', clips: [svgClip('logo', 'assets/logo.svg'), svgClip('small', 'assets/small.svg', true), svgClip('dark', 'assets/logo.svg', true)] }],
  } as unknown as Composition;
}
function view(c: Composition): EditorCompositionView {
  return { n: 1, format: LOGO, primaryFormat: LOGO, hash: 'h'.repeat(64), composition: structuredClone(c), files: [{ path: 'assets/logo.svg', size: 300 }, { path: 'assets/small.svg', size: 100 }], fonts: [] };
}

function Harness({ children, select }: { children: ReactNode; select: string }) {
  const [draft, actions] = useDraft(KEY);
  acts = actions;
  const [selection, setSelection] = useState<string | null>(select);
  const [svgElement, selectSvgElement] = useState<string | null>(null);
  useEffect(() => { actions.open(view(comp()), preset); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return null;
  const ctx = {
    slug: 'acme', creative: 'marchio', format: LOGO, primary: LOGO, draft, actions, player: null, selection, select: setSelection,
    snap: false, setSnap: () => {}, token: 'tok', staging: false, stageAsset: async () => null, readOnly, svgElement, selectSvgElement,
    stageSvg: async (from: Parameters<typeof stageSvg>[0]) => {
      const a = await stageSvg(from);
      actions.stage(a, { from });
      return a;
    },
    controls: { playing: false, ready: true, duration: 0 },
  } as unknown as EditorState;
  return <I18nProvider locale="en"><EditorContext.Provider value={ctx}>{children}</EditorContext.Provider></I18nProvider>;
}

async function mount(id = 'logo', extra?: ReactNode) {
  const r = render(<Harness select={id}><Inspector />{extra}</Harness>);
  await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
  return r;
}
const draft = () => peekDraft(KEY)!;
const clipOf = (id: string) => draft().composition.tracks.flatMap((t) => t.clips).find((k) => k.id === id)! as unknown as { src: string };
const section = () => screen.getByRole('region', { name: 'SVG content' });
const staged = (content: string): StagedSvgEdit => ({ path: `assets/lib/logo-e${String(content.length).padStart(8, '0')}.svg`, size: content.length, kind: 'svg', svgEdit: true, warnings: [] });

async function recolour(from: string, to: string) {
  fireEvent.click(await within(section()).findByRole('button', { name: new RegExp(`^${from}, used`) }));
  const field = within(section()).getByRole('textbox', { name: `New colour for ${from}` });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: to } });
  fireEvent.keyDown(field, { key: 'Enter' });
  return field;
}

beforeEach(() => {
  __resetDrafts();
  readOnly = null;
  api.getBrand.mockReset();
  api.getBrand.mockResolvedValue({ kit: { colors: [{ id: 'c1', name: 'Ink', hex: '#1B1913', role: 'primary', source: { kind: 'manual', ref: null } }], fonts: [] } });
  api.listAssets.mockReset();
  api.listAssets.mockResolvedValue({ assets: [], error: null, unregistered: [] });
  api.getEditorSvg.mockReset();
  api.getEditorSvg.mockImplementation(async (_s: string, _c: string, _t: string, path: string) => ({ path, content: SVG, warnings: [] }));
  stageSvg.mockReset();
  stageSvg.mockImplementation(async (from) => staged(from.content));
});
afterEach(() => { cleanup(); });

describe('the SVG content section', () => {
  it('reads the clip SVG through the core and lists its colours with their counts, its texts and its elements', async () => {
    await mount();
    expect(await within(section()).findByRole('button', { name: '#ff0000, used 2 times' })).toBeTruthy();
    expect(within(section()).getByRole('button', { name: '#00ff00, used 1 time' })).toBeTruthy();
    expect(api.getEditorSvg).toHaveBeenCalledWith('acme', 'marchio', 'tok', 'assets/logo.svg');
    expect((within(section()).getByRole('textbox', { name: 'Text 1' }) as HTMLTextAreaElement).value).toBe('Acme');
    const list = within(section()).getByRole('list', { name: 'Elements of the SVG' });
    // Named elements keep their name; the others are translated from their kind and place.
    expect(within(list).getAllByRole('button', { name: /^(mark|Rectangle 1|Path 1|Text 1)$/ }).map((b) => b.textContent)).toEqual(['mark', 'Rectangle 1', 'Path 1', 'Text 1']);
  });

  it('a colour change stages the new text from the clip file and points the clip at it, as one undo step', async () => {
    await mount();
    const field = await recolour('#ff0000', '#0000ff');
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(1));
    const from = stageSvg.mock.calls[0]![0];
    expect(from).toMatchObject({ kind: 'svgEdit', clipId: 'logo', baseSrc: 'assets/logo.svg' });
    expect(from.content).not.toMatch(/#ff0000|#FF0000/);
    expect(from.content.match(/#0000ff/g)).toHaveLength(2);
    await waitFor(() => expect(clipOf('logo').src).toBe(staged(from.content).path));
    expect(draft().ops).toEqual([{ kind: 'clipMedia', clipId: 'logo', src: staged(from.content).path }, { kind: 'svgContent', clipId: 'logo', colors: 1, texts: 0, hidden: 0 }]);
    expect(draft().past).toHaveLength(1);
    expect(await within(section()).findByRole('button', { name: '#0000ff, used 2 times' })).toBeTruthy();
    // The colour field stays the same field (not remounted by its own change): it now edits the new colour.
    expect(within(section()).getByRole('textbox', { name: 'New colour for #0000ff' })).toBe(field);
    // The file the clip now shows is known: no second read.
    expect(api.getEditorSvg).toHaveBeenCalledTimes(1);
  });

  it('undo restores the previous src and text, redo brings the edit back; a second edit starts from the staged file', async () => {
    await mount();
    await recolour('#ff0000', '#0000ff');
    await waitFor(() => expect(clipOf('logo').src).toMatch(/^assets\/lib\//));
    const first = clipOf('logo').src;
    act(() => undo());
    expect(clipOf('logo').src).toBe('assets/logo.svg');
    expect(draft().ops).toEqual([]);
    expect(await within(section()).findByRole('button', { name: '#ff0000, used 2 times' })).toBeTruthy();
    act(() => redo());
    expect(clipOf('logo').src).toBe(first);
    expect(await within(section()).findByRole('button', { name: '#0000ff, used 2 times' })).toBeTruthy();
    await recolour('#00ff00', '#123456');
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(2));
    expect(stageSvg.mock.calls[1]![0]).toMatchObject({ baseSrc: first });
  });

  it('a text change stages the new content', async () => {
    await mount();
    const box = await within(section()).findByRole('textbox', { name: 'Text 1' });
    fireEvent.change(box, { target: { value: 'Beta' } });
    fireEvent.blur(box);
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(1));
    expect(stageSvg.mock.calls[0]![0].content).toContain('>Beta</text>');
    await waitFor(() => expect(draft().ops.at(-1)).toEqual({ kind: 'svgContent', clipId: 'logo', colors: 0, texts: 1, hidden: 0 }));
  });

  it('hides an element, and selecting one shows its own paint', async () => {
    await mount();
    fireEvent.click(await within(section()).findByRole('button', { name: 'Hide Rectangle 1' }));
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(1));
    expect(stageSvg.mock.calls[0]![0].content).toMatch(/<rect[^>]*display="none"/);
    await waitFor(() => expect(draft().ops.at(-1)).toEqual({ kind: 'svgContent', clipId: 'logo', colors: 0, texts: 0, hidden: 1 }));
    expect(await within(section()).findByRole('button', { name: 'Show Rectangle 1' })).toBeTruthy();
    fireEvent.click(within(section()).getByRole('button', { name: 'Path 1' }));
    expect(within(section()).getByRole('button', { name: 'Path 1' }).getAttribute('aria-current')).toBe('true');
    expect((within(section()).getByRole('textbox', { name: 'Element fill' }) as HTMLInputElement).value).toBe('#00ff00');
    expect((within(section()).getByRole('textbox', { name: 'Element stroke' }) as HTMLInputElement).value).toBe('#ff0000');
  });

  it('a refused edit shows the reasons and keeps the src; the editor goes on working', async () => {
    stageSvg.mockRejectedValue(new FakeApiError(400, 'logo.svg did not pass the SVG safety check (1 reason)', 'svg-edit-refused', undefined, ['the SVG is over 512 KB']));
    await mount();
    await recolour('#ff0000', '#0000ff');
    const alert = await within(section()).findByRole('alert');
    expect(alert.textContent).toContain('logo.svg did not pass the SVG safety check (1 reason)');
    expect(alert.textContent).toContain('the SVG is over 512 KB');
    expect(clipOf('logo').src).toBe('assets/logo.svg');
    expect(draft().ops).toEqual([]);
    expect(within(section()).getByRole('button', { name: '#ff0000, used 2 times' })).toBeTruthy();
  });

  it('an SVG the core check refuses cannot be edited here: the reason shows, the other sections stay', async () => {
    api.getEditorSvg.mockRejectedValue(new FakeApiError(400, 'logo.svg did not pass the SVG safety check (1 reason)', 'svg-edit-refused', undefined, ['<script> is not allowed']));
    await mount();
    const alert = await within(section()).findByRole('alert');
    expect(alert.textContent).toContain('This SVG can’t be edited here');
    expect(alert.textContent).toContain('<script> is not allowed');
    expect(within(section()).queryByRole('list', { name: 'Elements of the SVG' })).toBeNull();
    expect(document.querySelector('[data-section="box"]')).toBeTruthy();
  });

  it('a discarded variant shows the section disabled', async () => {
    readOnly = 'This variant is discarded';
    await mount();
    const colour = await within(section()).findByRole('button', { name: '#ff0000, used 2 times' });
    expect((colour as HTMLButtonElement).disabled).toBe(true);
    expect((within(section()).getByRole('textbox', { name: 'Text 1' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((within(section()).getByRole('button', { name: 'Hide Rectangle 1' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(section()).getByText('This variant is discarded')).toBeTruthy();
  });

  it('two clips sharing a file: only the selected one gets the new file', async () => {
    await mount();
    await recolour('#ff0000', '#0000ff');
    await waitFor(() => expect(clipOf('logo').src).toMatch(/^assets\/lib\//));
    expect(clipOf('dark').src).toBe('assets/logo.svg');
  });

  it('the draft says changes are pending from the change until they are applied, and a late answer for a reopened draft is dropped', async () => {
    let finish: (a: StagedSvgEdit) => void = () => {};
    stageSvg.mockImplementationOnce((from) => new Promise((r) => { finish = () => r(staged(from.content)); }));
    await mount();
    await recolour('#ff0000', '#0000ff');
    expect(draft().svgPending.has('logo')).toBe(true);
    // No edit applied yet, but leaving would ask (the leave guard and the close confirmation use isDirty).
    expect(draft().ops).toEqual([]);
    expect(isDirty(draft())).toBe(true);
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(1));
    expect(draft().svgPending.has('logo')).toBe(true);
    // Saved (or discarded) meanwhile: a new draft opens under the same key.
    act(() => { acts!.discard(); acts!.open(view(comp()), preset); });
    const gen = draft().gen;
    await act(async () => { finish(staged('x')); await Promise.resolve(); });
    expect(draft().gen).toBe(gen);
    expect(clipOf('logo').src).toBe('assets/logo.svg');
    expect(draft().ops).toEqual([]);
    expect(draft().svgPending.size).toBe(0);
  });

  it('an undo while a change is on its way drops its result', async () => {
    await mount();
    await recolour('#ff0000', '#0000ff');
    await waitFor(() => expect(clipOf('logo').src).toMatch(/^assets\/lib\//));
    let finish: () => void = () => {};
    stageSvg.mockImplementationOnce((from) => new Promise((r) => { finish = () => r(staged(from.content)); }));
    await recolour('#00ff00', '#123456');
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(2));
    act(() => undo());
    expect(clipOf('logo').src).toBe('assets/logo.svg');
    await act(async () => { finish(); await Promise.resolve(); });
    await waitFor(() => expect(draft().svgPending.size).toBe(0));
    expect(clipOf('logo').src).toBe('assets/logo.svg');
    expect(draft().ops).toEqual([]);
  });

  it('a refused change keeps the changes made after it, which are staged next', async () => {
    let refuse: () => void = () => {};
    stageSvg.mockImplementationOnce(() => new Promise((_r, j) => { refuse = () => j(new FakeApiError(400, 'refused', 'svg-edit-refused', undefined, ['a reason'])); }));
    await mount();
    await recolour('#ff0000', '#0000ff');
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(1));
    const box = within(section()).getByRole('textbox', { name: 'Text 1' });
    fireEvent.change(box, { target: { value: 'Beta' } });
    fireEvent.blur(box);
    await act(async () => { refuse(); await Promise.resolve(); });
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(2));
    expect(stageSvg.mock.calls[1]![0]).toMatchObject({ baseSrc: 'assets/logo.svg' });
    expect(stageSvg.mock.calls[1]![0].content).toContain('>Beta</text>');
    await waitFor(() => expect(clipOf('logo').src).toMatch(/^assets\/lib\//));
    expect(draft().svgPending.size).toBe(0);
  });

  it('the hidden logo versions have readable layer names, and the section says they do not change with the main logo', async () => {
    await mount('logo', <LayersPanel />);
    const layers = screen.getByRole('list', { name: 'Layers of this image' });
    expect(within(layers).getByRole('button', { name: /^Small version/ })).toBeTruthy();
    expect(within(layers).getByRole('button', { name: /^Negative for dark backgrounds/ })).toBeTruthy();
    expect(within(section()).getByText('The other versions of the logo do not change: edit them from the layer list')).toBeTruthy();
  });
});
