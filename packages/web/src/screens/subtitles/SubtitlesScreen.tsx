// The subtitle editor (spec §6.3, layout B, Task 12): the creative's latest version in the live player on the left, with an
// editor-only caption of the line under the playhead, or, when the composition has a subtitles track, the runtime drawing
// the lines in the agent's style as they are edited (`setSubtitles`, debounced, Task 22); the list of lines on the right; the waveform timeline under both (Task 13). Edits save by
// themselves (useSubtitleSave); a `subtitles` broadcast reloads the set only when nothing is waiting to be saved. Task 14: a
// banner when the video changed under the set ("Rifai i tempi", and "Tempi controllati" to keep the timing), and "Rifai la
// trascrizione…" in the header. Task 26: the subtitle languages in the header (LangSwitcher), a translation's stale lines
// marked with "Ritraduci" per line and "Ritraduci tutto", the source text under each translated line.
import { clearSubtitlesBack, peekSubtitlesBack } from '../../shell/intents.ts';
import { SUPPORTED_LOCALES, drawsSubtitles, missingSourceLines, sourceCueOf, staleCues, translationSources, type CreativeDetail, type JobSummary, type LocaleTag, type SubtitleCue } from '@motion-studio/shared';
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError } from '../../api.ts';
import { CompositionPlayer, type CompositionMedia } from '../../components/CompositionPlayer.tsx';
import { usePreviewSession } from '../../components/compositionPreview.ts';
import { RetimeAction } from '../../components/SubtitlesReadyCard.tsx';
import { saveBlob } from '../../download.ts';
import { message } from '../../errors.ts';
import { useLocale, useT } from '../../i18n.tsx';
import { isActivePage, usePageShortcut } from '../../motion/index.ts';
import { isMac } from '../../platform.ts';
import { href } from '../../routes.ts';
import { go, ShellContext } from '../../shell/ShellContext.tsx';
import { useClock, type Clock } from '../../ui/clock.ts';
import { Button, Icon, Popover, Select, Spinner, Tooltip, cx, type SelectOption } from '../../ui/index.ts';
import { creativeLocales, localeName } from '../creative/languagesModel.ts';
import { usePlayerControls } from '../editor/usePlayerControls.ts';
import { activatesControl, bare, inOverlay, isTyping } from '../keys.ts';
import { CueList, FindReplace, msText, rowSelector, type CueSource } from './CueList.tsx';
import { entrySubtitleLang, inlineLangName, LangSwitcher, languageJob, noteSubtitleLangs } from './LangSwitcher.tsx';
import { CueTimeline, type CueTimelineProps } from './CueTimeline.tsx';
import { byStart, cueAt, editorReducer, initialEditorState, runtimeSubtitlesOf, warningsOf, type EditorOp } from './subtitlesModel.ts';
import { useSubtitleSave, type SubtitleSaveStatus } from './useSubtitleSave.ts';
import './subtitles.css';

const EXTS = ['srt', 'vtt'] as const;
/**
 * The lines go to the runtime this long after the last change (Task 22): a run of keystrokes is one `setSubtitles` (a
 * template layer reloads the whole set, up to about 0.5 MB, on each).
 */
export const SUBTITLES_PREVIEW_MS = 150;
/** ⌘ on macOS, Ctrl elsewhere (as the composition editor). */
const mod = (e: KeyboardEvent): boolean => (isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
const textOf = (cues: readonly SubtitleCue[]): string => JSON.stringify(cues);
/** Scrolls a row into view inside the list without moving the focus (jsdom has no scrollIntoView). */
const reveal = (el: Element | null | undefined) => { (el as HTMLElement | null | undefined)?.scrollIntoView?.({ block: 'nearest' }); };

export function SubtitlesScreen({ slug, creative, lang }: { slug: string; creative: string; lang?: LocaleTag }) {
  const t = useT();
  const shell = useContext(ShellContext);
  // A `subtitles` (or `creative`) broadcast bumps the creative's tick: the detail and the set are read again.
  const tick = shell?.live.creativeTicks[`${slug}/${creative}`] ?? 0;
  const [detail, setDetail] = useState<CreativeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getCreative(slug, creative)).then(
      (d) => { if (alive) { noteSubtitleLangs(slug, creative, d.subtitles ?? []); setDetail(d); setError(null); } },
      (e: unknown) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [slug, creative, tick]);
  // No language in the route: the original speech set, else the brief's language's, else the first (Task 26).
  const sets = detail?.subtitles ?? [];
  const brief = detail?.creative.brief ?? null;
  const shown = lang ?? entrySubtitleLang(sets, creativeLocales(brief ?? {})?.primary);
  // A language without its set yet (being translated, or gone): said so, with the switcher to leave it.
  if (shown && detail && !sets.some((x) => x.lang === shown)) {
    return <LangPending slug={slug} creative={creative} lang={shown} detail={detail} jobs={shell?.live.jobs ?? {}} />;
  }
  // The creative is read first, so a language without its set is never asked for (its read would only fail).
  if (shown && !detail && !error) return <main className="ms-subs"><Head slug={slug} creative={creative} /><div className="ms-subs-empty ms-subs-alone"><Spinner size={16} label={t.subtitles.loading} /></div></main>;
  if (shown) return <SubtitleEditor key={`${slug}/${creative}/${shown}`} slug={slug} creative={creative} lang={shown} detail={detail} tick={tick} />;
  return (
    <main className="ms-subs">
      <Head slug={slug} creative={creative} />
      <div className="ms-subs-empty ms-subs-alone">
        {error ? <p role="alert">{t.subtitles.loadFailed({ detail: error })}</p>
          : detail ? <p>{t.subtitles.noSets}</p> : <Spinner size={16} label={t.subtitles.loading} />}
      </div>
    </main>
  );
}

