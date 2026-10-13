import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_FORMATS, type AssetEntry, type Composition, type EditorCompositionView, type EditorFontOption, type StagedAsset } from '@motion-studio/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import spikeJson from '../../shared/test/fixtures/spike-composition.json';

const REEL = 'instagram-reel-9x16';
const spike = spikeJson as unknown as Composition;
const at = '2026-10-13T10:00:00.000Z';

const asset = (file: string, kind: AssetEntry['kind'], description = ''): AssetEntry => ({
  file, kind, origin: 'upload', sourceUrl: null, description, tags: [], width: null, height: null, addedAt: at, attribution: null,
});
const LIBRARY: AssetEntry[] = [
  asset('assets/new.png', 'image', 'A new picture'), asset('assets/clip.mp4', 'video', 'A short clip'), asset('assets/other.png', 'image'),
  asset('assets/song.mp3', 'audio'), asset('fonts/f.ttf', 'font'), asset('assets/mark.svg', 'svg'),
];
const api = vi.hoisted(() => ({
  getBrand: vi.fn(),
  listAssets: vi.fn(),
  uploadFiles: vi.fn(),
  registerAssets: vi.fn(),
}));
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));

const { EditorContext } = await import('../src/screens/editor/editorContext.ts');
const { __resetDrafts, draftKey, peekDraft, useDraft } = await import('../src/screens/editor/draftStore.ts');
const { Inspector } = await import('../src/screens/editor/Inspector.tsx');
const { useNudgeKeys } = await import('../src/screens/editor/useEditorKeys.ts');
const { nudgeClip, nudgeable } = await import('../src/screens/editor/nudge.ts');
const { fieldProblems } = await import('../src/screens/editor/inspector/problems.ts');
const { I18nProvider } = await import('../src/i18n.tsx');
const { createClock } = await import('../src/ui/clock.ts');
type EditorState = import('../src/screens/editor/editorContext.ts').EditorState;

const KEY = draftKey('acme', 'lancio', REEL);
const preset = DEFAULT_FORMATS.find((p) => p.id === REEL)!;
const clock = createClock();
const controls = { pause: vi.fn(), seek: vi.fn(), toggle: vi.fn(), step: vi.fn() };

let stageImpl: (from: unknown) => Promise<StagedAsset | null>;
const stageSpy = vi.fn();
let staging = false;
let fonts: EditorFontOption[] = [];
let select: string | null = null;

const filesOf = (c: Composition) => {
  const set = new Set<string>(c.fonts.map((f) => f.src));
  for (const t of c.tracks) for (const k of t.clips) {
    if ('src' in k) set.add(k.src);
    if (k.type === 'html') for (const p of Object.values(k.params ?? {})) if (p.type === 'image') set.add(p.value);
  }
  set.add('assets/new.png');
  return [...set].map((path) => ({ path, size: 10 }));
};
function view(c: Composition): EditorCompositionView {
  return { n: 1, format: REEL, primaryFormat: REEL, hash: 'h'.repeat(64), composition: structuredClone(c), files: filesOf(c), fonts };
}

function Harness({ children, comp }: { children: ReactNode; comp: Composition }) {
  const [draft, actions] = useDraft(KEY);
  const [selection, setSelection] = useState<string | null>(select);
  useEffect(() => { actions.open(view(comp), preset); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return null;
  const ctx = {
    slug: 'acme', creative: 'lancio', format: REEL, primary: REEL, draft, actions, player: null, selection, select: setSelection,
    snap: false, setSnap: () => {}, token: 't', staging,
    stageAsset: async (from: unknown) => {
      stageSpy(from);
      const a = await stageImpl(from);
      if (a) actions.stage(a);
      return a;
    },
    controls: { clock, playing: false, ready: true, duration: 6, ...controls },
  } as unknown as EditorState;
  return <I18nProvider locale="en"><EditorContext.Provider value={ctx}>{children}</EditorContext.Provider></I18nProvider>;
}

const comp0 = (): Composition => structuredClone(spike);
async function mount(id: string | null, comp: Composition = comp0()) {
  select = id;
  const r = render(<Harness comp={comp}><Inspector /></Harness>);
  await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
  return r;
}
const comp = () => peekDraft(KEY)!.composition;
const clipData = (id: string) => comp().tracks.flatMap((t) => t.clips).find((k) => k.id === id)!;
const ops = () => peekDraft(KEY)!.ops;
const last = () => ops().at(-1)!;
const sections = () => [...document.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'));
const num = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement;
function typeNum(name: string, value: string) {
  const el = num(name);
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: 'Enter' });
}
async function pickOption(trigger: string | RegExp, option: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name: trigger }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  __resetDrafts();
  select = null;
  staging = false;
  fonts = [];
  stageSpy.mockReset();
  stageImpl = async () => null;
  api.getBrand.mockReset();
  api.getBrand.mockResolvedValue({ kit: { colors: [{ id: 'c1', name: 'Ink', hex: '#1B1913', role: 'primary', source: { kind: 'manual', ref: null } }], fonts: [] } });
  api.listAssets.mockReset();
  api.listAssets.mockResolvedValue({ assets: LIBRARY, error: null, unregistered: [] });
  api.uploadFiles.mockReset();
  api.registerAssets.mockReset();
  for (const f of Object.values(controls)) f.mockClear();
});
afterEach(() => { cleanup(); });

