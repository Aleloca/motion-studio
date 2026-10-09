import type { AgentEvent, ApprovalRequest, JobSummary, LanguageSetting, Locale, ServerMessage } from '@motion-studio/shared';

/**
 * `liveUsage`: the latest live usage estimate per job. Live `usage` events (up to one a second per job) are kept here,
 * latest only, never in `events`, so they cannot push real events out of the MAX_EVENTS window. The final usage
 * (`live: false`) is a regular event. An entry is dropped when the final usage arrives, when its job ends, and on a
 * snapshot unless the job is still running.
 */
export interface EventsState { liveUsage?: Record<string, Extract<AgentEvent, { kind: 'usage' }>>; approvals: Record<string, ApprovalRequest>; jobs: Record<string, JobSummary>; events: Record<string, AgentEvent[]>; creativeTicks: Record<string, number>; projectTicks: Record<string, number>; /** Snapshots received (one per (re)connection): lets the UI tell restored state from new events. */ snapshots?: number; /** Unset until the first snapshot. */ language?: { locale: Locale; setting: LanguageSetting; systemLocale: Locale } | null }
export const initialEventsState: EventsState = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };
const MAX_EVENTS = 2000;
const TERMINAL = new Set<JobSummary['state']>(['succeeded', 'failed', 'cancelled']);

function withoutLiveUsage(state: EventsState, jobId: string): EventsState['liveUsage'] {
  if (!state.liveUsage || !(jobId in state.liveUsage)) return state.liveUsage;
  const { [jobId]: _gone, ...rest } = state.liveUsage;
  return rest;
}

export function eventsReducer(state: EventsState, msg: ServerMessage): EventsState {
  switch (msg.type) {
    case 'snapshot':
      // A snapshot follows a (re)connection: anything may have changed meanwhile, so every open creative refetches.
      return {
        ...state,
        snapshots: (state.snapshots ?? 0) + 1,
        jobs: Object.fromEntries(msg.jobs.map((j) => [j.id, j])),
        liveUsage: Object.fromEntries(Object.entries(state.liveUsage ?? {}).filter(([id]) => msg.jobs.some((j) => j.id === id && j.state === 'running'))),
        approvals: Object.fromEntries((msg.approvals ?? []).map((a) => [a.id, a])),
        language: msg.locale ? { locale: msg.locale, setting: msg.languageSetting ?? 'system', systemLocale: msg.systemLocale ?? msg.locale } : state.language,
        creativeTicks: Object.fromEntries(Object.entries(state.creativeTicks).map(([k, v]) => [k, v + 1])),
        projectTicks: Object.fromEntries(Object.entries(state.projectTicks).map(([k, v]) => [k, v + 1])),
      };
    case 'locale':
      return { ...state, language: { locale: msg.locale, setting: msg.setting, systemLocale: msg.systemLocale } };
    case 'approval':
      return { ...state, approvals: { ...state.approvals, [msg.approval.id]: msg.approval } };
    case 'approval_resolved': {
      const { [msg.id]: _gone, ...rest } = state.approvals;
      return { ...state, approvals: rest };
    }
    case 'job':
      return { ...state, jobs: { ...state.jobs, [msg.job.id]: msg.job }, ...(TERMINAL.has(msg.job.state) ? { liveUsage: withoutLiveUsage(state, msg.job.id) } : {}) };
    case 'agent': {
      if (msg.event.kind === 'usage' && msg.event.live) return { ...state, liveUsage: { ...state.liveUsage, [msg.jobId]: msg.event } };
      const list = [...(state.events[msg.jobId] ?? []), msg.event];
      const liveUsage = msg.event.kind === 'usage' ? withoutLiveUsage(state, msg.jobId) : state.liveUsage;
      return { ...state, liveUsage, events: { ...state.events, [msg.jobId]: list.length > MAX_EVENTS ? list.slice(-MAX_EVENTS) : list } };
    }
    case 'creative': {
      const key = `${msg.project}/${msg.creative}`;
      return { ...state, creativeTicks: { ...state.creativeTicks, [key]: (state.creativeTicks[key] ?? 0) + 1 } };
    }
    case 'project':
    case 'brand':
    case 'library':
      return { ...state, projectTicks: { ...state.projectTicks, [msg.project]: (state.projectTicks[msg.project] ?? 0) + 1 } };
  }
}

export function sessionIdOf(events: AgentEvent[]): string | undefined {
  let id: string | undefined;
  for (const e of events) {
    if (e.kind === 'session') id = e.sessionId;
    if (e.kind === 'result' && e.sessionId) id = e.sessionId;
  }
  return id;
}
