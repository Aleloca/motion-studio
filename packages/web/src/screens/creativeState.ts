import type { AgentEvent, ApprovalRequest, ConversationEntry, CreativeSummary, FormatPreset, JobSummary, Pin } from '@motion-studio/shared';
import type { EventsState } from '../eventsReducer.ts';
import { CHANNELS, type Channel } from '../ui/index.ts';

/** What a creative card says about a creative, from its stored status and the live state (approvals, jobs). */
export type CardState = 'needs' | 'running' | 'ready' | 'incomplete' | 'draft' | 'failed' | 'interrupted';

export interface LiveCreative {
  state: CardState;
  /** The first pending approval of the creative (state `needs`). */
  approval: ApprovalRequest | null;
  /** The active generation, if any (also while an approval waits). */
  job: JobSummary | null;
  /** Latest step the agent reported (progress events carry text only: no percentage exists). */
  step: string | null;
}

const isActive = (j: JobSummary) => j.state === 'queued' || j.state === 'running';

/**
 * The core's creative job key is `creative:<workspace root>:<project>:<creative>`; slugs never contain ':', so the
 * suffix identifies the creative without knowing the root.
 */
export function creativeJob(live: EventsState, project: string, creative: string): JobSummary | null {
  const suffix = `:${project}:${creative}`;
  return Object.values(live.jobs).find((j) => isActive(j) && j.key.startsWith('creative:') && j.key.endsWith(suffix)) ?? null;
}

/** Latest step the job reported (agent progress), if any. */
export function lastStep(events: AgentEvent[] | undefined): string | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'progress' && e.text.trim()) return e.text.trim();
  }
  return null;
}

export function liveCreative(c: CreativeSummary, project: string, live: EventsState): LiveCreative {
  const approval = Object.values(live.approvals)
    .filter((a) => a.projectSlug === project && a.creativeSlug === c.slug)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  const job = creativeJob(live, project, c.slug);
  const step = job ? lastStep(live.events[job.id]) : null;
  const state: CardState = approval ? 'needs'
    : job || c.status === 'working' ? 'running'
    : c.status === 'error' ? 'failed'
    : c.status;
  return { state, approval, job, step };
}

export type CreativeFilter = 'all' | 'needs' | 'running' | 'ready' | 'drafts';
export const CREATIVE_FILTERS: readonly CreativeFilter[] = ['all', 'needs', 'running', 'ready', 'drafts'];

/** The segment a state belongs to; failed and interrupted creatives are only under All. */
export function matches(filter: CreativeFilter, state: CardState): boolean {
  switch (filter) {
    case 'all': return true;
    case 'needs': return state === 'needs';
    case 'running': return state === 'running';
    // An incomplete version is still a result the user can look at.
    case 'ready': return state === 'ready' || state === 'incomplete';
    case 'drafts': return state === 'draft';
  }
}

/** `Instagram` → `instagram`, `App Store` → `appstore`; unknown channels get the generic web mark. */
export function channelOf(channel: string): Channel {
  const id = channel.toLowerCase().replace(/[^a-z]/g, '');
  return (CHANNELS as readonly string[]).includes(id) ? (id as Channel) : 'web';
}

export interface Frame { id: string; preset: FormatPreset | null; width: number; height: number }

/**
 * Preview frames for `formats` in proportion (the catalog gives width and height): the tallest is `height` px and the
 * row (with `gap` between frames) fits in `maxWidth`. A format missing from the catalog is drawn square.
 */
export function frames(formats: string[], presets: FormatPreset[], o: { height: number; maxWidth: number; gap: number }): Frame[] {
  const aspects = formats.map((id) => {
    const preset = presets.find((p) => p.id === id) ?? null;
    return { id, preset, a: preset ? preset.width / preset.height : 1 };
  });
  if (aspects.length === 0) return [];
  const sum = aspects.reduce((s, x) => s + x.a, 0);
  const room = o.maxWidth - o.gap * (aspects.length - 1);
  const h = Math.min(o.height, room / sum);
  return aspects.map(({ id, preset, a }) => ({ id, preset, width: Math.round(h * a), height: Math.round(h) }));
}

/**
 * What "Try again" sends after a failure: the user's turn that failed (text and pins), when the failure followed one,
 * i.e. the last user message comes after the last version. Otherwise (a failed first generation, or a failed
 * regenerate without a message) an empty turn, so the core starts again from the brief / its own retry wording.
 */
export function retryTurn(entries: ConversationEntry[]): { text?: string; pins?: Pin[] } {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === 'version') return {};
    if (e.type === 'user') return { text: e.text, ...(e.pins.length ? { pins: e.pins } : {}) };
  }
  return {};
}
