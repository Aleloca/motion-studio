import { renderExplanation, type Explanation, type Messages, type Risk } from '@motion-studio/shared';
import { useT } from '../i18n.tsx';
import { Chip, cx, type IconName } from '../ui/index.ts';

const ORDER: Record<Risk, number> = { high: 0, medium: 1, low: 2 };
/** Colour is never the only signal: every risk has its own icon, and a text prefix for screen readers. */
const ICON: Record<Risk, IconName> = { high: 'warn', medium: 'eye', low: 'shield' };
const TONE: Record<Risk, string | undefined> = { high: 'ms-danger', medium: 'ms-warn', low: undefined };

/** An explanation rendered with a catalog (the web's `useT()`: switching language re-renders it), chips in risk order. */
export function explanationView(e: Explanation, t: Messages) {
  const r = renderExplanation(e, t);
  // Stable sort: the core already sorts by risk, the UI does not rely on it.
  const indicators = r.indicators.map((x, i) => ({ ...x, i })).sort((a, b) => ORDER[a.risk] - ORDER[b.risk] || a.i - b.i);
  return { ...r, title: r.summary.join(' · '), indicators };
}

/** Indicator chips of a command explanation, in risk order: neutral (low), warn (medium), danger (high). */
export function RiskChips({ explanation }: { explanation: Explanation }) {
  const t = useT();
  const { indicators } = explanationView(explanation, t);
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
