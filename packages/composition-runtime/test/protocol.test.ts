import { COMPOSITION_LIMITS, type Composition } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { parseLayerReply } from '../src/layer-protocol.ts';
import { parseDraft } from '../src/draft.ts';
import { parseIncoming, parseIncoming as parseIncomingRaw, parseOutgoing, parseParentOrigin } from '../src/protocol.ts';
import { createPreviewBridge } from '../src/preview-bridge.ts';

describe('incoming messages', () => {
  it('accepts exactly the five commands with valid fields', () => {
    expect(parseIncoming({ type: 'seek', t: 1.5 })).toEqual({ type: 'seek', t: 1.5 });
    expect(parseIncoming({ type: 'play' })).toEqual({ type: 'play' });
    expect(parseIncoming({ type: 'play', loop: false, rate: 2 })).toEqual({ type: 'play', loop: false, rate: 2 });
    expect(parseIncoming({ type: 'pause' })).toEqual({ type: 'pause' });
    expect(parseIncoming({ type: 'select', clipId: 'title' })).toEqual({ type: 'select', clipId: 'title' });
    expect(parseIncoming({ type: 'select', clipId: null })).toEqual({ type: 'select', clipId: null });
    expect(parseIncoming({ type: 'setScale', scale: 'fit' })).toEqual({ type: 'setScale', scale: 'fit' });
    expect(parseIncoming({ type: 'setScale', scale: 0.5 })).toEqual({ type: 'setScale', scale: 0.5 });
    expect(parseIncoming({ type: 'mute', muted: true })).toEqual({ type: 'mute', muted: true });
    expect(parseIncoming({ type: 'mute', muted: false })).toEqual({ type: 'mute', muted: false });
  });
  it('ignores unknown types, extra fields and bad values', () => {
    for (const bad of [
      null, 'seek', [], { type: 'load', composition: {} }, { type: 'eval', code: 'x' }, { type: 'ready' }, { type: 'time', t: 1 },
      { type: 'seek' }, { type: 'seek', t: Number.NaN }, { type: 'seek', t: Infinity }, { type: 'seek', t: -1 }, { type: 'seek', t: '1' },
      { type: 'seek', t: 1, extra: true }, { type: 'play', rate: 0 }, { type: 'play', rate: 100 }, { type: 'play', loop: 'yes' },
      { type: 'select', clipId: 'x'.repeat(65) }, { type: 'select', clipId: 3 }, { type: 'select' },
      { type: 'setScale', scale: 0 }, { type: 'setScale', scale: 100 }, { type: 'setScale', scale: 'auto' },
      { type: 'mute' }, { type: 'mute', muted: 1 }, { type: 'mute', muted: 'true' }, { type: 'mute', muted: true, volume: 0 },
    ]) expect(parseIncoming(bad)).toBeNull();
  });
});

function smallComp(over: Record<string, unknown> = {}): Composition {
  return {
    $schema: 'motion-studio/composition@1', width: 320, height: 180, fps: 30, duration: 4, background: '#000000', fonts: [],
    scenes: [{ id: 's', start: 0, duration: 4 }],
    tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'logo', type: 'svg', src: 'assets/logo.svg', start: 0, duration: 4, hidden: true, props: {} }] }],
    ...over,
  } as Composition;
}

