import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';
import { Modal, Popover, Select, Toasts, toast } from '../src/ui/index.ts';
import { __resetToasts } from '../src/ui/toast.tsx';

const en = (ui: ReactNode) => render(<I18nProvider locale="en">{ui}</I18nProvider>);

/* A controllable Web Animations stub: each animate() returns an animation the test finishes or that enter() cancels. */
class FakeAnim {
  cancelled = false;
  done = false;
  constructor(readonly holds: boolean) { this.finished = new Promise((r, j) => { this.res = () => r(undefined); this.rej = () => j(new Error('cancelled')); }); }
  finished: Promise<unknown>;
  private res!: () => void;
  private rej!: () => void;
  cancel() { if (!this.cancelled && !this.done) { this.cancelled = true; this.rej(); } }
  finish() { this.done = true; this.res(); }
}
const live = new Map<Element, FakeAnim[]>();
const origAnimate = Element.prototype.animate;
const origGetAnimations = Element.prototype.getAnimations;
function stubAnimations() {
  Element.prototype.animate = function (this: Element, _frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const fake = new FakeAnim(opts.fill === 'forwards');
    live.set(this, [...(live.get(this) ?? []), fake]);
    return fake as unknown as Animation;
  } as never;
  Element.prototype.getAnimations = function (this: Element) {
    // Like the browser: a finished animation is gone unless it holds its end state (fill: forwards, i.e. an exit).
    return (live.get(this) ?? []).filter((a) => !a.cancelled && (!a.done || a.holds)) as unknown as Animation[];
  } as never;
}
const finishAll = async () => {
  await act(async () => { for (const list of live.values()) for (const a of list) if (!a.cancelled && !a.done) a.finish(); });
};

beforeEach(() => { live.clear(); __resetToasts(); });
afterEach(() => {
  Element.prototype.animate = origAnimate;
  Element.prototype.getAnimations = origGetAnimations;
  vi.useRealTimers();
});

function PopoverDemo({ under }: { under?: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={anchor} onClick={() => setOpen((o) => !o)}>Menu</button>
      <button onClick={under}>Elsewhere</button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor}>
        <button>First item</button>
        <button>Second item</button>
      </Popover>
    </div>
  );
}

function ModalDemo() {
  const [open, setOpen] = useState(false);
  const [pop, setPop] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open modal</button>
      <button>Beneath</button>
      <Modal open={open} onClose={() => setOpen(false)} label="Export">
        <p>Dialog body</p>
        <button ref={anchor} onClick={() => setPop((p) => !p)}>Formats</button>
        <Popover open={pop} onClose={() => setPop(false)} anchor={anchor}>
          <button>MP4</button>
        </Popover>
      </Modal>
    </div>
  );
}

const esc = (target: Element = document.activeElement ?? document.body) => fireEvent.keyDown(target, { key: 'Escape' });
const pointer = (el: Element) => { fireEvent.pointerDown(el); fireEvent.mouseDown(el); fireEvent.click(el); };

