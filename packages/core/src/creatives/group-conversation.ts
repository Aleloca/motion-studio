import type { ConversationEntry, VariantId } from '@motion-studio/shared';

/**
 * Decisions 980 and 982 (phase 2 of the single agent, spec `2026-10-18-single-agent-design.md` §4.1 and §10): a variant
 * group has one conversation, the host's `conversation.jsonl`, and every entry written for a member carries its `variant`.
 * Until the group is migrated (`variantGroup.chat: 'single'`), each member still writes its own file and readers merge
 * the files in memory with `mergeConversations`, the same merge the migration writes once.
 */

/** A member's own log as it was before the merge: kept, never read again by the app (only a person or git looks at it). */
export const PREMERGE_FILE = 'conversation.premerge.jsonl';
/** The merged log written by a migration before its commit point; renamed onto the host's log right after it. */
export const MERGED_FILE = 'conversation.merged.jsonl';

/** The entries of a log: one JSON object per line; a hand-edited or truncated line is skipped (as `readConversation` always did). */
export function parseConversation(raw: string): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ConversationEntry;
      if (e && typeof e === 'object' && typeof e.type === 'string') out.push(e);
    } catch { /* skipped */ }
  }
  return out;
}

/**
 * Every entry of member `letter`'s own log carries its variant (an entry that already names one keeps it). Phase 3: the
 * group's own entries (`group`, the coordinator's) never get one.
 */
export const stampEntries = (entries: readonly ConversationEntry[], letter: VariantId): ConversationEntry[] =>
  entries.map((e) => (e.variant === undefined && !e.group ? { ...e, variant: letter } : e));

/**
 * Phase 3 of the single agent: the members whose turn now runs as a helper of a group turn, by project folder and slug. Every
 * entry the store writes for such a member carries `groupJobId` (the chat folds the helper's steps under its group turn), so
 * the forty places that write a turn's entries need not know. Set when the helper's turn is made, cleared once it settled;
 * a member has at most one turn at a time. In memory only.
 */
const helperTags = new Map<string, string>();
const tagKey = (projectDir: string, slug: string) => `${projectDir}\0${slug}`;
export function setHelperTag(projectDir: string, slug: string, groupJobId: string | null): void {
  if (groupJobId) helperTags.set(tagKey(projectDir, slug), groupJobId);
  else helperTags.delete(tagKey(projectDir, slug));
}
export const helperTagOf = (projectDir: string, slug: string): string | undefined => helperTags.get(tagKey(projectDir, slug));

const timeOf = (e: ConversationEntry): number => {
  const ms = Date.parse(e.at);
  return Number.isFinite(ms) ? ms : -Infinity;
};

/**
 * The members' logs as one, in time order (decision 982). A k-way merge: each log keeps its own order whatever its times
 * say (a log is written in order; a clock step never reorders it), and at each step the earliest next entry goes first; on
 * a tie, the member listed first (the host, then the sisters in id order). An entry with no readable time goes as soon as
 * its log reaches it. Every entry is stamped with its member's variant.
 */
export function mergeConversations(lists: ReadonlyArray<{ letter: VariantId; entries: readonly ConversationEntry[]; own?: boolean }>): ConversationEntry[] {
  // `own`: a member's own log, every entry of it is that member's whatever stamp it carries (decision 1169).
  // Phase 3: the group's own entries keep no variant, whichever log holds them.
  const logs = lists.map((l) => (l.own ? l.entries.map((e) => (e.group ? e : { ...e, variant: l.letter })) : stampEntries(l.entries, l.letter)));
  const at = logs.map(() => 0);
  const total = logs.reduce((n, l) => n + l.length, 0);
  const out: ConversationEntry[] = [];
  while (out.length < total) {
    let pick = -1;
    let best = Infinity;
    for (let i = 0; i < logs.length; i++) {
      const e = logs[i]![at[i]!];
      if (!e) continue;
      const time = timeOf(e);
      if (pick < 0 || time < best) { pick = i; best = time; }
    }
    out.push(logs[pick]![at[pick]!]!);
    at[pick]!++;
  }
  return out;
}

export const serializeConversation = (entries: readonly ConversationEntry[]): string => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