describe('setComposition (incoming)', () => {
  const parseIncoming = (d: unknown) => parseIncomingRaw(d, parseDraft);
  it('is refused without a draft parser (protocol.ts carries no zod: the render runtime has none)', () => {
    expect(parseIncomingRaw({ type: 'setComposition', composition: smallComp(), seq: 1 })).toBeNull();
  });
  it('accepts a structurally valid composition with a seq and an optional keepTime, and returns a clean copy', () => {
    const c = smallComp();
    const parsed = parseIncoming({ type: 'setComposition', composition: c, keepTime: true, seq: 7 });
    expect(parsed).toEqual({ type: 'setComposition', composition: c, keepTime: true, seq: 7 });
    expect(parsed && parsed.type === 'setComposition' && parsed.composition).not.toBe(c); // a copy, never the sender's object
    expect(parseIncoming({ type: 'setComposition', composition: c, seq: 0 })).toEqual({ type: 'setComposition', composition: c, seq: 0 });
  });
  it('refuses a malformed composition, extra fields, a bad seq or keepTime', () => {
    const c = smallComp();
    for (const bad of [
      { type: 'setComposition', seq: 1 },
      { type: 'setComposition', composition: c },
      { type: 'setComposition', composition: c, seq: -1 }, { type: 'setComposition', composition: c, seq: 1.5 },
      { type: 'setComposition', composition: c, seq: 2 ** 31 }, { type: 'setComposition', composition: c, seq: '1' },
      { type: 'setComposition', composition: c, seq: 1, keepTime: 'yes' },
      { type: 'setComposition', composition: c, seq: 1, extra: true },
      { type: 'setComposition', composition: { ...c, width: 10 }, seq: 1 },
      { type: 'setComposition', composition: { ...c, script: 'x' }, seq: 1 },
      { type: 'setComposition', composition: 'json', seq: 1 },
      { type: 'setComposition', composition: null, seq: 1 },
      // No src outside assets/ or layers/: no scheme, no parent folder, no core media path.
      ...['https://evil.test/x.svg', '../x.svg', 'media/0.mp4', '/abs.svg', 'assets/../../x.svg'].map((src) => ({
        type: 'setComposition', seq: 1, composition: smallComp({ tracks: [{ id: 't', kind: 'visual', clips: [{ id: 'logo', type: 'svg', src, start: 0, duration: 4, props: {} }] }] }),
      })),
      // Core-only video fields are not part of the schema.
      { type: 'setComposition', seq: 1, composition: smallComp({ tracks: [{ id: 't', kind: 'video', clips: [{ id: 'v', type: 'video', src: 'assets/v.mp4', sourceTrusted: true, start: 0, duration: 4, props: {} }] }] }) },
    ]) expect(parseIncoming(bad)).toBeNull();
  });
  it('refuses a cyclic or non-JSON value without throwing', () => {
    const cyclic: Record<string, unknown> = { ...smallComp() };
    cyclic.self = cyclic;
    expect(parseIncoming({ type: 'setComposition', composition: cyclic, seq: 1 })).toBeNull();
    expect(parseIncoming({ type: 'setComposition', composition: { ...smallComp(), n: 10n }, seq: 1 })).toBeNull();
  });
  it('refuses a composition above COMPOSITION_LIMITS.jsonBytes (UTF-8), accepts one just below', () => {
    const name = (n: number) => smallComp({ scenes: [{ id: 's', name: 'x'.repeat(10), start: 0, duration: 4 }], tracks: [{ id: 't', kind: 'visual', name: 'é'.repeat(n), clips: [] }] });
    // Track names are bounded by the schema (200), so the size is reached with many text clips instead.
    const big = (count: number, text: string) => smallComp({ tracks: Array.from({ length: 4 }, (_, k) => ({ id: `t${k}`, kind: 'text', clips: Array.from({ length: count }, (_, i) => ({
      id: `c${k}-${i}`, type: 'text', start: 0, duration: 4, props: { text } })) })) });
    expect(parseIncoming({ type: 'setComposition', composition: name(10), seq: 1 })).not.toBeNull();
    const huge = big(500, 'é'.repeat(1990)); // 2000 clips × ~4 KB of UTF-8: about 8 MB
    expect(JSON.stringify(huge).length).toBeLessThan(COMPOSITION_LIMITS.jsonBytes); // UTF-16 length is below the bound…
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeGreaterThan(COMPOSITION_LIMITS.jsonBytes); // …its bytes are not
    expect(parseIncoming({ type: 'setComposition', composition: huge, seq: 1 })).toBeNull();
    const fits = big(500, 'a'.repeat(1990)); // about 4.2 MB
    expect(new TextEncoder().encode(JSON.stringify(fits)).length).toBeLessThan(COMPOSITION_LIMITS.jsonBytes);
    expect(parseIncoming({ type: 'setComposition', composition: fits, seq: 1 })).not.toBeNull();
  });
});

