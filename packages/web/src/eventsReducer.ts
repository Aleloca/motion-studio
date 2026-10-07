import type { AgentEvent, JobSummary, ServerMessage } from '@motion-studio/shared';

export interface EventsState { jobs: Record<string, JobSummary>; events: Record<string, AgentEvent[]>; creativeTicks: Record<string, number> }
export const initialEventsState: EventsState = { jobs: {}, events: {}, creativeTicks: {} };
const MAX_EVENTS = 2000;

export function eventsReducer(state: EventsState, msg: ServerMessage): EventsState {
  switch (msg.type) {
    case 'snapshot':
      return { ...state, jobs: Object.fromEntries(msg.jobs.map((j) => [j.id, j])) };
    case 'job':
      return { ...state, jobs: { ...state.jobs, [msg.job.id]: msg.job } };
    case 'agent': {
      const list = [...(state.events[msg.jobId] ?? []), msg.event];
      return { ...state, events: { ...state.events, [msg.jobId]: list.length > MAX_EVENTS ? list.slice(-MAX_EVENTS) : list } };
    }
    case 'creative': {
      const key = `${msg.project}/${msg.creative}`;
      return { ...state, creativeTicks: { ...state.creativeTicks, [key]: (state.creativeTicks[key] ?? 0) + 1 } };
    }
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
