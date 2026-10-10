import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const at = '2026-10-07T10:00:00.000Z';
const api = {
  listCreatives: vi.fn(async () => [
    { ok: true, slug: 'c1', title: 'Launch', status: 'ready', formats: ['a', 'b'], versions: 1, updatedAt: at, cover: null },
  ]),
  getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })),
  sendCreativeTurn: vi.fn(), updateCreative: vi.fn(), cancelJob: vi.fn(),
  fileUrl: (s: string, c: string, r: string) => `/f/${s}/${c}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { CanvasBoard } = await import('../src/screens/CanvasBoard.tsx');
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('creatives in English', () => {
  it('labels frames with English channel and format names', async () => {
    const banner = DEFAULT_FORMATS.find((f) => f.id === 'instagram-post-1x1')!;
    const version = { n: 1, commit: 'c', sessionId: 's', status: 'complete' as const, createdAt: at, request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null };
    const noop = () => {};
    const board = (n: number, withOutput: boolean) => (
      <CanvasBoard slug="acme" creative="c1" n={n} tool="select" zoom={1} selected={false} rendering={false} safe={false} pins={[]} draft={null} nextNumber={1}
        board={{ id: banner.id, preset: banner, out: withOutput ? { format: banner.id, file: 'a.png', width: 1080, height: 1080, durationSec: null, verified: true, preview: null } : null }}
        onSelect={noop} onOpen={noop} onPlace={noop} onEditPin={noop} onDraftText={noop} onDraftCommit={noop} onDraftCancel={noop} onDraftDelete={noop} />
    );
    const { unmount } = en(board(version.n, false));
    expect(screen.getByText('Missing in v1')).toBeTruthy();
    unmount();
    const second = en(board(version.n, true));
    expect(screen.getByRole('button', { name: 'Open the editor for Instagram · Post 1:1' })).toBeTruthy();
    second.unmount();
  });
});
