import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n.tsx';
import { useEnter } from '../motion/index.ts';
import { isMac } from '../platform.ts';
import { Button, Icon } from '../ui/index.ts';
import './pairing.css';

/** Prints the address of the running Motion Studio again (apps/cli `--print-url`). */
export const PRINT_URL_COMMAND = 'npx @motion-studio/cli --print-url';
const COPIED_MS = 1600;

/** Selects the text of `el`, so the user can copy it by hand. */
function selectText(el: HTMLElement | null) {
  const sel = window.getSelection();
  if (!el || !sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * The page shown when the server refuses the UI token (spec §6.2 #2): open the app from the terminal link, or print it
 * again with the copyable `--print-url` command. The desktop line is static text, not a link: the server's 401 says
 * nothing about a desktop app being installed.
 */
export function Pairing() {
  const t = useT();
  const p = t.web.pairing;
  const root = useEnter<HTMLDivElement>([]);
  const command = useRef<HTMLElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(PRINT_URL_COMMAND);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), COPIED_MS);
    } catch {
      // No clipboard (insecure context, denied permission): select the command and say how to copy it.
      selectText(command.current);
      setState('manual');
    }
  };

  return (
    <div className="ms-pairing">
      <div className="ms-pairing-col" ref={root}>
        <div className="ms-pairing-brand" data-enter>
          <span className="ms-logo" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 2.5v7l6-3.5-6-3.5Z" /></svg></span>
          <b>Motion Studio</b>
        </div>
        <div className="ms-pairing-head" data-enter>
          <h1>{p.title}</h1>
          <p role="alert">{p.body}</p>
        </div>
        <figure className="ms-term" data-enter aria-label={p.terminalExample}>
          <div className="ms-term-bar" aria-hidden="true">
            <span className="ms-term-dot" /><span className="ms-term-dot" /><span className="ms-term-dot" />
            <span className="ms-term-title">{p.terminal}</span>
          </div>
          <div className="ms-term-body">
            <div><span className="ms-term-dim">$</span> npx @motion-studio/cli</div>
            <div className="ms-term-dim">{p.running}</div>
            <div>{p.open} <span className="ms-term-link">{location.origin}/#t=•••••••••••</span></div>
          </div>
        </figure>
        <section className="ms-pairing-card" data-enter aria-labelledby="ms-pairing-lost">
          <b id="ms-pairing-lost">{p.lostTitle}</b>
          <span className="ms-pairing-muted">{p.lostBody}</span>
          <div className="ms-pairing-cmd">
            <code ref={command}>{PRINT_URL_COMMAND}</code>
            {/* The visible "Copy" / "Copied" is the accessible name; the status line below announces the result. */}
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              <Icon name={state === 'copied' ? 'check' : 'copy'} size={13} strokeWidth={state === 'copied' ? 2 : 1.4} />
              {state === 'copied' ? p.copied : p.copy}
            </Button>
          </div>
          <p className={state === 'manual' ? 'ms-pairing-hint' : 'ms-pairing-hint ms-sr'} role="status">
            {state === 'manual' ? p.copyFallback({ keys: isMac() ? '⌘C' : 'Ctrl+C' }) : state === 'copied' ? p.copiedStatus : ''}
          </p>
        </section>
        {/* Static copy (prototype): the desktop app opens with its own key and never shows this page. */}
        <span className="ms-pairing-desktop" data-enter>{p.desktopHint}</span>
      </div>
    </div>
  );
}
