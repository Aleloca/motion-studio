import { useRef, useState, type DragEvent } from 'react';

export function UploadZone({ label, onFiles, disabled }: { label: string; onFiles: (files: File[]) => Promise<void>; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (!files.length || disabled) return;
    setBusy(true); setError(null);
    try { await onFiles(files); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void send(e.dataTransfer.files); };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div role="button" tabIndex={0} aria-label={label} aria-disabled={disabled || busy}
        onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        style={{ border: `2px dashed ${over ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 12, padding: 18, textAlign: 'center', background: over ? 'var(--accent-soft)' : 'var(--surface)', cursor: 'pointer' }}>
        <strong>{busy ? 'Caricamento…' : label}</strong>
        <div className="muted" style={{ fontSize: 13 }}>Trascina qui i file o clicca per sceglierli (massimo 200 MB per file)</div>
      </div>
      <input ref={input} type="file" multiple aria-label={label} hidden onChange={(e) => { void send(e.target.files); e.target.value = ''; }} />
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
