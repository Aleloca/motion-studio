export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  pickFolder(title: string, defaultPath?: string): Promise<string | null>;
  revealPath(path: string): Promise<void>;
  /** Native notification from the main process (spec §6.3). Missing in desktop builds older than Phase 7. */
  notify?(p: { title: string; body: string }): Promise<void>;
  /** Dock badge with the pending approvals (0 clears it); the Dock bounces once when it grows. */
  setBadge?(n: number): Promise<void>;
}

/** The Electron preload bridge, or null in a plain browser (or when the bridge is malformed). */
export function desktop(): DesktopBridge | null {
  const b = (window as unknown as { motionStudio?: Partial<DesktopBridge> }).motionStudio;
  return b?.isDesktop === true && typeof b.pickFolder === 'function' && typeof b.revealPath === 'function' ? (b as DesktopBridge) : null;
}
