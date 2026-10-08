import { Fragment, type ReactNode } from 'react';
import { cx } from './cx.ts';

// Safe Markdown subset for agent and user text (spec point 32): **bold**, *italic* / _italic_, `code`, bullet lists,
// [label](https://…) and bare http(s) URLs. Everything else, HTML included, stays text: React escapes it and no
// dangerouslySetInnerHTML is used anywhere.
//
// Linear time on hostile input: every pattern's body stops at the next delimiter of its kind (bold cannot contain
// "**", a link label cannot contain "[" or "]", a URL in parentheses cannot contain "(" or "["), so a failed attempt
// from an opener scans only up to the next opener; and `inline` remembers each rule's next match, re-running a rule
// only once the text before that match has been consumed.

/** `m[0]` is the whole match, then the capture groups. `trimEnd`: drop sentence punctuation from the end of the match. */
type Rule = { /** global: searched from `lastIndex` */ re: RegExp; trimEnd?: boolean; render: (m: [string, ...string[]], key: string, links: boolean) => ReactNode };

const SAFE_URL = /^https?:\/\/[^\s]+$/i;
const TRAILING = /[.,;:!?'"]+$/;

/** Only absolute http(s) URLs become links; anything else (javascript:, data:, protocol-relative…) is refused. */
export function safeHref(raw: string): string | null {
  if (!SAFE_URL.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

// External: in the desktop app the window-open handler hands target=_blank links to the system browser.
const ExternalLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="ms-link" href={href} target="_blank" rel="noopener noreferrer">{children}</a>
);

const RULES: Rule[] = [
  { re: /`([^`\n]+)`/g, render: (m, key) => <code key={key}>{m[1]}</code> },
  { re: /\*\*(?=\S)((?:[^*\n]|\*(?!\*))+?)(?<=\S)\*\*/g, render: (m, key, links) => <strong key={key}>{inline(m[1]!, key, links)}</strong> },
  { re: /\*(?=[^\s*])([^*\n]+?)(?<=\S)\*/g, render: (m, key, links) => <em key={key}>{inline(m[1]!, key, links)}</em> },
  { re: /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, render: (m, key, links) => <em key={key}>{inline(m[1]!, key, links)}</em> },
  {
    re: /\[([^[\]\n]+)\]\(([^()[\]\s]+)\)/g,
    render: (m, key, links) => {
      const href = links ? safeHref(m[2]!) : null;
      return href ? <ExternalLink key={key} href={href}>{inline(m[1]!, key, false)}</ExternalLink> : m[0];
    },
  },
  {
    re: /https?:\/\/[^\s<>()[\]]+/g,
    trimEnd: true,
    render: (m, key, links) => {
      const href = links ? safeHref(m[0]) : null;
      return href ? <ExternalLink key={key} href={href}>{href}</ExternalLink> : m[0];
    },
  },
];

/** Inline spans of one line or list item. `links` is false inside a link label (no nested anchors). */
function inline(text: string, keyPrefix: string, links = true): ReactNode[] {
  const out: ReactNode[] = [];
  // Next match of each rule at or after `pos`; undefined = not searched yet, null = none left in the text.
  const next: (RegExpExecArray | null | undefined)[] = RULES.map(() => undefined);
  let pos = 0;
  let n = 0;
  while (pos < text.length) {
    let best = -1;
    RULES.forEach((rule, i) => {
      let m = next[i];
      if (m === undefined || (m !== null && m.index < pos)) {
        rule.re.lastIndex = pos;
        m = rule.re.exec(text);
        next[i] = m;
      }
      if (m && (best < 0 || m.index < next[best]!.index)) best = i;
    });
    const found = best < 0 ? null : next[best]!;
    if (!found) { out.push(text.slice(pos)); break; }
    const rule = RULES[best]!;
    // A bare URL does not swallow the punctuation that ends the sentence.
    const whole = rule.trimEnd ? found[0].replace(TRAILING, '') : found[0];
    if (found.index > pos) out.push(text.slice(pos, found.index));
    out.push(rule.render([whole, ...found.slice(1)], `${keyPrefix}.${n++}`, links));
    pos = found.index + whole.length;
  }
  return out;
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] };

const BULLET = /^\s*[-*+]\s+(.*)$/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  let cur: Block | null = null;
  for (const line of text.split(/\r?\n/)) {
    const bullet = BULLET.exec(line);
    if (!line.trim()) { cur = null; continue; }
    if (bullet) {
      if (cur?.kind !== 'ul') { cur = { kind: 'ul', items: [] }; out.push(cur); }
      cur.items.push(bullet[1]!);
    } else {
      if (cur?.kind !== 'p') { cur = { kind: 'p', lines: [] }; out.push(cur); }
      cur.lines.push(line);
    }
  }
  return out;
}

export interface MarkdownProps { text: string; className?: string }

/** Safe Markdown renderer: see the comment at the top of the file for the supported subset. */
export function Markdown({ text, className }: MarkdownProps) {
  return (
    <div className={cx('ms-md', className)}>
      {blocks(text).map((b, i) =>
        b.kind === 'ul' ? (
          <ul key={i}>{b.items.map((item, j) => <li key={j}>{inline(item, `${i}.${j}`)}</li>)}</ul>
        ) : (
          <p key={i}>{b.lines.map((line, j) => <Fragment key={j}>{j > 0 ? <br /> : null}{inline(line, `${i}.${j}`)}</Fragment>)}</p>
        ),
      )}
    </div>
  );
}
