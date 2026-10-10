import { describe, expect, it, vi } from 'vitest';
import { parseLayerReply } from '../src/layer-protocol.ts';
import { parseIncoming, parseOutgoing, parseParentOrigin } from '../src/protocol.ts';
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
  });
  it('ignores unknown types, extra fields and bad values', () => {
    for (const bad of [
      null, 'seek', [], { type: 'load', composition: {} }, { type: 'eval', code: 'x' }, { type: 'ready' }, { type: 'time', t: 1 },
      { type: 'seek' }, { type: 'seek', t: Number.NaN }, { type: 'seek', t: Infinity }, { type: 'seek', t: -1 }, { type: 'seek', t: '1' },
      { type: 'seek', t: 1, extra: true }, { type: 'play', rate: 0 }, { type: 'play', rate: 100 }, { type: 'play', loop: 'yes' },
      { type: 'select', clipId: 'x'.repeat(65) }, { type: 'select', clipId: 3 }, { type: 'select' },
      { type: 'setScale', scale: 0 }, { type: 'setScale', scale: 100 }, { type: 'setScale', scale: 'auto' },
    ]) expect(parseIncoming(bad)).toBeNull();
  });
});

describe('outgoing messages (for the UI side)', () => {
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
    const player = { seek: vi.fn(async () => {}), play: vi.fn(), pause: vi.fn(), select: vi.fn(), setScale: vi.fn() };
    const bridge = createPreviewBridge({ parent, parentOrigin: ORIGIN, player });
    return { parent, player, bridge };
  }
  it('runs commands from the parent at its origin', () => {
    const { parent, player, bridge } = setup();
    bridge.handle({ data: { type: 'seek', t: 2 }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'play', rate: 0.5 }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'pause' }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'select', clipId: 'title' }, origin: ORIGIN, source: parent });
    bridge.handle({ data: { type: 'setScale', scale: 'fit' }, origin: ORIGIN, source: parent });
    expect(player.seek).toHaveBeenCalledWith(2);
    expect(player.play).toHaveBeenCalledWith({ loop: true, rate: 0.5 });
    expect(player.pause).toHaveBeenCalled();
    expect(player.select).toHaveBeenCalledWith('title');
    expect(player.setScale).toHaveBeenCalledWith('fit');
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
