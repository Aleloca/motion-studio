import type { AssetEntry } from '@motion-studio/shared';
import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../api.ts';
import { formatNumber, formatWhen, useLocale, useT } from '../../i18n.tsx';
import { enter } from '../../motion/index.ts';
import { externalLinkRel } from '../../desktop.ts';
import { AudioPlayer, Button, Icon, Input, Textarea, Typing, VideoPlayer, clockText, cx, toast } from '../../ui/index.ts';
import { ShellContext } from '../../shell/ShellContext.tsx';
import { message } from '../common.tsx';
import { MAX_TAG, MAX_TAGS, baseName, formatBytes, mergeTags, splitTags } from './model.ts';
import { Thumb } from './Thumb.tsx';

export interface DetailProps {
  slug: string; asset: AssetEntry; describing: boolean; busy: boolean;
  onClose(): void; onSaved(entry: AssetEntry): void; onRenamed(from: string, entry: AssetEntry): void; onDescribe(): void; onUse(): void; onDelete(): void;
}

/** The detail panel (prototype AssetDetail, point 19): enters from +16 px; description and tag chips save themselves. */
export function AssetDetail({ slug, asset: x, describing, busy, onClose, onSaved, onRenamed, onDescribe, onUse, onDelete }: DetailProps) {
  const t = useT();
  const locale = useLocale();
  const a = t.web.library.assets;
  const d = a.detail;
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { void enter(ref.current, { x: 16, y: 0 }); }, []);
  // The description being typed wins over live reloads until it is saved (null: follow the server).
  const [draft, setDraft] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>(x.tags);
  const [tagText, setTagText] = useState('');
  const [status, setStatus] = useState<'saved' | null>(null);
  const pendingTags = useRef(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  // The waveform of an audio file, from the core (cached there); a failure leaves the plain bar.
  useEffect(() => {
    setPeaks(null);
    if (x.kind !== 'audio') return;
    let alive = true;
    Promise.resolve().then(() => api.assetWaveform(slug, x.file)).then((w) => { if (alive) setPeaks(w.peaks); }).catch(() => { /* plain bar */ });
    return () => { alive = false; };
  }, [slug, x.file, x.kind]);
  const serverTags = x.tags.join('\n');
  useEffect(() => { if (pendingTags.current === 0) setTags(x.tags); }, [serverTags]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (draft !== null && draft === x.description) setDraft(null); }, [x.description]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: unknown) => toast.show(d.saveFailed({ detail: message(e) }));
  const saveDescription = async () => {
    if (draft === null || draft === x.description) return;
    try {
      onSaved(await api.updateAsset(slug, x.file, { description: draft }));
      setDraft(null);
      setStatus('saved');
    } catch (e) { fail(e); }
  };
  const saveTags = async (next: string[]) => {
    const before = tags;
    setTags(next);
    pendingTags.current += 1;
    try {
      onSaved(await api.updateAsset(slug, x.file, { tags: next }));
      setStatus('saved');
    } catch (e) {
      setTags(before);
      fail(e);
    } finally {
      pendingTags.current -= 1;
    }
  };
  const submitRename = async () => {
    const next = (renaming ?? '').trim();
    if (!next || next === baseName(x.file) || renameBusy) { setRenaming(null); return; }
    setRenameBusy(true);
    try {
      const entry = await api.updateAsset(slug, x.file, { name: next });
      toast.show(d.renamed({ name: baseName(entry.file) }), { tone: 'ok' });
      setRenaming(null);
      onRenamed(x.file, entry);
    } catch (e) { toast.show(d.renameFailed({ detail: message(e) })); }
    finally { setRenameBusy(false); }
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void submitRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
  };
  const addTag = () => {
    const next = mergeTags(tags, splitTags(tagText));
    setTagText('');
    if (next.length !== tags.length) void saveTags(next);
  };
  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
    else if (e.key === 'Backspace' && !tagText && tags.length) { e.preventDefault(); void saveTags(tags.slice(0, -1)); }
  };
  const url = api.projectFileUrl(slug, `assets/${x.file}`);
  // Report 44: this image becomes the project's icon (Project settings can go back to Automatic or the initials).
  const [iconBusy, setIconBusy] = useState(false);
  const shell = useContext(ShellContext);
  const useAsIcon = async () => {
    setIconBusy(true);
    try {
      await api.updateProject(slug, { icon: { asset: x.file } });
      toast.show(d.projectIconSet, { tone: 'ok' });
      // The project bar's mark follows at once.
      shell?.catalog.refresh();
    } catch (e) {
      toast.show(d.projectIconFailed({ detail: message(e) }));
    } finally { setIconBusy(false); }
  };
  let host = x.sourceUrl ?? '';
  try { if (x.sourceUrl) host = new URL(x.sourceUrl).hostname; } catch { /* keep the raw address */ }

  return (
    <aside ref={ref} className="ms-adetail" aria-label={d.label}>
      <div className="ms-adetail-head">
        <b className="ms-adetail-name" title={x.file}>{baseName(x.file)}</b>
        <Button size="sm" variant="ghost" icon aria-label={d.rename} title={d.rename} aria-expanded={renaming !== null} onClick={() => setRenaming(renaming === null ? baseName(x.file) : null)}><Icon name="edit" size={12} /></Button>
        {status === 'saved' ? <span className="ms-adetail-saved" role="status">{d.saved}</span> : null}
        <Button size="sm" variant="ghost" icon aria-label={d.close} onClick={onClose}><Icon name="close" size={12} /></Button>
      </div>
      <div className="ms-adetail-body">
        {renaming !== null ? (
          <form className="ms-adetail-rename" onSubmit={(e) => { e.preventDefault(); void submitRename(); }}>
            <Input autoFocus value={renaming} aria-label={d.renameLabel} onChange={(e) => setRenaming(e.target.value)} onKeyDown={onRenameKey} />
            <Button type="submit" size="sm" variant="ink" loading={renameBusy} disabled={!renaming.trim()}>{d.renameApply}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>{d.renameCancel}</Button>
            <span className="ms-lib-faint ms-lib-small">{d.renameHint}</span>
          </form>
        ) : null}
        <div className={cx('ms-adetail-media', (x.kind === 'video' || x.kind === 'audio') && 'ms-adetail-player')}>
          {x.kind === 'video' ? <VideoPlayer src={url} name={baseName(x.file)} durationSec={x.durationSec} />
            : x.kind === 'audio' ? <AudioPlayer src={url} name={baseName(x.file)} peaks={peaks} durationSec={x.durationSec} />
              : <Thumb slug={slug} asset={x} big />}
        </div>
        <div className="ms-adetail-field">
          <div className="ms-lib-row">
            <span className="ms-lib-label">{d.description}</span>
            <span className="ms-lib-faint ms-lib-small">{d.descriptionHint}</span>
            <Button size="sm" variant="ghost" icon className="ms-lib-push" aria-label={a.describeAgain} title={busy ? a.describeBusy : a.describeAgain} disabled={busy} onClick={onDescribe}>
              <Icon name="refresh" size={12} />
            </Button>
          </div>
          {describing ? (
            <div className="ms-adetail-looking"><Typing />{d.looking}</div>
          ) : (
            <Textarea rows={5} aria-label={d.description} placeholder={d.descriptionPlaceholder} value={draft ?? x.description}
              onChange={(e) => { setDraft(e.target.value); setStatus(null); }} onBlur={() => void saveDescription()} />
          )}
        </div>
        <div className="ms-adetail-field">
          <span className="ms-lib-label">{d.tags}</span>
          <div className="ms-adetail-tags">
            {tags.map((g) => (
              <span key={g} className="ms-adetail-tag">
                {g}
                <button type="button" aria-label={d.removeTag({ tag: g })} onClick={() => void saveTags(tags.filter((y) => y !== g))}><Icon name="close" size={9} /></button>
              </span>
            ))}
            {tags.length < MAX_TAGS ? (
              <input className="ms-adetail-tagin" value={tagText} maxLength={MAX_TAG * 3} aria-label={d.addTag} placeholder={d.addTagPlaceholder}
                title={d.tagRules} onChange={(e) => setTagText(e.target.value)} onKeyDown={onTagKey} onBlur={() => { if (tagText.trim()) addTag(); }} />
            ) : null}
          </div>
        </div>
        <dl className="ms-adetail-meta">
          <dt>{d.file}</dt><dd className="ms-lib-mono">{x.file}</dd>
          {x.width && x.height ? <><dt>{d.size}</dt><dd>{x.width}×{x.height}</dd></> : null}
          {x.durationSec ? <><dt>{d.duration}</dt><dd>{clockText(x.durationSec)}</dd></> : null}
          {x.bytes !== undefined ? <><dt>{d.fileSize}</dt><dd>{formatBytes(x.bytes, (n) => formatNumber(locale, n))}</dd></> : null}
          <dt>{d.added}</dt><dd>{a.origins[x.origin]} · {formatWhen(locale, x.addedAt)}</dd>
          {x.sourceUrl ? <><dt>{d.source}</dt><dd><a href={x.sourceUrl} target="_blank" rel={externalLinkRel()} title={x.sourceUrl}>{host}</a></dd></> : null}
          {x.attribution ? <><dt>{d.credit}</dt><dd>{x.attribution}</dd></> : null}
        </dl>
        {x.kind === 'image' || x.kind === 'svg' ? (
          <Button variant="outline" loading={iconBusy} onClick={() => void useAsIcon()}><Icon name="image" size={13} />{d.useAsProjectIcon}</Button>
        ) : null}
        <div className="ms-lib-row">
          <Button variant="ink" className="ms-grow" onClick={onUse}>{a.useInCreative}</Button>
          <Button variant="danger" icon aria-label={d.delete} title={d.delete} onClick={onDelete}><Icon name="trash" size={14} /></Button>
        </div>
      </div>
    </aside>
  );
}