describe('outgoing messages (for the UI side)', () => {
  it('validates compositionApplied: an integer seq and bounded errors', () => {
    expect(parseOutgoing({ type: 'compositionApplied', seq: 3, errors: [{ code: 'assetLoadFailed', message: 'x', clipId: 'a' }], k: 1 }))
      .toEqual({ type: 'compositionApplied', seq: 3, errors: [{ code: 'assetLoadFailed', message: 'x', clipId: 'a' }] });
    for (const bad of [
      { type: 'compositionApplied', seq: -1, errors: [] }, { type: 'compositionApplied', seq: 1.5, errors: [] },
      { type: 'compositionApplied', seq: 1 }, { type: 'compositionApplied', seq: 1, errors: [{ code: 'nope', message: 'x' }] },
      { type: 'compositionApplied', seq: 1, errors: Array.from({ length: 201 }, () => ({ code: 'layerError', message: 'x' })) },
    ]) expect(parseOutgoing(bad)).toBeNull();
  });

  it('validates what the runtime sends', () => {
    expect(parseOutgoing({ type: 'time', t: 1, playing: true })).toEqual({ type: 'time', t: 1, playing: true });
    expect(parseOutgoing({ type: 'error', error: { code: 'fontLoadFailed', message: 'x' } })).not.toBeNull();
    expect(parseOutgoing({ type: 'clipBounds', clipId: 'a', bounds: { x: 0, y: 0, width: 1, height: 1 }, scale: 1 })).not.toBeNull();
    expect(parseOutgoing({ type: 'ready', version: 1, duration: 6, fps: 30, width: 1080, height: 1920, scenes: [], errors: [] })).not.toBeNull();
    expect(parseOutgoing({ type: 'seek', t: 1 })).toBeNull();
    expect(parseOutgoing({ type: 'time', t: 1, playing: true, html: '<img>' })).toEqual({ type: 'time', t: 1, playing: true });
    expect(parseOutgoing({ type: 'error', error: { code: 'layerError', message: 'x'.repeat(5000), extra: 1 }, more: 2 }))
      .toEqual({ type: 'error', error: { code: 'layerError', message: 'x'.repeat(2000) } });
    expect(parseOutgoing({ type: 'error', error: { code: 'nope', message: 'x' } })).toBeNull();
    expect(parseOutgoing({ type: 'error', error: { code: 'layerError', message: 'x', clipId: 7 } })).toBeNull();
    const ready = { type: 'ready', version: 1, duration: 6, fps: 30, width: 1, height: 1, errors: [] };
    expect(parseOutgoing({ ...ready, scenes: [{ id: 's', name: 'A', start: 0, duration: 6, x: 1 }] }))
      .toEqual({ ...ready, scenes: [{ id: 's', name: 'A', start: 0, duration: 6 }] });
    expect(parseOutgoing({ ...ready, scenes: [{ id: 's', name: 5, start: 0, duration: 6 }] })).toBeNull();
    expect(parseOutgoing({ ...ready, scenes: [{ id: 's', name: 'n'.repeat(201), start: 0, duration: 6 }] })).toBeNull();
    expect(parseOutgoing({ ...ready, scenes: Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, start: i, duration: 1 })) })).toBeNull();
    expect(parseOutgoing({ type: 'clipBounds', clipId: 'a', bounds: { x: 0, y: 0, width: 1, height: 1, z: 9 }, scale: 1, k: 1 }))
      .toEqual({ type: 'clipBounds', clipId: 'a', bounds: { x: 0, y: 0, width: 1, height: 1 }, scale: 1 });
    expect(parseOutgoing({ type: 'time', t: 'x', playing: true })).toBeNull();
  });
});

