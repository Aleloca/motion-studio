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

function ModalDemo({ under }: { under?: () => void }) {
  const [open, setOpen] = useState(false);
  const [pop, setPop] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open modal</button>
      <button onClick={under}>Beneath</button>
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

  it('closes on a scrim click without passing it through, and returns focus to the opener', async () => {
    const under = vi.fn();
    render(<ModalDemo under={under} />);
    const opener = screen.getByRole('button', { name: 'Open modal' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    await act(async () => { pointer(document.querySelector('.ms-scrim')!); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(under).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
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
  it('shows a status toast with an action that runs and dismisses it', async () => {
    en(<Toasts />);
    const run = vi.fn();
    act(() => { toast.show('Approval needed', { action: { label: 'Review', run } }); });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Approval needed');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review' })); });
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('auto-dismisses after ms (fake timers) and supports manual dismiss', async () => {
    vi.useFakeTimers();
    en(<Toasts />);
    act(() => { toast.show('Saved', { tone: 'ok', ms: 1000 }); });
    expect(screen.getByRole('status').textContent).toContain('Saved');
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(screen.queryByRole('status')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('status')).toBeNull();
    let id = 0;
    act(() => { id = toast.show('Sticky-ish', { ms: 60_000 }); });
    await act(async () => { toast.dismiss(id); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('caps the visible stack at 3, dropping the oldest', async () => {
    en(<Toasts />);
    await act(async () => { for (let i = 1; i <= 6; i++) toast.show(`T${i}`); });
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toEqual(['T4', 'T5', 'T6']);
  });

  it('renders into a body portal', () => {
    const { container } = en(<Toasts />);
    act(() => { toast.show('Hi'); });
    expect(container.contains(screen.getByRole('status'))).toBe(false);
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
