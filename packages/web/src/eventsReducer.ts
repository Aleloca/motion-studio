import type { AgentEvent, ApprovalRequest, JobSummary, ServerMessage } from '@motion-studio/shared';

export interface EventsState { approvals: Record<string, ApprovalRequest>; jobs: Record<string, JobSummary>; events: Record<string, AgentEvent[]>; creativeTicks: Record<string, number>; projectTicks: Record<string, number> }
export const initialEventsState: EventsState = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };
const MAX_EVENTS = 2000;

export function eventsReducer(state: EventsState, msg: ServerMessage): EventsState {
  switch (msg.type) {
    case 'snapshot':
      // A snapshot follows a (re)connection: anything may have changed meanwhile, so every open creative refetches.
      return {
        ...state,
        jobs: Object.fromEntries(msg.jobs.map((j) => [j.id, j])),
        approvals: Object.fromEntries((msg.approvals ?? []).map((a) => [a.id, a])),
        creativeTicks: Object.fromEntries(Object.entries(state.creativeTicks).map(([k, v]) => [k, v + 1])),
        projectTicks: Object.fromEntries(Object.entries(state.projectTicks).map(([k, v]) => [k, v + 1])),
      };
    case 'approval':
      return { ...state, approvals: { ...state.approvals, [msg.approval.id]: msg.approval } };
    case 'approval_resolved': {
      const { [msg.id]: _gone, ...rest } = state.approvals;
      return { ...state, approvals: rest };
    }
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
