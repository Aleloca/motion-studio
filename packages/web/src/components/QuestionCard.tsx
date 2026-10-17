// User note 8: the agent's AskUserQuestion as a question card (kind `question`). Each question shows its header and text, its
// options as choices with their descriptions (several for a multiple-choice question) and "Altro" with the user's own words.
// Everything the agent wrote is plain text, never HTML, shortened on screen only (the whole text in the tooltip): the core
// answers with the exact labels, from the indexes sent here. Same entrance, collapse and timer as the approval card.
import { QUESTION_DISPLAY, QUESTION_LIMITS, type AgentQuestion, type ApprovalRequest, type QuestionAnswers } from '@motion-studio/shared';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { message } from '../errors.ts';
import { useT } from '../i18n.tsx';
import { collapse, enter, pulse } from '../motion/index.ts';
import { Button, CountdownRing, Input } from '../ui/index.ts';

const ms = (iso: string) => new Date(iso).getTime();

/** `text` cut to `max` characters (whole code points) with "…"; `full` is set only when it was cut. */
export function clip(text: string, max: number): { shown: string; full?: string } {
  const chars = Array.from(text);
  if (chars.length <= max) return { shown: text };
  return { shown: `${chars.slice(0, max - 1).join('').trimEnd()}…`, full: text };
}

export function Clipped({ text, max, className }: { text: string; max: number; className?: string }) {
  const c = clip(text, max);
  return <span className={className} title={c.full}>{c.shown}</span>;
}

/** One question's choice: the indexes of the options picked, and the "Altro" text (null: "Altro" not picked). */
interface Choice { selected: number[]; other: string | null }

export interface QuestionCardProps {
  approval: ApprovalRequest;
  context?: string;
  leaving?: boolean;
  onGone?(id: string): void;
}

export function QuestionCard({ approval, context, leaving = false, onGone }: QuestionCardProps) {
  const t = useT();
  const q = t.web.questionUi;
  const a = t.web.approvalUi;
  const ref = useRef<HTMLDivElement>(null);
  const questions = approval.questions ?? [];
  const [choices, setChoices] = useState<Choice[]>(() => questions.map(() => ({ selected: [], other: null })));
  const [busy, setBusy] = useState(false);
  const [decided, setDecided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  useLayoutEffect(() => {
    const el = ref.current;
    void enter(el, { y: 10 }).then(async () => {
      for (let i = 0; i < 2 && !leavingRef.current && el?.isConnected; i++) await pulse(el);
    });
  }, []);
  const wasLeaving = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!leaving) {
      if (wasLeaving.current) { setDecided(false); void enter(el, { y: 0, ms: 200 }); }
      wasLeaving.current = false;
      return;
    }
    wasLeaving.current = true;
    let live = true;
    void collapse(el).then((finished) => { if (finished && live && leavingRef.current) onGoneRef.current?.(approval.id); });
    return () => { live = false; };
  }, [leaving, approval.id]);

  const set = (i: number, f: (c: Choice) => Choice) => setChoices((l) => l.map((c, k) => (k === i ? f(c) : c)));
  const answered = (c: Choice) => c.selected.length > 0 || (c.other !== null && c.other.trim() !== '');
  const ready = questions.length > 0 && choices.every(answered);
  const disabled = busy || decided || leaving;

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try {
      await call();
      // The card leaves when the core confirms (approval_resolved); until then it cannot be answered twice.
      setDecided(true);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? a.alreadyHandled : message(e));
    } finally { setBusy(false); }
  };
  const send = () => {
    const answers: QuestionAnswers = choices.map((c) => {
      const other = c.other?.trim() ?? '';
      return { selected: [...c.selected].sort((x, y) => x - y), ...(other ? { other } : {}) };
    });
    void run(() => api.answerQuestion(approval.id, answers));
  };

  const created = ms(approval.createdAt);
  const ttl = (ms(approval.expiresAt) - created) / 1000;
  return (
    <div ref={ref} role="group" aria-label={approval.title} className="ms-approval ms-question" data-approval={approval.id}>
      <div className="ms-approval-head">
        <span className="ms-approval-dot" aria-hidden="true" />
        <b className="ms-approval-title">{q.title}</b>
        {Number.isFinite(created) && Number.isFinite(ttl) && ttl > 0 && <CountdownRing createdAt={created} ttlSec={ttl} />}
      </div>
      {context && <span className="ms-approval-context">{context}</span>}
      {questions.map((question, i) => (
        <QuestionBlock key={i} question={question} choice={choices[i]!} disabled={disabled}
          onPick={(k) => set(i, (c) => (question.multiSelect
            ? { ...c, selected: c.selected.includes(k) ? c.selected.filter((x) => x !== k) : [...c.selected, k] }
            : { selected: [k], other: null }))}
          onOther={(on) => set(i, (c) => (question.multiSelect ? { ...c, other: on ? (c.other ?? '') : null } : { selected: [], other: on ? (c.other ?? '') : null }))}
          onOtherText={(text) => set(i, (c) => ({ ...c, other: text }))} />
      ))}
      <div className="ms-approval-actions">
        <Button size="sm" variant="ink" className="ms-grow" disabled={disabled || !ready} title={ready ? undefined : q.chooseFirst} onClick={send}>{q.send}</Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void run(() => api.decideApproval(approval.id, 'deny'))}>{q.skip}</Button>
      </div>
      {error && <p role="alert" className="ms-approval-error">{error}</p>}
    </div>
  );
}

function QuestionBlock({ question, choice, disabled, onPick, onOther, onOtherText }: {
  question: AgentQuestion; choice: Choice; disabled: boolean; onPick(k: number): void; onOther(on: boolean): void; onOtherText(text: string): void;
}) {
  const t = useT();
  const q = t.web.questionUi;
  const name = useId();
  const multi = question.multiSelect;
  const type = multi ? 'checkbox' : 'radio';
  const otherOn = choice.other !== null;
  return (
    <fieldset className="ms-question-block" role="group" aria-label={question.question}>
      {question.header && <Clipped className="ms-question-header" text={question.header} max={QUESTION_DISPLAY.header} />}
      <Clipped className="ms-question-text" text={question.question} max={QUESTION_DISPLAY.question} />
      {multi && <span className="ms-approval-note">{q.multiHint}</span>}
      <div className="ms-question-options">
        {question.options.map((o, k) => (
          <label key={k} className="ms-question-option">
            <input type={type} name={name} checked={choice.selected.includes(k)} disabled={disabled} onChange={() => onPick(k)} />
            <span className="ms-question-option-text">
              <Clipped className="ms-question-label" text={o.label} max={QUESTION_DISPLAY.label} />
              {o.description && <Clipped className="ms-question-desc" text={o.description} max={QUESTION_DISPLAY.description} />}
            </span>
          </label>
        ))}
        <label className="ms-question-option">
          <input type={type} name={name} checked={otherOn} disabled={disabled} onChange={() => onOther(multi ? !otherOn : true)} />
          <span className="ms-question-option-text"><span className="ms-question-label">{q.other}</span></span>
        </label>
        {otherOn && (
          <Input autoFocus value={choice.other ?? ''} maxLength={QUESTION_LIMITS.other} disabled={disabled} placeholder={q.otherPlaceholder}
            aria-label={q.otherPlaceholder} onChange={(e) => onOtherText(e.target.value)} />
        )}
      </div>
    </fieldset>
  );
}