describe('parent origin', () => {
  it('accepts a serialized http(s) origin only', () => {
    expect(parseParentOrigin('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317');
    expect(parseParentOrigin('https://example.test')).toBe('https://example.test');
    for (const bad of [null, '', '*', 'null', 'http://127.0.0.1:4317/', 'http://a/b', 'file:///x', 'javascript:1', 'app://x', 'http://user@a']) {
      expect(parseParentOrigin(bad)).toBeNull();
    }
  });
});

describe('preview bridge', () => {
  const ORIGIN = 'http://127.0.0.1:4317';
  function setup() {
    const parent = { postMessage: vi.fn() };
    const player = { seek: vi.fn(async () => {}), play: vi.fn(), pause: vi.fn(), select: vi.fn(), setScale: vi.fn(), setMuted: vi.fn(), setComposition: vi.fn() };
    const bridge = createPreviewBridge({ parent, parentOrigin: ORIGIN, player, parseDraft: () => parseDraft });
    return { parent, player, bridge };
  }
  it('runs commands from the parent at its origin', () => {
    const { parent, player, bridge } = setup();
    bridge.handle({ data: { type: 'seek', t: 2 }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'play', rate: 0.5 }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'pause' }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'select', clipId: 'title' }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'setScale', scale: 'fit' }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'mute', muted: true }, origin: ORIGIN, source: parent });
    expect(player.setMuted).toHaveBeenCalledWith(true);
    expect(player.seek).toHaveBeenCalledWith(2);
    expect(player.play).toHaveBeenCalledWith({ loop: true, rate: 0.5 });
    expect(player.pause).toHaveBeenCalled();
    expect(player.select).toHaveBeenCalledWith('title');
    expect(player.setScale).toHaveBeenCalledWith('fit');
  });
  it('passes a valid setComposition (a validated copy) to the player, ignores an invalid one or one not from the parent', () => {
    const { parent, player, bridge } = setup();
    const c = smallComp();
    bridge.handle({ data: { type: 'setComposition', composition: c, keepTime: true, seq: 4 }, origin: ORIGIN, source: parent });
    expect(player.setComposition).toHaveBeenCalledWith(c, { keepTime: true, seq: 4 });
    expect(player.setComposition.mock.calls[0]![0]).not.toBe(c);
    bridge.handle({ data: { type: 'setComposition', composition: c, seq: 5 }, origin: ORIGIN, source: {} });
    bridge.handle({ data: { type: 'setComposition', composition: c, seq: 6 }, origin: 'null', source: parent });
    bridge.handle({ data: { type: 'setComposition', composition: { ...c, fps: 7 }, seq: 7 }, origin: ORIGIN, source: parent });
    expect(player.setComposition).toHaveBeenCalledTimes(1);
    bridge.handle({ data: { type: 'setComposition', composition: c, seq: 8 }, origin: ORIGIN, source: parent });
    expect(player.setComposition).toHaveBeenLastCalledWith(c, { keepTime: false, seq: 8 });
  });
  it('a draft that comes before the parser has loaded waits for it (the latest only), then applies', () => {
    const parent = { postMessage: vi.fn() };
    const player = { seek: vi.fn(async () => {}), play: vi.fn(), pause: vi.fn(), select: vi.fn(), setScale: vi.fn(), setMuted: vi.fn(), setComposition: vi.fn() };
    let parser: typeof parseDraft | undefined;
    const bridge = createPreviewBridge({ parent, parentOrigin: ORIGIN, player, parseDraft: () => parser });
    bridge.handle({ data: { type: 'setComposition', composition: smallComp(), seq: 1 }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'setComposition', composition: smallComp(), seq: 2 }, origin: ORIGIN, source: {} }); // not the parent
    bridge.handle({ data: { type: 'setComposition', composition: smallComp(), seq: 3 }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'seek', t: 1 }, origin: ORIGIN, source: parent }); // other commands go on
    expect(player.seek).toHaveBeenCalledWith(1);
    expect(player.setComposition).not.toHaveBeenCalled();
    parser = parseDraft;
    bridge.parserReady();
    expect(player.setComposition).toHaveBeenCalledTimes(1);
    expect(player.setComposition.mock.calls[0]![1]).toEqual({ keepTime: false, seq: 3 });
    bridge.parserReady(); // nothing left
    expect(player.setComposition).toHaveBeenCalledTimes(1);
  });
  it('ignores a wrong origin, a source other than the parent and unknown types', () => {
    const { parent, player, bridge } = setup();
    bridge.handle({ data: { type: 'seek', t: 2 }, origin: 'http://evil.test', source: parent });
    bridge.handle({ data: { type: 'seek', t: 2 }, origin: 'null', source: parent });
    bridge.handle({ data: { type: 'seek', t: 2 }, origin: ORIGIN, source: {} }); // e.g. a layer frame
    bridge.handle({ data: { type: 'load', composition: {} }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'ready' }, origin: ORIGIN, source: parent });
    expect(player.seek).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
  });
  it('posts only to the parent origin, and only valid outgoing messages', () => {
    const { parent, bridge } = setup();
    bridge.post({ type: 'time', t: 1, playing: false });
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'time', t: 1, playing: false }, ORIGIN);
    expect(() => bridge.post({ type: 'seek', t: 1 } as never)).toThrow();
  });
});

describe('layer replies (untrusted)', () => {
  it('accepts well-formed replies and cuts long strings', () => {
    expect(parseLayerReply({ type: 'hello', v: 1 })).toEqual({ type: 'hello', v: 1 });
    expect(parseLayerReply({ id: 3, ok: true, warnings: ['a', 'b'.repeat(400)] })).toEqual({ id: 3, ok: true, warnings: ['a', 'b'.repeat(300)] });
    expect(parseLayerReply({ id: 4, ok: false, error: 'boom', code: 'frameTimeout', junk: 1 })).toEqual({ id: 4, ok: false, error: 'boom', code: 'frameTimeout' });
  });
  it('ignores anything else', () => {
    for (const bad of [null, 'x', [], { id: 1 }, { id: 1, ok: 'yes' }, { id: '1', ok: true }, { id: 1.5, ok: true },
      { id: 1, ok: true, warnings: 'w' }, { id: 1, ok: true, warnings: [1] }, { id: 1, ok: true, warnings: Array(21).fill('w') },
      { id: 1, ok: false, error: {} }, { id: 1, ok: false, code: 'other' }, { type: 'hello' }]) {
      expect(parseLayerReply(bad)).toBeNull();
    }
  });
});
