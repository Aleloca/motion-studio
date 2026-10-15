// Brief form of a creative ("Edit the brief" in the canvas panel), built from ui/ controls only: no native select,
// checkbox or number field, no textarea resize. Saves it, or saves and starts a new generation.
import { channelName, INSTANCE_ID_RE, legacyTurnKind, linksAfterBriefSave, nextInstanceId, packInstancesOf, presetOf, type StorePack, type Brief, type BriefServices, type CreativeDetail, type FormatPreset, type LinkedCodebase } from '@motion-studio/shared';
import { useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { api } from '../api.ts';
import { instanceName, presetFor, presetNameOf } from '../instances.ts';
import { useLocale, useT } from '../i18n.tsx';
import { Button, ChannelMark, Chip, channelOf, cx, Icon, Input, Modal, Segmented, Textarea } from '../ui/index.ts';
import { IdentityStart, identityForBrief, resolveIdentity, useBrandLogo } from '../screens/identity/IdentityStart.tsx';
import { CodebaseList } from './CodebaseList.tsx';
import { StorePackWizard } from '../screens/new-creative/StorePackWizard.tsx';
import { packChannel } from '../screens/new-creative/storePackModel.ts';
import { BriefLanguages } from '../screens/creative/BriefLanguages.tsx';
import { ServicesSelector, useConfiguredProviders, useKeyChecks } from './ServicesSelector.tsx';
import './brief.css';
import { message } from '../errors.ts';

const LENGTHS = ['none', '6', '15', '30', '60', 'custom'] as const;
type LengthChoice = (typeof LENGTHS)[number];
const lengthChoice = (sec: number | null): LengthChoice => (sec === null ? 'none' : (LENGTHS as readonly string[]).includes(String(sec)) ? (String(sec) as LengthChoice) : 'custom');

/** The draft's formats with the saved ones back as the server has them (order and removals); unsaved ones stay after the neighbour they had. */
function rollbackFormats(draft: readonly string[], saved: readonly string[]): string[] {
  const out = [...saved];
  draft.forEach((f, i) => {
    if (saved.includes(f)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const k = out.indexOf(draft[j]!); if (k >= 0) { at = k + 1; break; } }
    out.splice(at, 0, f);
  });
  return out;
}

export function BriefEditor({ slug, detail, presets, disabled, onChanged, onRefresh }: {
  slug: string; detail: CreativeDetail; presets: FormatPreset[]; disabled: boolean; onChanged(): void;
  /** The brief changed on the server without leaving the form (labels, order, removal of formats): reload the creative. */
  onRefresh?(): void;
}) {
  const t = useT();
  const cv = t.web.conversation;
  const nc = t.web.newCreative;
  const locale = useLocale();
  const id = useId();
  const c = detail.creative;
  const [title, setTitle] = useState(c.title);
  const [brief, setBrief] = useState<Brief>(c.brief);
  // The brief as the server has it: partial saves (labels, order, removal) move it without touching the rest of the draft.
  const [stored, setStoredState] = useState<Brief>(c.brief);
  // The latest stored brief for async code: a save that fails rolls back to what the server has NOW, not to a closure's copy.
  const storedRef = useRef<Brief>(c.brief);
  const setStored = (b: Brief) => { storedRef.current = b; setStoredState(b); };
  const [length, setLength] = useState<LengthChoice>(() => lengthChoice(c.brief.durationSec));
  const [custom, setCustom] = useState(() => (lengthChoice(c.brief.durationSec) === 'custom' ? String(c.brief.durationSec) : ''));
  const [assets, setAssets] = useState(c.brief.assets.join(', '));
  const [codebases, setCodebases] = useState<LinkedCodebase[]>(c.linkedCodebases);
  // Services touched here, else (null) the creative's current ones: a change made meanwhile from the chat chip is kept.
  const [services, setServices] = useState<BriefServices | null>(null);
  const configured = useConfiguredProviders();
  const keyChecks = useKeyChecks();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'regenerate' | null>(null);
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const labelsFor = (formats: string[], labels: Record<string, string> | undefined) => {
    const kept = Object.fromEntries(Object.entries(labels ?? {}).filter(([k]) => formats.includes(k)));
    return Object.keys(kept).length > 0 ? kept : undefined;
  };
  /** The draft's formats and labels together (a label never outlives its format). */
  const setFormats = (formats: string[]) => setBrief((b) => {
    const { formatLabels: _old, ...rest } = b;
    const labels = labelsFor(formats, b.formatLabels);
    return { ...rest, formats, ...(labels ? { formatLabels: labels } : {}) };
  });
  // A preset chip adds the preset, or takes out every instance of it; instances the server already has ask first.
  const toggle = (pid: string) => {
    const mine = brief.formats.filter((f) => presetOf(f) === pid);
    if (mine.length === 0) { setFormats([...brief.formats, pid]); return; }
    if (mine.some((f) => stored.formats.includes(f))) { setConfirm(mine); return; }
    remove(mine);
  };
  const [confirm, setConfirm] = useState<string[] | null>(null);
  // The store pack entry (Phase 14): the wizard in a dialog, and the confirmation before the pack is taken out.
  const [packOpen, setPackOpen] = useState(false);
  const [packRemove, setPackRemove] = useState(false);
  const [packBusy, setPackBusy] = useState(false);
  const packNow = stored.storePack;
  /**
   * Saves the pack at once, as a partial save (like order and removal): the core recomputes only the pack's instances. The
   * draft follows: the pack's instances and labels as the server has them, everything else the user typed stays.
   */
  const savePack = async (next: StorePack | null) => {
    setError(null);
    const before = storedRef.current;
    const saved = await api.updateCreative(slug, detail.slug, { storePack: next });
    const mine = new Set([...(before.storePack ? packInstancesOf(before.storePack) : []), ...(saved.brief.storePack ? packInstancesOf(saved.brief.storePack) : [])]);
    setStored(saved.brief);
    setBrief((b) => {
      // Unsaved additions stay; saved formats the pack no longer owns go; the server's order wins for the rest.
      const kept = b.formats.filter((f) => !before.formats.includes(f) || saved.brief.formats.includes(f));
      const formats = rollbackFormats(kept, saved.brief.formats);
      const labels = { ...(b.formatLabels ?? {}) };
      for (const k of mine) { delete labels[k]; if (saved.brief.formatLabels?.[k]) labels[k] = saved.brief.formatLabels[k]!; }
      const { formatLabels: _l, storePack: _p, ...rest } = b;
      const kl = labelsFor(formats, labels);
      return { ...rest, formats, ...(kl ? { formatLabels: kl } : {}), ...(saved.brief.storePack ? { storePack: saved.brief.storePack } : {}) };
    });
    onRefresh?.();
  };
  const removePack = async () => {
    setPackBusy(true);
    try { await savePack(null); setPackRemove(false); } catch (e) { setPackRemove(false); setError(t.web.storePack.saveFailed({ detail: message(e) })); }
    setPackBusy(false);
  };
  const [dragging, setDragging] = useState<string | null>(null);
  const nameOf = (fid: string) => instanceName(presetFor(presets, fid), fid, locale, brief.formatLabels);
  /** Order and removal are saved at once, as a partial save merged into the stored brief under the lock (Phase 12). */
  const savePartial = async (patch: { formats?: string[]; formatLabels?: Record<string, string | null> }) => {
    setError(null);
    try {
      const saved = await api.updateCreative(slug, detail.slug, patch);
      setStored(saved.brief);
      onRefresh?.();
    } catch (e) {
      // Only the failed change is undone, against the latest stored brief: unsaved "Add another" rows and the other typed labels stay.
      const now = storedRef.current;
      setBrief((b) => {
        const { formatLabels: old, ...rest } = b;
        const formats = patch.formats ? rollbackFormats(b.formats, now.formats) : b.formats;
        const labels = { ...(old ?? {}) };
        for (const k of Object.keys(patch.formatLabels ?? {})) {
          const was = now.formatLabels?.[k];
          if (was) labels[k] = was; else delete labels[k];
        }
        const kept = labelsFor(formats, labels);
        return { ...rest, formats, ...(kept ? { formatLabels: kept } : {}) };
      });
      setError(t.web.instances.saveFailed({ detail: message(e) }));
    }
  };
  /** The formats the server has, in the draft's order, without `gone`. */
  const storedOrder = (formats: string[], gone: readonly string[] = []) => formats.filter((f) => stored.formats.includes(f) && !gone.includes(f));
  const persistOrder = (formats: string[], gone: readonly string[] = []) => {
    const next = storedOrder(formats, gone);
    const cur = stored.formats;
    if (next.length > 0 && (next.length !== cur.length || next.some((f, i) => f !== cur[i]))) void savePartial({ formats: next });
  };
  const move = (fid: string, to: number) => {
    const from = brief.formats.indexOf(fid);
    if (from < 0 || to < 0 || to >= brief.formats.length || to === from) return;
    const next = brief.formats.filter((f) => f !== fid);
    next.splice(to, 0, fid);
    setFormats(next);
    persistOrder(next);
  };
  const addAnother = (fid: string) => {
    const next = nextInstanceId(presetOf(fid), brief.formats);
    if (!next) return;
    const last = brief.formats.reduce((k, f, i) => (presetOf(f) === presetOf(fid) ? i : k), -1);
    setFormats([...brief.formats.slice(0, last + 1), next, ...brief.formats.slice(last + 1)]);
  };
  const remove = (ids: string[]) => {
    setConfirm(null);
    const next = brief.formats.filter((f) => !ids.includes(f));
    setFormats(next);
    persistOrder(next, ids);
  };
  const commitLabel = (fid: string) => {
    const value = (brief.formatLabels?.[fid] ?? '').trim();
    if (!stored.formats.includes(fid) || (stored.formatLabels?.[fid] ?? '') === value) return;
    // Only this key goes: the server merges per key, so another tab's newer labels are kept ('' clears this one).
    void savePartial({ formatLabels: { [fid]: value } });
  };
  const setLabel = (fid: string, value: string) => setBrief((b) => {
    const { formatLabels: old, ...rest } = b;
    const labels = { ...(old ?? {}), [fid]: value };
    return { ...rest, formatLabels: labels };
  });
  const onDrop = (target: string) => (e: DragEvent) => {
    e.preventDefault();
    if (dragging && dragging !== target) move(dragging, brief.formats.indexOf(target));
    setDragging(null);
  };
  // The identity formats' "Partenza" (Phase 14): shown while the brief has one of those formats.
  const identityOn = brief.formats.some((f) => presetFor(presets, f)?.identity);
  const brandLogo = useBrandLogo(slug, identityOn);
  const packGroup = useMemo(() => packChannel(presets), [presets]);
  const groups = useMemo(() => {
    const m = new Map<string, FormatPreset[]>();
    for (const p of presets) m.set(p.channel, [...(m.get(p.channel) ?? []), p]);
    return [...m.entries()];
  }, [presets]);

  // Final review I4: on a creative made before compositions, "Save and regenerate" converts every format with the agent
  // (more tokens once), unless the save only adds formats linked to existing ones (copied without the agent). The same
  // rules as the core (shared): the links this save will give, and the base the turn builds on.
  const converts = useMemo(() => {
    const base = c.resumeFrom ? detail.versions.find((v) => v.n === c.resumeFrom!.version) : detail.versions.at(-1);
    return legacyTurnKind(base, { formats: brief.formats, links: linksAfterBriefSave(stored, brief.formats, presets) }) === 'convert';
  }, [c.resumeFrom, stored, detail.versions, brief.formats, presets]);

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
    // A legacy brief may hold an id the core no longer accepts on a full save: say which, instead of a bare refusal.
    const bad = brief.formats.find((f) => !INSTANCE_ID_RE.test(f));
    if (bad !== undefined) { setError(t.web.instances.invalidId({ id: bad })); return; }
    setBusy(regenerate ? 'regenerate' : 'save');
    let saved = false;
    try {
      const chosen = services ?? c.brief.services;
      // The pack changes only through its own entry (`storePack`), never with the rest of the brief.
      const { services: _draft, formatLabels: _labels, identity: _identity, storePack: _pack, ...rest } = brief;
      const labels = labelsFor(brief.formats, brief.formatLabels);
      const identity = identityOn && brief.identity ? { identity: identityForBrief(brief.identity, brandLogo.hasLogo) } : {};
      await api.updateCreative(slug, detail.slug, { title, brief: { ...rest, ...identity, ...(labels ? { formatLabels: labels } : {}), durationSec: sec, assets: assets.split(',').map((a) => a.trim()).filter(Boolean), ...(chosen ? { services: chosen } : {}) }, linkedCodebases: codebases });
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
                <Chip key={p.id} on={brief.formats.some((f) => presetOf(f) === p.id)} onClick={() => toggle(p.id)} icon={p.kind === 'video' ? 'video' : 'image'}
                  title={`${p.width}×${p.height}`}>{presetNameOf(p, locale)}</Chip>
              ))}
              {channel === packGroup ? (
                <span className="ms-brief-pack">
                  <Chip on={packNow !== undefined} onClick={() => setPackOpen(true)} icon="image" disabled={disabled}
                    title={packNow ? t.web.storePack.entryAria({ count: packNow.screenshots.length }) : t.web.storePack.entryAdd}>
                    {packNow ? t.web.storePack.entryOn({ count: packNow.screenshots.length }) : t.web.storePack.entryTitle}
                  </Chip>
                  {packNow ? (
                    <>
                      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setPackOpen(true)}>{t.web.storePack.entryEdit}</Button>
                      <Button size="sm" variant="ghost" aria-label={t.web.storePack.entryRemoveAria} disabled={disabled} onClick={() => setPackRemove(true)}>{t.web.storePack.entryRemove}</Button>
                    </>
                  ) : null}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <StorePackWizard open={packOpen} onClose={() => setPackOpen(false)} slug={slug} {...(packNow ? { initial: packNow } : {})} onConfirm={savePack} />
      <Modal open={packRemove} onClose={() => { if (!packBusy) setPackRemove(false); }} label={t.web.storePack.removeTitle} width={420}>
        <div className="ms-brief-confirm">
          <h3>{t.web.storePack.removeTitle}</h3>
          <p>{t.web.storePack.removeBody}</p>
          <div className="ms-brief-actions">
            <Button variant="danger" loading={packBusy} disabled={packBusy} onClick={() => void removePack()}>{t.web.storePack.removeConfirm}</Button>
            <Button variant="outline" disabled={packBusy} onClick={() => setPackRemove(false)}>{t.common.cancel}</Button>
          </div>
        </div>
      </Modal>
      {brief.formats.length > 0 ? (
        <>
          <span className="ms-brief-lbl" id={`${id}-inst`}>{t.web.instances.title}</span>
          <p className="ms-brief-hint">{t.web.instances.hint}</p>
          <ol className="ms-brief-inst" aria-labelledby={`${id}-inst`}>
            {brief.formats.map((fid, i) => {
              const preset = presetFor(presets, fid);
              const name = nameOf(fid);
              const full = nextInstanceId(presetOf(fid), brief.formats) === null;
              return (
                <li key={fid} className={cx('ms-brief-inst-row', dragging === fid && 'ms-drag')}
                  onDragOver={(e) => { if (dragging) e.preventDefault(); }} onDrop={onDrop(fid)}>
                  <span className="ms-brief-inst-head">
                    {/* Only the handle drags (the label field keeps its text selection); Move up/down are the keyboard way. */}
                    <span className="ms-brief-inst-grip" draggable={!disabled} title={t.web.instances.dragHandle({ name })} aria-hidden="true"
                      onDragStart={(e) => { setDragging(fid); e.dataTransfer?.setData('text/plain', fid); }} onDragEnd={() => setDragging(null)}><Icon name="menu" size={13} /></span>
                    {preset ? <ChannelMark channel={channelOf(preset.channel)} /> : null}
                    <b className="ms-brief-inst-name">{name}</b>
                  </span>
                  <Input className="ms-brief-inst-label" aria-label={t.web.instances.labelOf({ name })} placeholder={t.web.instances.labelPlaceholder} maxLength={60}
                    value={brief.formatLabels?.[fid] ?? ''} disabled={disabled} onChange={(e) => setLabel(fid, e.target.value)}
                    onBlur={() => commitLabel(fid)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitLabel(fid); } }} />
                  <span className="ms-brief-inst-actions">
                    <Button size="sm" variant="ghost" icon aria-label={t.web.instances.moveUp({ name })} disabled={disabled || i === 0} onClick={() => move(fid, i - 1)}>
                      <span className="ms-brief-up"><Icon name="chevron" size={13} /></span>
                    </Button>
                    <Button size="sm" variant="ghost" icon aria-label={t.web.instances.moveDown({ name })} disabled={disabled || i === brief.formats.length - 1} onClick={() => move(fid, i + 1)}>
                      <Icon name="chevron" size={13} />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={t.web.instances.addAnother({ name })} title={full ? t.web.instances.full : undefined} disabled={disabled || full || !preset} onClick={() => addAnother(fid)}>
                      <Icon name="plus" size={13} />{t.web.instances.addAnotherShort}
                    </Button>
                    <Button size="sm" variant="ghost" icon aria-label={t.web.instances.remove({ name })} disabled={disabled} onClick={() => setConfirm([fid])}>
                      <Icon name="trash" size={13} />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
      <Modal open={confirm !== null} onClose={() => setConfirm(null)} label={confirm ? t.web.instances.removeTitle({ name: confirm.map(nameOf).join(', ') }) : ''} width={420}>
        <div className="ms-brief-confirm">
          <h3>{confirm ? t.web.instances.removeTitle({ name: confirm.map(nameOf).join(', ') }) : ''}</h3>
          <p>{t.web.instances.removeBody}</p>
          <div className="ms-brief-actions">
            <Button variant="danger" onClick={() => { if (confirm) remove(confirm); }}>{t.web.instances.removeConfirm}</Button>
            <Button variant="outline" onClick={() => setConfirm(null)}>{t.common.cancel}</Button>
          </div>
        </div>
      </Modal>
      {identityOn ? (
        <IdentityStart value={resolveIdentity(brief.identity, brandLogo.hasLogo)} onChange={(v) => set('identity', v)} hasBrandLogo={brandLogo.hasLogo}
          fromCodebase={brandLogo.fromCodebase} withConcepts={false} disabled={disabled} />
      ) : null}
      <BriefLanguages value={brief.locales} disabled={disabled}
        onChange={(next) => setBrief((b) => { const { locales: _l, ...rest } = b; return next ? { ...rest, locales: next } : rest; })} />
      <span className="ms-brief-lbl">{t.web.services.title}</span>
      <p className="ms-brief-hint">{t.web.services.hint}</p>
      <ServicesSelector value={services ?? c.brief.services} configured={configured} checks={keyChecks} disabled={disabled} onChange={setServices} />
      <span className="ms-brief-lbl">{nc.codebases}</span>
      <CodebaseList value={codebases} onChange={setCodebases} disabled={disabled} />
      {converts ? <p className="ms-brief-notice" role="note"><Icon name="warn" size={13} /><span>{cv.legacyConvertNotice}</span></p> : null}
      {error ? <p role="alert" className="ms-brief-error">{error}</p> : null}
      <div className="ms-brief-actions">
        <Button type="submit" variant="outline" disabled={disabled || busy !== null} loading={busy === 'save'}>{t.common.save}</Button>
        <Button variant="ink" disabled={disabled || busy !== null || brief.formats.length === 0} loading={busy === 'regenerate'} onClick={() => void save(true)}>{cv.saveAndRegenerate}</Button>
      </div>
    </form>
  );
}