/** The header; `langs`: the language switcher, after the title. */
function Head({ slug, creative, langs, children }: { slug: string; creative: string; langs?: ReactNode; children?: ReactNode }) {
  const t = useT();
  const back = peekSubtitlesBack(`${slug}/${creative}`);
  return (
    <header className="ms-subs-head">
      <Button variant="ghost" size="sm" onClick={() => { clearSubtitlesBack(`${slug}/${creative}`); go(back ?? href.creative(slug, creative)); }}><Icon name="back" size={13} />{back ? t.subtitles.backToEditor : t.subtitles.backToCreative}</Button>
      <h1 className="ms-subs-title">{t.subtitles.editorTitle}</h1>
      {langs}
      <span className="ms-subs-grow" />
      {children}
    </header>
  );
}

/**
 * Task 26: a language in the route with no set: its subtitles on their way (the job making them, from the live jobs), the
 * job's failure, or none at all. The set's broadcast reloads the creative and opens the editor.
 */
function LangPending({ slug, creative, lang, detail, jobs }: { slug: string; creative: string; lang: LocaleTag; detail: CreativeDetail; jobs: Record<string, JobSummary> }) {
  const s = useT().subtitles;
  const locale = useLocale();
  const job = languageJob(jobs, slug, creative, lang);
  const name = inlineLangName(lang, locale);
  const goTo = (l: LocaleTag | null) => go(href.subtitles(slug, creative, l ?? undefined));
  return (
    <main className="ms-subs" data-lang={lang}>
      <Head slug={slug} creative={creative} langs={<LangSwitcher slug={slug} creative={creative} lang={lang} sets={detail.subtitles ?? []} brief={detail.creative.brief}
        edited={0} onSwitch={goTo} onLeave={goTo} />} />
      <div className="ms-subs-empty ms-subs-alone">
        {job && (job.state === 'queued' || job.state === 'running') ? <p role="status"><Spinner decorative size={14} /> {s.pendingLanguage({ lang: name })}</p>
          : job?.state === 'failed' ? <p role="alert">{s.pendingFailed({ lang: name, detail: job.error ?? '' })}</p>
            : <p>{s.noLanguage({ lang: name })}</p>}
      </div>
    </main>
  );
}

