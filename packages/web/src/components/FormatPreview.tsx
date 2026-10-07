import type { FormatPreset } from '@motion-studio/shared';
import { fitFrame } from '../frameSize.ts';

export function FormatPreview({ presets, selected }: { presets: FormatPreset[]; selected: string[] }) {
  return (
    <section className="stack dots" aria-label="Anteprima formati" style={{ padding: 16, borderRadius: 14, minHeight: 240 }}>
      <strong>Cosa riceverai · {selected.length} formati</strong>
      <div className="row" style={{ alignItems: 'flex-end', gap: 20 }}>
        {selected.map((id) => {
          const p = presets.find((x) => x.id === id);
          if (!p) return <span key={id} className="error">{id}: preset sconosciuto</span>;
          const size = fitFrame(p.width, p.height, 220, 170);
          return (
            <figure key={id} style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ ...size, border: '2px dashed var(--accent)', borderRadius: 4, background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="mono muted">{p.width}×{p.height}</span>
              </div>
              <figcaption style={{ fontSize: 12, fontWeight: 700, maxWidth: 220 }}>{p.channel} · {p.name}</figcaption>
            </figure>
          );
        })}
        {selected.length === 0 && <p className="muted" style={{ margin: 0 }}>Scegli almeno un formato.</p>}
      </div>
    </section>
  );
}
