import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalRequest } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
const api = { decideApproval: vi.fn(async (_id: string, _d: string) => ({})) };
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ApprovalCard } = await import('../src/components/ApprovalCard.tsx');
const { PaidBatchCard } = await import('../src/screens/creative/PaidBatchCard.tsx');

const batch: ApprovalRequest = {
  id: 'b1', jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'paid-batch', title: 'Generate 3 voices with ElevenLabs', detail: '', toolName: 'provider:tts-elevenlabs',
  alwaysRule: 'provider:tts-elevenlabs', explanation: null, agentReason: null, createdAt: '2026-10-08T10:00:00.000Z', expiresAt: '2026-10-08T10:10:00.000Z',
  paidBatch: { provider: 'elevenlabs', calls: [{ label: 'German · Reel · Narration', chars: 120 }, { label: 'French · Reel · Narration', chars: 1500 }, { label: 'Japanese · Reel · Narration', chars: 90 }], estimate: '$0.25' },
};
const ui = (a: ApprovalRequest = batch) => <I18nProvider locale="en"><PaidBatchCard approval={a} context="Acme · Launch" /></I18nProvider>;
beforeEach(() => vi.clearAllMocks());

describe('PaidBatchCard', () => {
  it('lists the provider, every call with its characters, the total and the estimate', () => {
    render(ui());
    const card = screen.getByRole('group', { name: 'Generate 3 voices with ElevenLabs' });
    expect(within(card).getByText('Motion Studio will make 3 paid calls to ElevenLabs.')).toBeTruthy();
    const calls = within(card).getByRole('list', { name: 'Calls' });
    expect(within(calls).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'German · Reel · Narration120 characters', 'French · Reel · Narration1,500 characters', 'Japanese · Reel · Narration90 characters',
    ]);
    expect(within(card).getByText('1,710 characters in all')).toBeTruthy();
    expect(within(card).getByText('Estimate $0.25')).toBeTruthy();
    expect(within(card).getByText('Acme · Launch')).toBeTruthy();
  });
  it('says when the price is not known', () => {
    const { paidBatch } = batch;
    render(ui({ ...batch, paidBatch: { provider: 'openai', calls: paidBatch!.calls.slice(0, 1) } }));
    expect(screen.getByText('Estimate not available')).toBeTruthy();
    expect(screen.getByText('Motion Studio will make 1 paid call to OpenAI.')).toBeTruthy();
  });
  it('Approve sends a one-time approval, and the card cannot be decided twice', async () => {
    render(ui());
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(api.decideApproval).toHaveBeenCalledWith('b1', 'once');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true));
  });
  it('Always saves the rule of the provider; Decline denies', async () => {
    const r = render(ui());
    expect(screen.getByText(/Always here allows: .*/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Always here' }));
    expect(api.decideApproval).toHaveBeenCalledWith('b1', 'always');
    r.unmount();
    render(ui());
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(api.decideApproval).toHaveBeenLastCalledWith('b1', 'deny');
  });
  it('has no "Always" button when the core offers no rule, and reports a request already handled', async () => {
    api.decideApproval.mockRejectedValueOnce(new ApiError(404, 'x'));
    render(ui({ ...batch, alwaysRule: null }));
    expect(screen.queryByRole('button', { name: 'Always here' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Request already handled'));
  });
  it('the approval card shown by the approvals center, the conversation and the dialogs is this card for a paid-batch request', () => {
    render(<I18nProvider locale="en"><ApprovalCard approval={batch} /></I18nProvider>);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByText('1,710 characters in all')).toBeTruthy();
  });
  it('a tool request keeps the usual card', () => {
    render(<I18nProvider locale="en"><ApprovalCard approval={{ ...batch, kind: 'tool', toolName: 'Bash', paidBatch: undefined, title: 'Run a command', detail: 'ls' }} /></I18nProvider>);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  });
});

// Phase 15 (decision 843): the one confirmation of a variant run.
describe('PaidBatchCard · a variant run', () => {
  const run: ApprovalRequest = {
    ...batch, id: 'v1', title: 'Paid services for 3 variants', toolName: 'provider:variant-batch', alwaysRule: null,
    paidBatch: {
      provider: 'elevenlabs',
      calls: [
        { label: 'Variant A · Voice (ElevenLabs)', chars: 120 }, { label: 'Variant B · Voice (ElevenLabs)', chars: 120 },
        { label: 'Variant B · Music (ElevenLabs)', chars: 0 }, { label: 'Variant C · Images (OpenAI)', chars: 0 }, { label: 'Variant C · Voice (ElevenLabs)', chars: 90 },
      ],
      items: [
        { variant: 'a', provider: 'elevenlabs', capability: 'voice', chars: 120, estimate: '$0.04' },
        { variant: 'b', provider: 'elevenlabs', capability: 'voice', chars: 120 },
        { variant: 'b', provider: 'elevenlabs', capability: 'music', seconds: 10 },
        { variant: 'c', provider: 'openai', capability: 'images' },
        { variant: 'c', provider: 'elevenlabs', capability: 'voice', chars: 90 },
      ],
      total: { variants: 3, calls: 5, providers: [{ provider: 'elevenlabs', calls: 4 }, { provider: 'openai', calls: 1 }], chars: 330, seconds: 10, estimate: '$0.50' },
    },
  };
  it('a mixed-provider batch names every provider and lists the estimated calls of each variant, never a price', () => {
    render(ui(run));
    const card = screen.getByRole('group', { name: 'Paid services for 3 variants' });
    expect(within(card).getByText('Motion Studio will make about 5 paid calls: ElevenLabs 4, OpenAI 1.')).toBeTruthy();
    expect(within(card).getByText('Estimated calls (price not known)')).toBeTruthy();
    const list = within(card).getByRole('list', { name: 'Calls per variant' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Variant A · Voice (ElevenLabs)120 characters', 'Variant B · Voice (ElevenLabs)120 characters', 'Variant B · Music (ElevenLabs)10 s',
      'Variant C · Images (OpenAI)', 'Variant C · Voice (ElevenLabs)90 characters',
    ]);
    expect(within(card).getByText('ElevenLabs, OpenAI')).toBeTruthy();
    // No price anywhere, even though an estimate sits in the data.
    expect(card.textContent).not.toMatch(/\$|Estimate \d|€/);
    expect(within(card).queryByText('Estimate not available')).toBeNull();
  });
  it('a single-provider batch says it plainly, and the approval flow is the same', async () => {
    const one: ApprovalRequest = { ...run, paidBatch: { ...run.paidBatch!, total: { variants: 3, calls: 3, providers: [{ provider: 'elevenlabs', calls: 3 }] } } };
    render(ui(one));
    expect(screen.getByText('Motion Studio will make 3 paid calls to ElevenLabs.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(api.decideApproval).toHaveBeenCalledWith('v1', 'once');
    expect(screen.queryByRole('button', { name: 'Always here' })).toBeNull();
  });
  it('is in Italian', () => {
    render(<I18nProvider locale="it"><PaidBatchCard approval={run} /></I18nProvider>);
    expect(screen.getByText('Motion Studio farà circa 5 chiamate a pagamento: ElevenLabs 4, OpenAI 1.')).toBeTruthy();
    expect(screen.getByText('Chiamate stimate (prezzo non noto)')).toBeTruthy();
  });
  it('a phase 12 batch without items is exactly as before', () => {
    render(ui());
    expect(screen.queryByRole('list', { name: 'Calls per variant' })).toBeNull();
    expect(screen.getByText('Estimate $0.25')).toBeTruthy();
  });
});
