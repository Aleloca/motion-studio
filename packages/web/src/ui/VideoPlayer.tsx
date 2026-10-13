import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';
import { PlayerControls } from './PlayerControls.tsx';
import { useMediaPlayer } from './useMediaPlayer.ts';

/**
 * A small in-house video player: the `<video>` without native controls (a click on the picture plays or pauses), and the
 * same controls as the audio player under it.
 */
export function VideoPlayer({ src, name, poster, durationSec, className }: {
  src: string; name: string; poster?: string; /** Known before the metadata loads. */ durationSec?: number | null; className?: string;
}) {
  const p = useT().web.player;
  const player = useMediaPlayer<HTMLVideoElement>(durationSec);
  return (
    <section className={cx('ms-player ms-player-video', className)} aria-label={p.video({ name })}>
      <video ref={player.ref} className="ms-player-picture" src={src} poster={poster} preload="metadata" playsInline onClick={player.toggle} />
      <PlayerControls player={player} />
    </section>
  );
}
