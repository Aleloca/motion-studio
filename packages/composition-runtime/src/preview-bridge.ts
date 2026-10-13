import type { Composition } from '@motion-studio/shared';
import { parseIncoming, parseOutgoing, type PreviewOutgoing } from './protocol.ts';

/** What the bridge drives: the mounted player. */
export interface BridgePlayer {
  seek(t: number): Promise<unknown>;
  play(o: { loop: boolean; rate: number }): void;
  pause(): void;
  select(clipId: string | null): void;
  setScale(scale: number | 'fit'): void;
  setMuted(muted: boolean): void;
  /** A validated draft (a fresh copy, `parseIncoming`): re-mount it in place (runtime-main). */
  setComposition(composition: Composition, o: { keepTime: boolean; seq: number }): void;
}

export interface PreviewBridge {
  /** Handles one `message` event; ignores anything not from the parent at its origin, or not a known command. */
  handle(ev: { data: unknown; origin: string; source: unknown }): void;
  /** Posts a runtime message to the parent, at its origin only. Throws on a malformed message (a runtime bug). */
  post(msg: PreviewOutgoing): void;
}

export function createPreviewBridge(o: { parent: { postMessage(msg: unknown, targetOrigin: string): void }; parentOrigin: string; player: BridgePlayer }): PreviewBridge {
  return {
    handle(ev) {
      if (ev.origin !== o.parentOrigin || ev.source !== o.parent) return;
      const cmd = parseIncoming(ev.data);
      if (!cmd) return;
      switch (cmd.type) {
        case 'seek': o.player.seek(cmd.t).catch(() => {}); break; // failures are reported as error messages
        case 'play': o.player.play({ loop: cmd.loop ?? true, rate: cmd.rate ?? 1 }); break;
        case 'pause': o.player.pause(); break;
        case 'select': o.player.select(cmd.clipId); break;
        case 'setScale': o.player.setScale(cmd.scale); break;
        case 'mute': o.player.setMuted(cmd.muted); break;
        case 'setComposition': o.player.setComposition(cmd.composition, { keepTime: cmd.keepTime ?? false, seq: cmd.seq }); break;
      }
    },
    post(msg) {
      if (!parseOutgoing(msg)) throw new Error(`preview bridge: malformed outgoing message ${String((msg as { type?: unknown }).type)}`);
      o.parent.postMessage(msg, o.parentOrigin);
    },
  };
}
