import type { FormatPreset } from '@motion-studio/shared';

export function groupByChannel(presets: FormatPreset[]): Array<[string, FormatPreset[]]> {
  const map = new Map<string, FormatPreset[]>();
  for (const p of presets) map.set(p.channel, [...(map.get(p.channel) ?? []), p]);
  return [...map.entries()];
}

export function FormatPicker({ presets, selected, onToggle }: { presets: FormatPreset[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {groupByChannel(presets).map(([channel, items]) => (
        <div key={channel} role="group" aria-label={channel} className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ flex: '0 0 96px', fontSize: 12, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{channel}</span>
          {items.map((p) => (
            <button key={p.id} type="button" className="chip" aria-pressed={selected.includes(p.id)} title={`${p.width}×${p.height} · ${p.kind === 'video' ? 'video' : 'immagine'}`} onClick={() => onToggle(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
