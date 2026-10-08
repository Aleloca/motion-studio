import { Fragment, type ReactNode } from 'react';
import { cx } from './cx.ts';

// Safe Markdown subset for agent and user text (spec point 32): **bold**, *italic* / _italic_, `code`, bullet lists,
// [label](https://…) and bare http(s) URLs. Everything else, HTML included, stays text: React escapes it and no
// dangerouslySetInnerHTML is used anywhere.

/** `m[0]` is the whole match, then the capture groups. `trimEnd`: drop sentence punctuation from the end of the match. */
type Rule = { re: RegExp; trimEnd?: boolean; render: (m: [string, ...string[]], key: string, links: boolean) => ReactNode };

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
  { re: /`([^`\n]+)`/, render: (m, key) => <code key={key}>{m[1]}</code> },
  { re: /\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/, render: (m, key, links) => <strong key={key}>{inline(m[1]!, key, links)}</strong> },
  { re: /\*(?=[^\s*])([^*\n]+?)(?<=\S)\*/, render: (m, key, links) => <em key={key}>{inline(m[1]!, key, links)}</em> },
  { re: /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]+?)(?<=\S)_(?![\p{L}\p{N}_])/u, render: (m, key, links) => <em key={key}>{inline(m[1]!, key, links)}</em> },
  {
    re: /\[([^\]\n]+)\]\(([^)\s]+)\)/,
    render: (m, key, links) => {
      const href = links ? safeHref(m[2]!) : null;
      return href ? <ExternalLink key={key} href={href}>{inline(m[1]!, key, false)}</ExternalLink> : m[0];
    },
  },
  {
    re: /https?:\/\/[^\s<>()[\]]+/,
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
  let rest = text;
  let n = 0;
  while (rest) {
    let best: { m: RegExpExecArray; rule: Rule } | null = null;
    for (const rule of RULES) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) { out.push(rest); break; }
    const { rule, m: found } = best;
    // A bare URL does not swallow the punctuation that ends the sentence.
    const whole = rule.trimEnd ? found[0].replace(TRAILING, '') : found[0];
    if (found.index > 0) out.push(rest.slice(0, found.index));
    out.push(rule.render([whole, ...found.slice(1)], `${keyPrefix}.${n++}`, links));
    rest = rest.slice(found.index + whole.length);
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
