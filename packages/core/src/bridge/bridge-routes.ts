import type { FastifyInstance } from 'fastify';
import { MCP_TOOLS } from '../agent/launcher.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { WorkspaceError } from '../workspace-store.ts';
import type { AgentBridge, BridgeContext } from './bridge.ts';

export type BridgeHandler = (ctx: BridgeContext, args: Record<string, unknown>) => Promise<unknown>;
export interface BridgeRoutesContext { bridge: AgentBridge; approvals: ApprovalBroker; extraTools?: Record<string, BridgeHandler> }

const DENY_MESSAGES = {
  deny: "L'utente ha negato questa azione.",
  expired: 'Nessuna risposta entro 10 minuti: azione negata.',
  cancelled: 'Il lavoro è stato annullato.',
} as const;
const MAX_GUIDELINES = 50_000;

/** Calls from the `studio` MCP server: one per tool, authenticated by the job's bridge token. */
export function registerBridgeRoutes(app: FastifyInstance, ctx: BridgeRoutesContext) {
  const tools: Record<string, BridgeHandler> = {
    approve: async (c, a) => {
      const input = (a.input ?? a.tool_input ?? {}) as Record<string, unknown>;
      const toolName = typeof a.tool_name === 'string' ? a.tool_name : 'sconosciuto';
      const { decision } = await ctx.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'tool', toolName, input });
      return decision === 'once' || decision === 'always'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: DENY_MESSAGES[decision] };
    },
    report_progress: async (c, a) => {
      const text = typeof a.message === 'string' ? a.message.trim() : '';
      if (!text || text.length > 300) throw new WorkspaceError(400, 'Messaggio di avanzamento non valido (1-300 caratteri)');
      c.emit({ kind: 'progress', text });
      return { ok: true };
    },
    validate_output: async (c) => {
      if (!c.validate) throw new WorkspaceError(400, 'Validazione disponibile solo nelle creatività');
      return c.validate();
    },
    read_brand_kit: async (c) => {
      const store = new BrandStore(c.projectDir);
      const guidelines = (await store.readGuidelines().catch(() => '')).slice(0, MAX_GUIDELINES);
      try { return { kit: await store.readKit(), guidelines }; }
      catch (e) { return { kit: null, guidelines, error: (e as Error).message }; }
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
      if (err instanceof WorkspaceError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }
  });
}
