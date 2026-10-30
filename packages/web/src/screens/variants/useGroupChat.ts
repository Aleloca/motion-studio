// Decision 980 (phase 2 of the single agent): a variant group has one chat, the same on the variants page, inside a variant and
// in the editor. The core answers the group's conversation for any member; these helpers give each page what the chat needs
// around it: a refresh when any member changes, the other variants' turns with their live events, and the group's approvals.
import { hostOf, letterOfSlug, type AgentEvent, type ApprovalRequest, type CreativeDetail, type CreativeStatus, type JobSummary, type VariantId } from '@motion-studio/shared';
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

export interface ChatTurns {
  versions: number; job: JobSummary | undefined; memberJobs: ReadonlyArray<{ job: JobSummary }>; memberVersions?: ReadonlyArray<number>;
  /**
   * Report 96 (decision 1984): what the creatives say server side (this one's and the known members'): a `working` status or a
   * queued request means a turn runs or is about to (the gap between one variant's turn ending and the next one in
   * `live.jobs`, or before the first snapshot), so there is nothing to start.
   */
  statuses?: ReadonlyArray<CreativeStatus | null | undefined>; queued?: number;
}

/** Report 96 (decision 1983): no turn of the creative or of its group works, waits or is about to start. */
export function chatTurnsIdle(o: ChatTurns): boolean {
  if (o.job && isActive(o.job)) return false;
  if ((o.statuses ?? []).includes('working') || (o.queued ?? 0) > 0) return false;
  return !o.memberJobs.some((m) => isActive(m.job));
}

/**
 * Decisions 850, 865, 1971: "Generate" in the chat is for a creative (or a variant group) that never started. Nothing in it
 * has a version, and no turn of it works or waits (the open one's, the chat's group turn, any other member's). While the
 * variants work and have saved nothing yet the chat shows the working controls instead, never "Generate". One rule for the
 * canvas, the format view and the editor. `memberVersions`: the version counts of the other members that are known.
 */
export function canGenerateChat(o: ChatTurns): boolean {
  if (o.versions > 0 || (o.memberVersions ?? []).some((n) => n > 0)) return false;
  return chatTurnsIdle(o);
}

export interface GroupChat {
  /**
   * This page's variant: its letter in the group, else the one its slug names (a host whose group is gone keeps the merged
   * chat, with the other variants' entries stamped: review minor 6).
   */
  self: VariantId;
  /** The other members' latest turns with their live events and their variant. */
  memberJobs: Array<{ job: JobSummary; live: AgentEvent[]; variant: VariantId }>;
  /** Whether an approval belongs in this chat: this creative's, or (in a group) any member's. */
  shows(a: ApprovalRequest): boolean;
  /**
   * Phase 3 of the single agent: the group has one agent: the composer sends to the group, and the chat follows the group's
   * turn (`groupJob`: its active one, else its latest). `memberJobs` then lists this page's own variant's turns too.
   */
  single: boolean;
  groupJob: JobSummary | undefined;
  /** For the pending comments (`useChatPins`): the group's host and this page's variant, when the group has one agent. */
  pinScope: { host: string; letter: VariantId } | null;
}

export function useGroupChat(live: EventsState, project: string, creative: string, detail: CreativeDetail | null): GroupChat {
  const v = detail?.variants;
  const group = v && !v.orphan ? v : null;
  const memberSlugs = useMemo(() => (group ? group.group.members.map((m) => m.slug) : [creative]), [group, creative]);
  const single = Boolean(group?.single);
  const memberJobs = useMemo(() => {
    if (!group || !detail) return [];
    // A member's job key is this creative's with the member's slug at the end (`creative:<root>:<project>:<slug>`).
    const prefix = detail.jobKey.slice(0, detail.jobKey.length - creative.length);
    const jobs = Object.values(live.jobs);
    // With one agent the chat follows the group turn: this page's variant's turns are members' turns like the others.
    return group.group.members.filter((m) => single || m.slug !== creative).flatMap((m) => {
      const mine = jobs.filter((j) => j.key === `${prefix}${m.slug}`);
      const job = mine.find(isActive) ?? [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return job ? [{ job, live: live.events[job.id] ?? [], variant: m.letter }] : [];
    });
  }, [group, detail, creative, live.jobs, live.events, single]);
  const groupKey = group?.single?.groupJobKey ?? null;
  const groupJob = useMemo(() => {
    if (!groupKey) return undefined;
    const mine = Object.values(live.jobs).filter((j) => j.key === groupKey);
    return mine.find(isActive) ?? [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [groupKey, live.jobs]);
  const self = group?.letter ?? letterOfSlug(creative);
  const host = group?.host ?? null;
  return useMemo(() => ({
    self,
    memberJobs,
    shows: (a: ApprovalRequest) => a.projectSlug === project && a.creativeSlug !== null && memberSlugs.includes(a.creativeSlug),
    single, groupJob,
    pinScope: single && host ? { host, letter: self } : null,
  }), [self, memberJobs, project, memberSlugs, single, groupJob, host]);
}
