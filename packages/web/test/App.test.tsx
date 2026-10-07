import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';

vi.mock('../src/api.ts', () => ({
  ApiError: class extends Error {},
  api: {
    getDoctor: vi.fn(() => Promise.reject(new Error('Failed to fetch'))),
    getWorkspace: vi.fn(() => Promise.reject(new Error('Failed to fetch'))),
  },
}));

class FakeWebSocket {
  onmessage: unknown; onclose: unknown;
  close() {}
}

describe('App startup', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('shows an alert in onboarding when the server is unreachable', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Impossibile contattare il server di Motion Studio: Failed to fetch');
    expect(screen.queryByText('Controllo in corso…')).toBeNull();
  });
});
