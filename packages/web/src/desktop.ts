/** What the system did with a desktop notification (apps/desktop/src/notify.ts). */
export type DesktopNotifyOutcome = { shown: true } | { shown: false; reason: 'failed' | 'timeout' | 'unsupported'; detail?: string };

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  pickFolder(title: string, defaultPath?: string): Promise<string | null>;
  revealPath(path: string): Promise<void>;
  /**
   * Native notification from the main process (spec §6.3), answering what the system did with it. Missing in desktop
   * builds older than Phase 7; builds older than this outcome answer nothing (undefined).
   */
  notify?(p: { title: string; body: string; sound?: boolean }): Promise<DesktopNotifyOutcome | undefined | void>;
  /** Whether the main process can show notifications at all. Missing in older desktop builds. */
  notifyStatus?(): Promise<{ supported: boolean }>;
  /** Dock badge with the pending approvals (0 clears it); the Dock bounces once when it grows. */
  setBadge?(n: number): Promise<void>;
  /** Calls `cb` when one of the app's native notifications is clicked; returns the unsubscribe. Missing before Phase 7. */
  onAttentionClick?(cb: () => void): () => void;
}

/** The Electron preload bridge, or null in a plain browser (or when the bridge is malformed). */
export function desktop(): DesktopBridge | null {
  const b = (window as unknown as { motionStudio?: Partial<DesktopBridge> }).motionStudio;
  return b?.isDesktop === true && typeof b.pickFolder === 'function' && typeof b.revealPath === 'function' ? (b as DesktopBridge) : null;
}
