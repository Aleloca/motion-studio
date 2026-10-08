import type { Brief, CreativeDetail, FormatPreset, LinkedCodebase } from '@motion-studio/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n.tsx';
import { CodebaseList } from './CodebaseList.tsx';
import { FormatPicker } from './FormatPicker.tsx';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Brief form of a creative: saves it, or saves and starts a new generation. */
export function BriefEditor({ slug, detail, presets, disabled, onChanged }: { slug: string; detail: CreativeDetail; presets: FormatPreset[]; disabled: boolean; onChanged(): void }) {
  const t = useT();
  const c = detail.creative;
  const [title, setTitle] = useState(c.title);
  const [brief, setBrief] = useState<Brief>(c.brief);
  const [assets, setAssets] = useState(c.brief.assets.join(', '));
  const [codebases, setCodebases] = useState<LinkedCodebase[]>(c.linkedCodebases);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const save = async (regenerate: boolean) => {
    setError(null);
    let saved = false;
    try {
      await api.updateCreative(slug, detail.slug, { title, brief: { ...brief, assets: assets.split(',').map((a) => a.trim()).filter(Boolean) }, linkedCodebases: codebases });
      saved = true;
      if (regenerate) await api.sendCreativeTurn(slug, detail.slug, {});
    } catch (e) { setError(message(e)); }
    // The brief is saved even if starting the generation failed: the page must show it.
    if (saved) onChanged();
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(false); }} style={{ padding: 14, overflow: 'auto' }}>
      <label htmlFor="b-title">{t.web.newCreative.title}</label><input id="b-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="b-goal">{t.web.conversation.goal}</label><textarea id="b-goal" rows={3} value={brief.goal} onChange={(e) => set('goal', e.target.value)} />
      <label htmlFor="b-msg">{t.web.newCreative.keyMessage}</label><input id="b-msg" value={brief.message} onChange={(e) => set('message', e.target.value)} />
      <label htmlFor="b-dur">{t.web.conversation.length}</label>
      <input id="b-dur" type="number" min={1} max={600} value={brief.durationSec ?? ''} onChange={(e) => set('durationSec', e.target.value ? Number(e.target.value) : null)} />
      <label htmlFor="b-assets">{t.web.conversation.assets}</label><input id="b-assets" value={assets} onChange={(e) => setAssets(e.target.value)} />
      <label htmlFor="b-notes">{t.web.conversation.notes}</label><input id="b-notes" value={brief.notes} onChange={(e) => set('notes', e.target.value)} />
      <strong>{t.web.conversation.formats}</strong>
      <FormatPicker presets={presets} selected={brief.formats} onToggle={(id) => set('formats', brief.formats.includes(id) ? brief.formats.filter((x) => x !== id) : [...brief.formats, id])} />
      <strong>{t.web.newCreative.codebases}</strong>
      <CodebaseList value={codebases} onChange={setCodebases} disabled={disabled} />
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <button type="submit" disabled={disabled}>{t.common.save}</button>
        <button type="button" className="primary" disabled={disabled} onClick={() => void save(true)}>{t.web.conversation.saveAndRegenerate}</button>
      </div>
    </form>
  );
}
