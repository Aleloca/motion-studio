import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureUiToken, markPairingNeeded, resetUiTokenForTests } from '../src/uiToken.ts';
import { useServerEvents } from '../src/useServerEvents.ts';

const urls: string[] = [];
const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  onmessage: unknown; onclose: (() => void) | null = null; onerror: unknown;
  constructor(url: string) { urls.push(url); sockets.push(this); }
  close() { this.onclose?.(); }
}
function Probe() { useServerEvents(); return null; }

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); resetUiTokenForTests(); urls.length = 0; sockets.length = 0; });

describe('useServerEvents', () => {
  it('passes the UI token to the events socket', () => {
    history.replaceState(null, '', `/#t=${'cd'.repeat(32)}`);
    captureUiToken();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    render(<Probe />);
    expect(urls[0]).toMatch(new RegExp(`/api/events\\?t=${'cd'.repeat(32)}$`));
  });
  it('stops reconnecting while pairing is needed and reconnects with a newly pasted token', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    render(<Probe />);
    expect(urls).toHaveLength(1);
    sockets[0]!.onclose!();
    vi.advanceTimersByTime(1500);
    expect(urls).toHaveLength(2); // normal drop: retried
    markPairingNeeded();
    sockets[1]!.onclose!();
    vi.advanceTimersByTime(5000);
    expect(urls).toHaveLength(2); // refused token: no retry loop
    history.replaceState(null, '', `/#t=${'ef'.repeat(32)}`);
    captureUiToken();
    expect(urls).toHaveLength(3);
    expect(urls[2]).toMatch(new RegExp(`\\?t=${'ef'.repeat(32)}$`));
    vi.advanceTimersByTime(5000);
    expect(urls).toHaveLength(3); // the replaced socket's close does not start another one
  });
});
