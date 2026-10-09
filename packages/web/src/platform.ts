/** Platform checks shared by the shell, motion helpers and screens. */

/** macOS (or iOS): shortcuts use ⌘ there and Ctrl elsewhere. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
