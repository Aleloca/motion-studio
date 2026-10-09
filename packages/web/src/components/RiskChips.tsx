import { renderExplanation, type Explanation, type Messages, type Risk } from '@motion-studio/shared';
import { useT } from '../i18n.tsx';
import { Chip, cx, type IconName } from '../ui/index.ts';

const ORDER: Record<Risk, number> = { high: 0, medium: 1, low: 2 };
/** Colour is never the only signal: every risk has its own icon, and a text prefix for screen readers. */
const ICON: Record<Risk, IconName> = { high: 'warn', medium: 'eye', low: 'shield' };
const TONE: Record<Risk, string | undefined> = { high: 'ms-danger', medium: 'ms-warn', low: undefined };

const RISKS = new Set<unknown>(['low', 'medium', 'high']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a (possibly persisted, possibly malformed) value has the shape of an Explanation. */
function wellFormed(e: unknown): e is Explanation {
  return isRecord(e) && RISKS.has(e.risk) && Array.isArray(e.summary) && Array.isArray(e.indicators)
    && e.summary.every((p) => isRecord(p) && typeof p.key === 'string' && (p.params === undefined || isRecord(p.params)))
    && e.indicators.every((x) => isRecord(x) && typeof x.id === 'string' && RISKS.has(x.risk) && (x.params === undefined || isRecord(x.params)));
}

/**
 * An explanation rendered with a catalog (the web's `useT()`: switching language re-renders it), chips in risk order.
 * Null when the value is not a well-formed explanation. A phrase or indicator the catalog lacks (a newer core) renders
 * as its key: it is replaced by a generic string, never shown raw.
 */
export function explanationView(e: Explanation | null | undefined, t: Messages) {
  if (!wellFormed(e)) return null;
  const r = renderExplanation({ ...e, summary: e.summary.map((p) => ({ ...p, params: p.params ?? {} })) }, t);
  const a = t.web.approvalUi;
  const summary = r.summary.map((s, i) => (s === e.summary[i]!.key || s.startsWith('explain.') ? a.runsCommand : s));
  // Stable sort: the core already sorts by risk, the UI does not rely on it.
  const indicators = r.indicators
    .map((x, i) => ({ ...x, label: x.label.startsWith('explain.') ? a.otherRisk : x.label, i }))
    .sort((p, q) => ORDER[p.risk] - ORDER[q.risk] || p.i - q.i);
  return { ...r, summary, title: summary.join(' · '), indicators };
}

/** Indicator chips of a command explanation, in risk order: neutral (low), warn (medium), danger (high). */
export function RiskChips({ explanation }: { explanation: Explanation }) {
  const t = useT();
  const indicators = explanationView(explanation, t)?.indicators ?? [];
  return (
    <>
      {indicators.map((x) => {
        const risk = t.explain.risk[x.risk];
        return (
          <Chip key={`${x.id}:${x.i}`} icon={ICON[x.risk]} className={cx('ms-risk', TONE[x.risk])} title={risk}>
            <span className="ms-sr">{t.web.approvalUi.riskPrefix({ risk })} </span>
            <span className="ms-risk-label">{x.label}</span>
          </Chip>
        );
      })}
    </>
  );
}
