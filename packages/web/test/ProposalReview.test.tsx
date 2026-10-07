import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BrandProposal } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';

const api = { applyProposal: vi.fn(async () => ({})), discardProposal: vi.fn(async () => ({})) };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ProposalReview, describeChange } = await import('../src/components/ProposalReview.tsx');

const site = { kind: 'website' as const, ref: 'https://acme.example' };
const proposal: BrandProposal = {
  schemaVersion: 1, id: 'p-20261007-100000', createdAt: '2026-10-07T10:00:00.000Z', sourceIds: ['s-1'], status: 'open',
  summary: 'Palette arancio/blu.', assetsAdded: ['brand/logo.svg'],
  guidelines: { current: '', proposed: '# Linee guida' },
  changes: [
    { id: 'colors:add:arancio', field: 'colors', op: 'add', itemId: 'arancio', before: null, after: { id: 'arancio', name: 'Arancio', hex: '#FF7A45', role: 'accent', source: site } },
    { id: 'tone:update:-', field: 'tone', op: 'update', itemId: null, before: { id: 'tone', text: 'Amichevole', source: site }, after: { id: 'tone', text: 'Energico', source: site } },
    { id: 'donts:remove:n1', field: 'donts', op: 'remove', itemId: 'n1', before: { id: 'n1', text: 'Niente gradienti', source: site }, after: null },
  ],
};

describe('describeChange', () => {
  it('labels changes in Italian', () => {
    expect(proposal.changes.map(describeChange)).toEqual(['Aggiungi colore Arancio #FF7A45', 'Aggiorna tono', 'Rimuovi regola da evitare: "Niente gradienti"']);
  });
});

describe('ProposalReview', () => {
  it('applies only the checked changes and the guidelines choice', async () => {
    const onDone = vi.fn();
    render(<ProposalReview slug="acme" proposal={proposal} onDone={onDone} />);
    expect(screen.getByText('Palette arancio/blu.')).toBeTruthy();
    expect(screen.getByText('1 asset scaricati e aggiunti alla libreria')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Aggiorna tono' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Applica le linee guida proposte' }));
    await userEvent.click(screen.getByRole('button', { name: 'Applica selezionate' }));
    await waitFor(() => expect(api.applyProposal).toHaveBeenCalledWith('acme', proposal.id, ['colors:add:arancio', 'donts:remove:n1'], false));
    expect(onDone).toHaveBeenCalled();
  });
  it('discards', async () => {
    const onDone = vi.fn();
    render(<ProposalReview slug="acme" proposal={proposal} onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Scarta proposta' }));
    await waitFor(() => expect(api.discardProposal).toHaveBeenCalledWith('acme', proposal.id));
  });
  it('handles an empty proposal', () => {
    render(<ProposalReview slug="acme" proposal={{ ...proposal, changes: [], guidelines: null, assetsAdded: [] }} onDone={() => {}} />);
    expect(screen.getByText('Nessuna modifica proposta.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Applica selezionate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Chiudi' })).toBeTruthy();
  });
  it('resets selection when a different proposal is shown', async () => {
    const { rerender } = render(<ProposalReview slug="acme" proposal={proposal} onDone={() => {}} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Aggiorna tono' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Applica le linee guida proposte' }));
    const next: BrandProposal = { ...proposal, id: 'p-20261007-110000', changes: [{ ...proposal.changes[0]!, id: 'colors:add:blu' }, { ...proposal.changes[1]!, id: 'tone:update:-2' }] };
    rerender(<ProposalReview slug="acme" proposal={next} onDone={() => {}} />);
    for (const cb of screen.getAllByRole('checkbox')) expect((cb as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Applica le linee guida proposte' }) as HTMLInputElement).checked).toBe(true);
  });
  it('shows an apply error and re-enables the buttons', async () => {
    api.applyProposal.mockRejectedValueOnce(new Error('Conflitto'));
    const onDone = vi.fn();
    render(<ProposalReview slug="acme" proposal={proposal} onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Applica selezionate' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Conflitto');
    expect(onDone).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Applica selezionate' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Scarta proposta' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
