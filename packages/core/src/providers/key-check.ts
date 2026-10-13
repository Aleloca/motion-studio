export type KeyCapabilityStatus = 'ok' | 'missing';
export interface KeyCapability { status: KeyCapabilityStatus; /** Name of the provider permission the key lacks (only when missing). */ permission?: string; checkedAt: string }

/** What is known about each provider key's capabilities. Core memory only: never persisted, never holds a key. */
export class KeyCheckCache {
  private readonly byProvider = new Map<string, Record<string, KeyCapability>>();
  get(provider: string): Record<string, KeyCapability> { return { ...(this.byProvider.get(provider) ?? {}) }; }
  record(provider: string, capability: string, status: KeyCapabilityStatus, permission?: string): void {
    const cur = { ...(this.byProvider.get(provider) ?? {}) };
    cur[capability] = { status, ...(status === 'missing' && permission ? { permission } : {}), checkedAt: new Date().toISOString() };
    this.byProvider.set(provider, cur);
  }
}
