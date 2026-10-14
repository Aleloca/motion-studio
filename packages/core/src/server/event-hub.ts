import type { ServerMessage } from '@motion-studio/shared';

export interface WebSocketLike {
  send(data: string): void;
  readonly readyState: number;
  on(event: 'close', cb: () => void): void;
}

const OPEN = 1;

export class EventHub {
  private readonly sockets = new Set<WebSocketLike>();

  add(socket: WebSocketLike): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  send(socket: WebSocketLike, msg: ServerMessage): void {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(msg));
  }

  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  /** Also tells `fn` every message broadcast (e.g. the project activity a localize turn reads). */
  listen(fn: (msg: ServerMessage) => void): void { this.listeners.add(fn); }

  broadcast(msg: ServerMessage): void {
    for (const fn of this.listeners) { try { fn(msg); } catch { /* a listener never stops the broadcast */ } }
    const data = JSON.stringify(msg);
    for (const s of this.sockets) if (s.readyState === OPEN) s.send(data);
  }
}
