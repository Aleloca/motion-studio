import { shownTotal, type ServerMessage } from '@motion-studio/shared';
import { useEffect, useReducer } from 'react';
import { api } from './api.ts';
import { eventsReducer, initialEventsState, type EventsState } from './eventsReducer.ts';
import { localDay, localMidnightIso, msToMidnight } from './usageLive.ts';
import { onUiTokenChange, pairingNeeded, uiToken } from './uiToken.ts';

export function useServerEvents(): EventsState {
  const [state, dispatch] = useReducer(eventsReducer, initialEventsState);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let midnight: ReturnType<typeof setTimeout> | undefined;
    // Today's token total from the ledger (spec §5.4): after every snapshot (startup and each reconnection) and at
    // local midnight. Only the latest request's answer is applied; a failure leaves the total as it was (unknown at
    // first: the top bar shows "—", never a made-up 0).
    let usageSeq = 0;
    const fetchToday = () => {
      const seq = ++usageSeq;
      const now = new Date();
      const day = localDay(now);
      Promise.resolve().then(() => api.getUsage({ from: localMidnightIso(now) }))
        .then((r) => { if (!stopped && seq === usageSeq) dispatch({ type: 'usage-today', day, tokens: shownTotal(r.total.tokens), billing: r.billing }); })
        .catch(() => { /* unknown stays unknown */ });
      clearTimeout(midnight);
      midnight = setTimeout(fetchToday, msToMidnight(now) + 1000);
    };
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const token = uiToken();
      const socket = new WebSocket(`${proto}://${location.host}/api/events${token ? `?t=${encodeURIComponent(token)}` : ''}`);
      ws = socket;
      socket.onmessage = (e) => {
        let msg: ServerMessage;
        try { msg = JSON.parse(String(e.data)) as ServerMessage; } catch { return; } // ignore malformed frames
        dispatch(msg);
        if (msg.type === 'snapshot') fetchToday();
      };
      // An error is followed by 'close' (which reconnects); closing explicitly covers sockets stuck after an error.
      socket.onerror = () => socket.close();
      // Without a valid token retrying is pointless: a new token (pasted link) reconnects instead.
      socket.onclose = () => { if (!stopped && ws === socket && !pairingNeeded()) retry = setTimeout(connect, 1000); };
    };
    connect();
    const off = onUiTokenChange(() => {
      if (stopped) return;
      clearTimeout(retry);
      const old = ws;
      ws = null;
      old?.close();
      connect();
    });
    return () => { stopped = true; off(); clearTimeout(retry); clearTimeout(midnight); ws?.close(); };
  }, []);
  return state;
}
