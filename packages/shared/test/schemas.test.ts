import { describe, expect, it } from 'vitest';
import { appConfigSchema, storedWorkspaceSettingsSchema, projectFileSchema, workspaceSettingsSchema } from '../src/index.ts';

describe('workspaceSettingsSchema', () => {
  it('fills defaults from an empty versioned object', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1, maxConcurrentJobs: 2, expertMode: false, theme: 'system', model: null, sandboxMode: 'auto', extraAllowedDomains: [], confirmPaidProviders: true, autoApproveSandboxed: true,
      exportNamePattern: '{title}-{format}-v{v}', agentLiveInput: true, agentInterrupt: true,
    });
  });
  it('decision 804: live input and interrupt default on and can be switched off', () => {
    const old = workspaceSettingsSchema.parse({ schemaVersion: 1, maxConcurrentJobs: 3 });
    expect(old).toMatchObject({ maxConcurrentJobs: 3, agentLiveInput: true, agentInterrupt: true });
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1, agentLiveInput: false, agentInterrupt: false })).toMatchObject({ agentLiveInput: false, agentInterrupt: false });
    expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, agentLiveInput: 'yes' }).success).toBe(false);
    expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, agentLiveDefaults: 803 }).success).toBe(false);
  });
  it('decision 804: a settings file from before the marker reads both on (its false was the old default); with the marker a false is the user\'s choice', () => {
    const before804 = { schemaVersion: 1, maxConcurrentJobs: 3, agentLiveInput: false, agentInterrupt: false };
    expect(storedWorkspaceSettingsSchema.parse(before804)).toMatchObject({ maxConcurrentJobs: 3, agentLiveInput: true, agentInterrupt: true, agentLiveDefaults: 804 });
    expect(storedWorkspaceSettingsSchema.parse({ schemaVersion: 1 })).toMatchObject({ agentLiveInput: true, agentInterrupt: true, agentLiveDefaults: 804 });
    const chosen = { ...before804, agentLiveDefaults: 804 };
    expect(storedWorkspaceSettingsSchema.parse(chosen)).toMatchObject({ agentLiveInput: false, agentInterrupt: false, agentLiveDefaults: 804 });
    expect(storedWorkspaceSettingsSchema.parse({ ...chosen, agentInterrupt: true })).toMatchObject({ agentLiveInput: false, agentInterrupt: true });
    // What the app writes for a new workspace carries the marker, so a later switch-off sticks.
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1, agentLiveDefaults: 804 }).agentLiveDefaults).toBe(804);
  });
  it('autoApproveSandboxed defaults to true when absent and can be turned off', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1 }).autoApproveSandboxed).toBe(true);
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1, autoApproveSandboxed: false }).autoApproveSandboxed).toBe(false);
    expect(storedWorkspaceSettingsSchema.parse({ schemaVersion: 1 }).autoApproveSandboxed).toBe(true);
  });
  it('exportNamePattern defaults when absent (old settings) and is bounded', () => {
    expect(storedWorkspaceSettingsSchema.parse({ schemaVersion: 1 }).exportNamePattern).toBe('{title}-{format}-v{v}');
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1, exportNamePattern: '{v}-{title}' }).exportNamePattern).toBe('{v}-{title}');
    expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, exportNamePattern: '' }).success).toBe(false);
    expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, exportNamePattern: 'x'.repeat(201) }).success).toBe(false);
  });
  it('rejects a concurrency outside 1..8', () => {
    expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, maxConcurrentJobs: 0 }).success).toBe(false);
    expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, maxConcurrentJobs: 9 }).success).toBe(false);
  });
});

describe('projectFileSchema', () => {
  const valid = {
    schemaVersion: 1, name: 'Acme', description: '', createdAt: '2026-10-07T10:00:00.000Z',
    updatedAt: '2026-10-07T10:00:00.000Z', linkedCodebases: [{ path: '/Users/me/dev/app', note: 'iOS' }],
  };
  it('accepts a valid project', () => {
    expect(projectFileSchema.parse(valid)).toEqual(valid);
  });
  it('trims the name', () => {
    expect(projectFileSchema.parse({ ...valid, name: '  Acme  ' }).name).toBe('Acme');
  });
  it('rejects a non-ISO date', () => {
    expect(projectFileSchema.safeParse({ ...valid, createdAt: 'ieri' }).success).toBe(false);
  });
  it('rejects an empty name', () => {
    expect(projectFileSchema.safeParse({ ...valid, name: '  ' }).success).toBe(false);
  });
  it('rejects an unknown schemaVersion', () => {
    expect(projectFileSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  });
});

describe('appConfigSchema', () => {
  it('defaults workspacePath to null', () => {
    expect(appConfigSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1, workspacePath: null, language: 'system' });
  });
});
