import type { AgentCapabilities } from '@motion-studio/shared';

export type { AgentCapabilities } from '@motion-studio/shared';

/** A Claude Code version from which a behaviour was verified live. */
export interface VerifiedCapability { minVersion: string; liveInput: boolean; interrupt: boolean }

/**
 * Versions verified live, keyed by min version (decision 804). 2.1.301 is the version the user's own probe measured on
 * 2026-10-16 (scripts/spike/stream-input-probe.mjs, docs/superpowers/notes/2026-10-16-stream-input-probe.md): a second
 * user message written mid-turn was accepted and answered in the same session, and an interrupt control_request was
 * acknowledged (control_response success, then a result `error_during_execution`). Older or unknown versions stay on the
 * Phase 13 fallback (queued messages, stop and resume).
 */
export const VERIFIED_CAPABILITIES: readonly VerifiedCapability[] = [{ minVersion: '2.1.301', liveInput: true, interrupt: true }];

/**
 * The user's workspace settings `agentLiveInput` / `agentInterrupt` (default on since decision 804). They can only switch a
 * verified capability off: a version that is not verified stays on the fallback whatever they say.
 */
export interface CapabilityOptIn { liveInput?: boolean; interrupt?: boolean }

/** `x.y.z` from `claude --version` output ("2.1.299 (Claude Code)"), or null. */
export function parseClaudeVersion(stdout: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1] ?? null;
}

const parts = (v: string): number[] | null => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
const compare = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; };

/**
 * What a Claude Code version supports by the table (the newest entry at or below the version), whatever the settings say.
 * An unknown version (null or unparsable: `claude` did not answer) supports nothing. Interrupt needs live input: the
 * control request travels on the open stdin.
 */
export function verifiedFor(version: string | null, table: readonly VerifiedCapability[] = VERIFIED_CAPABILITIES): { liveInput: boolean; interrupt: boolean } {
  const v = version ? parts(version) : null;
  if (!v) return { liveInput: false, interrupt: false };
  let base: VerifiedCapability | undefined;
  for (const row of table) {
    const min = parts(row.minVersion);
    if (min && compare(v, min) >= 0 && (!base || compare(min, parts(base.minVersion)!) > 0)) base = row;
  }
  const liveInput = base?.liveInput === true;
  return { liveInput, interrupt: liveInput && base?.interrupt === true };
}

/**
 * Effective capabilities of a Claude Code version under the user's settings (decision 804): each is on when the version
 * is verified for it AND the setting is a literal true (the settings default to true; absent here means off, so a caller
 * that could not read the settings gets the fallback). Interrupt also needs live input on (with live input off stdin
 * closes after the first message exactly as before Phase 13).
 */
export function capabilitiesFor(
  version: string | null,
  settings: CapabilityOptIn = {},
  now: Date = new Date(),
  table: readonly VerifiedCapability[] = VERIFIED_CAPABILITIES,
): AgentCapabilities {
  const verified = verifiedFor(version, table);
  const liveInput = verified.liveInput && settings.liveInput === true;
  const interrupt = liveInput && verified.interrupt && settings.interrupt === true;
  return { cliVersion: version || null, liveInput, interrupt, checkedAt: now.toISOString() };
}
