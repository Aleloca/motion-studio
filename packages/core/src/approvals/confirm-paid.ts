import type { WorkspaceSettings } from '@motion-studio/shared';
import { ProviderError } from '../providers/http.ts';
import { t } from '../i18n.ts';
import type { ApprovalBroker } from './broker.ts';
import { isAllowedRule, PermissionsStore } from './permissions-store.ts';

/** What a paid action needs to ask: the job it runs in (the agent's bridge context or a core job) and its abort signal. */
export interface PaidContext { jobId: string; projectSlug: string; projectDir: string; creativeSlug: string | null; signal: AbortSignal }

/**
 * Asks the user before a paid provider call (when the setting is on and no per-project "Always" rule covers it). Shared by the
 * agent tools and the core-run Generate jobs, so both go through the same approval card and the same rules.
 */
export async function confirmPaid(deps: { approvals: ApprovalBroker; settings: () => Promise<WorkspaceSettings> }, c: PaidContext, rule: string, title: string, detail: string): Promise<void> {
  const alive = () => { if (c.signal.aborted) throw new ProviderError(499, t().errors.jobCancelled); };
  if (!(await deps.settings()).confirmPaidProviders) return;
  // A stored rule counts only when it is one "Sempre" could have produced; an unreadable store means ask.
  if (isAllowedRule(rule) && await new PermissionsStore(c.projectDir).has(rule).catch(() => false)) return;
  // No await between the check and the request: a cancelled job must never leave a prompt behind.
  alive();
  const pending = deps.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'provider', toolName: rule, input: {}, title, detail });
  const onAbort = () => deps.approvals.cancelJob(c.jobId);
  c.signal.addEventListener('abort', onAbort, { once: true });
  let decision: Awaited<typeof pending>['decision'];
  try { ({ decision } = await pending); } finally { c.signal.removeEventListener('abort', onAbort); }
  alive();
  if (decision !== 'once' && decision !== 'always') throw new ProviderError(403, t().approvals.providerNotApproved);
}
