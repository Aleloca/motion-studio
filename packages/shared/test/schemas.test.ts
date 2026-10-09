import { describe, expect, it } from 'vitest';
import { appConfigSchema, storedWorkspaceSettingsSchema, projectFileSchema, workspaceSettingsSchema } from '../src/index.ts';

describe('workspaceSettingsSchema', () => {
  it('fills defaults from an empty versioned object', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1, maxConcurrentJobs: 2, expertMode: false, theme: 'system', model: null, sandboxMode: 'auto', extraAllowedDomains: [], confirmPaidProviders: true, autoApproveSandboxed: true,
    });
  });
  it('autoApproveSandboxed defaults to true when absent and can be turned off', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1 }).autoApproveSandboxed).toBe(true);
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1, autoApproveSandboxed: false }).autoApproveSandboxed).toBe(false);
    expect(storedWorkspaceSettingsSchema.parse({ schemaVersion: 1 }).autoApproveSandboxed).toBe(true);
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
