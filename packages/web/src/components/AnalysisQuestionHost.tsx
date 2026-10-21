import type { JobWaitReason, VideoAnalysisView } from '@motion-studio/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EventsState } from '../eventsReducer.ts';
import { jobPlace } from '../shell/ActivityCenter.tsx';
import { anyLayerOpen } from '../ui/index.ts';
import { useVideoAnalyses } from '../useVideoAnalyses.ts';
import { AnalysisQuestionDialog } from './TranscriptionDialog.tsx';

/** A key pressed in a text field this recently means the user is typing: the dialog waits (decision 1597). */
export const TYPING_IDLE_MS = 2500;
/** How often a waiting question checks whether it can open now. */
export const DEFER_POLL_MS = 250;
/** The holds of an analysis that asks the user (the long video, the transcription choice). */
const ASKING: ReadonlySet<JobWaitReason> = new Set<JobWaitReason>(['video-long', 'transcription-choice']);

/** One question: the project, the job, what it asks and about which video (a long video then its transcription: two). */
export const questionKey = (slug: string, v: VideoAnalysisView) => `${slug}:${v.jobId ?? ''}:${v.pending?.kind ?? ''}:${v.file}`;

export interface AnalysisQuestions {
  /** A screen shows these videos' questions itself (the brief chat's cards): no dialog opens for them. Returns the release. */
  claim(slug: string, files: readonly string[]): () => void;
  /** A question closed with Chiudi in a screen's own dialog: it never opens by itself again. */
  dismiss(slug: string, view: VideoAnalysisView): void;
}
const NONE: AnalysisQuestions = { claim: () => () => {}, dismiss: () => {} };
const Ctx = createContext<AnalysisQuestions>(NONE);
export const useAnalysisQuestions = () => useContext(Ctx);

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
function inTextField(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.has((el as HTMLInputElement).type);
}

/** The analyses of one project with a held job (its listing and its live views), told to the host. */
function HeldProject({ slug, live, onViews }: { slug: string; live: EventsState; onViews(slug: string, views: Record<string, VideoAnalysisView> | null): void }) {
  const { byFile } = useVideoAnalyses(slug, live);
  useEffect(() => { onViews(slug, byFile); }, [slug, byFile, onViews]);
  useEffect(() => () => onViews(slug, null), [slug, onViews]);
  return null;
}

/**
 * Report 65 (decisions 1596–1601): a held analysis's question (the long video, the transcription choice) opens its dialog by
 * itself, on whatever screen the user is on, once per question. One at a time: the next opens when the current one is
 * answered or closed. It never takes the focus while the user types in a text field or another dialog or popover is open: it
 * waits until that ends. A question closed with Chiudi does not open again by itself (it stays in the activity centre's
 * "Needs you" and on its video's card); one answered elsewhere closes its dialog. A question a screen shows itself (the brief
 * chat's card) is left to it.
 */
export function AnalysisQuestionHost({ live, enabled = true, children }: { live: EventsState; enabled?: boolean; children?: ReactNode }) {
  // The projects with an analysis held for the user, from the jobs (the activity centre's "Needs you").
  const projects = useMemo(() => {
    const out = new Set<string>();
    if (!enabled) return [];
    for (const j of Object.values(live.jobs)) {
      if (j.kind !== 'video-analysis' || j.state !== 'queued' || !j.waitReason || !ASKING.has(j.waitReason)) continue;
      const at = jobPlace(j);
      if (at) out.add(at.project);
    }
    return [...out].sort();
  }, [live.jobs, enabled]);
  const [views, setViews] = useState<Record<string, Record<string, VideoAnalysisView>>>({});
  const onViews = useCallback((slug: string, v: Record<string, VideoAnalysisView> | null) => {
    setViews((all) => {
      if (v === null) { if (!(slug in all)) return all; const { [slug]: _gone, ...rest } = all; return rest; }
      return all[slug] === v ? all : { ...all, [slug]: v };
    });
  }, []);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [claims, setClaims] = useState<ReadonlyArray<{ id: number; slug: string; files: readonly string[] }>>([]);
  const claimSeq = useRef(0);
  const api = useMemo<AnalysisQuestions>(() => ({
    claim: (slug, files) => {
      const id = ++claimSeq.current;
      setClaims((c) => [...c, { id, slug, files }]);
      return () => setClaims((c) => c.filter((x) => x.id !== id));
    },
    dismiss: (slug, view) => { if (view.pending) setDismissed((d) => new Set([...d, questionKey(slug, view)])); },
  }), []);

  const questions = useMemo(() => projects.flatMap((slug) => Object.values(views[slug] ?? {})
    .filter((v) => v.pending !== null)
    .map((v) => ({ slug, view: v, key: questionKey(slug, v) }))), [projects, views]);
  const claimed = (slug: string, file: string) => claims.some((c) => c.slug === slug && c.files.includes(file));
  const next = questions.find((q) => !dismissed.has(q.key) && !claimed(q.slug, q.view.file)) ?? null;

  const [current, setCurrent] = useState<{ key: string; slug: string; file: string } | null>(null);
  // The last key pressed in the page: a text field with the focus and a recent key means the user is typing.
  const lastKey = useRef(0);
  useEffect(() => {
    const on = () => { lastKey.current = Date.now(); };
    document.addEventListener('keydown', on, true);
    return () => document.removeEventListener('keydown', on, true);
  }, []);
  const nextKey = next?.key ?? null;
  useEffect(() => {
    if (current !== null || next === null) return;
    const target = { key: next.key, slug: next.slug, file: next.view.file };
    const tryOpen = () => {
      if (anyLayerOpen() || (inTextField() && Date.now() - lastKey.current < TYPING_IDLE_MS)) return false;
      setCurrent(target);
      return true;
    };
    if (tryOpen()) return;
    const id = window.setInterval(() => { if (tryOpen()) window.clearInterval(id); }, DEFER_POLL_MS);
    return () => window.clearInterval(id);
  }, [current, nextKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Answered elsewhere (another window, a remembered choice, its card): the dialog closes. While Whisper installs the analysis
  // still asks, so the dialog stays with its progress.
  const stillAsking = current !== null && questions.some((q) => q.key === current.key);
  useEffect(() => { if (current !== null && !stillAsking) setCurrent(null); }, [current, stillAsking]);
  // The last question stays shown while its dialog closes; each question its own dialog (keyed).
  const [shown, setShown] = useState<{ key: string; slug: string; file: string } | null>(null);
  useEffect(() => { if (current !== null) setShown(current); }, [current]);
  const close = (key: string) => {
    setDismissed((d) => new Set([...d, key]));
    setCurrent((c) => (c?.key === key ? null : c));
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {projects.map((slug) => <HeldProject key={slug} slug={slug} live={live} onViews={onViews} />)}
      {shown ? (
        <AnalysisQuestionDialog key={shown.key} slug={shown.slug} view={views[shown.slug]?.[shown.file] ?? null}
          open={current?.key === shown.key} onClose={() => close(shown.key)} />
      ) : null}
    </Ctx.Provider>
  );
}
