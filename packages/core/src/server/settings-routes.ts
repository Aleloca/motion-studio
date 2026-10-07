import type { FastifyInstance } from 'fastify';
import { PROVIDER_IDS, type ProviderId, type SecretStatus } from '@motion-studio/shared';
import type { SecretsVault } from '../secrets/vault.ts';
import { WorkspaceError } from '../workspace-store.ts';

export interface SettingsRoutesContext { vault: SecretsVault }

const providerOf = (p: string): ProviderId => {
  if (!(PROVIDER_IDS as readonly string[]).includes(p)) throw new WorkspaceError(400, `Provider sconosciuto: ${p}`);
  return p as ProviderId;
};

export function registerSettingsRoutes(app: FastifyInstance, ctx: SettingsRoutesContext) {
  const statusOf = async (p: ProviderId): Promise<SecretStatus> => (await ctx.vault.status()).find((s) => s.provider === p)!;
  const notEnv = async (p: ProviderId) => {
    if ((await statusOf(p)).source === 'env') throw new WorkspaceError(409, "La chiave arriva da una variabile d'ambiente: modificala lì");
  };
  app.get('/api/secrets', async () => ctx.vault.status());
  app.put<{ Params: { provider: string }; Body: { value?: unknown } }>('/api/secrets/:provider', async (req) => {
    const p = providerOf(req.params.provider);
    await notEnv(p);
    await ctx.vault.set(p, typeof req.body?.value === 'string' ? req.body.value : '');
    return statusOf(p);
  });
  app.delete<{ Params: { provider: string } }>('/api/secrets/:provider', async (req) => {
    const p = providerOf(req.params.provider);
    await notEnv(p);
    await ctx.vault.delete(p);
    return statusOf(p);
  });
}