describe('what the inspector shows', () => {
  it('asks to select a clip when none is selected', async () => {
    await mount(null);
    expect(screen.getByText('Select a clip')).toBeTruthy();
    expect(sections()).toEqual([]);
  });

  it.each([
    ['title', ['timing', 'box', 'text', 'animation']],
    ['card', ['timing', 'box', 'shape', 'animation']],
    ['photo1', ['timing', 'box', 'media', 'animation']],
    ['logo1', ['timing', 'box', 'media', 'animation']],
    ['bgv', ['timing', 'box', 'media', 'animation']],
    ['music', ['timing', 'audio']],
  ])('%s: only its own sections', async (id, expected) => {
    await mount(id);
    expect(sections()).toEqual(expected);
  });

  it('an html clip shows its declared parameters, and none when it declares none', async () => {
    await mount('outro-html');
    expect(sections()).toEqual(['timing', 'box', 'animation']);
    cleanup();
    __resetDrafts();
    const c = comp0();
    const html = c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'outro-html')!;
    (html as { params?: unknown }).params = { headline: { type: 'text', value: 'Hi', label: 'Headline' }, accent: { type: 'color', value: '#112233' }, size: { type: 'number', value: 3 }, pic: { type: 'image', value: 'assets/photo.jpg' } };
    await mount('outro-html', c);
    expect(sections()).toEqual(['timing', 'box', 'params', 'animation']);
    expect(screen.getByRole('textbox', { name: 'Headline' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'accent' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'size' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace…' })).toBeTruthy();
  });

  it('a still image has no timing and no animation; the box has no scale field', async () => {
    const still = comp0();
    still.duration = 0; still.scenes = []; still.fps = 30;
    still.tracks = [{ id: 'v', kind: 'visual', clips: [{ id: 'pic', type: 'image', src: 'assets/photo.jpg', start: 0, duration: 0, props: { x: 0, y: 0 } }] }];
    still.fonts = [];
    await mount('pic', still);
    expect(sections()).toEqual(['box', 'media']);
    expect(screen.queryByRole('spinbutton', { name: /scale/i })).toBeNull();
    expect(screen.queryByText(/scale/i)).toBeNull();
  });

  it('the box offers X, Y, width, height, rotation and opacity as keyboard fields', async () => {
    await mount('card');
    for (const n of ['X position', 'Y position', 'Width', 'Height', 'Rotation (degrees)', 'Opacity (0 to 1)']) expect(num(n)).toBeTruthy();
    expect(screen.getAllByRole('slider', { name: 'Opacity' })).toHaveLength(1);
  });

  it('a locked clip shows every field disabled and says so', async () => {
    const c = comp0();
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'card') as { locked?: boolean }).locked = true;
    await mount('card', c);
    expect(screen.getByText('Locked: unlock it in the timeline to edit it')).toBeTruthy();
    expect(num('X position').disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Hex colour' }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('every field edits through apply', () => {
  it('timing: IN keeps the duration, DUR and OUT change the length, never past the composition', async () => {
    await mount('title'); // 0.2 + 1.8
    typeNum('In point (seconds)', '0.5');
    expect(last()).toMatchObject({ kind: 'clipTiming', clipId: 'title', ripple: false });
    // The clip stays inside its scene (Intro ends at 2 s): the duration is cut back by applyEdit, the field shows the draft.
    expect(clipData('title')).toMatchObject({ start: 0.5, duration: expect.closeTo(1.5, 5) });
    expect(num('Duration (seconds)').value).toBe('1.5');
    typeNum('Duration (seconds)', '1');
    expect(clipData('title')).toMatchObject({ start: 0.5, duration: 1 });
    typeNum('Out point (seconds)', '1.2');
    expect(clipData('title')).toMatchObject({ start: 0.5, duration: expect.closeTo(0.7, 5) });
  });

  it('box: typed and arrow edits write clipProps, clamped to the schema bounds', async () => {
    await mount('card');
    typeNum('X position', '120');
    expect(last()).toMatchObject({ kind: 'clipProps', clipId: 'card', props: { x: 120 } });
    typeNum('Opacity (0 to 1)', '0.5');
    typeNum('Opacity (0 to 1)', '5');
    expect((clipData('card') as { props: { opacity?: number } }).props.opacity).toBe(1);
    typeNum('Rotation (degrees)', '99999');
    expect((clipData('card') as { props: { rotation?: number } }).props.rotation).toBe(3600);
    typeNum('Width', '-4');
    expect((clipData('card') as { props: { width?: number } }).props.width).toBe(0);
    fireEvent.keyDown(num('X position'), { key: 'ArrowUp', shiftKey: true });
    expect((clipData('card') as { props: { x?: number } }).props.x).toBe(130);
    expect(peekDraft(KEY)!.problems.filter((p) => p.key.startsWith('editor.'))).toEqual([]);
  });

  it('a burst of arrow presses is one undo step', async () => {
    await mount('card');
    const before = ops().length;
    for (let i = 0; i < 4; i++) fireEvent.keyDown(num('X position'), { key: 'ArrowUp' });
    expect(ops().length).toBe(before + 1);
    expect((clipData('card') as { props: { x?: number } }).props.x).toBe(((spike.tracks.flatMap((t) => t.clips).find((k) => k.id === 'card') as { props: { x?: number } }).props.x ?? 0) + 4);
  });

  it('text: content, size, colour (hex and swatches) and alignment', async () => {
    await mount('title');
    fireEvent.change(screen.getByRole('textbox', { name: 'Content' }), { target: { value: 'New headline' } });
    expect(last()).toMatchObject({ kind: 'clipProps', clipId: 'title', props: { text: 'New headline' } });
    typeNum('Size', '64');
    expect(last()).toMatchObject({ props: { fontSize: 64 } });
    await waitFor(() => expect(screen.getByRole('button', { name: '#1B1913' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '#1B1913' }));
    expect(last()).toMatchObject({ props: { color: '#1B1913' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Right' }));
    expect(last()).toMatchObject({ props: { align: 'right' } });
    expect(document.querySelector('input[type="color"]')).toBeNull();
    expect(document.querySelector('select, input[type="range"]')).toBeNull();
  });

  it('colour swatches also offer the colours the composition already uses', async () => {
    await mount('card');
    const group = await screen.findByRole('group', { name: 'In this composition' });
    expect(within(group).getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('shape: fill and radius', async () => {
    await mount('card');
    const input = screen.getByRole('textbox', { name: 'Hex colour' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '#abcdef' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(last()).toMatchObject({ kind: 'clipProps', clipId: 'card', props: { fill: '#abcdef' } });
    typeNum('Corner radius', '24');
    expect(last()).toMatchObject({ props: { radius: 24 } });
  });

  it('video: trim start and volume; audio: volume and fades, clamped', async () => {
    await mount('bgv');
    typeNum('Trim start (seconds)', '1.5');
    expect(last()).toMatchObject({ kind: 'clipMedia', clipId: 'bgv', trimStart: 1.5 });
    typeNum('Volume', '9');
    expect(last()).toMatchObject({ kind: 'clipMedia', volume: 2 });
    cleanup();
    __resetDrafts();
    await mount('vo'); // 0.5 + 4
    typeNum('Fade in (seconds)', '1');
    expect(last()).toMatchObject({ kind: 'clipMedia', clipId: 'vo', fadeIn: 1 });
    typeNum('Fade out (seconds)', '99');
    expect(last()).toMatchObject({ fadeOut: 4 });
    expect(screen.getAllByRole('slider', { name: 'Volume' })).toHaveLength(1);
  });

  it('animation: IN and OUT presets with their duration; None removes it; a custom animation is left to the agent', async () => {
    await mount('card');
    await pickOption(/Animation · In/, 'Slide up');
    expect(last()).toMatchObject({ kind: 'animationPreset', clipId: 'card', slot: 'in', preset: 'slideUp' });
    typeNum('Duration (seconds) · In', '0.8');
    expect(last()).toMatchObject({ slot: 'in', preset: 'slideUp', duration: 0.8 });
    await pickOption(/Animation · Out/, 'Fade out');
    expect(last()).toMatchObject({ slot: 'out', preset: 'fadeOut' });
    await pickOption(/Animation · In/, 'None');
    expect(last()).toMatchObject({ slot: 'in', preset: null });
    cleanup();
    __resetDrafts();
    const c = comp0();
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'card') as { animations?: unknown }).animations = [{ prop: 'opacity', from: 0, to: 1, duration: 0.5 }];
    await mount('card', c);
    expect(screen.getByText('Custom animation · ask the agent to change it')).toBeTruthy();
  });

  it('html parameters: one field per declared param, by type', async () => {
    const c = comp0();
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'outro-html') as { params?: unknown }).params = {
      headline: { type: 'text', value: 'Hi' }, accent: { type: 'color', value: '#112233' }, size: { type: 'number', value: 3 },
    };
    await mount('outro-html', c);
    fireEvent.change(screen.getByRole('textbox', { name: 'headline' }), { target: { value: 'Bye' } });
    expect(last()).toEqual({ kind: 'htmlParam', clipId: 'outro-html', key: 'headline', value: 'Bye' });
    typeNum('size', '7');
    expect(last()).toEqual({ kind: 'htmlParam', clipId: 'outro-html', key: 'size', value: 7 });
    const hex = screen.getByRole('textbox', { name: 'accent' });
    fireEvent.focus(hex);
    fireEvent.change(hex, { target: { value: '#445566' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(last()).toEqual({ kind: 'htmlParam', clipId: 'outro-html', key: 'accent', value: '#445566' });
  });
});

describe('problems under the field', () => {
  it('a refusal of applyEdit is shown translated under the field that caused it', async () => {
    const c = comp0();
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'outro-html') as { params?: unknown }).params = { pic: { type: 'image', value: 'assets/photo.jpg' } };
    stageImpl = async () => ({ path: 'elsewhere/x.png', size: 5, kind: 'image' });
    await mount('outro-html', c);
    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    fireEvent.click(await screen.findByRole('button', { name: /new\.png/ }));
    const alert = await screen.findByText('elsewhere/x.png is not a file of this composition under assets/');
    expect(alert.closest('.ms-insp-row')!.querySelector('.ms-insp-param')).not.toBeNull();
    expect(ops()).toEqual([]);
  });

  it('a problem of the draft with a path or a clip shows under the field it is about', async () => {
    const c = comp0();
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as { props: { fontFamily?: string } }).props.fontFamily = 'Ghost';
    await mount('title', c);
    const row = screen.getByRole('button', { name: /Font/ }).closest('.ms-insp-row')!;
    expect(row.querySelector('.ms-insp-err')?.textContent).toMatch(/Ghost/);
  });

  it('fieldProblems matches the clip by path without confusing clips[1] and clips[10]', () => {
    const c = comp0();
    const track = c.tracks.find((t) => t.id === 'visual')!;
    const base = `tracks[${c.tracks.indexOf(track)}].clips[1]`;
    const id = track.clips[1]!.id;
    const other = track.clips[0]!.id;
    const p = [{ key: 'composition.tooBig', params: { path: `${base}.props.x`, max: 100000 } }, { key: 'composition.tooBig', params: { path: `${base}0.props.x`, max: 100000 } }];
    expect(fieldProblems(p, c, id, ['x'], 'en')).toHaveLength(1);
    expect(fieldProblems(p, c, id, ['y'], 'en')).toEqual([]);
    expect(fieldProblems(p, c, other, ['x'], 'en')).toEqual([]);
  });
});

describe('the asset picker', () => {
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    return screen.findByRole('dialog');
  };

  it('lists only the library files that fit the clip kind', async () => {
    await mount('photo1');
    const dialog = await open();
    expect(await within(dialog).findByRole('button', { name: /new\.png/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /other\.png/ })).toBeTruthy();
    for (const no of [/clip\.mp4/, /song\.mp3/, /f\.ttf/, /mark\.svg/]) expect(within(dialog).queryByRole('button', { name: no })).toBeNull();
    cleanup(); __resetDrafts();
    await mount('bgv');
    const d2 = await open();
    expect(await within(d2).findByRole('button', { name: /clip\.mp4/ })).toBeTruthy();
    expect(within(d2).queryByRole('button', { name: /new\.png/ })).toBeNull();
  });

  it('picking stages the file with the library request, then edits the clip source', async () => {
    stageImpl = async () => ({ path: 'assets/new.png', size: 10, kind: 'image', width: 10, height: 10 });
    await mount('photo1');
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole('button', { name: /new\.png/ }));
    await waitFor(() => expect(last()).toEqual({ kind: 'clipMedia', clipId: 'photo1', src: 'assets/new.png' }));
    expect(stageSpy).toHaveBeenCalledWith({ kind: 'library', file: 'assets/new.png' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a file that cannot be staged leaves the draft as it is', async () => {
    stageImpl = async () => null;
    await mount('photo1');
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole('button', { name: /new\.png/ }));
    await waitFor(() => expect(stageSpy).toHaveBeenCalled());
    expect(ops()).toEqual([]);
  });

  it('Upload… uploads, takes the registered entry and picks it', async () => {
    const uploaded = asset('assets/up.png', 'image');
    api.uploadFiles.mockResolvedValue({ assets: [uploaded] });
    stageImpl = async () => ({ path: 'assets/new.png', size: 10, kind: 'image' });
    await mount('photo1');
    const dialog = await open();
    await within(dialog).findByRole('button', { name: /new\.png/ });
    const file = new File(['x'], 'up.png', { type: 'image/png' });
    fireEvent.change(within(dialog).getByLabelText('File to upload'), { target: { files: [file] } });
    await waitFor(() => expect(api.uploadFiles).toHaveBeenCalledWith('acme', 'assets', [file]));
    await waitFor(() => expect(stageSpy).toHaveBeenCalledWith({ kind: 'library', file: 'assets/up.png' }));
    await waitFor(() => expect(last()).toMatchObject({ kind: 'clipMedia', clipId: 'photo1', src: 'assets/new.png' }));
    expect(api.registerAssets).not.toHaveBeenCalled();
  });

  it('an upload the library did not register is registered, then picked', async () => {
    api.uploadFiles.mockResolvedValue({ assets: [] });
    api.listAssets.mockResolvedValueOnce({ assets: LIBRARY, error: null, unregistered: [] });
    api.listAssets.mockResolvedValueOnce({ assets: LIBRARY, error: null, unregistered: ['assets/loose.png'] });
    api.registerAssets.mockResolvedValue({ assets: [asset('assets/loose.png', 'image')] });
    stageImpl = async () => ({ path: 'assets/new.png', size: 10, kind: 'image' });
    await mount('photo1');
    const dialog = await open();
    await within(dialog).findByRole('button', { name: /new\.png/ });
    fireEvent.change(within(dialog).getByLabelText('File to upload'), { target: { files: [new File(['x'], 'loose.png')] } });
    await waitFor(() => expect(api.registerAssets).toHaveBeenCalledWith('acme', ['assets/loose.png']));
    await waitFor(() => expect(stageSpy).toHaveBeenCalledWith({ kind: 'library', file: 'assets/loose.png' }));
  });

  it('a failed upload is shown and nothing is picked', async () => {
    api.uploadFiles.mockRejectedValue(new Error('disk full'));
    await mount('photo1');
    const dialog = await open();
    await within(dialog).findByRole('button', { name: /new\.png/ });
    fireEvent.change(within(dialog).getByLabelText('File to upload'), { target: { files: [new File(['x'], 'a.png')] } });
    expect(await within(dialog).findByText(/Couldn’t upload the file: disk full/)).toBeTruthy();
    expect(stageSpy).not.toHaveBeenCalled();
  });

  it('while a large video stages the picker shows the busy state', async () => {
    let finish: (a: StagedAsset) => void = () => {};
    stageImpl = () => new Promise<StagedAsset>((r) => { finish = r; });
    await mount('bgv');
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole('button', { name: /clip\.mp4/ }));
    await waitFor(() => expect(within(dialog).getByText('Preparing clip.mp4…')).toBeTruthy());
    expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish({ path: 'assets/lib/clip.mp4', size: 9, kind: 'video', durationSec: 10 }); });
    await waitFor(() => expect(last()).toMatchObject({ kind: 'clipMedia', clipId: 'bgv', src: 'assets/lib/clip.mp4' }));
  });

  it('a replacement video shorter than trim + clip duration warns and offers "Fit clip to video", never cutting silently', async () => {
    stageImpl = async () => ({ path: 'assets/lib/clip.mp4', size: 9, kind: 'video', durationSec: 4 });
    const c = comp0(); // bgv lasts 6 s from 0
    await mount('bgv', c);
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole('button', { name: /clip\.mp4/ }));
    await waitFor(() => expect(clipData('bgv')).toMatchObject({ src: 'assets/lib/clip.mp4' }));
    // The clip was not shortened by the replacement itself.
    expect(clipData('bgv')).toMatchObject({ start: 0, duration: 6 });
    const warn = await screen.findByRole('alert');
    expect(warn.textContent).toMatch(/lasts 4 s/);
    expect(ops().some((o) => o.kind === 'clipTiming')).toBe(false);
    fireEvent.click(within(warn).getByRole('button', { name: 'Fit clip to video' }));
    expect(last()).toEqual({ kind: 'clipTiming', clipId: 'bgv', start: 0, duration: 4, ripple: false });
    expect(clipData('bgv')).toMatchObject({ start: 0, duration: 4 });
    expect(screen.queryByText(/lasts 4 s/)).toBeNull();
  });

  it('"Fit clip to video" never makes a zero-length clip: with the trim at or past the video it explains instead', async () => {
    stageImpl = async () => ({ path: 'assets/lib/clip.mp4', size: 9, kind: 'video', durationSec: 2 });
    await mount('bgv');
    typeNum('Trim start (seconds)', '3');
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole('button', { name: /clip\.mp4/ }));
    const warn = await screen.findByRole('alert');
    fireEvent.click(within(warn).getByRole('button', { name: 'Fit clip to video' }));
    expect(ops().some((o) => o.kind === 'clipTiming')).toBe(false);
    expect(screen.getByText('The trim start (3 s) is at or past the end of this video (2 s): lower the trim start first')).toBeTruthy();
    expect(clipData('bgv')).toMatchObject({ duration: 6 });
  });

  it('an upload of the wrong kind says so and picks nothing', async () => {
    api.uploadFiles.mockResolvedValue({ assets: [asset('assets/song2.mp3', 'audio')] });
    await mount('photo1');
    const dialog = await open();
    await within(dialog).findByRole('button', { name: /new\.png/ });
    fireEvent.change(within(dialog).getByLabelText('File to upload'), { target: { files: [new File(['x'], 'song2.mp3')] } });
    expect(await within(dialog).findByText('The uploaded file is a different kind: this clip needs image. Nothing was replaced')).toBeTruthy();
    expect(stageSpy).not.toHaveBeenCalled();
  });

  it('the warning counts the trim start', async () => {
    stageImpl = async () => ({ path: 'assets/lib/clip.mp4', size: 9, kind: 'video', durationSec: 8 });
    await mount('bgv');
    typeNum('Trim start (seconds)', '3');
    const dialog = await open();
    fireEvent.click(await within(dialog).findByRole('button', { name: /clip\.mp4/ }));
    const warn = await screen.findByRole('alert');
    expect(warn.textContent).toMatch(/lasts 8 s.*needs 9 s/);
    fireEvent.click(within(warn).getByRole('button', { name: 'Fit clip to video' }));
    expect(last()).toMatchObject({ kind: 'clipTiming', duration: 5 });
  });
});

describe('brand fonts and weights', () => {
  const brandFonts: EditorFontOption[] = [
    { family: 'SpikeFont', weights: [400, 700], source: 'composition', staged: false },
    { family: 'Playfair', weights: [400, 600, 800], source: 'brand', brandFontId: 'f1', staged: false },
    { family: 'Lonely', weights: [400], source: 'brand', brandFontId: 'f2', staged: false },
  ];
  const kit = { colors: [], fonts: [
    { id: 'f1', family: 'Playfair', role: 'heading', weights: [400, 600, 800], file: 'brand/playfair.ttf', source: { kind: 'manual', ref: null } },
    { id: 'f2', family: 'Lonely', role: 'body', weights: [400], file: null, source: { kind: 'manual', ref: null } },
  ] };

  it('groups the composition fonts and the brand kit, and lists a brand font without a file disabled with the reason', async () => {
    fonts = brandFonts;
    api.getBrand.mockResolvedValue({ kit });
    await mount('title');
    fireEvent.click(screen.getByRole('button', { name: /Font/ }));
    expect(await screen.findByText('In this composition', { selector: '.ms-option-group' })).toBeTruthy();
    expect(screen.getByText('Brand kit', { selector: '.ms-option-group' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: /Lonely/ }).getAttribute('aria-disabled')).toBe('true'));
    expect(within(screen.getByRole('option', { name: /Lonely/ })).getByText('No font file in the brand kit')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Playfair/ }).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Lonely/ }));
    expect(stageSpy).not.toHaveBeenCalled();
    expect(ops()).toEqual([]);
  });

  it('choosing a brand font stages its file, adds the font, then sets the family (and a weight it has)', async () => {
    fonts = brandFonts;
    api.getBrand.mockResolvedValue({ kit });
    stageImpl = async () => ({ path: 'assets/lib/ab12cd34-playfair.ttf', size: 100, kind: 'font' });
    await mount('title');
    await waitFor(() => expect(api.getBrand).toHaveBeenCalled());
    await pickOption(/Font/, /Playfair/);
    await waitFor(() => expect(clipData('title')).toMatchObject({ props: { fontFamily: 'Playfair' } }));
    expect(stageSpy).toHaveBeenCalledWith({ kind: 'brandFont', id: 'f1' });
    const o = ops();
    // The kit lists three weights for one file: nothing says which the file has, so only 400 is declared.
    expect(o[0]).toEqual({ kind: 'addFont', font: { family: 'Playfair', src: 'assets/lib/ab12cd34-playfair.ttf', weight: 400 } });
    expect(o[1]).toMatchObject({ kind: 'clipProps', clipId: 'title', props: { fontFamily: 'Playfair' } });
    expect(comp().fonts.map((f) => f.family)).toContain('Playfair');
    // Only the declared weight is offered, never the kit's other weights.
    fireEvent.click(screen.getByRole('button', { name: /Weight/ }));
    expect((await screen.findAllByRole('option')).map((x) => x.textContent)).toEqual(['400']);
  });

  it('a brand font the kit lists with one weight declares that weight, and the clip weight moves to it', async () => {
    fonts = [{ family: 'SpikeFont', weights: [400], source: 'composition', staged: false }, { family: 'Boldy', weights: [700], source: 'brand', brandFontId: 'f3', staged: false }];
    api.getBrand.mockResolvedValue({ kit: { colors: [], fonts: [{ id: 'f3', family: 'Boldy', role: 'heading', weights: [700], file: 'brand/boldy.ttf', source: { kind: 'manual', ref: null } }] } });
    stageImpl = async () => ({ path: 'assets/lib/aa-boldy.ttf', size: 1, kind: 'font' });
    await mount('title');
    await pickOption(/Font/, /Boldy/);
    await waitFor(() => expect(clipData('title')).toMatchObject({ props: { fontFamily: 'Boldy', fontWeight: 700 } }));
    expect(ops()[0]).toMatchObject({ kind: 'addFont', font: { family: 'Boldy', weight: 700 } });
  });

  it('an undeclared weight is refused at the UI level and the field says so when the clip has one', async () => {
    const c = comp0();
    c.fonts = [{ family: 'SpikeFont', src: 'assets/spikefont.ttf', weight: 400 }];
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as { props: { fontWeight?: number } }).props.fontWeight = 700;
    await mount('title', c);
    const row = screen.getByRole('button', { name: /Weight/ }).closest('.ms-insp-row')!;
    expect(row.querySelector('.ms-insp-err')?.textContent).toBe('Weight 700 is not one this font declares: choose one from the list');
    const r = peekDraft(KEY)!;
    const refused = (await import('@motion-studio/shared')).applyEdit(r.composition, { kind: 'clipProps', clipId: 'title', props: { fontWeight: 600 } });
    expect(refused.ok).toBe(false);
  });

  it('a composition font offers only the weights it declares, and a family change moves an unavailable weight to the nearest', async () => {
    const c = comp0();
    c.fonts = [{ family: 'SpikeFont', src: 'assets/spikefont.ttf', weight: 400 }, { family: 'SpikeFont', src: 'assets/spikefont.ttf', weight: 700 }, { family: 'Thin', src: 'assets/spikefont.ttf', weight: 300 }];
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'title') as { props: { fontWeight?: number } }).props.fontWeight = 700;
    fonts = [{ family: 'SpikeFont', weights: [400, 700], source: 'composition', staged: false }, { family: 'Thin', weights: [300], source: 'composition', staged: false }];
    await mount('title', c);
    fireEvent.click(screen.getByRole('button', { name: /Weight/ }));
    expect((await screen.findAllByRole('option')).map((x) => x.textContent)).toEqual(['400', '700']);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await pickOption(/Font/, /Thin/);
    expect(last()).toMatchObject({ kind: 'clipProps', props: { fontFamily: 'Thin', fontWeight: 300 } });
    fireEvent.click(screen.getByRole('button', { name: /Weight/ }));
    expect((await screen.findAllByRole('option')).map((x) => x.textContent)).toEqual(['300']);
  });
});

