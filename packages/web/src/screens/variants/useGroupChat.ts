// Decision 980 (phase 2 of the single agent): a variant group has one chat, the same on the variants page, inside a variant and
// in the editor. The core answers the group's conversation for any member; these helpers give each page what the chat needs
// around it: a refresh when any member changes, the other variants' turns with their live events, and the group's approvals.
import { hostOf, type AgentEvent, type ApprovalRequest, type CreativeDetail, type JobSummary, type VariantId } from '@motion-studio/shared';
import { useMemo } from 'react';
import type { EventsState } from '../../eventsReducer.ts';

/** The refresh tick of `creative`'s chat: its own, plus every member of its group's (the host's and its sisters'). */
export function chatTick(ticks: Record<string, number>, project: string, creative: string): number {
  const host = `${project}/${hostOf(creative)}`;
  let n = 0;
  for (const [k, v] of Object.entries(ticks)) if (k === host || k.startsWith(`${host}~`)) n += v;
  return n;
}

const isActive = (j: JobSummary) => j.state === 'queued' || j.state === 'running';

export interface GroupChat {
  /** This page's variant (absent outside a group). */
  self?: VariantId;
  /** The other members' latest turns with their live events. */
  memberJobs: Array<{ job: JobSummary; live: AgentEvent[] }>;
  /** Whether an approval belongs in this chat: this creative's, or (in a group) any member's. */
  shows(a: ApprovalRequest): boolean;
}

export function useGroupChat(live: EventsState, project: string, creative: string, detail: CreativeDetail | null): GroupChat {
  const v = detail?.variants;
  const group = v && !v.orphan ? v : null;
  const memberSlugs = useMemo(() => (group ? group.group.members.map((m) => m.slug) : [creative]), [group, creative]);
  const memberJobs = useMemo(() => {
    if (!group || !detail) return [];
    // A member's job key is this creative's with the member's slug at the end (`creative:<root>:<project>:<slug>`).
    const prefix = detail.jobKey.slice(0, detail.jobKey.length - creative.length);
    const jobs = Object.values(live.jobs);
    return group.group.members.filter((m) => m.slug !== creative).flatMap((m) => {
      const mine = jobs.filter((j) => j.key === `${prefix}${m.slug}`);
      const job = mine.find(isActive) ?? [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return job ? [{ job, live: live.events[job.id] ?? [] }] : [];
    });
  }, [group, detail, creative, live.jobs, live.events]);
  const self = group?.letter;
  return useMemo(() => ({
    ...(self ? { self } : {}),
    memberJobs,
    shows: (a: ApprovalRequest) => a.projectSlug === project && a.creativeSlug !== null && memberSlugs.includes(a.creativeSlug),
  }), [self, memberJobs, project, memberSlugs]);
}
