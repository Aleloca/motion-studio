import type { FastifyInstance } from 'fastify';
import { EMPTY_BRAND_KIT, brandKitSchema } from '@motion-studio/shared';
import { MCP_SERVER, MCP_TOOLS } from '../agent/launcher.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { readConfinedFile } from '../brand/agent-guard.ts';
import { ProviderError } from '../providers/http.ts';
import { WorkspaceError } from '../workspace-store.ts';
import type { AgentBridge, BridgeContext } from './bridge.ts';
import { t } from '../i18n.ts';

export type BridgeHandler = (ctx: BridgeContext, args: Record<string, unknown>) => Promise<unknown>;
export interface BridgeRoutesContext { bridge: AgentBridge; approvals: ApprovalBroker; extraTools?: Record<string, BridgeHandler> }

const denyMessage = (d: 'deny' | 'expired' | 'cancelled'): string => (d === 'deny' ? t().approvals.denied : d === 'expired' ? t().approvals.expired : t().errors.jobCancelled);
const MAX_GUIDELINES = 50_000;

/** Progress shown in the UI: no control, zero-width or bidi characters (they could disguise the text), single spaces. */
export const cleanProgress = (text: string) => text
  .replace(/[\t\n\v\f\r]/g, ' ')
  .replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/gu, '')
  .replace(/\s+/g, ' ')
  .trim();

/** Calls from the `studio` MCP server: one per tool, authenticated by the job's bridge token. */
export function registerBridgeRoutes(app: FastifyInstance, ctx: BridgeRoutesContext) {
  const tools: Record<string, BridgeHandler> = {
    approve: async (c, a) => {
      const raw = a.input ?? a.tool_input;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { behavior: 'deny', message: t().approvals.invalidRequest };
      const input = raw as Record<string, unknown>;
      const toolName = typeof a.tool_name === 'string' ? a.tool_name : t().approvals.unknownTool;
      // Provider confirmations and Motion Studio's own tools never go through the agent's permission prompts.
      if (toolName.startsWith('provider:') || toolName.startsWith(`mcp__${MCP_SERVER}__`)) return { behavior: 'deny', message: t().approvals.invalidRequest };
      const { decision } = await ctx.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'tool', toolName, input });
      return decision === 'once' || decision === 'always'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMessage(decision) };
    },
    report_progress: async (c, a) => {
      const text = typeof a.message === 'string' ? cleanProgress(a.message) : '';
      if (!text || text.length > 300) throw new WorkspaceError(400, t().errors.invalidProgress);
      c.emit({ kind: 'progress', text });
      return { ok: true };
    },
    validate_output: async (c) => {
      if (!c.validate) throw new WorkspaceError(400, t().errors.validateOnlyCreatives);
      return c.validate();
    },
    // The core is not sandboxed: never follow the agent's symlinks, never read special or huge files.
    read_brand_kit: async (c) => {
      const g = await readConfinedFile(c.projectDir, 'brand/guidelines.md');
      const guidelines = g && 'text' in g ? g.text.slice(0, MAX_GUIDELINES) : '';
      const k = await readConfinedFile(c.projectDir, 'brand/brand-kit.json');
      if (k === null) return { kit: EMPTY_BRAND_KIT, guidelines };
      if ('text' in k) {
        let json: unknown = undefined;
        try { json = JSON.parse(k.text); } catch { /* reported below, without the parser's message */ }
        const parsed = brandKitSchema.safeParse(json);
        if (parsed.success) return { kit: parsed.data, guidelines };
      }
      return { kit: null, guidelines, error: 'Brand kit non leggibile' };
    },
    ...ctx.extraTools,
  };

  app.post<{ Params: { tool: string } }>('/api/bridge/:tool', async (req, reply) => {
    const c = ctx.bridge.resolve(req.headers['x-motion-studio-bridge'] as string | undefined);
    if (!c) return reply.status(401).send({ error: 'Accesso al bridge non valido' });
    const { tool } = req.params;
    const handler = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
    if (!handler) return reply.status(404).send({ error: `Strumento sconosciuto: ${tool}` });
    // Defence in depth for a leaked token: a job only reaches the tools of its kind.
    if (tool !== 'approve' && !MCP_TOOLS[c.kind].includes(tool)) return reply.status(403).send({ error: 'Strumento non disponibile in questo lavoro' });
    try {
      return await handler(c, (req.body ?? {}) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof WorkspaceError || err instanceof ProviderError) return reply.status(err.status).send({ error: err.message });
      return reply.status(500).send({ error: 'Errore interno di Motion Studio' });
    }
  });
}
