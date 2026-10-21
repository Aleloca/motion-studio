import { useImperativeHandle, type Ref } from 'react';
import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';
import { PlayerControls } from './PlayerControls.tsx';
import { useMediaPlayer } from './useMediaPlayer.ts';

/** What a screen can do with the player: seek to a time in seconds (the library's analysis rows). */
export interface VideoPlayerHandle { seek(sec: number): void }

/**
 * A small in-house video player: the `<video>` without native controls (a click on the picture plays or pauses), and the
 * same controls as the audio player under it.
 */
export function VideoPlayer({ src, name, poster, durationSec, className, handle }: {
  src: string; name: string; poster?: string; /** Known before the metadata loads. */ durationSec?: number | null; className?: string; handle?: Ref<VideoPlayerHandle>;
}) {
  const p = useT().web.player;
  const player = useMediaPlayer<HTMLVideoElement>(durationSec);
  useImperativeHandle(handle, () => ({ seek: player.seek }), [player.seek]);
  return (
    <section className={cx('ms-player ms-player-video', className)} aria-label={p.video({ name })}>
      <video ref={player.ref} className="ms-player-picture" src={src} poster={poster} preload="metadata" playsInline onClick={player.toggle} />
      <PlayerControls player={player} />
    </section>
  );
}
