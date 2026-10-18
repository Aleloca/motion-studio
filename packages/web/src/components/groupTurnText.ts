// Phase 3 of the single agent (decision 980): the line that says what a group turn did, per variant ("Worked on: B (v4), C (no
// change, v2)"), in the chat and in the Activity center.
import type { GroupTurnOutcome } from '@motion-studio/shared';
import type { useT } from '../i18n.tsx';

export function groupTurnText(t: ReturnType<typeof useT>, outcome: readonly GroupTurnOutcome[]): string {
  const g = t.web.conversation.groupTurn;
  const part = (o: GroupTurnOutcome) => `${o.variant.toUpperCase()} (${o.status === 'complete' ? `v${o.version}`
    : o.status === 'incomplete' ? g.incomplete({ n: o.version ?? 0 })
      : o.status === 'unchanged' ? (o.version !== null ? g.unchangedAt({ n: o.version }) : g.unchanged)
        : o.status === 'stopped' ? g.stopped : g.failed})`;
  return g.workedOn({ list: outcome.map(part).join(', ') });
}
