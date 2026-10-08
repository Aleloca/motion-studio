import type { ServerMessage } from '@motion-studio/shared';
import { useEffect, useReducer } from 'react';
import { eventsReducer, initialEventsState, type EventsState } from './eventsReducer.ts';
import { uiToken } from './uiToken.ts';

export function useServerEvents(): EventsState {
  const [state, dispatch] = useReducer(eventsReducer, initialEventsState);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const token = uiToken();
      ws = new WebSocket(`${proto}://${location.host}/api/events${token ? `?t=${encodeURIComponent(token)}` : ''}`);
      ws.onmessage = (e) => {
        let msg: ServerMessage;
        try { msg = JSON.parse(String(e.data)) as ServerMessage; } catch { return; } // ignore malformed frames
        dispatch(msg);
      };
      // An error is followed by 'close' (which reconnects); closing explicitly covers sockets stuck after an error.
      ws.onerror = () => ws?.close();
      ws.onclose = () => { if (!stopped) retry = setTimeout(connect, 1000); };
    };
    connect();
    return () => { stopped = true; clearTimeout(retry); ws?.close(); };
  }, []);
  return state;
}
