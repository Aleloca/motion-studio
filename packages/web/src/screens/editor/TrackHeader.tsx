// The header of a timeline lane (Phase 10b, Task 7): the track's name and kind, and its hide, lock and (audio) mute buttons.
import { trackLocked, type Track } from '@motion-studio/shared';
import { useT } from '../../i18n.tsx';
import { Button, Icon, cx, type IconName } from '../../ui/index.ts';

export const KIND_ICON: Record<Track['kind'], IconName> = { visual: 'image', video: 'video', text: 'text', audio: 'music', subtitles: 'text' };

export { trackLocked };

export function TrackHeader({ track, name, onFlag }: { track: Track; name: string; onFlag(flag: 'hidden' | 'locked' | 'muted', value: boolean): void }) {
  const e = useT().web.editor;
  const hidden = Boolean(track.hidden);
  const locked = trackLocked(track);
  const muted = Boolean(track.muted);
  const hideLabel = hidden ? e.showTrack({ name }) : e.hideTrack({ name });
  const lockLabel = locked ? e.unlockTrack({ name }) : e.lockTrack({ name });
  const muteLabel = muted ? e.unmuteTrack({ name }) : e.muteTrack({ name });
  return (
    <div className={cx('ms-tl-head', hidden && 'ms-dim')} role="group" aria-label={name} data-track-head={track.id}>
      <Icon name={KIND_ICON[track.kind]} size={13} />
      <span className="ms-tl-name" title={name}>{name}</span>
      <Button size="sm" variant="ghost" icon aria-label={hideLabel} title={hideLabel} onClick={() => onFlag('hidden', !hidden)}><Icon name={hidden ? 'eyeOff' : 'eye'} size={13} /></Button>
      <Button size="sm" variant="ghost" icon aria-label={lockLabel} title={lockLabel} disabled={track.kind === 'subtitles'} onClick={() => onFlag('locked', !locked)}><Icon name={locked ? 'lock' : 'unlock'} size={13} /></Button>
      {track.kind === 'audio' ? (
        <Button size="sm" variant="ghost" icon aria-label={muteLabel} title={muteLabel} onClick={() => onFlag('muted', !muted)}><Icon name={muted ? 'mute' : 'volume'} size={13} /></Button>
      ) : null}
    </div>
  );
}