/** One set (keyed by creative and language: the autosave hook is mounted once per set). */
function SubtitleEditor({ slug, creative, lang, detail, tick }: { slug: string; creative: string; lang: LocaleTag; detail: CreativeDetail | null; tick: number }) {
  const t = useT();
  const s = t.subtitles;
  const root = useRef<HTMLElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const [state, dispatch] = useReducer(editorReducer, undefined, initialEditorState);
  /** The set's hash and audio fingerprint, set in the same render as each `load` (the save hook's contract, decision 1657). */
  const [hash, setHash] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  /** The format the set was timed on, once read. */
  const [timedOn, setTimedOn] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const save = useSubtitleSave(slug, creative, lang, state, { hash, fingerprint, dispatch });

  // The set: read at mount and again on each broadcast. A reload never goes over unsaved edits or a conflict being resolved
  // (the save hook's contract): the set read is applied after the render that holds every op dispatched meanwhile, and only
  // when those cues are what the server has with nothing in flight (`isSaved`, final review M1: never on a status read in
  // the answer's callback, which may predate a drag step); otherwise it is dropped and read again once they are. Cues the
  // editor already shows load nothing, so the undo history stays (the broadcast of our own save is one of those).
  const [incoming, setIncoming] = useState<{ cues: SubtitleCue[]; hash: string; fingerprint: string } | null>(null);
  const stale = useRef(false);
  const durationMs = useRef(0);
  const cuesNow = useRef(state.cues);
  cuesNow.current = state.cues;
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.subtitleSet(slug, creative, lang)).then(({ set, hash: h }) => {
      if (!alive) return;
      setLoadError(null);
      setTimedOn(set.timing.format);
      setIncoming({ cues: [...set.cues].sort(byStart), hash: h, fingerprint: set.timing.fingerprint });
    }, (e: unknown) => { if (alive && !loaded) setLoadError(message(e)); });
    return () => { alive = false; };
  }, [slug, creative, lang, tick, again]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!incoming) return;
    setIncoming(null);
    if (loaded) {
      if (!save.isSaved(state.cues)) { stale.current = true; return; }
      stale.current = false;
      if (textOf(incoming.cues) === textOf(state.cues)) return;
    }
    setLoaded(true);
    setHash(incoming.hash);
    setFingerprint(incoming.fingerprint);
    dispatch({ type: 'load', cues: incoming.cues, durationMs: Math.max(durationMs.current, ...incoming.cues.map((c) => c.end)), lang });
  }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps
  // A set dropped while edits were unsaved is read again once they are saved (after a conflict too, I2).
  useEffect(() => {
    if (stale.current && save.isSaved(cuesNow.current)) { stale.current = false; setAgain((n) => n + 1); }
  });

  // The player: the latest version, on the format the set was timed on (else its first own composition).
  const latest = detail?.versions.at(-1) ?? null;
  const comps = latest?.compositions ?? [];
  const format = timedOn === null ? null : comps.find((c) => c.format === timedOn)?.format ?? comps.find((c) => !c.followsFormat)?.format ?? null;
  const preview = usePreviewSession({ slug, creative, n: latest?.n ?? null, format: format ?? '', enabled: latest !== null && format !== null });
  const session = preview.state.kind === 'ready' ? preview.state.session : null;
  const [player, setPlayer] = useState<CompositionMedia | null>(null);
  const controls = usePlayerControls(player, `${latest?.n ?? 0}/${format ?? ''}`, session?.fps ?? 30);
  // Task 22: with a subtitles track in the played composition the runtime draws the lines in the agent's style, sent as they
  // are edited; without one the editor's own caption shows the line, and until it is known neither does (the page may already
  // draw its staged subtitles). A composition that cannot be read counts as one without the track: the caption shows, and if
  // the composition does have the track the page's own (saved) lines show under it too, a double caption accepted over none.
  const [track, setTrack] = useState<boolean | null>(null);
  const trackOf = latest !== null && format !== null ? { n: latest.n, format } : null;
  useEffect(() => {
    setTrack(null);
    if (!trackOf) return;
    let alive = true;
    Promise.resolve().then(() => api.getEditorComposition(slug, creative, trackOf.n, trackOf.format)).then(
      (v) => { if (alive) setTrack(drawsSubtitles(v.composition)); },
      () => { if (alive) setTrack(false); });
    return () => { alive = false; };
  }, [slug, creative, trackOf?.n, trackOf?.format]); // eslint-disable-line react-hooks/exhaustive-deps
  const sessionMs = session ? Math.round(session.duration * 1000) : 0;
  const drawn = useMemo(() => (track ? runtimeSubtitlesOf(lang, state.cues, sessionMs) : undefined), [track, lang, state.cues, sessionMs]);
  const liveSubtitles = useDebounced(drawn, SUBTITLES_PREVIEW_MS);

  // The video's length bounds new lines and moved times.
  useEffect(() => {
    if (!session) return;
    durationMs.current = Math.round(session.duration * 1000);
    dispatch({ type: 'duration', ms: Math.max(durationMs.current, ...cuesNow.current.map((c) => c.end)) });
  }, [session]);

  // The cue under the playhead: only its change re-renders the page, not every frame.
  const cuesRef = useRef(state.cues);
  cuesRef.current = state.cues;
  const now = useSyncExternalStore(controls.clock.subscribe, () => cueAt(cuesRef.current, Math.round(controls.clock.get().time * 1000))?.id ?? null);
  const nowCue = now ? state.cues.find((c) => c.id === now) ?? null : null;
  const warnings = useMemo(() => warningsOf(state.cues, state.lang), [state.cues, state.lang]);

  // The timeline's waveform: the played version's audio mix, read once per version (it may take a few seconds on a long
  // creative: the timeline says so and stays usable). Unavailable: no waveform, nothing else changes.
  const [wave, setWave] = useState<{ peaks: number[]; durationMs: number } | null>(null);
  const [waveDone, setWaveDone] = useState(false);
  const waveOf = latest?.n ?? null;
  // A localized voice's set is timed on its own video: its waveform is that audio (Task 24).
  const summary = detail?.subtitles?.find((x) => x.lang === lang);
  const waveLang = summary?.timing.locale;
  useEffect(() => {
    if (waveOf === null) return;
    let alive = true;
    setWave(null);
    setWaveDone(false);
    (waveLang ? api.subtitleWaveform(slug, creative, waveOf, waveLang) : api.subtitleWaveform(slug, creative, waveOf)).then(
      (w) => { if (alive) { setWave(w); setWaveDone(true); } },
      () => { if (alive) setWaveDone(true); });
    return () => { alive = false; };
  }, [slug, creative, waveOf, waveLang]);
  const seekMs = useCallback((ms: number) => controls.seek(ms / 1000), [controls]);

  const rowOf = (id: string) => listBox.current?.querySelector(rowSelector(id));
  // The row under the playhead follows playback (scrolled to; the focus stays where it is).
  // Not while the focus is inside the list (the user is typing or using a row's controls).
  useEffect(() => {
    if (!now || !controls.playing || listBox.current?.contains(document.activeElement)) return;
    reveal(rowOf(now));
  }, [now, controls.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state.selected) reveal(rowOf(state.selected)); }, [state.selected]);

  const show = useCallback((cue: SubtitleCue) => {
    dispatch({ type: 'select', id: cue.id });
    const at = Math.round(controls.clock.get().time * 1000);
    if (!(at >= cue.start && at < cue.end)) controls.seek(cue.start / 1000);
  }, [controls]);
  const step = (dir: 1 | -1) => {
    const cues = state.cues;
    const i = cues.findIndex((c) => c.id === state.selected);
    let next: SubtitleCue | undefined;
    if (i >= 0) next = cues[Math.min(cues.length - 1, Math.max(0, i + dir))];
    else {
      // Nothing selected: the line under the playhead, else the next one (↓) or the previous one (↑).
      const at = Math.round(controls.clock.get().time * 1000);
      next = cueAt(cues, at) ?? (dir === 1 ? cues.find((c) => c.start >= at) ?? cues.at(-1) : [...cues].reverse().find((c) => c.end <= at) ?? cues[0]);
    }
    if (!next) return;
    dispatch({ type: 'select', id: next.id });
    controls.seek(next.start / 1000);
  };

  // "+ Riga": at the playhead when it is between lines, else right after the line under it, else after the selected one. The
  // new line's text box takes the focus with its placeholder selected, so typing replaces it.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [noRoom, setNoRoom] = useState(false);
  const addLine = () => {
    const at = Math.round(controls.clock.get().time * 1000);
    const sel = state.cues.find((c) => c.id === state.selected);
    for (const where of [at, cueAt(state.cues, at)?.end, sel?.end]) {
      if (where === undefined) continue;
      const op: EditorOp = { type: 'add', at: where };
      const next = editorReducer(state, op);
      if (next === state) continue;
      dispatch(op);
      setFocusId(next.selected);
      setNoRoom(false);
      return;
    }
    setNoRoom(true);
  };
  useEffect(() => {
    if (!focusId) return;
    const box = rowOf(focusId)?.querySelector('textarea');
    if (!box) return;
    setFocusId(null);
    box.focus();
    box.select();
  }, [focusId, state.cues]);
  useEffect(() => { setNoRoom(false); }, [now, state.cues]);

  // The keyboard (spec §6.3): Space plays and pauses, ↑/↓ move between lines (never while typing), ⌘Z / ⇧⌘Z undo and redo
  // the lines (also from a line's fields; the find and replace fields keep their own).
  const free = (e: KeyboardEvent) => !e.isComposing && !e.altKey && !inOverlay(e);
  // Undo and redo are the page's own listener, not a page shortcut: a held chord repeats, and every keydown of it (repeats
  // included) is default-prevented, so the browser's own undo of a text box (or the desktop menu's) never mixes in.
  useEffect(() => {
    const letter = (e: KeyboardEvent, k: string) => e.key.toLowerCase() === k;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !free(e) || !isActivePage(root.current)) return;
      if (e.target instanceof Element && e.target.closest('.ms-subs-find')) return;
      const undo = mod(e) && !e.shiftKey && letter(e, 'z');
      const redo = (mod(e) && e.shiftKey && letter(e, 'z')) || (!isMac() && e.ctrlKey && !e.metaKey && !e.shiftKey && letter(e, 'y'));
      if (!undo && !redo) return;
      e.preventDefault();
      dispatch({ type: undo ? 'undo' : 'redo' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const plain = (e: KeyboardEvent) => free(e) && bare(e) && !e.shiftKey && !isTyping(e);
  usePageShortcut(root, (e) => plain(e) && (e.key === ' ' || e.code === 'Space') && !activatesControl(e, '.ms-subs-play'), () => controls.toggle());
  usePageShortcut(root, (e) => plain(e) && (e.key === 'ArrowDown' || e.key === 'ArrowUp'), (e) => step(e.key === 'ArrowDown' ? 1 : -1));
  // Final review, I1: Enter (outside a field, not on a control) puts the focus in the selected line's text, caret at the end.
  usePageShortcut(root, (e) => plain(e) && e.key === 'Enter' && !activatesControl(e) && state.selected !== null, () => {
    const box = state.selected ? rowOf(state.selected)?.querySelector('textarea') : null;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });

  // Downloads: an edit still waiting is saved first, so the file has it.
  const [busy, setBusy] = useState<'srt' | 'vtt' | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const download = async (ext: 'srt' | 'vtt') => {
    setBusy(ext);
    setDownloadError(null);
    try {
      // An edit not saved (a failed save, a conflict not merged yet) would be missing from the file: no stale download.
      if (!(await save.flush())) { setDownloadError(s.downloadFailed({ detail: s.notSaved })); return; }
      saveBlob(await api.subtitleFile(slug, creative, lang, ext), `${creative}.${lang}.${ext}`);
    } catch (e) { setDownloadError(s.downloadFailed({ detail: message(e) })); }
    finally { setBusy(null); }
  };

  const [finding, setFinding] = useState(false);
  const ratio = session ? session.width / session.height : 16 / 9;
  const frameLabel = t.web.render.playerFrame({ label: detail && latest ? `${detail.creative.title} v${latest.n}` : creative });
  const waiting = preview.state.kind === 'loading' || preview.state.kind === 'busy' || (preview.state.kind === 'idle' && format !== null);
  const noPreview = preview.state.kind === 'legacy' || (loaded && detail !== null && format === null);
  const timingChanged = summary?.timingChanged === true;
  // Task 25: a translation follows its source's times; it is never retimed nor marked checked on its own.
  const translation = summary?.origin === 'translation';

  // Task 26: another language opens once a waiting edit is saved (the save hook is per language); one that cannot be saved
  // keeps the language and says so (anti-goal 1).
  const [switchError, setSwitchError] = useState(false);
  const switchTo = async (to: LocaleTag) => {
    if (to === lang) return;
    setSwitchError(false);
    if (!(await save.flush())) { setSwitchError(true); return; }
    go(href.subtitles(slug, creative, to));
  };
  const edited = useMemo(() => state.cues.filter((c) => c.edited).length, [state.cues]);
  const sources = useSourceLines(slug, creative, translation ? summary?.sourceLang ?? null : null, tick);
  const marks = useMemo(() => staleOf(state.cues, sources, !timingChanged), [state.cues, sources, timingChanged]);
  const retranslate = useRetranslate(slug, creative, lang, save.flush);
  return (
    <main ref={root} className="ms-subs" data-lang={lang}>
      <Head slug={slug} creative={creative} langs={<LangSwitcher slug={slug} creative={creative} lang={lang} sets={detail?.subtitles ?? []} brief={detail?.creative.brief ?? null}
        edited={edited} onSwitch={switchTo} onLeave={(to) => go(href.subtitles(slug, creative, to ?? undefined))} />}>
        <SaveState status={save.status} notice={save.notice} retry={() => void save.flush()} />
        {/* A translation's lines come from its source, never from speech (final review I3). */}
        {translation ? null : <RedoTranscription slug={slug} creative={creative} />}
        <span className="ms-subs-undo">
          <Tooltip label={s.undo}><Button size="sm" variant="ghost" icon aria-label={s.undo} disabled={state.past.length === 0} onClick={() => dispatch({ type: 'undo' })}><Icon name="undo" size={14} /></Button></Tooltip>
          <Tooltip label={s.redo}><Button size="sm" variant="ghost" icon aria-label={s.redo} disabled={state.future.length === 0} onClick={() => dispatch({ type: 'redo' })}><Icon name="redo" size={14} /></Button></Tooltip>
        </span>
        {EXTS.map((ext) => (
          <Button key={ext} size="sm" variant="outline" disabled={busy !== null || !loaded} aria-busy={busy === ext || undefined}
            aria-label={s.download({ ext: `.${ext}` })} onClick={() => void download(ext)}>
            <Icon name="download" size={13} />.{ext}
          </Button>
        ))}
        {translation && (marks.size > 0 || marks.actionable > 0) ? <RetranslateAll count={marks.actionable} busy={retranslate.busy} run={() => void retranslate.run()} /> : null}
        {downloadError ? <span className="ms-subs-head-error" role="alert">{downloadError}</span> : null}
        {switchError ? <span className="ms-subs-head-error" role="alert">{s.notSavedSwitch}</span> : null}
        {retranslate.note ? <span className={retranslate.note.ok ? 'ms-subs-head-note' : 'ms-subs-head-error'} role={retranslate.note.ok ? 'status' : 'alert'}>{retranslate.note.text}</span> : null}
      </Head>
      {timingChanged ? (
        <section className="ms-subs-banner" aria-label={s.timingChanged}>
          <Icon name="warn" size={14} />
          <span className="ms-subs-banner-text">{translation ? s.translationTimingChanged : s.timingChanged}</span>
          {translation ? null : <RetimeAction slug={slug} creative={creative} lang={lang} className="ms-subs-banner-note" />}
          {translation ? null : <TimingChecked mark={save.timingChecked} />}
        </section>
      ) : null}

      <section className="ms-subs-player" aria-label={frameLabel}>
        <div className="ms-subs-stage">
          <div className="ms-subs-frame" style={{ '--ar': ratio } as CSSProperties}>
            {session ? <CompositionPlayer session={session} title={frameLabel} onMedia={setPlayer} onStall={preview.stalled} onShowing={preview.showing}
              {...(liveSubtitles ? { subtitles: liveSubtitles } : {})} /> : null}
            {waiting ? <span className="ms-cplayer-state" role="status">{preview.state.kind === 'busy' ? t.web.render.busy : t.web.render.loading}</span> : null}
            {preview.state.kind === 'failed' ? (
              <span className="ms-subs-frame-note" role="alert">
                <span>{t.web.render.failed({ detail: preview.state.message })}</span>
                <Button size="sm" variant="outline" onClick={preview.retry}><Icon name="refresh" size={12} />{t.web.render.retry}</Button>
              </span>
            ) : null}
            {noPreview ? <span className="ms-subs-frame-note">{s.noPreview}</span> : null}
            {nowCue && track === false ? <p className="ms-subs-caption" data-testid="subs-caption"><span className={cx(nowCue.id === state.selected && 'ms-on')}>{nowCue.text}</span></p> : null}
          </div>
        </div>
        <div className="ms-subs-transport">
          <Button size="sm" variant="ghost" icon className="ms-subs-play" aria-label={controls.playing ? s.pause : s.play} disabled={!controls.ready} onClick={controls.toggle}>
            <Icon name={controls.playing ? 'pause' : 'play'} size={14} />
          </Button>
          <TimeReadout clock={controls.clock} duration={controls.duration} />
        </div>
      </section>

      <section className="ms-subs-side" aria-label={s.lines}>
        <div className="ms-subs-side-head">
          <h2 className="ms-subs-side-title">{s.lines}<span className="ms-subs-count">{state.cues.length}</span></h2>
          <span className="ms-subs-grow" />
          <Tooltip label={s.findReplace}>
            <Button size="sm" variant={finding ? 'default' : 'ghost'} icon aria-label={s.findReplace} aria-expanded={finding} onClick={() => setFinding((v) => !v)}><Icon name="search" size={14} /></Button>
          </Tooltip>
          <Button size="sm" variant="outline" disabled={!loaded} onClick={addLine}>{s.addLine}</Button>
        </div>
        {noRoom ? <p className="ms-subs-note" role="status">{s.noRoom}</p> : null}
        {translation && marks.missing.length > 0 ? <MissingLines lines={marks.missing} sourceLang={summary?.sourceLang} /> : null}
        {finding ? <FindReplace cues={state.cues} dispatch={dispatch} /> : null}
        <div ref={listBox} className="ms-subs-scroll">
          {loadError ? (
            <div className="ms-subs-empty">
              <p role="alert">{s.loadFailed({ detail: loadError })}</p>
              <Button size="sm" variant="outline" onClick={() => setAgain((n) => n + 1)}><Icon name="refresh" size={12} />{s.retry}</Button>
            </div>
          ) : !loaded ? (
            <div className="ms-subs-empty"><Spinner size={16} label={s.loading} /></div>
          ) : (
            <CueList cues={state.cues} lang={state.lang} warnings={warnings} selected={state.selected} now={now} dispatch={dispatch} onPick={show}
              {...(translation ? { sources: marks.rows, sourceLang: summary?.sourceLang, retranslating: retranslate.busy, onRetranslate: (id: string) => void retranslate.run([id]) } : {})} />
          )}
        </div>
      </section>
      <Timeline clock={controls.clock} cues={state.cues} durationMs={state.durationMs} peaks={waveDone ? wave?.peaks ?? [] : null}
        peaksMs={wave?.durationMs} selected={state.selected} dragging={state.dragging} dispatch={dispatch} onSeek={seekMs} />
    </main>
  );
}

/**
 * Task 26: the lines of a translation's source set (`sourceLang`), read again on each change of the creative; null when it
 * is not a translation or the read failed (no marks then).
 */
function useSourceLines(slug: string, creative: string, sourceLang: LocaleTag | null, tick: number): SubtitleCue[] | null {
  const [cues, setCues] = useState<SubtitleCue[] | null>(null);
  // Another source drops the old lines; a re-read keeps them until it answers (the marks do not blink on each save).
  useEffect(() => { setCues(null); }, [sourceLang]);
  useEffect(() => {
    if (!sourceLang) return;
    let alive = true;
    Promise.resolve().then(() => api.subtitleSet(slug, creative, sourceLang)).then(
      ({ set }) => { if (alive) setCues(set.cues); }, () => { /* no marks */ });
    return () => { alive = false; };
  }, [slug, creative, sourceLang, tick]);
  return cues;
}

/**
 * Task 26: each translated line against its source now (the shared `staleCues`, on the editor's lines, unsaved edits
 * included): `changed` (its source line says something else now, shown with that text) or `gone` (no source line under it
 * any more); a current line shows the text it was translated from. `missing`: the source lines no line stands for
 * ("Manca la traduzione", `missingSourceLines`, final review I2). `actionable`: the lines "Ritraduci tutto" translates: for a
 * translation timed as its source (`following`), the changed lines the user did not correct (the corrected ones and the
 * gone ones it leaves to the user) and the missing ones; for one its source's retime left behind, every source line no
 * corrected line stands for (it is translated again whole, I2).
 */
export function staleOf(cues: readonly SubtitleCue[], source: readonly SubtitleCue[] | null, following = true):
  { rows: Map<string, CueSource>; size: number; actionable: number; missing: SubtitleCue[] } {
  const rows = new Map<string, CueSource>();
  if (!source) return { rows, size: 0, actionable: 0, missing: [] };
  const stale = new Set(staleCues({ cues: [...cues] }, { cues: [...source] }));
  const missing = missingSourceLines(cues, source, following);
  let changed = 0;
  for (const c of cues) {
    if (!c.source) continue;
    if (!stale.has(c.id)) { rows.set(c.id, { state: 'current', text: c.source.text }); continue; }
    const now = sourceCueOf(c, source);
    if (!now) { rows.set(c.id, { state: 'gone', text: c.source.text }); continue; }
    rows.set(c.id, { state: 'changed', text: now.text });
    if (!c.edited) changed++;
  }
  let actionable = changed + missing.length;
  if (!following) {
    const partner = translationSources(cues, source, false);
    const corrected = new Set(cues.filter((c) => c.edited).map((c) => partner.get(c.id)?.id));
    actionable = source.filter((s) => !corrected.has(s.id)).length;
  }
  return { rows, size: stale.size, actionable, missing };
}

/** Final review I2: the source lines with no line in this language ("Manca la traduzione"), covered by "Ritraduci tutto". */
function MissingLines({ lines, sourceLang }: { lines: readonly SubtitleCue[]; sourceLang: LocaleTag | undefined }) {
  const s = useT().subtitles;
  return (
    <section className="ms-subs-missing" aria-label={s.missingTranslation}>
      <p className="ms-subs-missing-head"><Icon name="warn" size={12} />{s.missingTranslation}<span className="ms-subs-count">{lines.length}</span></p>
      <p className="ms-subs-missing-hint">{s.missingTranslationHint}</p>
      <ul className="ms-subs-missing-list">
        {lines.map((c) => (
          <li key={c.id}><span className="ms-subs-missing-at">{msText(c.start)}</span><span className="ms-subs-missing-text" lang={sourceLang}>{c.text}</span></li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Task 26: "Ritraduci" (lines by id) and "Ritraduci tutto" (no ids): the edits are saved first, then the translation of those
 * lines starts (the lines come back with the set's broadcast). Its outcome in plain words: started, lines removed because
 * their source is gone (`dropped`, also on a refusal), or the refusal (409 `subtitles-nothing-stale` says why).
 */
function useRetranslate(slug: string, creative: string, lang: LocaleTag, flush: () => Promise<boolean>) {
  const s = useT().subtitles;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (ids?: string[]) => {
    setBusy(true);
    setNote(null);
    try {
      if (!(await flush())) { setNote({ ok: false, text: s.retranslateFailed({ detail: s.notSaved }) }); return; }
      const r = await api.retranslateSubtitles(slug, creative, lang, ids ? { ids } : {});
      const dropped = r.dropped ? ` ${s.retranslateDropped({ count: r.dropped })}` : '';
      setNote({ ok: true, text: r.job ? `${s.retranslateStarted}${dropped}` : dropped.trim() });
    } catch (e) {
      const dropped = e instanceof ApiError && e.dropped ? ` ${s.retranslateDropped({ count: e.dropped })}` : '';
      const nothing = e instanceof ApiError && e.code === 'subtitles-nothing-stale';
      setNote({ ok: false, text: `${nothing ? message(e) : s.retranslateFailed({ detail: message(e) })}${dropped}` });
    } finally { setBusy(false); }
  };
  return { busy, note, run };
}

/** "Ritraduci tutto" with the number of lines it translates again. */
function RetranslateAll({ count, busy, run }: { count: number; busy: boolean; run(): void }) {
  const s = useT().subtitles;
  return (
    <Tooltip label={s.retranslateAllHint}>
      <Button size="sm" variant="outline" disabled={busy} aria-busy={busy || undefined} onClick={run}>
        <Icon name="refresh" size={13} />{s.retranslateAll}{count > 0 ? <span className="ms-subs-count">{count}</span> : null}
      </Button>
    </Tooltip>
  );
}

/**
 * Task 14: "Rifai la trascrizione…": the spoken language (recognised automatically unless the user picks one, the only
 * case the transcriber is told a language), then a new transcription of the latest version. Edited lines stay as they are.
 */
function RedoTranscription({ slug, creative }: { slug: string; creative: string }) {
  const s = useT().subtitles;
  const locale = useLocale();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<LocaleTag | 'auto'>('auto');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const options = useMemo((): SelectOption<LocaleTag | 'auto'>[] => [
    { value: 'auto', label: s.redoAuto },
    ...SUPPORTED_LOCALES.map((l) => ({ value: l.tag, label: localeName(l.tag, locale) })).sort((a, b) => a.label.localeCompare(b.label, locale)),
  ], [s, locale]);
  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.startSubtitles(slug, creative, { mode: 'new', ...(pick !== 'auto' ? { lang: pick } : {}) });
      setOpen(false);
      setNote({ ok: true, text: s.redoStarted });
    } catch (e) { setNote({ ok: false, text: s.redoFailed({ detail: message(e) }) }); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setNote(null); setOpen((v) => !v); }}>{s.redoMenu}</Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" width={300} label={s.redoTitle}>
        <div className="ms-subs-redo">
          <b className="ms-subs-redo-title">{s.redoTitle}</b>
          <Select<LocaleTag | 'auto'> label={s.redoLanguage} value={pick} options={options} onChange={setPick} />
          <p className="ms-subs-redo-hint">{s.redoHint}</p>
          <p className="ms-subs-redo-hint">{s.redoOtherLanguage}</p>
          {note && !note.ok ? <p className="ms-subs-redo-error" role="alert">{note.text}</p> : null}
          <Button size="sm" variant="ink" loading={busy} onClick={() => void start()}>{s.redoStart}</Button>
        </div>
      </Popover>
      {note?.ok ? <span className="ms-subs-head-note" role="status">{note.text}</span> : null}
    </>
  );
}

/**
 * Final review, M3: "Tempi controllati": the user checked the lines against the new video and keeps their timing. Once the
 * edits are saved, the set's timing is marked as checked on the latest audio (the banner then goes with the broadcast).
 */
function TimingChecked({ mark }: { mark(): Promise<void> }) {
  const s = useT().subtitles;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try { await mark(); } catch (e) { setError(s.timingCheckedFailed({ detail: message(e) })); } finally { setBusy(false); }
  };
  return (
    <>
      <Tooltip label={s.timingCheckedHint}>
        <Button size="sm" variant="ghost" disabled={busy} aria-busy={busy || undefined} onClick={() => void run()}><Icon name="check" size={13} />{s.timingChecked}</Button>
      </Tooltip>
      {error ? <span role="alert" className="ms-subs-banner-note">{error}</span> : null}
    </>
  );
}

function SaveState({ status, notice, retry }: { status: SubtitleSaveStatus; notice: boolean; retry(): void }) {
  const s = useT().subtitles;
  // After a conflict, "saved" keeps saying the lines were changed elsewhere until the next edit.
  const elsewhere = status === 'conflict' || (status === 'saved' && notice);
  return (
    <span className="ms-subs-save">
      <span role="status" aria-label={s.saveState} className={cx('ms-subs-save-text', `ms-${elsewhere ? 'conflict' : status}`)}>
        {status === 'saving' ? <Spinner decorative size={11} /> : <Icon name={status === 'saved' && !elsewhere ? 'check' : 'warn'} size={12} />}
        {status === 'saving' ? s.saving : elsewhere ? s.savedElsewhere : status === 'saved' ? s.saved : s.saveFailed}
      </span>
      {status === 'error' ? <Button size="sm" variant="ghost" onClick={retry}>{s.retry}</Button> : null}
    </span>
  );
}

/** `value`, once it has stayed the same for `ms` (Task 22). */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** The timeline with the playhead from the player's clock (only the timeline re-renders on each frame). */
function Timeline({ clock, ...p }: Omit<CueTimelineProps, 'time'> & { clock: Clock }) {
  const { time } = useClock(clock);
  return <CueTimeline {...p} time={time * 1000} />;
}

function TimeReadout({ clock, duration }: { clock: Clock; duration: number }) {
  const { time } = useClock(clock);
  return <span className="ms-subs-tc">{msText(time * 1000)}<span className="ms-subs-tc-total"> / {msText(duration * 1000)}</span></span>;
}
