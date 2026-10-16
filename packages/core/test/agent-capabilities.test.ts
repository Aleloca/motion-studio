import { describe, expect, it } from 'vitest';
import { capabilitiesFor, parseClaudeVersion, VERIFIED_CAPABILITIES, verifiedFor } from '../src/agent/agent-capabilities.ts';

const AT = new Date('2026-10-14T10:00:00.000Z');
const ON = { liveInput: true, interrupt: true };

describe('capabilitiesFor (decision 804: on from the measured 2.1.301)', () => {
  it('verifies 2.1.301, the version the user\'s probe measured, for both', () => {
    expect(VERIFIED_CAPABILITIES).toEqual([{ minVersion: '2.1.301', liveInput: true, interrupt: true }]);
  });

  it('both on for 2.1.301 and newer with the settings on (their default)', () => {
    for (const v of ['2.1.301', '2.1.302', '2.2.0', '3.0.0', '10.0.0']) {
      expect(capabilitiesFor(v, ON, AT)).toEqual({ cliVersion: v, liveInput: true, interrupt: true, checkedAt: AT.toISOString() });
    }
  });

  it('both off for older versions, even with the settings on', () => {
    for (const v of ['2.1.300', '2.1.299', '2.1.205', '2.0.999', '1.9.400', '0.0.1']) {
      expect(capabilitiesFor(v, ON, AT)).toEqual({ cliVersion: v, liveInput: false, interrupt: false, checkedAt: AT.toISOString() });
    }
  });

  it('an unknown version means both off, even with the settings on', () => {
    for (const v of [null, '', 'garbage', '2.x']) {
      expect(capabilitiesFor(v, ON, AT)).toMatchObject({ liveInput: false, interrupt: false });
    }
    expect(capabilitiesFor(null, ON, AT).cliVersion).toBeNull();
  });

  it('the settings switch each capability off on a verified version', () => {
    expect(capabilitiesFor('2.1.301', { liveInput: true, interrupt: false }, AT)).toMatchObject({ liveInput: true, interrupt: false });
    expect(capabilitiesFor('2.1.301', { liveInput: false, interrupt: false }, AT)).toMatchObject({ liveInput: false, interrupt: false });
  });

  it('interrupt needs live input: the control request travels on the open stdin', () => {
    expect(capabilitiesFor('2.1.301', { liveInput: false, interrupt: true }, AT)).toMatchObject({ liveInput: false, interrupt: false });
  });

  it('settings that could not be read (absent) mean the fallback; only a literal true counts', () => {
    expect(capabilitiesFor('2.1.301', {}, AT)).toMatchObject({ liveInput: false, interrupt: false });
    expect(capabilitiesFor('2.1.301', { liveInput: 'yes' as unknown as boolean, interrupt: true }, AT).liveInput).toBe(false);
  });

  it('a table entry applies from its min version on (numeric comparison), newest entry wins', () => {
    const table = [{ minVersion: '2.2.0', liveInput: true, interrupt: false }, { minVersion: '2.10.0', liveInput: true, interrupt: true }];
    expect(capabilitiesFor('2.1.301', ON, AT, table)).toMatchObject({ liveInput: false, interrupt: false });
    expect(capabilitiesFor('2.2.0', ON, AT, table)).toMatchObject({ liveInput: true, interrupt: false });
    expect(capabilitiesFor('2.9.5', ON, AT, table)).toMatchObject({ liveInput: true, interrupt: false });
    expect(capabilitiesFor('2.10.1', ON, AT, table)).toMatchObject({ liveInput: true, interrupt: true });
    expect(verifiedFor('2.10.1', table)).toEqual({ liveInput: true, interrupt: true });
    expect(verifiedFor(null, table)).toEqual({ liveInput: false, interrupt: false });
  });

  it('defaults checkedAt to now', () => {
    const before = Date.now();
    const c = capabilitiesFor('2.1.301', ON);
    expect(Date.parse(c.checkedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe('parseClaudeVersion', () => {
  it('reads the version from `claude --version` output', () => {
    expect(parseClaudeVersion('2.1.301 (Claude Code)\n')).toBe('2.1.301');
    expect(parseClaudeVersion('9.9.9 (Claude Code)')).toBe('9.9.9');
    expect(parseClaudeVersion('')).toBeNull();
    expect(parseClaudeVersion('no version here')).toBeNull();
  });
});
