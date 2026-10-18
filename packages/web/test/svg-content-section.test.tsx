// SVG inner editor, Task 3: the inspector's "SVG content" section of an svg clip. Colours (with their counts), texts and
// elements edit a copy of the clip's checked SVG text; each change is staged through the core (`stageSvg`, mocked here)
// and the clip's `src` then points at the staged file, one undo step per change. User test items 12 to 14: the elements are
// children of the layer in the Layers panel, and one of them has an inspector of its own (fill, stroke, visibility).
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
const { SvgSessions } = await import('../src/screens/editor/svgSessions.tsx');
const { I18nProvider } = await import('../src/i18n.tsx');
type EditorState = import('../src/screens/editor/editorContext.ts').EditorState;

const KEY = draftKey('acme', 'marchio', LOGO);
const preset = DEFAULT_FORMATS.find((p) => p.id === LOGO)!;
const stageSvg = vi.fn<(from: { kind: 'svgEdit'; clipId: string; baseSrc: string; content: string }) => Promise<StagedSvgEdit>>();
let readOnly: string | null = null;
let svgText = SVG;
const askElement = vi.fn();
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
  const [pick, setPick] = useState<{ clip: string; path: string } | null>(null);
  const svgElement = pick && pick.clip === selection ? pick.path : null;
  const selectSvgElement = (path: string | null, clipId?: string) => {
    const clip = clipId ?? selection;
    if (clip === null) return;
    setSelection(clip);
    setPick(path === null ? null : { clip, path });
  };
  useEffect(() => { actions.open(view(comp()), preset); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return null;
  const ctx = {
    slug: 'acme', creative: 'marchio', format: LOGO, primary: LOGO, draft, actions, player: null, selection, select: setSelection,
    snap: false, setSnap: () => {}, token: 'tok', staging: false, stageAsset: async () => null, readOnly, svgElement, selectSvgElement, askElement,
    stageSvg: async (from: Parameters<typeof stageSvg>[0]) => {
      const a = await stageSvg(from);
      actions.stage(a, { from });
      return a;
    },
    controls: { playing: false, ready: true, duration: 0 },
  } as unknown as EditorState;
  return <I18nProvider locale="en"><EditorContext.Provider value={ctx}><SvgSessions>{children}</SvgSessions></EditorContext.Provider></I18nProvider>;
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
  svgText = SVG;
  askElement.mockReset();
  api.getBrand.mockReset();
  api.getBrand.mockResolvedValue({ kit: { colors: [{ id: 'c1', name: 'Ink', hex: '#1B1913', role: 'primary', source: { kind: 'manual', ref: null } }], fonts: [] } });
  api.listAssets.mockReset();
  api.listAssets.mockResolvedValue({ assets: [], error: null, unregistered: [] });
  api.getEditorSvg.mockReset();
  api.getEditorSvg.mockImplementation(async (_s: string, _c: string, _t: string, path: string) => ({ path, content: svgText, warnings: [] }));
  stageSvg.mockReset();
  stageSvg.mockImplementation(async (from) => staged(from.content));
});
afterEach(() => { cleanup(); });

