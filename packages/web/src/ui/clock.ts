// Playback time as a small store: only the parts that show the playhead (the transport, the comment layer, the hint)
// read it, so a page does not re-render at frame rate while a video plays.
import { useSyncExternalStore } from 'react';

/**
 * `time` follows the picture (every frame while playing); `settled` changes only on a seek, a pause or the media's
 * `timeupdate` (what assistive technology is told).
 */
export interface ClockState { time: number; settled: number }
export interface Clock { get(): ClockState; set(time: number, settled: boolean): void; subscribe(l: () => void): () => void }

export function createClock(): Clock {
  let state: ClockState = { time: 0, settled: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(time, settled) {
      if (state.time === time && (!settled || state.settled === time)) return;
      state = { time, settled: settled ? time : state.settled };
      for (const l of listeners) l();
    },
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}

export const useClock = (clock: Clock) => useSyncExternalStore(clock.subscribe, clock.get, clock.get);
