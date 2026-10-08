import { formatLabel, type FormatPreset } from '@motion-studio/shared';
import { useLocale, useT } from '../i18n.tsx';
import { fitFrame } from '../frameSize.ts';

export function FormatPreview({ presets, selected }: { presets: FormatPreset[]; selected: string[] }) {
  const t = useT();
  const locale = useLocale();
  return (
    <section className="stack dots" aria-label={t.web.formatUi.previewAria} style={{ padding: 16, borderRadius: 14, minHeight: 240 }}>
      <strong>{t.web.formatUi.youWillGet({ count: selected.length })}</strong>
      <div className="row" style={{ alignItems: 'flex-end', gap: 20 }}>
        {selected.map((id) => {
          const p = presets.find((x) => x.id === id);
          if (!p) return <span key={id} className="error">{t.web.formatUi.unknownPreset({ id })}</span>;
          const size = fitFrame(p.width, p.height, 220, 170);
          return (
            <figure key={id} style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ ...size, border: '2px dashed var(--accent)', borderRadius: 4, background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="mono muted">{p.width}×{p.height}</span>
              </div>
              <figcaption style={{ fontSize: 12, fontWeight: 700, maxWidth: 220 }}>{formatLabel(p, locale)}</figcaption>
            </figure>
          );
        })}
        {selected.length === 0 && <p className="muted" style={{ margin: 0 }}>{t.web.formatUi.chooseOne}</p>}
      </div>
    </section>
  );
}
