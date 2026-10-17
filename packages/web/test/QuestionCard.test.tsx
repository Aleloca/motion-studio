import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalRequest } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
const api = { decideApproval: vi.fn(async () => ({})), answerQuestion: vi.fn(async () => ({})) };
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ApprovalCard } = await import('../src/components/ApprovalCard.tsx');

// User note 8: the agent's AskUserQuestion as a question card, not a permission card.
const q1 = 'Il brief dice circa 30 s, il titolo 12 s: quale durata uso?';
const q2 = 'Quali formati aggiorno?';
const question: ApprovalRequest = {
  id: 'q1', jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'question', title: 'L\'agente ti fa una domanda', detail: '', toolName: 'AskUserQuestion',
  alwaysRule: null, explanation: null, agentReason: null, createdAt: '2026-10-17T10:00:00.000Z', expiresAt: '2026-10-17T10:10:00.000Z',
  questions: [
    { question: q1, header: 'Durata', multiSelect: false, options: [{ label: '12 s', description: 'Come nel titolo e nell’obiettivo' }, { label: '30 s', description: 'Come nel brief' }] },
    { question: q2, header: 'Formati', multiSelect: true, options: [{ label: 'Instagram', description: '1:1' }, { label: 'Story', description: '9:16' }, { label: 'Banner', description: '300×250' }] },
  ],
};
const groupOf = (text: string) => screen.getByRole('group', { name: text });
beforeEach(() => vi.clearAllMocks());

describe('question card', () => {
  it('shows header, question, options with their descriptions, and no permission wording', () => {
    render(<ApprovalCard approval={question} />);
    expect(screen.getByText('Durata')).toBeTruthy();
    expect(screen.getByText(q1)).toBeTruthy();
    expect(screen.getByRole('radio', { name: /12 s/ })).toBeTruthy();
    expect(screen.getByText('Come nel brief')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Banner/ })).toBeTruthy();
    expect(screen.getByText('Puoi sceglierne più di una')).toBeTruthy();
    for (const w of [/Usa(re)? (lo strumento )?AskUserQuestion/i, /Comando sconosciuto/, /Unknown command/, /"questions"/, /Consenti/, /Sempre qui/]) expect(screen.queryByText(w)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Consenti' })).toBeNull();
  });

  it('sends the chosen options by index (single and multiple choice)', async () => {
    render(<ApprovalCard approval={question} />);
    const send = screen.getByRole('button', { name: 'Rispondi' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: /12 s/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Banner/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Instagram/ }));
    expect(send.disabled).toBe(false);
    await userEvent.click(send);
    expect(api.answerQuestion).toHaveBeenCalledWith('q1', [{ selected: [0] }, { selected: [0, 2] }]);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Rispondi' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('"Altro" takes the user\'s own words (instead of an option for one choice, with the options for several)', async () => {
    render(<ApprovalCard approval={question} />);
    const first = within(groupOf(q1));
    await userEvent.click(first.getByRole('radio', { name: /12 s/ }));
    await userEvent.click(first.getByRole('radio', { name: 'Altro' }));
    await userEvent.type(first.getByRole('textbox'), '20 s');
    const second = within(groupOf(q2));
    await userEvent.click(second.getByRole('checkbox', { name: /Story/ }));
    await userEvent.click(second.getByRole('checkbox', { name: 'Altro' }));
    await userEvent.type(second.getByRole('textbox'), 'anche il reel');
    await userEvent.click(screen.getByRole('button', { name: 'Rispondi' }));
    expect(api.answerQuestion).toHaveBeenCalledWith('q1', [{ selected: [], other: '20 s' }, { selected: [1], other: 'anche il reel' }]);
  });

  it('"Non rispondere" leaves it unanswered', async () => {
    render(<ApprovalCard approval={question} />);
    await userEvent.click(screen.getByRole('button', { name: 'Non rispondere' }));
    expect(api.decideApproval).toHaveBeenCalledWith('q1', 'deny');
    expect(api.answerQuestion).not.toHaveBeenCalled();
  });

  it('agent text is plain text, never HTML, and long texts are shortened on screen only', () => {
    const long = `${'Domanda lunga '.repeat(80)}fine?`;
    render(<ApprovalCard approval={{ ...question, questions: [{ question: long, header: '<img src=x onerror=alert(1)>', multiSelect: false, options: [{ label: '<b>A</b>', description: '<script>x</script>' }, { label: 'B', description: '' }] }] }} />);
    expect(document.querySelector('img, script, .ms-question-block b')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('<script>x</script>')).toBeTruthy();
    const shown = screen.getByText(/^Domanda lunga/);
    expect(shown.textContent!.length).toBeLessThan(long.length);
    expect(shown.textContent!.endsWith('…')).toBe(true);
    expect(shown.getAttribute('title')).toBe(long);
  });

  it('reports a question already answered elsewhere', async () => {
    api.answerQuestion.mockRejectedValueOnce(new ApiError(404, 'x'));
    render(<ApprovalCard approval={{ ...question, questions: [question.questions![0]!] }} />);
    await userEvent.click(screen.getByRole('radio', { name: /30 s/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Rispondi' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Richiesta già gestita'));
  });

  it('English', () => {
    render(<I18nProvider locale="en"><ApprovalCard approval={question} /></I18nProvider>);
    expect(screen.getByRole('button', { name: 'Answer' })).toBeTruthy();
    expect(screen.getAllByRole('radio', { name: 'Other' })).toHaveLength(1);
  });
});
