import { describe, expect, it } from 'vitest';
import { capabilitiesFor, parseClaudeVersion, VERIFIED_CAPABILITIES } from '../src/agent/agent-capabilities.ts';

const AT = new Date('2026-10-14T10:00:00.000Z');

describe('capabilitiesFor', () => {
  it('has no verified version (spike suspended, decisions log 610)', () => {
    expect(VERIFIED_CAPABILITIES).toEqual([]);
  });

  it('turns both capabilities off for every version without the opt-in', () => {
    for (const v of ['2.1.299', '2.1.205', '9.9.9', '0.0.1', '10.0.0']) {
      expect(capabilitiesFor(v, {}, AT)).toEqual({ cliVersion: v, liveInput: false, interrupt: false, checkedAt: AT.toISOString() });
    }
  });

  it('an unknown version means both off, even with the opt-in', () => {
    for (const v of [null, '', 'garbage', '2.x']) {
      const c = capabilitiesFor(v, { liveInput: true, interrupt: true }, AT);
      expect(c).toMatchObject({ liveInput: false, interrupt: false });
    }
    expect(capabilitiesFor(null, {}, AT).cliVersion).toBeNull();
  });

  it('the explicit opt-in turns each capability on for a known version', () => {
    expect(capabilitiesFor('2.1.299', { liveInput: true }, AT)).toMatchObject({ liveInput: true, interrupt: false });
    expect(capabilitiesFor('2.1.299', { liveInput: true, interrupt: true }, AT)).toMatchObject({ liveInput: true, interrupt: true });
  });

  it('interrupt needs live input: the control request travels on the open stdin', () => {
    expect(capabilitiesFor('2.1.299', { interrupt: true }, AT)).toMatchObject({ liveInput: false, interrupt: false });
  });

  it('a verified table entry applies from its min version on (numeric comparison)', () => {
    const table = [{ minVersion: '2.2.0', liveInput: true, interrupt: false }, { minVersion: '2.10.0', liveInput: true, interrupt: true }];
    expect(capabilitiesFor('2.1.299', {}, AT, table)).toMatchObject({ liveInput: false, interrupt: false });
    expect(capabilitiesFor('2.2.0', {}, AT, table)).toMatchObject({ liveInput: true, interrupt: false });
    expect(capabilitiesFor('2.9.5', { interrupt: true }, AT, table)).toMatchObject({ liveInput: true, interrupt: true });
    expect(capabilitiesFor('2.10.1', {}, AT, table)).toMatchObject({ liveInput: true, interrupt: true });
    expect(capabilitiesFor(null, {}, AT, table)).toMatchObject({ liveInput: false, interrupt: false });
  });

  it('only a literal true opts in', () => {
    expect(capabilitiesFor('2.1.299', { liveInput: 'yes' as unknown as boolean }, AT).liveInput).toBe(false);
  });

  it('defaults checkedAt to now', () => {
    const before = Date.now();
    const c = capabilitiesFor('2.1.299');
    expect(Date.parse(c.checkedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe('parseClaudeVersion', () => {
  it('reads the version from `claude --version` output', () => {
    expect(parseClaudeVersion('2.1.299 (Claude Code)\n')).toBe('2.1.299');
    expect(parseClaudeVersion('9.9.9 (Claude Code)')).toBe('9.9.9');
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('no version here')).toBeNull();
  });
});
