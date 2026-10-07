import { describe, expect, it } from 'vitest';
import { assetEntrySchema, permissionsFileSchema, workspaceSettingsSchema } from '../src/index.ts';

describe('phase 4 settings', () => {
  it('defaults sandbox, domains and paid confirmation', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1 })).toMatchObject({ sandboxMode: 'auto', extraAllowedDomains: [], confirmPaidProviders: true });
  });
  it('validates and lowercases domains', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1, extraAllowedDomains: ['*.Example.com', 'api.acme.io'] }).extraAllowedDomains).toEqual(['*.example.com', 'api.acme.io']);
    for (const bad of ['*', 'http://x.com', 'x', '*.com', 'a b.com']) {
      expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, extraAllowedDomains: [bad] }).success, bad).toBe(false);
    }
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
