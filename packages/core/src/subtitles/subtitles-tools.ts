import { isSupportedLocale, issuesText, type LocaleTag } from '@motion-studio/shared';
import { z } from 'zod';
import type { BridgeHandler } from '../bridge/bridge-routes.ts';
import type { CreativeRef, CreativeTurnService } from '../creatives/creative-turns.ts';
import { currentLocale, t } from '../i18n.ts';
import { CodedError } from '../workspace-store.ts';
import type { SubtitlesService } from './subtitles-job.ts';

/** `drawn`: phase 3's drawn subtitles; the agent is not offered it in phase 1 (decision 1710), so absent means files only. */
const startInput = z.strictObject({ drawn: z.boolean().optional(), lang: z.string().refine(isSupportedLocale, { message: 'not a supported language' }).optional() });

/**
 * Decision 1703 (U9, spec §6.2): the agent's `start_subtitles`, creative turns only (the turn's creative from its
 * `appScope`; 403 `tool-unavailable` for any other job). Like `render_version "current"`, the job starts when the turn
 * settles, on the version it saved (none saved: the latest), so subtitles asked in the brief's first turn, or with an
 * audio change in the same turn, are timed on that turn's work. Once per turn (409 after that). The transcription switched
 * off is refused at once; any other refusal when the turn settles, or a turn that failed or was stopped, is a chat line.
 */
export function subtitlesTools(deps: { subtitles: SubtitlesService; turns: Pick<CreativeTurnService, 'onTurnSettled' | 'noteFromTurn'> }): Record<'start_subtitles', BridgeHandler> {
  /** What each turn asked for, by job id, until it settles. */
  const asked = new Map<string, { drawn: boolean; lang?: LocaleTag }>();
  deps.turns.onTurnSettled(async (ref, jobId, o) => {
    const a = asked.get(jobId);
    asked.delete(jobId);
    if (!a) return;
    const say = (text: string) => deps.turns.noteFromTurn(jobId, ref, { type: 'system', at: new Date().toISOString(), level: 'warning', text, origin: 'agent' });
    if (o.state !== 'succeeded' || o.stopped) { await say(t().subtitles.notStartedTurn); return; }
    try {
      await deps.subtitles.start(plain(ref), { mode: 'new', drawn: a.drawn, ...(a.lang ? { lang: a.lang } : {}) });
    } catch (err) {
      await say(t().subtitles.notStarted({ reason: err instanceof Error ? err.message : String(err) }));
    }
  });
  return {
    start_subtitles: async (c, args) => {
      const a = c.appScope;
      if (c.kind !== 'creative' || !a || a.group) throw new CodedError(403, t().errors.toolUnavailable, 'tool-unavailable');
      if (c.signal.aborted) throw new CodedError(409, t().errors.jobCancelled, 'tool-aborted');
      const r = startInput.safeParse(args ?? {});
      if (!r.success) throw new CodedError(400, t().errors.invalidRequestDetail({ detail: issuesText(r.error, currentLocale()) }), 'invalid-request');
      if (asked.has(c.jobId)) throw new CodedError(409, t().errors.subtitlesOncePerTurn, 'subtitles-once');
      await deps.subtitles.assertTranscriptionOn();
      asked.set(c.jobId, { drawn: r.data.drawn === true, ...(r.data.lang ? { lang: r.data.lang as LocaleTag } : {}) });
      return { started: true, when: 'after-turn' };
    },
  };
}

const plain = (ref: CreativeRef): CreativeRef => ({ root: ref.root, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: ref.creativeSlug });
