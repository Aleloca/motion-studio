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

/** Every entry of member `letter`'s own log carries its variant (an entry that already names one keeps it). */
export const stampEntries = (entries: readonly ConversationEntry[], letter: VariantId): ConversationEntry[] =>
  entries.map((e) => (e.variant === undefined ? { ...e, variant: letter } : e));

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
export function mergeConversations(lists: ReadonlyArray<{ letter: VariantId; entries: readonly ConversationEntry[] }>): ConversationEntry[] {
  const logs = lists.map((l) => stampEntries(l.entries, l.letter));
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
