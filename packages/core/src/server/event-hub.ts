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

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.sockets) if (s.readyState === OPEN) s.send(data);
  }
}
