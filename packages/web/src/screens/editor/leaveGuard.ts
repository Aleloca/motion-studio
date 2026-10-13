// The editor's leave guard (Phase 10b, Review Focus 3). The router (App.tsx `useHashRoute`) asks it before it follows a
// hash change: while a draft with edits is open, any route other than the editor's own is refused and the address is put
// back, then the editor asks "Save as vN · Discard · Keep editing". One place covers the back button, a format or version
// switch, the browser's back button, the command palette and every link, without each of them knowing about drafts.
export interface LeaveGuard {
  /** Whether going to `hash` would lose edits. */
  blocks(hash: string): boolean;
  /** The move was refused: ask the user, and go to `hash` if they save or discard. */
  ask(hash: string): void;
}

const guards = new Set<LeaveGuard>();

/** Registers a guard while the editor is on the page; returns the unregister. */
export function registerLeaveGuard(g: LeaveGuard): () => void {
  guards.add(g);
  return () => { guards.delete(g); };
}

/** True (and the user is asked) when a guard refuses the move to `hash`. */
export function leaveRefused(hash: string): boolean {
  for (const g of guards) {
    if (g.blocks(hash)) {
      g.ask(hash);
      return true;
    }
  }
  return false;
}
