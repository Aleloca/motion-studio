import type { ConversationEntry, CreativeDetail, JobSummary, AgentEvent, Pin, FormatPreset } from '@motion-studio/shared';

export interface ConversationPanelProps {
  slug: string; detail: CreativeDetail; conversation: ConversationEntry[]; presets: FormatPreset[];
  job: JobSummary | undefined; liveEvents: AgentEvent[]; expert: boolean;
  pins: Pin[]; onRemovePin(index: number): void; onSent(): void; onSelectVersion(n: number): void; onChanged(): void;
}

export function ConversationPanel(_: ConversationPanelProps) {
  return <aside className="card" aria-label="Conversazione">Conversazione</aside>;
}
