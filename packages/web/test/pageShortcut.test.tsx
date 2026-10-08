import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { isActivePage, usePageShortcut } from '../src/motion/index.ts';

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
});
