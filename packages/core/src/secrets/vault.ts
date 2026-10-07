import { PROVIDER_IDS, type ProviderId, type SecretStatus } from '@motion-studio/shared';
import { WorkspaceError } from '../workspace-store.ts';

export const PROVIDER_ENV: Record<ProviderId, string> = { openai: 'OPENAI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', pexels: 'PEXELS_API_KEY', unsplash: 'UNSPLASH_ACCESS_KEY' };

export interface SecretsVault {
  get(p: ProviderId): Promise<string | null>;
  set(p: ProviderId, value: string): Promise<void>;
  delete(p: ProviderId): Promise<void>;
  status(): Promise<SecretStatus[]>;
}

export function cleanSecret(value: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || v.length > 500 || /[\r\n]/.test(v)) throw new WorkspaceError(400, 'Chiave non valida: incolla la chiave del provider su una sola riga');
  return v;
}

export function redact(text: string, secrets: string[]): string {
  return secrets.filter((s) => s.length >= 4).reduce((t, s) => t.split(s).join('•••'), text);
}

abstract class BaseVault implements SecretsVault {
  constructor(protected readonly env: NodeJS.ProcessEnv) {}
  protected abstract read(p: ProviderId): Promise<string | null>;
  protected abstract write(p: ProviderId, v: string): Promise<void>;
  protected abstract remove(p: ProviderId): Promise<void>;
  private fromEnv(p: ProviderId) { const v = this.env[PROVIDER_ENV[p]]?.trim(); return v ? v : null; }
  async get(p: ProviderId) { return this.fromEnv(p) ?? (await this.read(p)); }
  async set(p: ProviderId, value: string) { await this.write(p, cleanSecret(value)); }
  async delete(p: ProviderId) { await this.remove(p); }
  async status(): Promise<SecretStatus[]> {
    return Promise.all(PROVIDER_IDS.map(async (provider): Promise<SecretStatus> => {
      if (this.fromEnv(provider)) return { provider, configured: true, source: 'env' };
      return (await this.read(provider)) ? { provider, configured: true, source: 'keychain' } : { provider, configured: false, source: null };
    }));
  }
}

export class MemoryVault extends BaseVault {
  private readonly store = new Map<ProviderId, string>();
  constructor(env: NodeJS.ProcessEnv = {}) { super(env); }
  protected async read(p: ProviderId) { return this.store.get(p) ?? null; }
  protected async write(p: ProviderId, v: string) { this.store.set(p, v); }
  protected async remove(p: ProviderId) { this.store.delete(p); }
}

export class KeyringVault extends BaseVault {
  private readonly service: string;
  private warned = false;
  constructor(opts: { env?: NodeJS.ProcessEnv; service?: string } = {}) { super(opts.env ?? process.env); this.service = opts.service ?? 'Motion Studio'; }
  private async entry(p: ProviderId) {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(this.service, p, { linux: { store: 'secret-service' } });
  }
  protected async read(p: ProviderId) {
    try { return (await (await this.entry(p)).getPassword()) ?? null; }
    catch (e) { if (!this.warned) { this.warned = true; console.warn(`Portachiavi non disponibile: ${(e as Error).message}`); } return null; }
  }
  protected async write(p: ProviderId, v: string) {
    try { await (await this.entry(p)).setPassword(v); }
    catch (e) { throw new WorkspaceError(500, `Portachiavi del sistema non disponibile: ${(e as Error).message}`); }
  }
  protected async remove(p: ProviderId) {
    try { await (await this.entry(p)).deletePassword(); } catch { /* already absent */ }
  }
}