describe('Popover', () => {
  it('opens in a body portal, focuses inside, closes on Esc and returns focus to the anchor', async () => {
    const { container } = render(<PopoverDemo />);
    const anchor = screen.getByRole('button', { name: 'Menu' });
    anchor.focus();
    fireEvent.click(anchor);
    const item = screen.getByRole('button', { name: 'First item' });
    expect(container.contains(item)).toBe(false);
    expect(document.body.contains(item)).toBe(true);
    expect(document.activeElement).toBe(item);
    await act(async () => { esc(); });
    expect(screen.queryByRole('button', { name: 'First item' })).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it('closes on an outside pointer down but not on one inside or on the anchor toggle', async () => {
    const under = vi.fn();
    render(<PopoverDemo under={under} />);
    const anchor = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(anchor);
    pointer(screen.getByRole('button', { name: 'Second item' }));
    expect(screen.getByRole('button', { name: 'Second item' })).toBeTruthy();
    await act(async () => { pointer(anchor); });
    expect(screen.queryByRole('button', { name: 'Second item' })).toBeNull();
    fireEvent.click(anchor);
    await act(async () => { pointer(screen.getByRole('button', { name: 'Elsewhere' })); });
    expect(screen.queryByRole('button', { name: 'Second item' })).toBeNull();
  });

  it('clicks inside the popover do not bubble to React ancestors of the portal', () => {
    const parent = vi.fn();
    render(<div onClick={parent}><PopoverDemo /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    parent.mockClear();
    pointer(screen.getByRole('button', { name: 'First item' }));
    expect(parent).not.toHaveBeenCalled();
  });

  it('flips above the anchor and caps its height when the space below is short', () => {
    const h = window.innerHeight;
    window.innerHeight = 600;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.textContent === 'Menu' ? { left: 20, right: 120, top: 540, bottom: 570, width: 100, height: 30 } : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    });
    try {
      render(<PopoverDemo />);
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
      const pop = document.querySelector<HTMLElement>('.ms-pop')!;
      expect(pop.style.top).toBe('');
      expect(pop.style.bottom).toBe(`${600 - 540 + 6}px`);
      expect(pop.style.maxHeight).toBe(`${540 - 6 - 8}px`);
      expect(pop.style.transformOrigin).toBe('bottom left');
    } finally {
      rect.mockRestore();
      window.innerHeight = h;
    }
  });

  it('stays below with a capped height when there is room', () => {
    const h = window.innerHeight;
    window.innerHeight = 600;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.textContent === 'Menu' ? { left: 20, right: 120, top: 40, bottom: 70, width: 100, height: 30 } : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
    });
    try {
      render(<PopoverDemo />);
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
      const pop = document.querySelector<HTMLElement>('.ms-pop')!;
      expect(pop.style.top).toBe('76px');
      expect(pop.style.maxHeight).toBe(`${600 - 76 - 8}px`);
    } finally {
      rect.mockRestore();
      window.innerHeight = h;
    }
  });

  it('keeps Tab inside (light focus trap)', () => {
    render(<PopoverDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const second = screen.getByRole('button', { name: 'Second item' });
    second.focus();
    fireEvent.keyDown(second, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First item' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(second);
  });

  it('survives open → close → open during the exit animation, and is removed after a finished exit', async () => {
    stubAnimations();
    render(<PopoverDemo />);
    const anchor = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(anchor);
    await finishAll();
    await act(async () => { fireEvent.click(anchor); }); // close: exit animation pending
    expect(screen.getByRole('button', { name: 'First item' })).toBeTruthy();
    await act(async () => { fireEvent.click(anchor); }); // reopen during the exit
    await finishAll();
    const item = screen.getByRole('button', { name: 'First item' });
    expect(item).toBeTruthy();
    const pop = item.closest('.ms-pop')!;
    expect((pop as HTMLElement).getAnimations().length).toBe(0); // no exit left holding it invisible
    await act(async () => { fireEvent.click(anchor); });
    await finishAll();
    expect(screen.queryByRole('button', { name: 'First item' })).toBeNull();
  });
});

describe('Modal', () => {
  it('is a labelled modal dialog in a body portal with the --scrim token', () => {
    render(<ModalDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Open modal' }));
    const dialog = screen.getByRole('dialog', { name: 'Export' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('.ms-scrim')).not.toBeNull();
  });

  it('closes on a scrim click, and returns focus to the opener', async () => {
    render(<ModalDemo />);
    const opener = screen.getByRole('button', { name: 'Open modal' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    await act(async () => { pointer(document.querySelector('.ms-scrim')!); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('clicks on the scrim or inside the dialog do not bubble to React ancestors of the portal', async () => {
    const parent = vi.fn();
    render(<div onClick={parent}><ModalDemo /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Open modal' }));
    parent.mockClear();
    pointer(screen.getByText('Dialog body'));
    await act(async () => { pointer(document.querySelector('.ms-scrim')!); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(parent).not.toHaveBeenCalled();
  });

  it('pulls focus back into the dialog: Tab from body, and focus moving to the page behind', () => {
    render(<ModalDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Open modal' }));
    const dialog = screen.getByRole('dialog');
    act(() => { (document.activeElement as HTMLElement).blur(); });
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => { (document.activeElement as HTMLElement).blur(); });
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => { screen.getByRole('button', { name: 'Beneath', hidden: true }).focus(); });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Tab skips focusables inside hidden or inert containers', () => {
    render(
      <Modal open onClose={() => {}} label="H">
        <button>One</button>
        <button>Two</button>
        <div hidden><button>Hidden</button></div>
        <div inert><button>Inert</button></div>
      </Modal>,
    );
    const two = screen.getByRole('button', { name: 'Two' });
    act(() => { two.focus(); });
    fireEvent.keyDown(two, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'One' }));
  });

  it('returns focus to the menu anchor when the opener (a menu item) has gone', async () => {
    function MenuToModal() {
      const [menu, setMenu] = useState(false);
      const [modal, setModal] = useState(false);
      const a = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={a} onClick={() => setMenu((m) => !m)}>More</button>
          <Popover open={menu} onClose={() => setMenu(false)} anchor={a}>
            <button onClick={() => { setMenu(false); setModal(true); }}>Export…</button>
          </Popover>
          <Modal open={modal} onClose={() => setModal(false)} label="Export"><button>Done</button></Modal>
        </>
      );
    }
    render(<MenuToModal />);
    const more = screen.getByRole('button', { name: 'More' });
    act(() => { more.focus(); });
    fireEvent.click(more);
    const item = screen.getByRole('button', { name: 'Export…' });
    expect(document.activeElement).toBe(item);
    await act(async () => { fireEvent.click(item); });
    expect(screen.queryByRole('button', { name: 'Export…' })).toBeNull();
    await act(async () => { esc(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('restores focus when unmounted while open', () => {
    function Host() {
      const [on, setOn] = useState(false);
      return <><button onClick={() => setOn(true)}>Go</button>{on ? <Modal open onClose={() => {}} label="U"><button onClick={() => setOn(false)}>Leave</button></Modal> : null}</>;
    }
    render(<Host />);
    const go = screen.getByRole('button', { name: 'Go' });
    act(() => { go.focus(); });
    fireEvent.click(go);
    const leave = screen.getByRole('button', { name: 'Leave' });
    expect(document.activeElement).toBe(leave);
    act(() => { fireEvent.click(leave); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(go);
  });

  it('does not close on a click inside the dialog', () => {
    render(<ModalDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Open modal' }));
    pointer(screen.getByText('Dialog body'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes on Esc and traps Tab', async () => {
    render(<ModalDemo />);
    const opener = screen.getByRole('button', { name: 'Open modal' });
    opener.focus();
    fireEvent.click(opener);
    const formats = screen.getByRole('button', { name: 'Formats' });
    formats.focus();
    fireEvent.keyDown(formats, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    await act(async () => { esc(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('with a popover open inside: the first Esc closes only the popover, the second the modal', async () => {
    render(<ModalDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Open modal' }));
    const formats = screen.getByRole('button', { name: 'Formats' });
    formats.focus();
    fireEvent.click(formats);
    expect(screen.getByRole('button', { name: 'MP4' })).toBeTruthy();
    await act(async () => { esc(); });
    expect(screen.queryByRole('button', { name: 'MP4' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(formats);
    await act(async () => { esc(); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the modal below its popover when both open in the same commit (child effects run first)', async () => {
    function Both() {
      const [m, setM] = useState(true);
      const [p, setP] = useState(true);
      const a = useRef<HTMLButtonElement>(null);
      return (
        <Modal open={m} onClose={() => setM(false)} label="Both">
          <button ref={a}>Anchor</button>
          <Popover open={p} onClose={() => setP(false)} anchor={a}><button>Inner</button></Popover>
        </Modal>
      );
    }
    render(<Both />);
    await act(async () => { esc(); });
    expect(screen.queryByRole('button', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Both' })).toBeTruthy();
  });

  it('an outside click that closes a popover inside the modal does not close the modal', async () => {
    render(<ModalDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Open modal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Formats' }));
    await act(async () => { pointer(document.querySelector('.ms-scrim')!); });
    expect(screen.queryByRole('button', { name: 'MP4' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => { pointer(document.querySelector('.ms-scrim')!); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a click inside the dialog closes its popover but not the modal', async () => {
    render(<ModalDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Open modal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Formats' }));
    await act(async () => { pointer(screen.getByText('Dialog body')); });
    expect(screen.queryByRole('button', { name: 'MP4' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('survives open → close → open during the exit animation', async () => {
    stubAnimations();
    function Ctl() {
      const [open, setOpen] = useState(true);
      return <><button onClick={() => setOpen((o) => !o)}>Toggle</button><Modal open={open} onClose={() => setOpen(false)} label="M">x</Modal></>;
    }
    render(<Ctl />);
    await finishAll();
    const toggle = screen.getByRole('button', { name: 'Toggle' });
    await act(async () => { fireEvent.click(toggle); });
    expect(screen.getByRole('dialog', { hidden: true })).toBeTruthy();
    await act(async () => { fireEvent.click(toggle); });
    await finishAll();
    expect(screen.getByRole('dialog', { name: 'M' })).toBeTruthy();
    expect(screen.getByRole('dialog').getAnimations().length).toBe(0);
    await act(async () => { fireEvent.click(toggle); });
    await finishAll();
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });
});

describe('Select', () => {
  const opts = [{ value: 'mp4', label: 'MP4' }, { value: 'webm', label: 'WebM' }, { value: 'gif', label: 'GIF' }] as const;
  function SelectDemo({ onChange }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState<'mp4' | 'webm' | 'gif'>('mp4');
    return <Select label="Format" value={v} options={[...opts]} onChange={(x) => { setV(x); onChange?.(x); }} />;
  }

  it('shows the value on a labelled trigger and opens a listbox with aria-selected options', () => {
    render(<SelectDemo />);
    const trigger = screen.getByRole('button', { name: /Format/ });
    expect(trigger.textContent).toContain('MP4');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox', { name: 'Format' });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
  });

  it('chooses with the arrows and Enter, then returns focus to the trigger', async () => {
    const onChange = vi.fn();
    render(<SelectDemo onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /Format/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'WebM' }).id);
    await act(async () => { fireEvent.keyDown(list, { key: 'Enter' }); });
    expect(onChange).toHaveBeenCalledWith('webm');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.textContent).toContain('WebM');
    expect(document.activeElement).toBe(trigger);
  });

  it('chooses with a click', async () => {
    const onChange = vi.fn();
    render(<SelectDemo onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Format/ }));
    await act(async () => { pointer(screen.getByRole('option', { name: 'GIF' })); });
    expect(onChange).toHaveBeenCalledWith('gif');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Esc closes without choosing and restores focus', async () => {
    const onChange = vi.fn();
    render(<SelectDemo onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /Format/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    await act(async () => { esc(); });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Toasts', () => {
  const region = () => screen.getByRole('status');
  const visible = () => [...document.querySelectorAll('.ms-toast:not([aria-hidden])')].map((t) => t.querySelector('.ms-toast-text')!.textContent);

  it('has one persistent polite status region, empty with no toasts', () => {
    en(<Toasts />);
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(region().textContent).toBe('');
    act(() => { toast.show('Hi'); });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(region().textContent).toContain('Hi');
  });

  it('shows a toast inside the status region with an action that runs and dismisses it', async () => {
    en(<Toasts />);
    const run = vi.fn();
    act(() => { toast.show('Approval needed', { action: { label: 'Review', run } }); });
    expect(region().textContent).toContain('Approval needed');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review' })); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(visible()).toEqual([]);
  });

  it('still dismisses when the action throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    en(<Toasts />);
    act(() => { toast.show('Boom', { action: { label: 'Undo', run: () => { throw new Error('nope'); } } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(visible()).toEqual([]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('auto-dismisses after ms (fake timers) and supports manual dismiss', async () => {
    vi.useFakeTimers();
    en(<Toasts />);
    act(() => { toast.show('Saved', { tone: 'ok', ms: 1000 }); });
    expect(visible()).toEqual(['Saved']);
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(visible()).toEqual(['Saved']);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(visible()).toEqual([]);
    let id = 0;
    act(() => { id = toast.show('Later', { ms: 60_000 }); });
    await act(async () => { toast.dismiss(id); });
    expect(visible()).toEqual([]);
  });

  it('pauses while hovered or focused and resumes with the remaining time', async () => {
    vi.useFakeTimers();
    en(<Toasts />);
    act(() => { toast.show('Hover me', { ms: 1000, action: { label: 'Open', run() {} } }); });
    const el = document.querySelector('.ms-toast')!;
    await act(async () => { vi.advanceTimersByTime(400); });
    fireEvent.pointerEnter(el);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(visible()).toEqual(['Hover me']);
    fireEvent.pointerLeave(el);
    await act(async () => { vi.advanceTimersByTime(599); });
    expect(visible()).toEqual(['Hover me']);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(visible()).toEqual([]);

    act(() => { toast.show('Focus me', { ms: 1000, action: { label: 'Go', run() {} } }); });
    const btn = screen.getByRole('button', { name: 'Go' });
    act(() => { btn.focus(); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(visible()).toEqual(['Focus me']);
    act(() => { btn.blur(); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(visible()).toEqual([]);
  });

  it('keeps a sticky toast until dismissed', async () => {
    vi.useFakeTimers();
    en(<Toasts />);
    let id = 0;
    act(() => { id = toast.show('Stays', { sticky: true, action: { label: 'Review', run() {} } }); });
    await act(async () => { vi.advanceTimersByTime(600_000); });
    expect(visible()).toEqual(['Stays']);
    await act(async () => { toast.dismiss(id); });
    expect(visible()).toEqual([]);
  });

  it('caps the visible stack at 3, dropping the oldest', async () => {
    en(<Toasts />);
    await act(async () => { for (let i = 1; i <= 6; i++) toast.show(`T${i}`); });
    expect(visible()).toEqual(['T4', 'T5', 'T6']);
  });

  it('renders into a body portal; the neutral tone carries no accent', () => {
    const { container } = en(<Toasts />);
    act(() => { toast.show('Hi'); });
    expect(container.contains(region())).toBe(false);
    const css = readFileSync(resolve(import.meta.dirname, '../src/ui/ui.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.includes('ms-toast'));
    expect(rules.length).toBeGreaterThan(0);
    // No orange fill on a toast; the action text may use the AA --accentText (checked in ui-basic).
    for (const r of rules) expect(r[2], r[1]).not.toMatch(/var\(--accent\)|var\(--onAccent/);
  });
});

describe('overlay class names', () => {
  it('every class an overlay component emits is ms- prefixed', () => {
    function All() {
      const a = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={a}>a</button>
          <Popover open onClose={() => {}} anchor={a} placement="bottom-end" width={200}><span>p</span></Popover>
          <Select label="S" value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />
          <Modal open onClose={() => {}} label="M" width={500}>m</Modal>
          <Toasts />
        </>
      );
    }
    en(<All />);
    act(() => { toast.show('ok', { tone: 'ok', action: { label: 'Undo', run() {} } }); toast.show('n'); });
    fireEvent.click(screen.getByRole('button', { name: /^S/ }));
    const tokens = new Set<string>();
    for (const el of document.body.querySelectorAll('[class]')) for (const c of (el.getAttribute('class') ?? '').split(/\s+/)) if (c) tokens.add(c);
    expect([...tokens].filter((c) => !c.startsWith('ms-'))).toEqual([]);
  });
});
