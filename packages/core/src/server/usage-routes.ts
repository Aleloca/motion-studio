import type { FastifyInstance } from 'fastify';
import type { UsageBilling, UsageReport } from '@motion-studio/shared';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import type { UsageLedger } from '../usage/usage-ledger.ts';
import { buildUsageReport, defaultUsageRange, firstGenerationTokens, rangeEndingAt, type UsageProject } from '../usage/usage-report.ts';
import { t } from '../i18n.ts';

/** Longest range a report may cover (one bucket per day). */
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 400 * DAY_MS;
/** Default window of the first-generation figures (New creative estimate). */
const FIRST_GEN_DAYS = 90;

export interface UsageRouteDeps {
  /** Null while no workspace is open: the report is then empty, never an error. */
  workspace: () => WorkspaceStore | null;
  ledger: UsageLedger;
  /** Cached by the caller (it runs `claude auth status`). */
  billing: () => Promise<UsageBilling>;
}

function parseDate(raw: unknown): Date | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** GET /api/usage?from=<iso>&to=<iso>&project=<slug>: token and cost usage from the projects' ledgers (spec §5.5). */
export function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps) {
  app.get<{ Querystring: { from?: string; to?: string; project?: string } }>('/api/usage', async (req): Promise<UsageReport> => {
    const q = req.query ?? {};
    const from = parseDate(q.from);
    const to = parseDate(q.to);
    if (from === null || to === null) throw new WorkspaceError(400, t().errors.invalidRequest);
    const range = from && to ? { from, to } : from ? { from, to: defaultUsageRange().to } : to ? rangeEndingAt(to) : defaultUsageRange();
    if (range.from >= range.to || range.to.getTime() - range.from.getTime() > MAX_RANGE_MS) throw new WorkspaceError(400, t().errors.invalidRequest);
    // Started before the project listing and awaited together with the ledger reads: the first call does not wait for
    // `claude auth status` after them.
    const billing = deps.billing().catch(() => 'unknown' as const);
    const ws = deps.workspace();
    let projects: UsageProject[] = [];
    if (ws && typeof q.project === 'string' && q.project !== '') {
      const project = await ws.getProject(q.project); // 400 for a bad slug, 404 when missing
      projects = [{ slug: q.project, name: project.name, dir: ws.projectDir(q.project) }];
    } else if (ws) {
      const list = await ws.listProjects().catch(() => []);
      // A project with an unreadable project.json still has its ledger: it is listed under its folder name.
      projects = list.map((p) => ({ slug: p.slug, name: p.ok ? p.project.name : p.slug, dir: ws.projectDir(p.slug) }));
    }
    return buildUsageReport({ ledger: deps.ledger, projects, billing, ...range });
  });

  /**
   * GET /api/usage/first-generations?days=90: the shown tokens of each creative's first generation started in the last
   * `days` days (1–400), for the New creative estimate. Read-only; empty while no workspace is open.
   */
  app.get<{ Querystring: { days?: string } }>('/api/usage/first-generations', async (req): Promise<{ tokens: number[] }> => {
    const raw = req.query?.days;
    const days = raw === undefined || raw === '' ? FIRST_GEN_DAYS : /^[0-9]{1,3}$/.test(String(raw)) ? Number(raw) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 400) throw new WorkspaceError(400, t().errors.invalidRequest);
    const ws = deps.workspace();
    if (!ws) return { tokens: [] };
    const list = await ws.listProjects().catch(() => []);
    const ledgers = await Promise.all(list.map((p) => deps.ledger.read(ws.projectDir(p.slug))));
    return { tokens: firstGenerationTokens(ledgers, new Date(Date.now() - days * DAY_MS)) };
  });
}
