import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { desktop } from '../desktop.ts';
import { formatNumber, useLocale, useT } from '../i18n.tsx';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ExportDialog({ slug, creative, version, onClose }: { slug: string; creative: string; version: number; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const bridge = desktop();
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ destination: string; count: number; skipped: string[] } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    // Focus moves into the dialog and goes back to the opener when it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    // Document-level so Escape and the Tab trap keep working even when focus sits on a disabled control.
    const keyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) { e.preventDefault(); dialogRef.current.focus(); return; }
      const current = document.activeElement;
      const inside = dialogRef.current.contains(current) && current !== dialogRef.current;
      if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && current === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && current === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => { document.removeEventListener('keydown', keyDown); if (opener?.isConnected) opener.focus(); };
  }, []);

  const choose = async () => {
    try { const picked = await bridge?.pickFolder(t.web.exportUi.pickTitle, destination.trim() || undefined); if (picked) { setDestination(picked); setDone(null); } }
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
    <div role="dialog" aria-modal="true" aria-label={t.web.exportUi.title({ n: version })} tabIndex={-1} ref={dialogRef}
      style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50 }}>
      <div className="card stack" style={{ width: 'min(560px, 100%)', maxHeight: '95vh', overflow: 'auto' }}>
        <div className="row"><strong>{t.web.exportUi.title({ n: version })}</strong><div style={{ flex: 1 }} /><button type="button" onClick={onClose}>{t.common.close}</button></div>
        <label htmlFor="export-destination">{t.web.exportUi.destination}</label>
        <div className="row" style={{ gap: 8 }}>
          <input id="export-destination" value={destination} disabled={busy} onChange={(e) => { setDestination(e.target.value); setDone(null); }} placeholder={t.web.exportUi.placeholder} style={{ flex: '1 1 240px', width: 'auto' }} />
          {bridge && <button type="button" disabled={busy} onClick={choose}>{t.web.common.chooseFolder}</button>}
        </div>
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
        {done && (
          <div role="status" className="stack" style={{ gap: 4 }}>
            <span>{t.web.exportUi.done({ count: done.count, destination: done.destination })}</span>
            {done.skipped.length > 0 && <span className="warn">{t.web.exportUi.skipped({ list: done.skipped.join(', ') })}</span>}
            {bridge && <div className="row"><button type="button" onClick={() => { bridge.revealPath(done.destination).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }}>{t.web.common.revealFolder}</button></div>}
          </div>
        )}
        <div className="row"><button type="button" className="primary" disabled={busy || !destination.trim()} onClick={run}>{t.web.exportUi.run}</button></div>
      </div>
    </div>
  );
}
