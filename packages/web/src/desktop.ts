export interface DesktopBridge { isDesktop: true; platform: string; pickFolder(title: string, defaultPath?: string): Promise<string | null>; revealPath(path: string): Promise<void> }

/** The Electron preload bridge, or null in a plain browser (or when the bridge is malformed). */
export function desktop(): DesktopBridge | null {
  const b = (window as unknown as { motionStudio?: Partial<DesktopBridge> }).motionStudio;
  return b?.isDesktop === true && typeof b.pickFolder === 'function' && typeof b.revealPath === 'function' ? (b as DesktopBridge) : null;
}
