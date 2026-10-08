import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api.ts';
import { desktop } from '../desktop.ts';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ExportDialog({ slug, creative, version, onClose }: { slug: string; creative: string; version: number; onClose: () => void }) {
  const bridge = desktop();
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ destination: string; count: number; skipped: string[] } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Focus moves into the dialog and goes back to the opener when it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) { e.preventDefault(); return; }
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && current === last) { e.preventDefault(); first.focus(); }
  };

  const choose = async () => {
    try { const picked = await bridge?.pickFolder('Scegli la cartella di destinazione', destination.trim() || undefined); if (picked) setDestination(picked); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const run = async () => {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.exportVersion(slug, creative, version, destination.trim());
      setDone({ destination: r.destination, count: r.files.length, skipped: r.skipped ?? [] });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={`Esporta v${version}`} tabIndex={-1} ref={dialogRef} onKeyDown={keyDown}
      style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50 }}>
      <div className="card stack" style={{ width: 'min(560px, 100%)', maxHeight: '95vh', overflow: 'auto' }}>
        <div className="row"><strong>Esporta v{version}</strong><div style={{ flex: 1 }} /><button type="button" onClick={onClose}>Chiudi</button></div>
        <label htmlFor="export-destination">Cartella di destinazione (percorso assoluto)</label>
        <div className="row" style={{ gap: 8 }}>
          <input id="export-destination" value={destination} disabled={busy} onChange={(e) => setDestination(e.target.value)} placeholder="/Users/tuonome/Consegna" style={{ flex: '1 1 240px', width: 'auto' }} />
          {bridge && <button type="button" disabled={busy} onClick={choose}>Scegli cartella…</button>}
        </div>
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
        {done && (
          <div role="status" className="stack" style={{ gap: 4 }}>
            <span>Esportati {done.count} file in {done.destination}</span>
            {done.skipped.length > 0 && <span className="warn">Non esportati: {done.skipped.join(', ')}</span>}
            {bridge && <div className="row"><button type="button" onClick={() => { bridge.revealPath(done.destination).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }}>Mostra nella cartella</button></div>}
          </div>
        )}
        <div className="row"><button type="button" className="primary" disabled={busy || !destination.trim()} onClick={run}>Esporta</button></div>
      </div>
    </div>
  );
}