describe('the SVG content section', () => {
  it('reads the clip SVG through the core and lists its colours with their counts and its texts; the elements are in the layers tree', async () => {
    await mount('logo', <LayersPanel />);
    expect(await within(section()).findByRole('button', { name: '#ff0000, used 2 times' })).toBeTruthy();
    expect(within(section()).getByRole('button', { name: '#00ff00, used 1 time' })).toBeTruthy();
    expect(api.getEditorSvg).toHaveBeenCalledWith('acme', 'marchio', 'tok', 'assets/logo.svg');
    expect((within(section()).getByRole('textbox', { name: 'Text 1' }) as HTMLTextAreaElement).value).toBe('Acme');
    // No list of elements in the layer's inspector (user test item 12): they moved to the Layers panel.
    expect(within(section()).queryByRole('list', { name: 'Elements of the SVG' })).toBeNull();
    const twisty = screen.getByRole('button', { name: 'Show the elements of logo' });
    expect(twisty.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(twisty);
    expect(screen.getByRole('button', { name: 'Hide the elements of logo' }).getAttribute('aria-expanded')).toBe('true');
    const tree = await screen.findByRole('list', { name: 'Elements of logo' });
    // Named elements keep their name; the others are translated from their kind and place.
    expect(within(tree).getAllByRole('button', { name: /^(mark|Rectangle 1|Path 1|Text 1)$/ }).map((b) => b.textContent)).toEqual(['mark', 'Rectangle 1', 'Path 1', 'Text 1']);
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

  it('the eye of an element in the layers tree hides it through the staging', async () => {
    await mount('logo', <LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the elements of logo' }));
    const tree = await screen.findByRole('list', { name: 'Elements of logo' });
    fireEvent.click(within(tree).getByRole('button', { name: 'Hide Rectangle 1' }));
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(1));
    expect(stageSvg.mock.calls[0]![0].content).toMatch(/<rect[^>]*display="none"/);
    await waitFor(() => expect(draft().ops.at(-1)).toEqual({ kind: 'svgContent', clipId: 'logo', colors: 0, texts: 0, hidden: 1 }));
    expect(await within(tree).findByRole('button', { name: 'Show Rectangle 1' })).toBeTruthy();
  });

  it('an element row shows the element inspector: a way back to the layer, visibility, labelled fill and stroke, one palette', async () => {
    await mount('logo', <LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the elements of logo' }));
    fireEvent.click(within(await screen.findByRole('list', { name: 'Elements of logo' })).getByRole('button', { name: 'Path 1' }));
    const insp = document.querySelector('[data-slot="inspector"]') as HTMLElement;
    const crumbs = within(insp).getByRole('navigation', { name: 'Layer and element' });
    expect(crumbs.textContent).toBe('logoPath 1');
    expect(within(insp).getByText('SVG element')).toBeTruthy();
    // Only the element's settings: no box, no layer content.
    expect(insp.querySelector('[data-section="box"]')).toBeNull();
    expect(insp.querySelector('[data-section="svg"]')).toBeNull();
    expect((within(insp).getByRole('switch', { name: 'Visible' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    expect((within(insp).getByRole('textbox', { name: 'Fill' }) as HTMLInputElement).value).toBe('#00ff00');
    expect((within(insp).getByRole('textbox', { name: 'Stroke' }) as HTMLInputElement).value).toBe('#ff0000');
    expect(within(insp).getByText('Fill', { selector: '.ms-paint-cap' })).toBeTruthy();
    expect(within(insp).getByText('Stroke', { selector: '.ms-paint-cap' })).toBeTruthy();
    // The brand palette once, for the row in use (the fill first).
    expect(within(insp).getAllByRole('group', { name: 'Brand palette' })).toHaveLength(1);
    expect(within(insp).getByText('Swatches for: Fill')).toBeTruthy();
    fireEvent.focus(within(insp).getByRole('textbox', { name: 'Stroke' }));
    expect(within(insp).getByText('Swatches for: Stroke')).toBeTruthy();
    fireEvent.click(within(insp).getByRole('button', { name: '#1B1913' }));
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(1));
    expect(stageSvg.mock.calls[0]![0].content).toMatch(/<path[^>]*stroke="#1b1913"/i);
    // The tree marks the element, not the layer.
    expect(document.querySelector('[data-svg-element="0/1"]')!.getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('[data-layer-name="logo"]')!.getAttribute('aria-current')).toBeNull();
    // Back to the layer.
    fireEvent.click(within(crumbs).getByRole('button', { name: 'logo' }));
    expect(insp.querySelector('[data-section="svg"]')).not.toBeNull();
  });

  it('no stroke says so and can be added; a stroke can be removed', async () => {
    svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L5 5" fill="#00ff00"/></svg>';
    await mount('logo', <LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the elements of logo' }));
    fireEvent.click(within(await screen.findByRole('list', { name: 'Elements of logo' })).getByRole('button', { name: 'Path 1' }));
    const insp = document.querySelector('[data-slot="inspector"]') as HTMLElement;
    expect(within(insp).getByRole('status', { name: 'Stroke: No stroke' })).toBeTruthy();
    expect(within(insp).queryByRole('textbox', { name: 'Stroke' })).toBeNull();
    fireEvent.click(within(insp).getByRole('button', { name: 'Add stroke' }));
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(1));
    expect(stageSvg.mock.calls[0]![0].content).toMatch(/<path[^>]*stroke="#1b1913"/i);
    await waitFor(() => expect((within(insp).getByRole('textbox', { name: 'Stroke' }) as HTMLInputElement).value).toBe('#1b1913'));
    fireEvent.click(within(insp).getByRole('button', { name: 'Remove the fill' }));
    await waitFor(() => expect(stageSvg).toHaveBeenCalledTimes(2));
    expect(stageSvg.mock.calls[1]![0].content).toMatch(/<path[^>]*fill="none"/);
    expect(await within(insp).findByRole('button', { name: 'Add fill' })).toBeTruthy();
  });

  it('an element row of another svg layer selects that layer and the element', async () => {
    await mount('logo', <LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the elements of Small version' }));
    fireEvent.click(within(await screen.findByRole('list', { name: 'Elements of Small version' })).getByRole('button', { name: 'Path 1' }));
    const insp = document.querySelector('[data-slot="inspector"]') as HTMLElement;
    expect(within(insp).getByRole('navigation', { name: 'Layer and element' }).textContent).toBe('Small versionPath 1');
  });

  it('an SVG without text: the element says its lettering is drawn as shapes, and asks the agent through a comment', async () => {
    svgText = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L5 5" fill="#000"/><path id="word" d="M1 1L4 4" fill="#000"/></svg>';
    await mount('logo', <LayersPanel />);
    expect(await within(section()).findByText(/^No editable texts/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show the elements of logo' }));
    fireEvent.click(within(await screen.findByRole('list', { name: 'Elements of logo' })).getByRole('button', { name: 'word' }));
    const insp = document.querySelector('[data-slot="inspector"]') as HTMLElement;
    expect(within(insp).getByText('This SVG has no editable text: its lettering is drawn as shapes. To change the words, ask the agent.')).toBeTruthy();
    fireEvent.click(within(insp).getByRole('button', { name: 'Ask the agent to change it' }));
    expect(askElement).toHaveBeenCalledWith('logo', { path: '1', name: 'word' });
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
    await mount('logo', <LayersPanel />);
    const colour = await within(section()).findByRole('button', { name: '#ff0000, used 2 times' });
    expect((colour as HTMLButtonElement).disabled).toBe(true);
    expect((within(section()).getByRole('textbox', { name: 'Text 1' }) as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show the elements of logo' }));
    expect((within(await screen.findByRole('list', { name: 'Elements of logo' })).getByRole('button', { name: 'Hide Rectangle 1' }) as HTMLButtonElement).disabled).toBe(true);
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
