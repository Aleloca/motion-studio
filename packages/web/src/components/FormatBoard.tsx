import type { FormatPreset, OutputFileInfo, Pin, VersionEntry } from '@motion-studio/shared';
import type { CSSProperties } from 'react';
import { fitFrame } from '../frameSize.ts';
import { groupByChannel } from './FormatPicker.tsx';
import { MediaThumb } from './MediaThumb.tsx';

interface BoardProps {
  presets: FormatPreset[]; formats: string[]; version: VersionEntry | null; compare: VersionEntry | null;
  fileUrl: (n: number, file: string) => string; pins: Pin[]; showSafeZone: boolean; onOpen: (id: string) => void;
}

function Frame({ preset, version, fileUrl, pins, showSafeZone }: { preset: FormatPreset; version: VersionEntry | null; fileUrl: BoardProps['fileUrl']; pins: Array<{ pin: Pin; number: number }>; showSafeZone: boolean }) {
  const size = fitFrame(preset.width, preset.height, 300, 260);
  const out: OutputFileInfo | undefined = version?.outputs.find((o) => o.format === preset.id);
  const label = `${preset.channel} · ${preset.name}`;
  const band = (s: CSSProperties): CSSProperties => ({ position: 'absolute', background: 'var(--accent)', opacity: 0.18, ...s });
  const sz = preset.safeZone;
  return (
    <div style={{ ...size, position: 'relative', borderRadius: 4, overflow: 'hidden', background: 'var(--surface)', border: out ? '1px solid var(--border)' : '2px dashed var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {out && version
        ? <MediaThumb src={fileUrl(version.n, out.file)} alt={`${label} v${version.n}`} />
        : <span className="muted" style={{ fontSize: 12 }}>{version ? `Mancante in v${version.n}` : 'In attesa'}</span>}
      {showSafeZone && sz && (
        <>
          <span style={band({ left: 0, right: 0, top: 0, height: `${(sz.top / preset.height) * 100}%` })} />
          <span style={band({ left: 0, right: 0, bottom: 0, height: `${(sz.bottom / preset.height) * 100}%` })} />
          <span data-testid="safe-left" style={band({ top: 0, bottom: 0, left: 0, width: `${(sz.left / preset.width) * 100}%` })} />
          <span data-testid="safe-right" style={band({ top: 0, bottom: 0, right: 0, width: `${(sz.right / preset.width) * 100}%` })} />
        </>
      )}
      {out?.verified === false && <span className="badge" style={{ position: 'absolute', top: 6, left: 6 }}>non verificato</span>}
      {pins.map(({ pin: p, number }) => (
        <span key={number} aria-label={`Commento ${number}`} style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: 'translate(-50%, -100%)', width: 22, height: 22, borderRadius: '50% 50% 50% 0', background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--on-accent)' }}>{number}</span>
      ))}
    </div>
  );
}

export function FormatBoard({ presets, formats, version, compare, fileUrl, pins, showSafeZone, onOpen }: BoardProps) {
  const known = presets.filter((p) => formats.includes(p.id));
  const unknown = formats.filter((id) => !presets.some((p) => p.id === id));
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 24, padding: 20 }}>
      {groupByChannel(known).map(([channel, items]) => (
        <section key={channel} aria-label={channel} className="stack" style={{ gap: 10, padding: 14, borderRadius: 14, border: '1px dashed var(--border)' }}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{channel}</span>
          <div className="row" style={{ alignItems: 'flex-end', gap: 18 }}>
            {items.map((p) => {
              const formatPins = pins.map((pin, i) => ({ pin, number: i + 1 })).filter((x) => x.pin.format === p.id);
              return (
                <button key={p.id} type="button" onClick={() => onOpen(p.id)} aria-label={`${p.channel} · ${p.name} — apri`} className="frame-open">
                  <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
                    {compare && (
                      <div className="stack" style={{ gap: 4 }}>
                        <Frame preset={p} version={compare} fileUrl={fileUrl} pins={[]} showSafeZone={showSafeZone} />
                        <span className="muted" style={{ fontSize: 12 }}>v{compare.n}</span>
                      </div>
                    )}
                    <div className="stack" style={{ gap: 4 }}>
                      <Frame preset={p} version={version} fileUrl={fileUrl} pins={formatPins} showSafeZone={showSafeZone} />
                      {compare && version && <span className="muted" style={{ fontSize: 12 }}>v{version.n}</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name} <span className="mono muted">{p.width}×{p.height}</span></span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {unknown.length > 0 && (
        <section aria-label="Altro" className="stack" style={{ gap: 6, padding: 14 }}>
          {unknown.map((id) => <span key={id} className="error">{id}: preset sconosciuto</span>)}
        </section>
      )}
    </div>
  );
}
