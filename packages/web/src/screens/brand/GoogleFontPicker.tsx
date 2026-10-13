// Google Fonts from the brand page: search, preview, weights and add. Everything goes through the core: the catalog,
// the preview subsets (loaded with FontFace under a private family, like brandFonts.ts) and the download of the files.
import type { BrandFont } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { api, type GoogleFamily, type GoogleFontSearch } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { Button, Check, cx, Input, Modal, Select, Spinner, Toggle, toast } from '../../ui/index.ts';
import { message } from '../common.tsx';
import { specimenFamily, useFontPreview } from '../brandFonts.ts';

/** Quiet time after typing before the catalog is asked. */
export const SEARCH_MS = 300;
const LIMIT = 24;
const CATEGORIES = ['Sans Serif', 'Serif', 'Display', 'Handwriting', 'Monospace'] as const;
const ROLES: Array<BrandFont['role']> = ['heading', 'body', 'accent', 'other'];

const previewWeight = (f: GoogleFamily) => (f.weights.includes(400) ? 400 : f.weights[0]!);

function Row({ f, selected, onPick }: { f: GoogleFamily; selected: boolean; onPick(): void }) {
  const t = useT();
  const g = t.web.brand.fonts.google;
  const preview = useFontPreview(api.googleFontPreviewUrl(f.family, previewWeight(f)));
  return (
    <button type="button" className={cx('ms-gf-row', selected && 'ms-on')} aria-pressed={selected} onClick={onPick}>
      <span className="ms-gf-name" style={{ fontFamily: specimenFamily(preview) }}>{f.family}</span>
      <span className="ms-gf-meta ms-muted">
        {f.category ? (g.categories as Record<string, string>)[f.category] ?? f.category : ''}
        {f.variable ? ` · ${g.variable}` : ''}
        {preview.state === 'failed' ? ` · ${g.previewFailed}` : ''}
      </span>
    </button>
  );
}

export function GoogleFontPicker({ open, slug, locked, onClose, onAdded }: {
  open: boolean; slug: string; locked: boolean; onClose(): void; onAdded(font: BrandFont): void;
}) {
  const t = useT();
  const g = t.web.brand.fonts.google;
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [result, setResult] = useState<GoogleFontSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [weights, setWeights] = useState<number[]>([]);
  const [italic, setItalic] = useState(false);
  const [role, setRole] = useState<BrandFont['role']>('body');
  const [adding, setAdding] = useState(false);
  const seq = useRef(0);

  // Debounced search: only the answer to the latest query counts.
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      Promise.resolve().then(() => api.searchGoogleFonts({ q: text.trim(), category, limit: LIMIT })).then(
        (r) => { if (seq.current === mine) { setResult(r); setError(null); setSearching(false); } },
        (e: unknown) => { if (seq.current === mine) { setError(message(e)); setSearching(false); } },
      );
    }, text ? SEARCH_MS : 0);
    return () => clearTimeout(timer);
  }, [open, text, category]);

  const family = result?.families.find((f) => f.family === picked) ?? null;
  const pick = (f: GoogleFamily) => {
    setPicked(f.family);
    setWeights(f.weights.includes(400) ? [400] : [f.weights[0]!]);
    setItalic(false);
  };
  const toggleWeight = (w: number, on: boolean) => setWeights((cur) => (on ? [...cur, w] : cur.filter((x) => x !== w)).sort((a, b) => a - b));
  const add = async () => {
    if (!family || !weights.length) return;
    setAdding(true);
    try {
      const { font } = await api.addGoogleFont(slug, { family: family.family, weights, italic: italic && family.italic, role });
      onAdded(font);
      toast.show(g.added({ family: font.family }), { tone: 'ok' });
      onClose();
    } catch (e) {
      toast.show(g.addFailed({ error: message(e) }));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} label={g.title} width={760}>
      <div className="ms-gf">
        <h2 className="ms-gf-title">{g.title}</h2>
        <div className="ms-gf-bar">
          <Input value={text} aria-label={g.search} placeholder={g.searchHint} onChange={(e) => setText(e.target.value)} autoFocus />
          <Select value={category} label={g.category} onChange={setCategory}
            options={[{ value: '', label: g.categoryAll }, ...CATEGORIES.map((c) => ({ value: c, label: g.categories[c] }))]} />
        </div>
        {result?.fallback ? <p className="ms-bnote" role="status">{g.fallback}</p> : null}
        {result?.stale && !result.fallback ? <p className="ms-bnote" role="status">{g.stale}</p> : null}
        {error ? <p className="ms-bwarn" role="alert">{g.failed({ error })}</p> : null}
        <div className="ms-gf-body">
          <div className="ms-gf-list" role="group" aria-label={g.results} aria-busy={searching}>
            {searching && !result ? <Spinner size={16} /> : null}
            {result && !result.families.length && !searching ? <p className="ms-bempty-line">{g.empty}</p> : null}
            {result?.families.map((f) => <Row key={f.family} f={f} selected={f.family === picked} onPick={() => pick(f)} />)}
          </div>
          <div className="ms-gf-side">
            {family ? (
              <>
                <b>{family.family}</b>
                <div className="ms-bpop-field">
                  <span>{g.weights}</span>
                  <div className="ms-gf-weights">
                    {family.weights.map((w) => (
                      <label key={w} className="ms-gf-weight">
                        <Check on={weights.includes(w)} onChange={(on) => toggleWeight(w, on)} label={g.weight({ weight: w })} />
                        <span className="ms-mono">{w}</span>
                      </label>
                    ))}
                  </div>
                </div>
                {family.italic ? (
                  <div className="ms-gf-weight">
                    <Toggle on={italic} onChange={setItalic} label={g.italic} size="sm" />
                    <span>{g.italic}</span>
                  </div>
                ) : null}
                <div className="ms-bpop-field">
                  <span>{g.role}</span>
                  <Select value={role} label={g.role} onChange={(v) => setRole(v as BrandFont['role'])} options={ROLES.map((r) => ({ value: r, label: t.web.labels.fontRoles[r] }))} />
                </div>
                <small className="ms-muted">{g.license}</small>
                <Button variant="accent" disabled={locked || adding || !weights.length} onClick={() => { void add(); }}>{adding ? g.adding : g.add}</Button>
              </>
            ) : <p className="ms-muted">{g.choose}</p>}
          </div>
        </div>
        <div className="ms-gf-foot"><Button variant="ghost" onClick={onClose}>{g.close}</Button></div>
      </div>
    </Modal>
  );
}
