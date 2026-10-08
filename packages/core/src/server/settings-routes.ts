import type { FastifyInstance } from 'fastify';
import { PROVIDER_IDS, type ProviderId, type SecretStatus } from '@motion-studio/shared';
import type { SecretsVault } from '../secrets/vault.ts';
import { PermissionsStore } from '../approvals/permissions-store.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { t } from '../i18n.ts';

export interface SettingsRoutesContext { vault: SecretsVault; approvals: ApprovalBroker; requireWorkspace: () => WorkspaceStore }

const providerOf = (p: string): ProviderId => {
  if (!(PROVIDER_IDS as readonly string[]).includes(p)) throw new WorkspaceError(400, t().errors.unknownProvider({ provider: p }));
  return p as ProviderId;
};

export function registerSettingsRoutes(app: FastifyInstance, ctx: SettingsRoutesContext) {
  const statusOf = async (p: ProviderId): Promise<SecretStatus> => (await ctx.vault.status()).find((s) => s.provider === p)!;
  const notEnv = async (p: ProviderId) => {
    if ((await statusOf(p)).source === 'env') throw new WorkspaceError(409, t().errors.keyFromEnv);
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
  app.get('/api/approvals', async () => ctx.approvals.pending());
  app.post<{ Params: { id: string }; Body: { decision?: unknown } }>('/api/approvals/:id', async (req) => {
    const d = req.body?.decision;
    if (d !== 'once' && d !== 'always' && d !== 'deny') throw new WorkspaceError(400, t().errors.invalidDecision);
    return ctx.approvals.decide(req.params.id, d);
  });
  app.get<{ Params: { slug: string } }>('/api/projects/:slug/permissions', async (req) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    return new PermissionsStore(ws.projectDir(req.params.slug)).list();
  });
  app.delete<{ Params: { slug: string }; Body: { rule?: unknown } }>('/api/projects/:slug/permissions', async (req) => {
    if (typeof req.body?.rule !== 'string') throw new WorkspaceError(400, t().errors.ruleMissing);
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    await new PermissionsStore(ws.projectDir(req.params.slug)).remove(req.body.rule);
    return { ok: true };
  });
}
