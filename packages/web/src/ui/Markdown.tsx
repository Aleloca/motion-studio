import { Fragment, type ReactNode } from 'react';
import { cx } from './cx.ts';

// Safe Markdown subset for agent and user text (spec point 32): **bold**, *italic* / _italic_, `code`, bullet lists,
// [label](https://…), bare http(s) URLs, fenced code blocks (``` or ~~~, with an optional language label; an unclosed
// fence runs to the end) and, with `headings`, `#` titles. Everything else, HTML included, stays text: React escapes
// it and no dangerouslySetInnerHTML is used anywhere. A fenced block's content is always plain text, never parsed.
//
// Linear time on hostile input: every pattern's body stops at the next delimiter of its kind (bold cannot contain
// "**", a link label cannot contain "[" or "]", a URL in parentheses cannot contain "(" or "["), so a failed attempt
// from an opener scans only up to the next opener; and `inline` remembers each rule's next match, re-running a rule
// only once the text before that match has been consumed.

/** `m[0]` is the whole match, then the capture groups. `trimEnd`: drop sentence punctuation from the end of the match. */
type Rule = { /** global: searched from `lastIndex` */ re: RegExp; trimEnd?: boolean; render: (m: [string, ...string[]], key: string, links: boolean) => ReactNode };

const SAFE_URL = /^https?:\/\/[^\s]+$/i;
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
/** Drops the sentence punctuation that ends a bare URL (a loop: an unanchored `[…]+$` is quadratic on long runs). */
function trimTrailing(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAILING.has(raw[end - 1]!)) end--;
  return raw.slice(0, end);
}

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
    const whole = rule.trimEnd ? trimTrailing(found[0]) : found[0];
    if (found.index > pos) out.push(text.slice(pos, found.index));
    out.push(rule.render([whole, ...found.slice(1)], `${keyPrefix}.${n++}`, links));
    pos = found.index + whole.length;
  }
  return out;
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'h'; level: number; text: string }
  | { kind: 'pre'; lang: string; lines: string[] };

// Line patterns end in `([^]*)$`, never `(.*)$`: `.` stops at a lone \r, U+2028 or U+2029 (the line split keeps them),
// and `(.*)$` would then fail and retry once per character of the run before it (quadratic). `[^]*` always reaches
// the end, so each pattern scans its line once.
const BULLET = /^\s*[-*+]\s+([^]*)$/;
const HEADING = /^(#{1,6})[ \t]+([^]*)$/;
/** A fence opener: up to 3 spaces, 3+ backticks or tildes, the info string (its first word is the language). */
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})([^]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** Drops a closing `##` run and trailing spaces (a loop, not a regex: linear on hostile input). */
function headingText(raw: string): string {
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === '#' || raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
  return raw.slice(0, end);
}

function blocks(text: string, headings: boolean): Block[] {
  const out: Block[] = [];
  let cur: Block | null = null;
  // The open fenced block: its fence character and length, the opener's indentation (removed from its lines).
  let fence: { ch: string; len: number; indent: number; block: { kind: 'pre'; lang: string; lines: string[] } } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) { fence = null; cur = null; continue; }
      let cut = 0;
      while (cut < fence.indent && line[cut] === ' ') cut++;
      fence.block.lines.push(line.slice(cut));
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string has no backtick (```code``` on one line is inline code).
    if (open && !(open[2]![0] === '`' && open[3]!.includes('`'))) {
      const block = { kind: 'pre' as const, lang: open[3]!.trim().split(' ')[0]!, lines: [] as string[] };
      out.push(block);
      fence = { ch: open[2]![0]!, len: open[2]!.length, indent: open[1]!.length, block };
      cur = null;
      continue;
    }
    const bullet = BULLET.exec(line);
    const heading = headings ? HEADING.exec(line) : null;
    if (!line.trim()) { cur = null; continue; }
    const title = heading ? headingText(heading[2]!) : '';
    if (heading && title) {
      out.push({ kind: 'h', level: heading[1]!.length, text: title });
      cur = null;
    } else if (bullet) {
      if (cur?.kind !== 'ul') { cur = { kind: 'ul', items: [] }; out.push(cur); }
      cur.items.push(bullet[1]!);
    } else {
      if (cur?.kind !== 'p') { cur = { kind: 'p', lines: [] }; out.push(cur); }
      cur.lines.push(line);
    }
  }
  return out;
}

export interface MarkdownProps {
  text: string;
  className?: string;
  /** `#` … `######` lines become headings (documents such as the brand guidelines); off for chat text. */
  headings?: boolean;
}

/** `#` → h3, `##` → h4, deeper → h5: documents are shown inside cards and dialogs that have their own h1/h2. */
const H = ['h3', 'h4', 'h5'] as const;

/** Safe Markdown renderer: see the comment at the top of the file for the supported subset. */
export function Markdown({ text, className, headings = false }: MarkdownProps) {
  return (
    <div className={cx('ms-md', className)}>
      {blocks(text, headings).map((b, i) => {
        if (b.kind === 'h') {
          const Tag = H[Math.min(b.level, 3) - 1]!;
          return <Tag key={i} className="ms-md-h">{inline(b.text, `${i}`)}</Tag>;
        }
        if (b.kind === 'pre') {
          return (
            <div key={i} className="ms-md-code">
              {b.lang ? <span className="ms-md-lang">{b.lang}</span> : null}
              <pre className="ms-md-pre"><code>{b.lines.join('\n')}</code></pre>
            </div>
          );
        }
        return b.kind === 'ul' ? (
          <ul key={i}>{b.items.map((item, j) => <li key={j}>{inline(item, `${i}.${j}`)}</li>)}</ul>
        ) : (
          <p key={i}>{b.lines.map((line, j) => <Fragment key={j}>{j > 0 ? <br /> : null}{inline(line, `${i}.${j}`)}</Fragment>)}</p>
        );
      })}
    </div>
  );
}
