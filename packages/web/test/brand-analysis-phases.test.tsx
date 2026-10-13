import { render, screen, within } from '@testing-library/react';
import type { AgentEvent, JobSummary } from '@motion-studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventsState } from '../src/eventsReducer.ts';
import { I18nProvider } from '../src/i18n.tsx';

vi.mock('../src/api.ts', () => ({ api: { cancelJob: vi.fn(async () => ({ cancelled: true })) }, ApiError: class extends Error {} }));
const { AnalysisCard } = await import('../src/screens/BrandSide.tsx');
const { analysisPhases, analysisSteps } = await import('../src/screens/brandModel.ts');

const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: 'j1', key: 'brand:k', kind: 'brand-analysis', label: 'Brand analysis', state: 'running', createdAt: '2026-10-13T10:00:00.000Z', ...over });
const live = (events: AgentEvent[]): EventsState => ({ approvals: {}, jobs: {}, events: { j1: events }, creativeTicks: {}, projectTicks: {} });
const card = (events: AgentEvent[], locale: 'en' | 'it' = 'en', j = job()) => render(<I18nProvider locale={locale}><AnalysisCard job={j} live={live(events)} /></I18nProvider>);
const queued: AgentEvent = { kind: 'progress', text: '', phase: 'queued' };
afterEach(() => vi.clearAllMocks());

describe('analysisPhases', () => {
  it('is null without phase events (older cores and jobs)', () => {
    expect(analysisPhases(undefined)).toBeNull();
    expect(analysisPhases([{ kind: 'progress', text: 'Reading acme.example' }])).toBeNull();
  });
  it('marks the phases before the latest one completed and the rest pending', () => {
    const states = analysisPhases([queued, { kind: 'progress', text: 'Reading', phase: 'reading' }, { kind: 'progress', text: 'Fonts', phase: 'fonts' }])!;
    expect(states.map((s) => `${s.phase}:${s.state}`)).toEqual(['queued:done', 'reading:done', 'fonts:current', 'colors:pending', 'logos:pending', 'tone:pending', 'writing:pending', 'done:pending']);
    expect(analysisPhases([queued, { kind: 'progress', text: '', phase: 'done' }])!.every((s) => s.state === 'done')).toBe(true);
  });
  it('never turns the core markers into free-text steps', () => {
    expect(analysisSteps([queued, { kind: 'progress', text: 'Reading the site', phase: 'reading' }, { kind: 'progress', text: '', phase: 'done' }])).toEqual(['Reading the site']);
  });
});

describe('AnalysisCard · phases stepper', () => {
  it('shows the phases above the free-text steps, with the current one marked', () => {
    card([queued, { kind: 'progress', text: 'Reading acme.example (4 pages)', phase: 'reading' }, { kind: 'progress', text: 'Looking at the CSS fonts', phase: 'fonts' }]);
    const region = screen.getByRole('region', { name: 'Learning the brand' });
    const stepper = within(region).getByRole('list', { name: 'Analysis phases' });
    const items = within(stepper).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Starting: completed', 'Reading: completed', 'Fonts: in progress', 'Colors: not started', 'Logos: not started', 'Tone: not started', 'Writing: not started', 'Done: not started',
    ]);
    expect(items.filter((li) => li.getAttribute('aria-current') === 'step').map((li) => li.dataset.state)).toEqual(['current']);
    expect(items[2]!.getAttribute('aria-current')).toBe('step');
    // The free-text steps are still there, after the stepper.
    const text = within(region).getByText('Looking at the CSS fonts');
    expect(stepper.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(region).getByText('Reading acme.example (4 pages)')).toBeTruthy();
  });

  it('shows the core\'s queued marker as the first current phase, and nothing empty in the steps', () => {
    card([queued]);
    const stepper = screen.getByRole('list', { name: 'Analysis phases' });
    expect(within(stepper).getAllByRole('listitem')[0]!.getAttribute('aria-current')).toBe('step');
    const steps = document.querySelectorAll('.ms-bsteps > li');
    expect([...steps].map((li) => li.textContent)).toEqual(['Starting: reading the sources']);
  });

  it('is translated', () => {
    card([queued, { kind: 'progress', text: 'Colori', phase: 'colors' }], 'it');
    const stepper = screen.getByRole('list', { name: "Fasi dell'analisi" });
    expect(within(stepper).getAllByRole('listitem').map((li) => li.textContent).slice(2, 4)).toEqual(['Font: completata', 'Colori: in corso']);
  });

  it('renders as before when no phase was received', () => {
    card([{ kind: 'progress', text: 'Reading acme.example (4 pages)' }, { kind: 'progress', text: 'Sampling colors' }]);
    const region = screen.getByRole('region', { name: 'Learning the brand' });
    expect(within(region).queryByRole('list', { name: 'Analysis phases' })).toBeNull();
    expect(within(region).getByText('Reading acme.example (4 pages)')).toBeTruthy();
    expect(within(region).getByText('Sampling colors')).toBeTruthy();
  });

  it('a queued job with no events keeps the waiting line and no stepper', () => {
    card([], 'en', job({ state: 'queued' }));
    expect(screen.queryByRole('list', { name: 'Analysis phases' })).toBeNull();
    expect(screen.getByText('Waiting to start…')).toBeTruthy();
  });
});
