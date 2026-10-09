// Brief form of a creative ("Edit the brief" in the canvas panel), built from ui/ controls only: no native select,
// checkbox or number field, no textarea resize. Saves it, or saves and starts a new generation.
import { channelName, formatName, type Brief, type CreativeDetail, type FormatPreset, type LinkedCodebase } from '@motion-studio/shared';
import { useId, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { useLocale, useT } from '../i18n.tsx';
import { Button, ChannelMark, Chip, channelOf, Input, Segmented, Textarea } from '../ui/index.ts';
import { CodebaseList } from './CodebaseList.tsx';
import './brief.css';
import { message } from '../errors.ts';

const LENGTHS = ['none', '6', '15', '30', '60', 'custom'] as const;
type LengthChoice = (typeof LENGTHS)[number];
const lengthChoice = (sec: number | null): LengthChoice => (sec === null ? 'none' : (LENGTHS as readonly string[]).includes(String(sec)) ? (String(sec) as LengthChoice) : 'custom');

export function BriefEditor({ slug, detail, presets, disabled, onChanged }: { slug: string; detail: CreativeDetail; presets: FormatPreset[]; disabled: boolean; onChanged(): void }) {
  const t = useT();
  const cv = t.web.conversation;
  const nc = t.web.newCreative;
  const locale = useLocale();
  const id = useId();
  const c = detail.creative;
  const [title, setTitle] = useState(c.title);
  const [brief, setBrief] = useState<Brief>(c.brief);
  const [length, setLength] = useState<LengthChoice>(() => lengthChoice(c.brief.durationSec));
  const [custom, setCustom] = useState(() => (lengthChoice(c.brief.durationSec) === 'custom' ? String(c.brief.durationSec) : ''));
  const [assets, setAssets] = useState(c.brief.assets.join(', '));
  const [codebases, setCodebases] = useState<LinkedCodebase[]>(c.linkedCodebases);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'regenerate' | null>(null);
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const toggle = (fid: string) => set('formats', brief.formats.includes(fid) ? brief.formats.filter((x) => x !== fid) : [...brief.formats, fid]);
  const groups = useMemo(() => {
    const m = new Map<string, FormatPreset[]>();
    for (const p of presets) m.set(p.channel, [...(m.get(p.channel) ?? []), p]);
    return [...m.entries()];
  }, [presets]);

  const durationSec = (): number | null | 'invalid' => {
    if (length === 'none') return null;
    if (length !== 'custom') return Number(length);
    const n = Number(custom);
    return Number.isInteger(n) && n >= 1 && n <= 600 ? n : 'invalid';
  };
  const save = async (regenerate: boolean) => {
    setError(null);
    const sec = durationSec();
    if (sec === 'invalid') { setError(nc.customInvalid); return; }
    setBusy(regenerate ? 'regenerate' : 'save');
    let saved = false;
    try {
      await api.updateCreative(slug, detail.slug, { title, brief: { ...brief, durationSec: sec, assets: assets.split(',').map((a) => a.trim()).filter(Boolean) }, linkedCodebases: codebases });
      saved = true;
      if (regenerate) await api.sendCreativeTurn(slug, detail.slug, {});
    } catch (e) { setError(message(e)); }
    setBusy(null);
    // The brief is saved even if starting the generation failed: the page must show it.
    if (saved) onChanged();
  };

  return (
    <form className="ms-brief-form" onSubmit={(e) => { e.preventDefault(); void save(false); }}>
      <label className="ms-brief-lbl" htmlFor={`${id}-title`}>{nc.title}</label>
      <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
      <label className="ms-brief-lbl" htmlFor={`${id}-goal`}>{cv.goal}</label>
      <Textarea id={`${id}-goal`} rows={4} value={brief.goal} onChange={(e) => set('goal', e.target.value)} />
      <label className="ms-brief-lbl" htmlFor={`${id}-msg`}>{nc.keyMessage}</label>
      <Input id={`${id}-msg`} value={brief.message} onChange={(e) => set('message', e.target.value)} />
      <span className="ms-brief-lbl">{cv.length}</span>
      <Segmented className="ms-brief-len" label={cv.lengthFor} value={length} onChange={setLength}
        options={LENGTHS.map((v) => ({ value: v, label: v === 'none' ? cv.lengthNone : v === 'custom' ? nc.custom : nc.secondsShort({ n: Number(v) }) }))} />
      {length === 'custom' ? (
        <Input inputMode="numeric" aria-label={nc.customSeconds} placeholder={nc.customSeconds} value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/\D/g, '').slice(0, 3))} />
      ) : null}
      <label className="ms-brief-lbl" htmlFor={`${id}-assets`}>{cv.assets}</label>
      <Input id={`${id}-assets`} value={assets} onChange={(e) => setAssets(e.target.value)} />
      <label className="ms-brief-lbl" htmlFor={`${id}-notes`}>{cv.notes}</label>
      <Input id={`${id}-notes`} value={brief.notes} onChange={(e) => set('notes', e.target.value)} />
      <span className="ms-brief-lbl">{cv.formats}</span>
      <div className="ms-brief-formats">
        {groups.map(([channel, items]) => (
          <div key={channel} className="ms-brief-group" role="group" aria-label={channelName(channel, locale)}>
            <span className="ms-brief-ghead"><ChannelMark channel={channelOf(channel)} />{channelName(channel, locale)}</span>
            <div className="ms-brief-chips">
              {items.map((p) => (
                <Chip key={p.id} on={brief.formats.includes(p.id)} onClick={() => toggle(p.id)} icon={p.kind === 'video' ? 'video' : 'image'}
                  title={`${p.width}×${p.height}`}>{formatName(p, locale)}</Chip>
              ))}
            </div>
          </div>
        ))}
      </div>
      <span className="ms-brief-lbl">{nc.codebases}</span>
      <CodebaseList value={codebases} onChange={setCodebases} disabled={disabled} />
      {error ? <p role="alert" className="ms-brief-error">{error}</p> : null}
      <div className="ms-brief-actions">
        <Button type="submit" variant="outline" disabled={disabled || busy !== null} loading={busy === 'save'}>{t.common.save}</Button>
        <Button variant="ink" disabled={disabled || busy !== null || brief.formats.length === 0} loading={busy === 'regenerate'} onClick={() => void save(true)}>{cv.saveAndRegenerate}</Button>
      </div>
    </form>
  );
}
