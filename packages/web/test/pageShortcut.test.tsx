import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isActivePage, isSubmitChord, usePageShortcut } from '../src/motion/index.ts';

let platform: ReturnType<typeof vi.spyOn> | null = null;
const onPlatform = (name: 'MacIntel' | 'Win32') => { platform?.mockRestore(); platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(name); };
beforeEach(() => onPlatform('MacIntel'));
afterEach(() => { platform?.mockRestore(); platform = null; });

function Probe({ run }: { run: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  usePageShortcut(ref, (e) => e.key === 'Enter' && e.metaKey, run);
  return <div ref={ref} />;
}

describe('isActivePage / usePageShortcut', () => {
  it('only the active page counts; outside a page host everything does', () => {
    const page = document.createElement('div');
    page.className = 'ms-page';
    const child = page.appendChild(document.createElement('span'));
    document.body.appendChild(page);
    expect(isActivePage(child)).toBe(false);
    page.setAttribute('data-page-active', '');
    expect(isActivePage(child)).toBe(true);
    const loose = document.body.appendChild(document.createElement('span'));
    expect(isActivePage(loose)).toBe(true);
    expect(isActivePage(document.createElement('span'))).toBe(false); // detached
    expect(isActivePage(null)).toBe(false);
    page.remove(); loose.remove();
  });

  it('runs on the chord, not on a repeat, an already handled event or a leaving page', () => {
    const run = vi.fn();
    const { container } = render(<div className="ms-page" data-page-active=""><Probe run={run} /></div>);
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true, repeat: true });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(run).toHaveBeenCalledOnce();
    container.querySelector('.ms-page')!.removeAttribute('data-page-active');
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it('nested page hosts: every enclosing page must be active', () => {
    const outer = document.body.appendChild(document.createElement('div'));
    outer.className = 'ms-page';
    const inner = outer.appendChild(document.createElement('div'));
    inner.className = 'ms-page';
    const el = inner.appendChild(document.createElement('span'));
    // Outer leaving, inner active.
    inner.setAttribute('data-page-active', '');
    expect(isActivePage(el)).toBe(false);
    // Outer active, inner leaving.
    outer.setAttribute('data-page-active', '');
    inner.removeAttribute('data-page-active');
    expect(isActivePage(el)).toBe(false);
    // Both active.
    inner.setAttribute('data-page-active', '');
    expect(isActivePage(el)).toBe(true);
    outer.remove();
  });
});

describe('isSubmitChord', () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'Enter', ...init });
  it('⌘↵ on Mac only', () => {
    onPlatform('MacIntel');
    expect(isSubmitChord(ev({ metaKey: true }))).toBe(true);
    expect(isSubmitChord(ev({ ctrlKey: true }))).toBe(false);
    expect(isSubmitChord(ev({ metaKey: true, ctrlKey: true }))).toBe(false);
  });
  it('Ctrl+↵ elsewhere only', () => {
    onPlatform('Win32');
    expect(isSubmitChord(ev({ ctrlKey: true }))).toBe(true);
    expect(isSubmitChord(ev({ metaKey: true }))).toBe(false);
    expect(isSubmitChord(ev({ ctrlKey: true, metaKey: true }))).toBe(false);
  });
  it('never with Alt, while composing, or for another key', () => {
    expect(isSubmitChord(ev({ metaKey: true, altKey: true }))).toBe(false);
    expect(isSubmitChord(ev({ metaKey: true, isComposing: true }))).toBe(false);
    expect(isSubmitChord(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))).toBe(false);
  });
});
