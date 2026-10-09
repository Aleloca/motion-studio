// Token figures (spec §5.3–5.4, prototype `Tokens`): the top-bar button with today's tokens, inline counts, and the
// usage of a version or analysis with its breakdown. Tokens are the primary figure (input + output + cache write);
// cache reads appear only in the breakdown; the cost is secondary and labelled by billing method. Absent data shows
// "—" or nothing, never a 0 that looks like data.
import type { Locale, Messages, UsageBilling, UsageSummary } from '@motion-studio/shared';
import { shownTotal } from '@motion-studio/shared';
import { useRef, useState } from 'react';
import { formatNumber, useLocale, useT } from '../i18n.tsx';
import { Button, Popover, cx } from '../ui/index.ts';
import { go } from './ShellContext.tsx';

/** Settings → Usage (the section itself arrives with Task 9 of Phase 8). */
export const USAGE_HASH = '#/settings/usage';

/**
 * "38.2k" (one decimal) from 1000 up, the plain number below. The "k" suffix (and the " · " joiners elsewhere) are
 * formatting, not words: Intl's compact notation has no "k" in it-IT ("38.240" → "38.240"), so it is not used.
 */
export function formatTokens(locale: Locale, n: number): string {
  if (n < 1000) return formatNumber(locale, n, { maximumFractionDigits: 0 });
  return `${formatNumber(locale, n / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
}

/** "$0.42" (three decimals under 10 cents). */
export function formatCost(locale: Locale, usd: number): string {
  return formatNumber(locale, usd, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: usd > 0 && usd < 0.1 ? 3 : 2 });
}

/** The cost, "≥ $X" when part of it is unknown; null without any cost. */
export function costText(t: Messages, locale: Locale, usd: number | null, estimated = false): string | null {
  if (usd === null) return null;
  const c = formatCost(locale, usd);
  return estimated ? t.web.usage.atLeast({ cost: c }) : c;
}

/** The cost labelled by billing method (spec §5.3); null without any cost. */
export function billingNote(t: Messages, locale: Locale, billing: UsageBilling, usd: number | null, estimated = false): string | null {
  const cost = costText(t, locale, usd, estimated);
  if (cost === null) return null;
  const u = t.web.usage;
  return billing === 'subscription' ? u.billingSubscription({ cost }) : billing === 'api' ? u.billingApi({ cost }) : u.billingUnknown({ cost });
}

/** Top-bar button: today's tokens of the whole workspace ("—" until known); opens Settings → Usage. */
export function TokensButton({ tokens }: { tokens: number | null }) {
  const t = useT();
  const locale = useLocale();
  const count = tokens === null ? t.web.usage.unknown : formatTokens(locale, tokens);
  return (
    <Button variant="ghost" className="ms-tokens ms-mono" aria-label={t.web.usage.todayButton({ count })} onClick={() => go(USAGE_HASH)}>
      {t.web.usage.tokens({ count })}
    </Button>
  );
}

/**
 * "12.3k tokens", tabular; nothing when `tokens` is null. `partial`: the figure may miss runs this page did not see
 * ("≥ 12.3k tokens"). `live`: a running figure, read as "… so far" by screen readers.
 */
export function TokenCount({ tokens, className, live, partial }: { tokens: number | null; className?: string; live?: boolean; partial?: boolean }) {
  const t = useT();
  const locale = useLocale();
  if (tokens === null) return null;
  const count = formatTokens(locale, tokens);
  return (
    <span className={cx('ms-tokcount', className)}>
      {partial ? t.web.usage.tokensAtLeast({ count }) : t.web.usage.tokens({ count })}
      {live ? <span className="ms-sr">{` ${t.web.usage.soFar}`}</span> : null}
    </span>
  );
}

/**
 * The usage of a version or an analysis: "38.4k tokens · $0.42", with a popover splitting input, output, cache write
 * and cache read, plus the billing note. Nothing without `usage` (older versions and proposals).
 */
export function UsageBadge({ usage, billing }: { usage: UsageSummary | undefined; billing: UsageBilling | null }) {
  const t = useT();
  const u = t.web.usage;
  const locale = useLocale();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const estimated = usage.estimated === true;
  const cost = costText(t, locale, usage.costUsd, estimated);
  const label = [u.tokens({ count: formatTokens(locale, shownTotal(usage.tokens)) }), cost].filter(Boolean).join(' · ');
  const note = billingNote(t, locale, billing ?? 'unknown', usage.costUsd, estimated);
  const n = (v: number) => formatNumber(locale, v);
  const rows: Array<[string, number]> = [[u.input, usage.tokens.input], [u.output, usage.tokens.output], [u.cacheWrite, usage.tokens.cacheWrite], [u.cacheRead, usage.tokens.cacheRead]];
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" className="ms-usage-badge ms-mono" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} placement="bottom-end" width={280} label={u.details}>
        <div className="ms-usage-pop">
          <b>{u.details}</b>
          <dl className="ms-usage-rows">
            {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{n(v)}</dd></div>)}
          </dl>
          <p className="ms-usage-note">{note ?? u.noCost}</p>
          {/* "≥": some run of this usage has no known cost. */}
          {estimated && usage.costUsd !== null ? <p className="ms-usage-note">{u.costUnknown}</p> : null}
        </div>
      </Popover>
    </>
  );
}
