import { DEFAULT_FORMATS, type ConversationEntry, type CreativeDetail } from '@motion-studio/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
const { ConversationPanel } = await import('../src/components/ConversationPanel.tsx');
const { FormatBoard } = await import('../src/components/FormatBoard.tsx');
const { FocusView } = await import('../src/components/FocusView.tsx');
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('creatives in English', () => {
  it('shows the conversation panel in English', () => {
    const detail: CreativeDetail = {
      slug: 'c1', jobKey: 'k',
      creative: { schemaVersion: 1, title: 'Launch', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [],
        brief: { goal: 'g', message: '', formats: [], durationSec: null, assets: [], notes: '' } },
      versions: [{ n: 1, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null }],
    };
    const conversation: ConversationEntry[] = [
      { type: 'user', at, text: 'Bigger logo', pins: [{ format: 'f', x: 0.5, y: 0.5, timeSec: 1.5 }], attachments: [] },
      { type: 'version', at, n: 1, status: 'complete' },
    ];
    en(<ConversationPanel slug="acme" detail={detail} conversation={conversation} presets={DEFAULT_FORMATS} job={undefined} liveEvents={[]} expert approvals={[]}
      pins={[]} onRemovePin={() => {}} onSent={() => {}} onSelectVersion={() => {}} onChanged={() => {}} />);
    expect(screen.getByRole('complementary', { name: 'Conversation' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Expert' })).toBeTruthy();
    expect(screen.getByText('1 · f @ 1.5s')).toBeTruthy();
    expect(screen.getByText('v1 · Ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View v1' })).toBeTruthy();
    expect(screen.getByLabelText('Request a change')).toBeTruthy();
  });
  it('labels frames and the focus view with English channel and format names', async () => {
    const banner = DEFAULT_FORMATS.find((f) => f.id === 'instagram-post-1x1')!;
    const version = { n: 1, commit: 'c', sessionId: 's', status: 'complete' as const, createdAt: at, request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null };
    const onOpen = vi.fn();
    en(<FormatBoard presets={DEFAULT_FORMATS} formats={[banner.id]} version={version} compare={null} fileUrl={() => ''} pins={[]} showSafeZone={false} onOpen={onOpen} />);
    expect(screen.getByRole('button', { name: 'Instagram · Post 1:1 — open' })).toBeTruthy();
    expect(screen.getByText('Missing in v1')).toBeTruthy();
    en(<FocusView preset={banner} src="/f/a.png" compareSrc={null} versionN={1} compareN={null} verified={false} pins={[]} onAddPin={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Instagram · Post 1:1' })).toBeTruthy();
    expect(screen.getByText('unverified')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add comment' })).toBeTruthy();
  });
});
