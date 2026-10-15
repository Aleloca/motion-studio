import { afterEach, describe, expect, it } from 'vitest';
import type { Natives } from '../src/clock.ts';
import { connectLayer, LayerRequestError } from '../src/layer-host.ts';
import { LAYER_PROTOCOL_VERSION } from '../src/layer-protocol.ts';

/** A fake layer frame: it answers the connect handshake, and seeks only when `answers` is true (with `reply`, if given). */
function fakeFrame(answers: () => boolean, reply: Record<string, unknown> = { ok: true }) {
  const ports: MessagePort[] = [];
  let onLoad: (() => void) | null = null;
  let seeks = 0;
  const frame = {
    addEventListener: (type: string, cb: () => void) => { if (type === 'load') onLoad = cb; },
    contentWindow: {
      postMessage: (_m: unknown, _o: string, transfer: MessagePort[]) => {
        const port = transfer[0]!;
        ports.push(port);
        port.onmessage = (m: MessageEvent) => {
          const d = m.data as { id: number; op: string };
          if (d.op === 'seek') { seeks++; if (answers()) port.postMessage({ id: d.id, ...reply }); }
        };
        port.postMessage({ type: 'hello', v: LAYER_PROTOCOL_VERSION });
      },
    },
  };
  return { frame: frame as unknown as HTMLIFrameElement, load: () => onLoad!(), seeks: () => seeks, close: () => ports.forEach((p) => p.close()) };
}
const natives = { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (id: unknown) => clearTimeout(id as NodeJS.Timeout) } as unknown as Natives;

describe('layer host: a layer that never answers (M3)', () => {
  const open: Array<() => void> = [];
  afterEach(() => { while (open.length) open.pop()!(); });

  it('render (failFast): dead after its first timeout, later seeks fail at once without being sent', async () => {
    const f = fakeFrame(() => false);
    open.push(f.close);
    const host = connectLayer(f.frame, natives, 200, { failFast: true });
    f.load();
    await host.connected;
    await expect(host.seek(0)).rejects.toThrow(/timed out/);
    await expect(host.seek(1)).rejects.toThrow(/skipped: the layer did not answer a seek within 200 ms/);
    await expect(host.seek(2)).rejects.toThrow(/skipped/);
    expect(f.seeks()).toBe(1); // the later seeks were never sent, so they could not wait
  });

  it('preview (default): every request waits again, so a layer that recovers works', async () => {
    let answer = false;
    const f = fakeFrame(() => answer);
    open.push(f.close);
    const host = connectLayer(f.frame, natives, 200);
    f.load();
    await host.connected;
    await expect(host.seek(0)).rejects.toThrow(/timed out/);
    answer = true;
    await expect(host.seek(1)).resolves.toBeUndefined();
    expect(f.seeks()).toBe(2);
  });
});

describe('layer host: failure codes', () => {
  it('a stalled layer rejects with a LayerRequestError whose code is layerStalled (the mount reports it as such)', async () => {
    const f = fakeFrame(() => true, { ok: false, error: 'msSeek waited 5 s for a timer', code: 'layerStalled' });
    const host = connectLayer(f.frame, natives, 200, { failFast: true });
    f.load();
    await host.connected;
    const err = await host.seek(0).catch((e: unknown) => e);
    f.close();
    expect(err).toBeInstanceOf(LayerRequestError);
    expect(err).toMatchObject({ code: 'layerStalled', message: 'msSeek waited 5 s for a timer' });
  });
});