describe('Alt+arrows nudge the selected clip', () => {
  function Keys({ selection }: { selection: string | null }) {
    const [draft, actions] = useDraft(KEY);
    const ref = useRef<HTMLDivElement>(null);
    const [msg, setMsg] = useState('');
    useEffect(() => { actions.open(view(comp0()), preset); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useNudgeKeys(ref, true, {
      can: () => (draft ? nudgeable(draft, selection) : false),
      nudge: (dx, dy) => { const d = peekDraft(KEY)!; const r = nudgeClip(d, actions, selection, dx, dy); setMsg(r.ok ? '' : r.reason); },
    });
    return <div ref={ref}><input aria-label="field" /><output>{msg}</output></div>;
  }
  const press = (init: KeyboardEventInit, target: Element | Window = window) => { fireEvent.keyDown(target, init); };
  const x = () => (clipData('card') as { props: { x?: number; y?: number } }).props;

  it('1 px with Alt, 10 px with Alt+Shift, as one undo step per burst; plain arrows are left alone', async () => {
    render(<Keys selection="card" />);
    await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
    const x0 = x().x ?? 0, y0 = x().y ?? 0;
    press({ key: 'ArrowRight', altKey: true });
    press({ key: 'ArrowRight', altKey: true });
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(x().x).toBe(x0 + 2);
    expect(x().y).toBe(y0 + 10);
    expect(ops().length).toBe(1);
    press({ key: 'ArrowRight' });
    expect(x().x).toBe(x0 + 2);
  });

  it('is refused on a locked clip and never happens while typing', async () => {
    const c = comp0();
    (c.tracks.flatMap((t) => t.clips).find((k) => k.id === 'card') as { locked?: boolean }).locked = true;
    __resetDrafts();
    const d0 = peekDraft(KEY);
    expect(d0).toBeNull();
    const { rerender } = render(<Harness comp={c}><div /></Harness>);
    await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
    const r = nudgeClip(peekDraft(KEY)!, { apply: vi.fn() } as never, 'card', 1, 0);
    expect(r).toEqual({ ok: false, reason: 'locked' });
    rerender(<div />);
    cleanup(); __resetDrafts();
    render(<Keys selection="card" />);
    await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
    const before = ops().length;
    press({ key: 'ArrowRight', altKey: true }, screen.getByLabelText('field'));
    expect(ops().length).toBe(before);
  });

  it('does nothing for audio or without a selection', async () => {
    render(<Keys selection="music" />);
    await waitFor(() => expect(peekDraft(KEY)).not.toBeNull());
    press({ key: 'ArrowRight', altKey: true });
    expect(ops()).toEqual([]);
  });
});
