/**
 * User report 94 (decisions 1971-1975): "Generate" in the chat is only for a creative or variant group that never started.
 * While variants work (and have saved nothing yet) the chat shows one send action and never "Generate".
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type JobSummary, type VariantId } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { at, groupOf, HOST } from './support/variants.ts';

vi.setConfig({ testTimeout: 30_000 });

type Run = { jobs: Partial<Record<VariantId, string>>; queued: VariantId[]; skipped: VariantId[]; failed: Partial<Record<VariantId, string>> };
const run = vi.fn(async (..._a: unknown[]): Promise<Run> => ({ jobs: { a: 'j1' }, queued: [], skipped: [], failed: {} }));
const api = {
  sendCreativeTurn: vi.fn(async (..._a: unknown[]) => ({ id: 'j9' })),
  getAgentCapabilities: vi.fn(async () => ({ cliVersion: null, liveInput: true, interrupt: true, checkedAt: at })),
  postLiveMessage: vi.fn(), redirectJob: vi.fn(), stopJob: vi.fn(), removeQueued: vi.fn(), editQueued: vi.fn(), reorderQueue: vi.fn(), runNext: vi.fn(), decideApproval: vi.fn(),
  getPinFrames: vi.fn(async () => ({ n: 1, expiresAt: at, frames: [] })),
  fileUrl: (s: string, c: string, rel: string) => `/f/${s}/${c}/${rel}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error { status = 0; } }));
const { Conversation } = await import('../src/components/Conversation.tsx');
const { canGenerateChat } = await import('../src/screens/variants/useGroupChat.ts');
const { I18nProvider } = await import('../src/i18n.tsx');

const job = (id: string, over: Partial<JobSummary> = {}): JobSummary => ({ id, key: `creative:/w:acme:${HOST}`, kind: 'creative', label: 'Lancio', state: 'running', createdAt: at, ...over });
const group = groupOf(['a', 'b', 'c']);

/** The variants page: "all" mode, the host's own job `own` and the other members' turns `members`. */
function panel(o: { own?: JobSummary; members?: JobSummary[]; all?: boolean; canGenerate?: boolean }) {
  const memberJobs = (o.members ?? []).map((j, i) => ({ job: j, live: [], variant: (['b', 'c'] as const)[i]! }));
  return (
    <I18nProvider locale="it">
      <Conversation slug="acme" creative={HOST} entries={[]} approvals={[]} job={o.own} onSent={vi.fn()} canGenerate={o.canGenerate ?? true} memberJobs={memberJobs}
        variants={{ group, current: 'a', all: o.all ?? true, missing: [], onSelect: vi.fn() as never, runAll: run }} />
    </I18nProvider>
  );
}
const generate = () => screen.queryByRole('button', { name: 'Genera' });
const sendButtons = () => screen.queryAllByRole('button').filter((b) => /^(Invia|Metti in coda|Genera)$/.test(b.getAttribute('aria-label') ?? ''));

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('Generate while the variants work (report 94)', () => {
  it('"All" with variants working or queued and nothing saved yet: no Generate, one send button', () => {
    render(panel({ own: job('j1'), members: [job('j2', { key: `${HOST}~b` }), job('j3', { key: `${HOST}~c`, state: 'queued', waitReason: 'variant-slot' })] }));
    expect(generate()).toBeNull();
    expect(sendButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['Invia']);
  });

  it('"All" where only another member works (the open one is idle): still no Generate', () => {
    render(panel({ members: [job('j2', { key: `${HOST}~b` })] }));
    expect(generate()).toBeNull();
    expect(sendButtons()).toHaveLength(1);
  });

  it('one variant (a letter) while it works: the working controls, no Generate', async () => {
    render(panel({ all: false, own: job('j1') }));
    expect(generate()).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: /Stop|Ferma/ })).toBeTruthy());
    await waitFor(() => expect(screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'submit')).toHaveLength(1));
  });

  it('a group that never started still shows Generate (one button, it starts everything), and it works', async () => {
    render(panel({}));
    expect(sendButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['Genera', 'Invia']);
    await userEvent.click(generate()!);
    await waitFor(() => expect(run).toHaveBeenCalledWith(null));
  });

  it('the rule: canGenerateChat', () => {
    const j = (state: JobSummary['state']) => ({ job: job('jx', { state }) });
    expect(canGenerateChat({ versions: 0, job: undefined, memberJobs: [] })).toBe(true);
    expect(canGenerateChat({ versions: 0, job: undefined, memberJobs: [j('succeeded')] })).toBe(true);
    expect(canGenerateChat({ versions: 1, job: undefined, memberJobs: [] })).toBe(false);
    expect(canGenerateChat({ versions: 0, job: undefined, memberJobs: [], memberVersions: [0, 2] })).toBe(false);
    expect(canGenerateChat({ versions: 0, job: job('j1'), memberJobs: [] })).toBe(false);
    expect(canGenerateChat({ versions: 0, job: undefined, memberJobs: [j('queued')] })).toBe(false);
    expect(canGenerateChat({ versions: 0, job: undefined, memberJobs: [j('running')] })).toBe(false);
  });
});
