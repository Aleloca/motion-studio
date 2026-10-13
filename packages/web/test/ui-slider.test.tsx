import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Slider } from '../src/ui/index.ts';

if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}

const rect = (el: HTMLElement) => vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20, x: 0, y: 0, toJSON() {} });

describe('Slider', () => {
  it('exposes role, values and text, and keys move by step, page, home and end', () => {
    const onChange = vi.fn();
    render(<Slider label="Zoom" min={0} max={100} step={5} value={50} valueText="half" onChange={onChange} />);
    const s = screen.getByRole('slider', { name: 'Zoom' });
    expect([s.getAttribute('aria-valuemin'), s.getAttribute('aria-valuemax'), s.getAttribute('aria-valuenow'), s.getAttribute('aria-valuetext')]).toEqual(['0', '100', '50', 'half']);
    for (const [key, to] of [['ArrowRight', 55], ['ArrowLeft', 45], ['PageUp', 100], ['PageDown', 0], ['Home', 0], ['End', 100]] as const) {
      fireEvent.keyDown(s, { key });
      expect(onChange).toHaveBeenLastCalledWith(to);
    }
  });
  it('a disabled slider ignores keys and the pointer', () => {
    const onChange = vi.fn();
    render(<Slider label="Z" min={0} max={10} value={5} disabled onChange={onChange} />);
    const s = screen.getByRole('slider');
    fireEvent.keyDown(s, { key: 'ArrowRight' });
    fireEvent.pointerDown(s, { clientX: 10, button: 0 });
    expect(onChange).not.toHaveBeenCalled();
    expect(s.getAttribute('tabindex')).toBe('-1');
  });
  it('the pointer sets the value from the position, snapped to the step, and a drag keeps calling the LATEST onChange', () => {
    const calls: string[] = [];
    function Host() {
      const [v, setV] = useState(0);
      // A new function every render, closing over the value of that render.
      return <Slider label="Z" min={0} max={100} step={10} value={v} onChange={(n) => { calls.push(`${v}->${n}`); setV(n); }} />;
    }
    render(<Host />);
    const s = screen.getByRole('slider');
    rect(s);
    fireEvent.pointerDown(s, { clientX: 100, button: 0, pointerId: 1 });
    expect(s.getAttribute('aria-valuenow')).toBe('50');
    fireEvent.pointerMove(window, { clientX: 160, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 200, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(calls).toEqual(['0->50', '50->80', '80->100']);
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });
    expect(s.getAttribute('aria-valuenow')).toBe('100');
  });
});
