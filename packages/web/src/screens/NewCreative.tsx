import type { FormatPreset, LinkedCodebase } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { CodebaseList } from '../components/CodebaseList.tsx';
import { FormatPicker } from '../components/FormatPicker.tsx';
import { FormatPreview } from '../components/FormatPreview.tsx';
import { useT } from '../i18n.tsx';
import { href } from '../routes.ts';

const DURATIONS: Array<number | null> = [6, 15, 30, 60, null];

export function NewCreative({ slug }: { slug: string }) {
  const t = useT();
  const n = t.web.newCreative;
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [message, setMessage] = useState('');
  const [formats, setFormats] = useState<string[]>([]);
  const [durationSec, setDurationSec] = useState<number | null>(15);
  const [assets, setAssets] = useState('');
  const [codebases, setCodebases] = useState<LinkedCodebase[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getFormats().then((s) => { setPresets(s.presets); setCatalogError(s.error); }).catch((e: unknown) => setError(String((e as Error).message)));
  }, []);

  const toggle = (id: string) => setFormats((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const ready = goal.trim() !== '' && formats.length > 0 && !busy;

  const submit = async (generate: boolean) => {
    setBusy(true); setError(null);
    try {
      const created = await api.createCreative(slug, {
        title: title.trim() || goal.trim().slice(0, 60),
        brief: {
          goal: goal.trim(), message: message.trim(), formats, durationSec,
          assets: assets.split(',').map((a) => a.trim()).filter(Boolean), notes: notes.trim(),
        },
        generate,
        linkedCodebases: codebases,
      });
      location.hash = href.creative(slug, created.slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" style={{ maxWidth: 1280 }}>
      <a href={href.project(slug)} className="muted">{n.back}</a>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginTop: 12 }}>
        <form className="card stack" style={{ flex: '1 1 520px', minWidth: 0 }} onSubmit={(e) => { e.preventDefault(); void submit(true); }}>
          <label htmlFor="goal" style={{ fontSize: 24, fontWeight: 800 }}>{n.goalQuestion}</label>
          <textarea id="goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={n.goalPlaceholder} />
          <label htmlFor="message"><strong>{n.keyMessage}</strong> <span className="muted">{n.optional}</span></label>
          <input id="message" value={message} onChange={(e) => setMessage(e.target.value)} />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend style={{ fontWeight: 800, marginBottom: 8 }}>{n.whereTo}</legend>
            {catalogError && <p className="warn" style={{ margin: 0 }}>{catalogError}</p>}
            <FormatPicker presets={presets} selected={formats} onToggle={toggle} />
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend style={{ fontWeight: 800, marginBottom: 8 }}>{n.videoLength}</legend>
            <div className="row" style={{ gap: 6 }}>
              {DURATIONS.map((v) => (
                <button key={v ?? 'none'} type="button" className="chip" aria-pressed={durationSec === v} onClick={() => setDurationSec(v)}>{v === null ? n.noDuration : n.seconds({ n: v })}</button>
              ))}
            </div>
          </fieldset>
          <label htmlFor="assets"><strong>{n.assetsToUse}</strong> <span className="muted">{n.assetsHint}</span></label>
          <input id="assets" value={assets} onChange={(e) => setAssets(e.target.value)} placeholder="assets/logo.svg" />
          <strong>{n.codebases} <span className="muted" style={{ fontWeight: 400 }}>{n.codebasesHint}</span></strong>
          <CodebaseList value={codebases} onChange={setCodebases} />
          <label htmlFor="notes"><strong>{n.notesForAgent}</strong> <span className="muted">{n.optional}</span></label>
          <input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <label htmlFor="title"><strong>{n.title}</strong> <span className="muted">{n.optional}</span></label>
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
          <div className="row">
            <div style={{ flex: 1 }} />
            <button type="button" disabled={!ready} onClick={() => void submit(false)}>{n.saveDraft}</button>
            <button type="submit" className="primary" disabled={!ready}>{n.generate}</button>
          </div>
        </form>
        <div style={{ flex: '1 1 420px', minWidth: 0 }}>
          <FormatPreview presets={presets} selected={formats} />
        </div>
      </div>
    </main>
  );
}
