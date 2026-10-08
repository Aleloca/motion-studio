import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureUiToken, resetUiTokenForTests } from '../src/uiToken.ts';
import { useServerEvents } from '../src/useServerEvents.ts';

const urls: string[] = [];
class FakeWebSocket {
  onmessage: unknown; onclose: unknown; onerror: unknown;
  constructor(url: string) { urls.push(url); }
  close() {}
}
function Probe() { useServerEvents(); return null; }

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); resetUiTokenForTests(); urls.length = 0; });

describe('useServerEvents', () => {
  it('passes the UI token to the events socket', () => {
    history.replaceState(null, '', `/#t=${'cd'.repeat(32)}`);
    captureUiToken();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    render(<Probe />);
    expect(urls[0]).toMatch(new RegExp(`/api/events\\?t=${'cd'.repeat(32)}$`));
  });
});
