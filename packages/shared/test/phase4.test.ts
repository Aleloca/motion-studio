import { describe, expect, it } from 'vitest';
import { assetEntrySchema, permissionsFileSchema, storedWorkspaceSettingsSchema, workspaceSettingsSchema } from '../src/index.ts';

describe('phase 4 settings', () => {
  it('defaults sandbox, domains and paid confirmation', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1 })).toMatchObject({ sandboxMode: 'auto', extraAllowedDomains: [], confirmPaidProviders: true });
  });
  it('validates and lowercases domains', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1, extraAllowedDomains: ['*.Example.com', 'api.acme.io'] }).extraAllowedDomains).toEqual(['*.example.com', 'api.acme.io']);
    for (const bad of ['*', 'http://x.com', 'x', '*.com', 'a b.com',
      'localhost', 'app.localhost', '*.localhost', 'printer.local', '*.local', 'db.internal', 'nas.home.arpa', '*.home.arpa',
      '*.co.uk', '*.com.au', '*.co.jp', '*.com.br', '*.co.nz', '*.org.uk',
      '-a.example.com', 'a-.example.com', `${'a'.repeat(64)}.example.com`, `${'a.'.repeat(126)}com`, 'a..com', '*.*.example.com']) {
      expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, extraAllowedDomains: [bad] }).success, bad).toBe(false);
    }
    for (const good of ['bbc.co.uk', '*.bbc.co.uk', 'a-b.example.com', `${'a'.repeat(63)}.example.com`, '*.example.it', 'local.example.com']) {
      expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, extraAllowedDomains: [good] }).success, good).toBe(true);
    }
  });
});

describe('stored settings', () => {
  it('keeps the valid domains one by one and reports the dropped ones', () => {
    const s = storedWorkspaceSettingsSchema.parse({ schemaVersion: 1, extraAllowedDomains: ['API.acme.io', 'printer.local', '*.co.uk', 3, 'cdn.acme.io'] });
    expect(s.extraAllowedDomains).toEqual(['api.acme.io', 'cdn.acme.io']);
    expect(s.droppedDomains).toEqual(['printer.local', '*.co.uk', '3']);
    expect(storedWorkspaceSettingsSchema.parse({ schemaVersion: 1 }).droppedDomains).toBeUndefined();
    expect(storedWorkspaceSettingsSchema.safeParse({ schemaVersion: 1, maxConcurrentJobs: 99 }).success).toBe(false);
  });
});

describe('asset attribution', () => {
  it('defaults to null', () => {
    const a = assetEntrySchema.parse({ file: 'a.png', kind: 'image', origin: 'stock', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-10-08T10:00:00.000Z' });
    expect(a.attribution).toBeNull();
  });
});

describe('permissionsFileSchema', () => {
  it('defaults allow to []', () => {
    expect(permissionsFileSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1, allow: [] });
  });
});
