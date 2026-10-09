import { channelName, formatLabel, formatName, type AssetEntry, type BrandKit, type FormatPreset, type LinkedCodebase } from '@motion-studio/shared';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { CodebaseList } from '../components/CodebaseList.tsx';
import { useLocale, useT } from '../i18n.tsx';
import { anim, E, flash, isSubmitChord, useEnter, usePageShortcut } from '../motion/index.ts';
import { href } from '../routes.ts';
import { useNewCreativeAssetsIntent } from '../shell/intents.ts';
import { go, ShellContext } from '../shell/ShellContext.tsx';
import { isMac } from '../platform.ts';
import { Button, ChannelMark, Chip, Empty, Icon, Input, Popover, Segmented, Spinner, cx, initials, toast } from '../ui/index.ts';
import { channelOf } from './creativeState.ts';
import './newcreative.css';
import { message as errText } from './common.tsx';
import { isVideoFile } from '../media.ts';


/** Brief length shown under the field (prototype: "142 / 2000"). */
const GOAL_MAX = 2000;
const TITLE_MAX = 60;
const LENGTHS = ['6', '15', '30', '60', 'custom'] as const;
type LengthChoice = (typeof LENGTHS)[number];
type Kind = 'all' | 'video' | 'image';
/** Channels open on arrival (prototype): the rest sit behind "More channels" until asked for, searched or selected. */
const PRIMARY = ['Instagram', 'TikTok', 'YouTube'];
const SUGGESTIONS = ['teaser', 'feature', 'screenshots'] as const;
/** The "App Store screenshots" suggestion also picks this format when the catalog has it. */
const SCREENSHOT_FORMAT = 'appstore-iphone-69';
/** Selected formats drawn in the summary bar. */
const SUMMARY_FRAMES = 5;
const VISUAL = /^(image|svg|video)$/;

/**
 * Creative title from the brief: its first sentence, at most 60 characters cut on a word boundary, without trailing
 * punctuation, first letter capitalised; `fallback` when nothing is left. The title can be renamed in the canvas.
 */
