import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';
import { PlayerControls } from './PlayerControls.tsx';
import { useMediaPlayer } from './useMediaPlayer.ts';

/**
 * An in-house audio player (Phase 11): a hidden `<audio>` driven from our own controls (no native ones), with the
 * waveform from the core as the scrub bar when `peaks` are given. Keyboard: Tab to the play button and to the bar.
 */
export function AudioPlayer({ src, name, peaks, durationSec, className }: {
  src: string; name: string; peaks?: readonly number[] | null; /** Known before the metadata loads. */ durationSec?: number | null; className?: string;
}) {
  const p = useT().web.player;
  const player = useMediaPlayer<HTMLAudioElement>(durationSec);
  return (
    <section className={cx('ms-player ms-player-audio', className)} aria-label={p.audio({ name })}>
      <audio ref={player.ref} src={src} preload="metadata" />
      <PlayerControls player={player} peaks={peaks} />
    </section>
  );
}
