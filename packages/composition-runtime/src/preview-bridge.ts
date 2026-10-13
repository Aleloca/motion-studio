import type { Composition } from '@motion-studio/shared';
import { parseIncoming, parseOutgoing, type DraftParser, type PreviewOutgoing } from './protocol.ts';

/** Where `preview.js` puts the draft parser on the runtime's window (entry/preview.ts). */
export const DRAFT_PARSER_KEY = '__msDraft';

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
  /** The draft parser is loaded (`preview.js`): a draft that came before it is handled now (the latest one only). */
  parserReady(): void;
}

/**
 * `parseDraft` gives the draft parser once `preview.js` has loaded (undefined before). A `setComposition` from the parent
 * that arrives earlier is kept, the latest only and still unparsed, until `parserReady()`.
 */
export function createPreviewBridge(o: {
  parent: { postMessage(msg: unknown, targetOrigin: string): void }; parentOrigin: string; player: BridgePlayer; parseDraft?: () => DraftParser | undefined;
}): PreviewBridge {
  let early: unknown = null;
  const handle = (ev: { data: unknown; origin: string; source: unknown }) => {
    if (ev.origin !== o.parentOrigin || ev.source !== o.parent) return;
    const parser = o.parseDraft?.();
    if (!parser && (ev.data as { type?: unknown } | null)?.type === 'setComposition') { early = ev.data; return; }
    const cmd = parseIncoming(ev.data, parser);
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
  };
  return {
    handle,
    post(msg) {
      if (!parseOutgoing(msg)) throw new Error(`preview bridge: malformed outgoing message ${String((msg as { type?: unknown }).type)}`);
      o.parent.postMessage(msg, o.parentOrigin);
    },
    parserReady() {
      if (early === null) return;
      const data = early;
      early = null;
      handle({ data, origin: o.parentOrigin, source: o.parent });
    },
  };
}
