import { isSupportedLocale, issuesText, type LocaleTag } from '@motion-studio/shared';
import { z } from 'zod';
import type { BridgeHandler } from '../bridge/bridge-routes.ts';
import type { CreativeTurnService } from '../creatives/creative-turns.ts';
import { currentLocale, t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import type { SubtitlesService } from './subtitles-job.ts';

const startInput = z.strictObject({ drawn: z.boolean(), lang: z.string().refine(isSupportedLocale, { message: 'not a supported language' }).optional() });

/**
 * Decision 1640 (U9): the agent's `start_subtitles`, creative turns only (the turn's creative from its `appScope`; 403
 * `tool-unavailable` for any other job). It starts the subtitles job of the creative's latest version and returns at once:
 * the job runs on its own and the chat says when they are ready. Once per turn: a second call answers 409.
 */
export function subtitlesTools(deps: { subtitles: SubtitlesService; turns: Pick<CreativeTurnService, 'onTurnSettled'> }): Record<'start_subtitles', BridgeHandler> {
  /** The turns that already started their subtitles, until they settle. */
  const started = new Set<string>();
  deps.turns.onTurnSettled(async (_ref, jobId) => { started.delete(jobId); });
  return {
    start_subtitles: async (c, args) => {
      const a = c.appScope;
      if (c.kind !== 'creative' || !a || a.group) throw new CodedError(403, t().errors.toolUnavailable, 'tool-unavailable');
      if (c.signal.aborted) throw new CodedError(409, t().errors.jobCancelled, 'tool-aborted');
      const r = startInput.safeParse(args ?? {});
      if (!r.success) throw new CodedError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }), 'invalid-request');
      if (started.has(c.jobId)) throw new CodedError(409, t().errors.subtitlesOncePerTurn, 'subtitles-once');
      const ref = { root: a.root, projectSlug: a.projectSlug, projectDir: a.projectDir, creativeSlug: a.creativeSlug };
      // Only a job that started counts: after a refusal (no video, one running, transcription off) the agent may try again.
      started.add(c.jobId);
      try {
        const job = await deps.subtitles.start(ref, { mode: 'new', drawn: r.data.drawn, ...(r.data.lang ? { lang: r.data.lang as LocaleTag } : {}) });
        return { started: true, jobId: job.id };
      } catch (err) {
        started.delete(c.jobId);
        throw err;
      }
    },
  };
}
