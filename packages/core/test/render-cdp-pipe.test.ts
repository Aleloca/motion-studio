import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CdpError, CdpPipe, waitForEvent, type CdpEvent } from '../src/render/cdp-pipe.ts';

/** A pipe pair: what the client writes (`sent`), and a stream to feed it browser frames (`feed`). */
function pair(o: { defaultTimeoutMs?: number; maxMessageBytes?: number } = {}) {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const sent: Array<{ id: number; method: string; params: unknown; sessionId?: string }> = [];
  let buf = '';
  toBrowser.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\0')) >= 0) { sent.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const cdp = new CdpPipe(toBrowser, fromBrowser, o);
  const feed = (s: string | Buffer) => fromBrowser.write(s);
  const frame = (m: object) => Buffer.concat([Buffer.from(JSON.stringify(m)), Buffer.from([0])]);
  return { cdp, sent, feed, frame, fromBrowser };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('CDP over pipe', () => {
  it('frames each call as JSON + NUL with increasing ids and the session id, and resolves the matching answer', async () => {
    const { cdp, sent, feed, frame } = pair();
    const a = cdp.send('Browser.getVersion');
    const b = cdp.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'S1' });
    await tick();
    expect(sent).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'S1' },
    ]);
    // Answers out of order, in one chunk.
    feed(Buffer.concat([frame({ id: 2, result: { v: 2 } }), frame({ id: 1, result: { product: 'x' } })]));
    expect(await a).toEqual({ product: 'x' });
    expect(await b).toEqual({ v: 2 });
  });

  it('reassembles a frame split across chunks, byte by byte, including multi-byte UTF-8', async () => {
    const { cdp, feed, frame } = pair();
    const p = cdp.send('X.y');
    const bytes = frame({ id: 1, result: { text: 'città ✓ 🎬' } });
    for (let i = 0; i < bytes.length; i++) feed(bytes.subarray(i, i + 1));
    expect(await p).toEqual({ text: 'città ✓ 🎬' });
  });

  it('dispatches events with their session id, and a remote error rejects the call', async () => {
    const { cdp, feed, frame } = pair();
    const events: CdpEvent[] = [];
    cdp.onEvent((e) => events.push(e));
    const p = cdp.send('Page.navigate', { url: 'x' });
    feed(Buffer.concat([frame({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S' }), frame({ id: 1, error: { message: 'boom' } })]));
    await expect(p).rejects.toThrow('Page.navigate: boom');
    expect(events).toEqual([{ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S' }]);
  });

  it('every call times out (default and per call), and a late answer is ignored', async () => {
    const { cdp, feed, frame } = pair({ defaultTimeoutMs: 50 });
    const p = cdp.send('Slow.call');
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    await expect(cdp.send('Slower.call', {}, { timeoutMs: 20 })).rejects.toThrow(/timed out after 20 ms/);
    feed(frame({ id: 1, result: {} })); // late: no throw, no effect
    const q = cdp.send('Next.call');
    feed(frame({ id: 3, result: { ok: true } }));
    expect(await q).toEqual({ ok: true });
  });

  it('waitForEvent filters by session and times out', async () => {
    const { cdp, feed, frame } = pair();
    const w = waitForEvent(cdp, 'Page.loadEventFired', { sessionId: 'B', timeoutMs: 5_000 });
    feed(frame({ method: 'Page.loadEventFired', params: { n: 1 }, sessionId: 'A' }));
    feed(frame({ method: 'Page.loadEventFired', params: { n: 2 }, sessionId: 'B' }));
    expect(await w).toEqual({ n: 2 });
    await expect(waitForEvent(cdp, 'Never.happens', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' });
    const ac = new AbortController();
    const aborted = waitForEvent(cdp, 'Never.happens', { timeoutMs: 5_000, signal: ac.signal });
    ac.abort(new Error('stop'));
    await expect(aborted).rejects.toThrow('stop');
  });

  it('the browser closing the pipe rejects every pending call and every later one', async () => {
    const { cdp, fromBrowser } = pair();
    const closed: Error[] = [];
    cdp.onClose((e) => closed.push(e));
    const p = cdp.send('A.b');
    const w = waitForEvent(cdp, 'X.y', { timeoutMs: 5_000 });
    fromBrowser.end();
    await expect(p).rejects.toMatchObject({ code: 'closed' });
    await expect(w).rejects.toMatchObject({ code: 'closed' });
    await expect(cdp.send('C.d')).rejects.toBeInstanceOf(CdpError);
    expect(closed).toHaveLength(1);
  });

  it('a detached session fails its pending calls at once (a closed target never answers)', async () => {
    const { cdp, feed, frame } = pair();
    const onPage = cdp.send('Runtime.evaluate', {}, { sessionId: 'GONE', timeoutMs: 60_000 });
    const other = cdp.send('Runtime.evaluate', {}, { sessionId: 'KEPT', timeoutMs: 60_000 });
    feed(frame({ method: 'Target.detachedFromTarget', params: { sessionId: 'GONE', targetId: 't' } }));
    await expect(onPage).rejects.toThrow(/detached/);
    feed(frame({ id: 2, result: { ok: 1 } }));
    expect(await other).toEqual({ ok: 1 });
  });

  it('a malformed frame or one over the size limit closes the connection', async () => {
    const bad = pair();
    const p = bad.cdp.send('A.b');
    bad.feed(Buffer.from('{not json\0'));
    await expect(p).rejects.toThrow(/malformed CDP message/);
    expect(bad.cdp.closed).toBeInstanceOf(CdpError);

    const big = pair({ maxMessageBytes: 64 });
    const q = big.cdp.send('A.b');
    big.feed('x'.repeat(100)); // no NUL yet: the buffered part alone is over the limit
    await expect(q).rejects.toThrow(/too large/);
  });
});
