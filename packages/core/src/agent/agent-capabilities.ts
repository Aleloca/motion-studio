import type { AgentCapabilities } from '@motion-studio/shared';

export type { AgentCapabilities } from '@motion-studio/shared';

/** A Claude Code version from which a behaviour was verified live (Phase 13 Task 0 spike). */
export interface VerifiedCapability { minVersion: string; liveInput: boolean; interrupt: boolean }

/**
 * Versions verified live, keyed by min version. EMPTY: the stream-input spike was suspended after a safety-classifier
 * stop (decisions log 610, docs/superpowers/notes/2026-10-14-phase13-stream-input-spike.md), so no version is verified
 * and every version runs the fallback (queued messages, stop and resume) unless the user opts in.
 */
export const VERIFIED_CAPABILITIES: readonly VerifiedCapability[] = [];

/** The user's explicit opt-in (workspace settings `agentLiveInput` / `agentInterrupt`, default off). */
export interface CapabilityOptIn { liveInput?: boolean; interrupt?: boolean }

/** `x.y.z` from `claude --version` output ("2.1.299 (Claude Code)"), or null. */
export function parseClaudeVersion(stdout: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1] ?? null;
}

const parts = (v: string): number[] | null => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
const compare = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; };

/**
 * Effective capabilities of a Claude Code version. An unknown version (null or unparsable: `claude` did not answer) is
 * both off, even with the opt-in. Otherwise each capability is on when the newest table entry at or below the version
 * has it, or when the user opted in. Interrupt needs live input: the control request travels on the open stdin, and
 * with live input off stdin closes after the first message exactly as before Phase 13.
 */
export function capabilitiesFor(
  version: string | null,
  optIn: CapabilityOptIn = {},
  now: Date = new Date(),
  table: readonly VerifiedCapability[] = VERIFIED_CAPABILITIES,
): AgentCapabilities {
  const v = version ? parts(version) : null;
  const off: AgentCapabilities = { cliVersion: version || null, liveInput: false, interrupt: false, checkedAt: now.toISOString() };
  if (!v) return off;
  let base: VerifiedCapability | undefined;
  for (const row of table) {
    const min = parts(row.minVersion);
    if (min && compare(v, min) >= 0 && (!base || compare(min, parts(base.minVersion)!) > 0)) base = row;
  }
  const liveInput = base?.liveInput === true || optIn.liveInput === true;
  const interrupt = liveInput && (base?.interrupt === true || optIn.interrupt === true);
  return { ...off, liveInput, interrupt };
}