export function titleFromBrief(brief: string, fallback: string): string {
  const first = brief.trim().split(/\n|(?<=[.!?…])\s/)[0] ?? '';
  let t = first.replace(/\s+/g, ' ').trim();
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX);
    // The 60th character ends a word when the next one is not a letter or digit; otherwise back to the last space.
    const space = /[\p{L}\p{N}]/u.test(t[TITLE_MAX]!) ? cut.lastIndexOf(' ') : TITLE_MAX;
    t = space > 0 ? cut.slice(0, space) : cut;
  }
  t = t.replace(/[\s.,;:!?…\-–—"'“”«»()]+$/u, '');
  return t ? t.charAt(0).toLocaleUpperCase() + t.slice(1) : fallback;
}

/** Maximum length of a format: whole minutes from 2 min up, seconds below ("≤ 90 s", "≤ 3 min"). */
export function maxLengthNote(sec: number): string {
  return sec >= 120 && sec % 60 === 0 ? `≤ ${sec / 60} min` : `≤ ${sec} s`;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const NAMED: Array<[number, number]> = [[1, 1], [4, 5], [5, 4], [9, 16], [16, 9], [2, 3], [3, 2], [3, 4], [4, 3], [4, 1], [1, 4]];
/** `9:16` for the usual proportions (exact, or within 1.5%), the pixel size otherwise (`728×90`). */
export function ratioLabel(w: number, h: number): string {
  const d = gcd(w, h);
  if (w / d <= 21 && h / d <= 21) return `${w / d}:${h / d}`;
  const near = NAMED.find(([a, b]) => Math.abs(w / h / (a / b) - 1) < 0.015);
  return near ? `${near[0]}:${near[1]}` : `${w}×${h}`;
}

const is916Video = (p: FormatPreset) => p.kind === 'video' && ratioLabel(p.width, p.height) === '9:16';
const baseName = (path: string) => path.split('/').pop() ?? path;
/** Brief paths are project paths; the library lists files inside `assets/`. */
const assetPath = (file: string) => `assets/${file}`;

interface Loaded<T> { value: T | null; error: string | null }

/**
 * New creative (spec §6.2 #5), ported from the prototype's NewCreativePage / Tile and the NewCreative boards: brief with
 * suggestions, key message, video length, asset picker from the library, brand, the format board from the real catalog
 * (channels, kind, drawn proportion, maximum length, filter, search, more channels), and the summary bar with Generate.
 */
export function NewCreative({ slug }: { slug: string }) {
  const t = useT();
  const n = t.web.newCreative;
  const locale = useLocale();
  const shell = useContext(ShellContext);
  const projectName = shell?.catalog.projects?.find((p) => p.slug === slug)?.name ?? slug;

  const [goal, setGoal] = useState('');
  const [message, setMessage] = useState('');
  const [length, setLength] = useState<LengthChoice>('6');
  const [customSec, setCustomSec] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [kind, setKind] = useState<Kind>('all');
  const [query, setQuery] = useState('');
  const [more, setMore] = useState<Set<string>>(() => new Set());
  const [picked, setPicked] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [codebases, setCodebases] = useState<LinkedCodebase[]>([]);
  const [options, setOptions] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goalError, setGoalError] = useState(false);
  const [formatError, setFormatError] = useState(false);
  const [lengthError, setLengthError] = useState(false);

  const [catalog, setCatalog] = useState<Loaded<FormatPreset[]> & { warning: string | null }>({ value: null, error: null, warning: null });
  const [catalogNonce, setCatalogNonce] = useState(0);
  const [library, setLibrary] = useState<Loaded<AssetEntry[]>>({ value: null, error: null });
  const [libraryNonce, setLibraryNonce] = useState(0);
  const [brand, setBrand] = useState<Loaded<BrandKit>>({ value: null, error: null });
  const [pickerOpen, setPickerOpen] = useState(false);

  const goalRef = useRef<HTMLTextAreaElement>(null);
  const goalBox = useRef<HTMLDivElement>(null);
  const boardHead = useRef<HTMLDivElement>(null);
  const pickerAnchor = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getFormats())
      .then((c) => { if (alive) setCatalog({ value: c.presets, error: null, warning: c.error }); })
      .catch((e: unknown) => { if (alive) setCatalog({ value: null, error: errText(e), warning: null }); });
    return () => { alive = false; };
  }, [catalogNonce]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.listAssets(slug))
      .then((r) => { if (alive) setLibrary({ value: r.assets, error: r.error }); })
      .catch((e: unknown) => { if (alive) setLibrary({ value: null, error: errText(e) }); });
    return () => { alive = false; };
  }, [slug, libraryNonce]);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getBrand(slug))
      .then((b) => { if (alive) setBrand({ value: b.kit, error: b.kitError }); })
      .catch((e: unknown) => { if (alive) setBrand({ value: null, error: errText(e) }); });
    return () => { alive = false; };
  }, [slug]);

  // "Use in a creative" from Assets.
  useNewCreativeAssetsIntent(slug, useCallback((paths: string[]) => setPicked((p) => [...p, ...paths.filter((x) => !p.includes(x))]), []));

  const presets = catalog.value ?? [];
  const chosen = useMemo(() => selected.flatMap((id) => presets.filter((p) => p.id === id)), [selected, presets]);
  const videos = chosen.filter((p) => p.kind === 'video');
  const images = chosen.filter((p) => p.kind === 'image');
  // The first selected 9:16 video in catalog order: the others are marked as the same file (linking: Phase 9).
  const firstVertical = presets.find((p) => selected.includes(p.id) && is916Video(p)) ?? null;
  const verticals = chosen.filter(is916Video).length;
  const linked = (p: FormatPreset) => verticals > 1 && is916Video(p) && selected.includes(p.id) && p.id !== firstVertical?.id;

  const durationSec = length === 'custom' ? Number(customSec) : Number(length);
  const durationValid = Number.isInteger(durationSec) && durationSec >= 1 && durationSec <= 600;
  const tooLong = videos.find((p) => p.maxDurationSec !== undefined && durationValid && durationSec > p.maxDurationSec) ?? null;
  const title = titleFromBrief(goal, n.untitled);

  // Board: channel groups in catalog order.
  const q = query.trim().toLocaleLowerCase();
  const shown = (p: FormatPreset) => (kind === 'all' || p.kind === kind)
    && (!q || `${channelName(p.channel, locale)} ${formatName(p, locale)} ${p.channel} ${p.name}`.toLocaleLowerCase().includes(q));
  const groups = useMemo(() => [...new Set(presets.map((p) => p.channel))], [presets]);
  const primary = groups.some((g) => PRIMARY.includes(g)) ? groups.filter((g) => PRIMARY.includes(g)) : groups.slice(0, 3);
  const open = (g: string) => q !== '' || primary.includes(g) || more.has(g) || presets.some((p) => p.channel === g && selected.includes(p.id));
  const visibleGroups = groups.map((g) => ({ g, items: presets.filter((p) => p.channel === g && shown(p)) })).filter(({ g, items }) => open(g) && items.length > 0);
  const hiddenGroups = q ? [] : groups.filter((g) => !open(g));

  const root = useEnter<HTMLDivElement>([catalog.value !== null]);

  const toggle = (id: string) => {
    setFormatError(false);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const suggest = (k: (typeof SUGGESTIONS)[number]) => {
    setGoal(n.suggestions[k].text);
    setGoalError(false);
    if (k === 'screenshots') {
      const shot = presets.find((p) => p.id === SCREENSHOT_FORMAT);
      if (shot) { setSelected([shot.id]); setMore((m) => new Set([...m, shot.channel])); setFormatError(false); }
    }
    void flash(goalBox.current);
  };
  const togglePicked = (path: string) => setPicked((p) => (p.includes(path) ? p.filter((x) => x !== path) : [...p, path]));
  const openPicker = (el: HTMLElement) => { pickerAnchor.current = el; setPickerOpen(true); };

  // One creative per Generate: set before the request and cleared only on failure, so a second press (while the
  // request runs, or while the page is leaving after success) never creates a duplicate and starts a second agent.
  const inFlight = useRef(false);
  const submit = async (generate: boolean) => {
    if (inFlight.current) return;
    if (!goal.trim()) {
      setGoalError(true);
      goalRef.current?.focus();
      void flash(goalBox.current);
      return;
    }
    if (chosen.length === 0) {
      setFormatError(true);
      void flash(boardHead.current);
      return;
    }
    if (videos.length > 0 && !durationValid) { setLengthError(true); return; }
    inFlight.current = true;
    setBusy(generate ? 'generate' : 'draft');
    setError(null);
    try {
      const created = await api.createCreative(slug, {
        title,
        brief: {
          goal: goal.trim(), message: message.trim(), formats: chosen.map((p) => p.id),
          durationSec: videos.length > 0 ? durationSec : null, assets: picked, notes: notes.trim(),
        },
        generate,
        linkedCodebases: codebases,
      });
      if (generate) go(href.creative(slug, created.slug));
      else {
        toast.show(n.draftSaved({ title }), { tone: 'ok', action: { label: n.open, run: () => go(href.creative(slug, created.slug)) } });
        go(href.project(slug));
      }
      // Success: stay busy; the page is leaving.
    } catch (e) {
      inFlight.current = false;
      setBusy(null);
      setError(errText(e));
    }
  };
  usePageShortcut(root, isSubmitChord, () => { void submit(true); });

  const kit = brand.value;
  const hasBrand = !!kit && (kit.colors.length > 0 || kit.fonts.length > 0 || kit.logos.length > 0 || kit.tone !== null);
  // The brand in one line, as on the board: heading font · main colour · tone.
  const brandLine = kit ? [kit.fonts[0]?.family, kit.colors[0]?.name, kit.tone?.text].filter(Boolean).join(' · ') : '';
  const libraryItems = (library.value ?? []).filter((a) => a.kind !== 'font');
  const entryOf = (path: string) => library.value?.find((a) => assetPath(a.file) === path) ?? null;

  return (
    <div className="ms-nc" ref={root}>
      <div className="ms-nc-body">
        <div className="ms-nc-left">
          <section className="ms-nc-sec ms-nc-brief" data-enter>
            <label htmlFor="ms-nc-goal" className="ms-nc-q">{n.goalQuestion}</label>
            <div ref={goalBox} className={cx('ms-nc-goalbox', goalError && 'ms-invalid')}>
              <textarea
                id="ms-nc-goal" ref={goalRef} rows={4} maxLength={GOAL_MAX} value={goal} placeholder={n.goalPlaceholder}
                aria-invalid={goalError || undefined} aria-describedby={goalError ? 'ms-nc-goal-err' : undefined}
                onChange={(e) => { setGoal(e.target.value); if (e.target.value.trim()) setGoalError(false); }}
              />
              <div className="ms-nc-goalbar">
                {hasBrand ? <Chip className="ms-nc-kit"><span className="ms-nc-mono" aria-hidden="true">{initials(projectName)}</span>{n.brandKit}</Chip> : null}
                {picked.length > 0 ? (
                  <Chip className="ms-nc-kit">
                    <AssetFace slug={slug} path={picked[0]!} entry={entryOf(picked[0]!)} small />
                    {n.assetCount({ count: picked.length })}
                  </Chip>
                ) : null}
                <Button size="sm" variant="ghost" icon aria-label={n.addAssets} title={n.addAssets} onClick={(e) => openPicker(e.currentTarget)}><Icon name="plus" size={14} /></Button>
                <span className="ms-nc-count">{n.goalCount({ n: goal.length, max: GOAL_MAX })}</span>
              </div>
            </div>
            {goalError ? <p id="ms-nc-goal-err" className="ms-nc-err"><Icon name="warn" size={13} />{n.goalRequired}</p> : null}
            {goal.trim() ? (
              <p className="ms-nc-title"><span>{n.title}:</span> <b>{title}</b> <span className="ms-nc-faint">· {n.titleHint}</span></p>
            ) : null}
            <div className="ms-nc-try">
              <span className="ms-nc-faint">{n.tryLabel}</span>
              {SUGGESTIONS.map((k) => <Chip key={k} onClick={() => suggest(k)}>{n.suggestions[k].label}</Chip>)}
            </div>
          </section>

          <section className="ms-nc-sec" data-enter>
            <label className="ms-nc-lbl" htmlFor="ms-nc-msg">{n.keyMessage} <span className="ms-nc-faint">{n.keyMessageHint}</span></label>
            <Input id="ms-nc-msg" className="ms-nc-msg" value={message} onChange={(e) => setMessage(e.target.value)} />
          </section>

          <div className={cx('ms-nc-sec', videos.length === 0 && 'ms-nc-off')} data-enter>
            <div className="ms-nc-row">
              <span className="ms-nc-lbl">{n.videoLength}</span>
              <span id="ms-nc-len-why" className="ms-nc-faint ms-nc-small">{videos.length ? n.lengthFor({ count: videos.length }) : n.noVideo}</span>
            </div>
            <Segmented
              className="ms-nc-len"
              label={n.videoLength}
              disabled={videos.length === 0}
              describedBy="ms-nc-len-why"
              value={length}
              onChange={(v) => { setLength(v); setLengthError(false); }}
              options={LENGTHS.map((v) => ({ value: v, label: v === 'custom' ? n.custom : n.secondsShort({ n: Number(v) }) }))}
            />
            {length === 'custom' && videos.length > 0 ? (
              <Input
                className="ms-nc-custom" inputMode="numeric" aria-label={n.customSeconds} placeholder={n.customSeconds} value={customSec}
                aria-invalid={lengthError || undefined}
                onChange={(e) => { setCustomSec(e.target.value.replace(/\D/g, '').slice(0, 3)); setLengthError(false); }}
              />
            ) : null}
            {lengthError ? <p className="ms-nc-err"><Icon name="warn" size={13} />{n.customInvalid}</p> : null}
            {tooLong && tooLong.maxDurationSec ? (
              <p className="ms-nc-note"><Icon name="clock" size={13} />{n.overMax({ label: formatLabel(tooLong, locale), max: maxLengthNote(tooLong.maxDurationSec) })}</p>
            ) : null}
          </div>

          <section className="ms-nc-sec" data-enter>
            <div className="ms-nc-row">
              <span className="ms-nc-lbl" id="ms-nc-assets-lbl">{n.assetsToUse}</span>
              <Button size="sm" variant="ghost" className="ms-nc-browse" onClick={(e) => openPicker(e.currentTarget)}>{n.browse}</Button>
            </div>
            <div className="ms-nc-assets" role="list" aria-labelledby="ms-nc-assets-lbl">
              {picked.map((path) => (
                <div role="listitem" key={path} className="ms-nc-asset-item">
                  <button type="button" className="ms-nc-asset ms-on" aria-label={n.removeAsset({ name: baseName(path) })} title={n.removeAsset({ name: baseName(path) })} onClick={() => togglePicked(path)}>
                    <AssetFace slug={slug} path={path} entry={entryOf(path)} />
                    <span className="ms-nc-tick" aria-hidden="true"><Icon name="check" size={10} strokeWidth={2.4} /></span>
                  </button>
                </div>
              ))}
              <div role="listitem" className="ms-nc-asset-item">
                <button type="button" className="ms-nc-asset ms-nc-add" aria-label={n.addAssets} onClick={(e) => openPicker(e.currentTarget)}><Icon name="plus" size={16} /></button>
              </div>
            </div>
            <span className="ms-nc-faint ms-nc-small">{n.brandAuto}</span>
          </section>

          <section className="ms-nc-sec" data-enter>
            {brand.value === null && brand.error === null ? null : hasBrand && kit ? (
              <div className="ms-nc-brand">
                <div className="ms-nc-swatches" aria-hidden="true">
                  {kit.colors.slice(0, 4).map((c) => <span key={c.id} style={{ background: c.hex }} />)}
                </div>
                <div className="ms-nc-brand-text">
                  <b>{n.followsBrand({ project: projectName })}</b>
                  {brandLine ? <span className="ms-nc-ell" title={brandLine}>{brandLine}</span> : null}
                </div>
                {/* Information only: the brief has no brand field, so there is no switch (it returns when there is). */}
                <a className="ms-link ms-nc-editbrand" href={href.project(slug, 'brand')}>{n.editBrand}</a>
              </div>
            ) : (
              <div className="ms-nc-brand ms-nc-nobrand">
                <span className="ms-nc-brand-icon" aria-hidden="true"><Icon name="drop" size={14} /></span>
                <div className="ms-nc-brand-text">
                  <b>{brand.error ? n.brandFailed({ detail: brand.error }) : n.noBrand}</b>
                  <span className="ms-nc-wrap">{n.noBrandBody}</span>
                </div>
                <Button size="sm" variant="outline" onClick={() => go(href.project(slug, 'brand'))}>{n.setUpBrand}</Button>
              </div>
            )}
          </section>

          <section className="ms-nc-sec ms-nc-options" data-enter>
            <button type="button" className="ms-nc-disclose" aria-expanded={options} aria-controls="ms-nc-options" onClick={() => setOptions((o) => !o)}>
              <Icon name={options ? 'chevron' : 'forward'} size={13} />{n.moreOptions}
            </button>
            {options ? (
              <div id="ms-nc-options" className="ms-nc-options-body">
                <label className="ms-nc-lbl" htmlFor="ms-nc-notes">{n.notesForAgent} <span className="ms-nc-faint">{n.optional}</span></label>
                <Input id="ms-nc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
                <span className="ms-nc-lbl">{n.codebases} <span className="ms-nc-faint">{n.codebasesHint}</span></span>
                <CodebaseList value={codebases} onChange={setCodebases} />
              </div>
            ) : null}
          </section>
        </div>

        <div className="ms-nc-right">
          <div className="ms-nc-boardhead" ref={boardHead}>
            <h2>{n.whereTo}</h2>
            <div className="ms-grow" />
            <Segmented
              className="ms-nc-kind"
              label={n.formatKind}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'all', label: n.kindAll },
                { value: 'video', label: n.kindVideo, icon: 'video' },
                { value: 'image', label: n.kindImage, icon: 'image' },
              ]}
            />
            <label className="ms-nc-search">
              <Icon name="search" size={14} />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={n.searchFormats} aria-label={n.searchFormats} />
            </label>
          </div>

          {catalog.warning ? <p className="ms-nc-alert" role="status"><Icon name="warn" size={14} /><span>{catalog.warning}</span></p> : null}
          {catalog.error ? (
            <div className="ms-nc-alert" role="alert">
              <Icon name="warn" size={14} /><span>{n.formatsFailed({ detail: catalog.error })}</span>
              <Button size="sm" variant="outline" onClick={() => { setCatalog({ value: null, error: null, warning: null }); setCatalogNonce((x) => x + 1); }}>{n.tryAgain}</Button>
            </div>
          ) : null}
          {catalog.value === null && !catalog.error ? (
            <div className="ms-nc-group" aria-busy="true">
              <span className="ms-sr" role="status">{n.formatsLoading}</span>
              <div className="ms-nc-tiles">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="ms-nc-tile ms-nc-skel" aria-hidden="true" />)}</div>
            </div>
          ) : null}

          {catalog.value !== null && visibleGroups.length === 0 ? (
            <Empty icon="search" title={n.noMatch} sub={n.noMatchBody} action={<Button size="sm" variant="outline" onClick={() => { setQuery(''); setKind('all'); }}>{n.showAllFormats}</Button>} />
          ) : null}

          {visibleGroups.map(({ g, items }) => {
            const count = items.filter((p) => selected.includes(p.id)).length;
            const name = channelName(g, locale);
            return (
              <div key={g} className="ms-nc-group" role="group" aria-label={name} data-enter>
                <div className="ms-nc-ghead">
                  <ChannelMark channel={channelOf(g)} size={20} />
                  <b className="ms-nc-ell">{name}</b>
                  {count ? <span className="ms-nc-faint ms-nc-small">{n.selectedCount({ n: count })}</span> : null}
                </div>
                <div className="ms-nc-tiles">
                  {items.map((p) => (
                    <Tile key={p.id} preset={p} on={selected.includes(p.id)} linked={linked(p)} onClick={() => toggle(p.id)} />
                  ))}
                </div>
              </div>
            );
          })}

          {catalog.value !== null && hiddenGroups.length > 0 ? (
            <div className="ms-nc-more" data-enter>
              <span className="ms-nc-lbl ms-nc-muted">{n.moreChannels}</span>
              <div className="ms-nc-more-list">
                {hiddenGroups.map((g) => (
                  <Button key={g} variant="outline" className="ms-nc-chbtn" onClick={() => setMore((m) => new Set([...m, g]))}>
                    <ChannelMark channel={channelOf(g)} size={20} />
                    <span className="ms-nc-ell">{channelName(g, locale)}</span>
                    <span className="ms-nc-faint ms-nc-small">{presets.filter((p) => p.channel === g).length}</span>
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Above the bar, not inside it: a long error keeps its remedy in full. */}
      <div className="ms-nc-errbar">
        {error ? <p className="ms-nc-ferr" role="alert"><Icon name="warn" size={14} /><span>{n.createFailed({ detail: error })}</span></p> : null}
      </div>
      <footer className="ms-nc-foot">
        <div className="ms-nc-frames" aria-hidden="true">
          {chosen.slice(0, SUMMARY_FRAMES).map((p) => {
            const h = 40;
            const w = Math.max(14, Math.min(64, Math.round((h * p.width) / p.height)));
            return <span key={p.id} style={{ width: w, height: Math.min(h, Math.round((w * p.height) / p.width)) }} />;
          })}
        </div>
        <div className="ms-nc-sum">
          {chosen.length ? (
            <b>{n.summary({ formats: chosen.length, videos: videos.length, images: images.length })}</b>
          ) : (
            <b className={cx(formatError && 'ms-nc-warn')}>{n.pickFormat}</b>
          )}
          <span className="ms-nc-muted ms-nc-small">{n.summaryHint}</span>
        </div>
        <div className="ms-grow" />
        <Button size="lg" variant="ghost" loading={busy === 'draft'} disabled={busy !== null} onClick={() => void submit(false)}>{n.saveDraft}</Button>
        <Button size="lg" variant="accent" aria-label={n.generate} loading={busy === 'generate'} disabled={busy !== null} onClick={() => void submit(true)}>
          <Icon name="sparkle" size={14} />{n.generate}<kbd className="ms-nc-kbd" aria-hidden="true">{isMac() ? '⌘↵' : 'Ctrl ↵'}</kbd>
        </Button>
      </footer>

      <Popover open={pickerOpen} onClose={() => setPickerOpen(false)} anchor={pickerAnchor} placement="bottom-end" width={360}>
        <div role="dialog" aria-label={n.libraryTitle({ project: projectName })} className="ms-nc-picker">
          <span className="ms-nc-cap ms-nc-ell">{n.libraryTitle({ project: projectName })}</span>
          {library.value === null && !library.error ? (
            <div className="ms-nc-pick-state" role="status"><Spinner size={14} decorative />{n.libraryLoading}</div>
          ) : library.error && library.value === null ? (
            <div className="ms-nc-pick-state ms-nc-wrap" role="alert">
              <span>{n.libraryFailed({ detail: library.error })}</span>
              <Button size="sm" variant="outline" onClick={() => { setLibrary({ value: null, error: null }); setLibraryNonce((x) => x + 1); }}>{n.tryAgain}</Button>
            </div>
          ) : null}
          {library.error && library.value !== null ? (
            <p className="ms-nc-pick-warn" role="status"><Icon name="warn" size={13} /><span>{n.libraryPartial({ detail: library.error })}</span></p>
          ) : null}
          {library.value === null ? null : libraryItems.length === 0 ? (
            <Empty icon="image" title={n.libraryEmpty} sub={n.libraryEmptyBody} action={<Button size="sm" variant="outline" onClick={() => { setPickerOpen(false); go(href.project(slug, 'assets')); }}>{n.openAssets}</Button>} />
          ) : (
            <div className="ms-nc-pick-grid">
              {libraryItems.map((a) => {
                const path = assetPath(a.file);
                const on = picked.includes(path);
                return (
                  <button key={a.file} type="button" data-row className={cx('ms-nc-pick', on && 'ms-on')} aria-pressed={on} aria-label={a.file} title={a.description || a.file} onClick={() => togglePicked(path)}>
                    <AssetFace slug={slug} path={path} entry={a} />
                    {on ? <span className="ms-nc-tick" aria-hidden="true"><Icon name="check" size={10} strokeWidth={2.4} /></span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}

/** Thumbnail of a library file: the picture for images, SVGs and videos; an icon and the name otherwise. */
function AssetFace({ slug, path, entry, small }: { slug: string; path: string; entry: AssetEntry | null; small?: boolean }) {
  const kind = entry?.kind ?? (isVideoFile(path) ? 'video' : /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(path) ? 'image' : 'other');
  const url = api.projectFileUrl(slug, path);
  if (VISUAL.test(kind)) {
    return kind === 'video'
      ? <video className={cx('ms-nc-face', small && 'ms-sm')} src={url} muted preload="metadata" aria-hidden="true" />
      : <img className={cx('ms-nc-face', kind === 'svg' && 'ms-nc-face-svg', small && 'ms-sm')} src={url} alt="" />;
  }
  if (small) return <span className="ms-nc-face ms-sm ms-nc-face-file" aria-hidden="true"><Icon name="folder" size={10} /></span>;
  return <span className="ms-nc-face ms-nc-face-file" aria-hidden="true"><Icon name={kind === 'audio' ? 'play' : 'folder'} size={14} /><span>{baseName(path)}</span></span>;
}

/** One format of the board (prototype Tile): drawn proportion with the kind icon, name, ratio and maximum length. */
function Tile({ preset: p, on, linked, onClick }: { preset: FormatPreset; on: boolean; linked: boolean; onClick(): void }) {
  const t = useT();
  const n = t.web.newCreative;
  const locale = useLocale();
  const ref = useRef<HTMLButtonElement>(null);
  const first = useRef(true);
  // T13: the tile answers the click with a small spring.
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    void anim(ref.current, [{ transform: 'scale(.96)' }, { transform: 'scale(1)' }], 260, E.spring);
  }, [on]);
  const h = 48;
  const w = Math.max(18, Math.min(56, Math.round((h * p.width) / p.height)));
  const fh = Math.min(h, Math.round((w * p.height) / p.width));
  const video = p.kind === 'video';
  const note = p.maxDurationSec !== undefined ? maxLengthNote(p.maxDurationSec) : video ? t.web.formatUi.video : t.web.formatUi.image;
  return (
    <button ref={ref} type="button" className={cx('ms-nc-tile', on && 'ms-on')} aria-pressed={on} onClick={onClick} title={`${p.width}×${p.height}`}>
      <span className="ms-nc-tile-top">
        <span className="ms-nc-frame" style={{ width: w, height: fh }} aria-hidden="true">
          <Icon name={video ? 'play' : 'image'} size={video ? 10 : 12} fill={video} />
        </span>
        {linked ? <span className="ms-nc-link" title={n.linkLater} aria-hidden="true"><Icon name="link" size={13} /></span> : null}
      </span>
      <span className="ms-nc-tile-text">
        <b className="ms-nc-ell">{formatName(p, locale)}</b>
        <span className="ms-nc-tile-meta ms-nc-ell">{ratioLabel(p.width, p.height)} · {note}</span>
      </span>
      {on ? <span className="ms-nc-tick" aria-hidden="true"><Icon name="check" size={10} strokeWidth={2.4} /></span> : null}
    </button>
  );
}
