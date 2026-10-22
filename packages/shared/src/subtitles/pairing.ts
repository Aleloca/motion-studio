// Which video a subtitle language goes on (subtitles Task 27, spec §6.6, U8). A video is named by its language: the brief's
// primary for the original video, an extra language for its localized video. Shared by the core's export and the dialog.
import type { LocaleTag } from '../localization/locales.ts';

/**
 * Whether a set may go on the video of `video` (drawn, as files or as a soft track). A set timed on a localized voice
 * (`timing.locale`) follows that video's audio: only that video. Any other set (the original speech, a translation) follows
 * the original audio's times and may go on any video.
 */
export function subtitlesFitVideo(timing: { locale?: LocaleTag | undefined }, video: LocaleTag): boolean {
  return timing.locale === undefined || timing.locale === video;
}

/**
 * The video a subtitle language goes on by default (U8): the video it was timed on when it follows a localized voice, else the
 * video in that language when the creative is localized into it (and, given `translated`, that language has a translation of
 * the format: final review Minor 3), else the original (`locales.primary`).
 */
export function defaultSubtitleVideo(set: { lang: LocaleTag; timing: { locale?: LocaleTag | undefined } }, locales: { primary: LocaleTag; extra: readonly LocaleTag[] },
  translated?: (lang: LocaleTag) => boolean): LocaleTag {
  if (set.timing.locale !== undefined) return set.timing.locale;
  return locales.extra.includes(set.lang) && (translated?.(set.lang) ?? true) ? set.lang : locales.primary;
}
