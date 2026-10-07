import type { ServerMessage } from '@motion-studio/shared';
import { useEffect, useReducer } from 'react';
import { eventsReducer, initialEventsState, type EventsState } from './eventsReducer.ts';

export function useServerEvents(): EventsState {
  const [state, dispatch] = useReducer(eventsReducer, initialEventsState);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/events`);
      ws.onmessage = (e) => dispatch(JSON.parse(String(e.data)) as ServerMessage);
      ws.onclose = () => { if (!stopped) retry = setTimeout(connect, 1000); };
    };
    connect();
    return () => { stopped = true; clearTimeout(retry); ws?.close(); };
  }, []);
  return state;
}
