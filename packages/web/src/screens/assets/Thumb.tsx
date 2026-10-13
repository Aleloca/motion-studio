import type { AssetEntry } from '@motion-studio/shared';
import { api } from '../../api.ts';
import { MediaThumb, SafeImg } from '../../components/MediaThumb.tsx';
import { Icon, cx } from '../../ui/index.ts';
import { specimenFamily, useFontPreview } from '../brandFonts.ts';
import { baseName, mayBeTransparent, wantsDarkStage } from './model.ts';

/** The media of an asset: images and SVG as they are, a video frame, a font specimen with the real file, or the kind. */
export function Thumb({ slug, asset: x, big }: { slug: string; asset: AssetEntry; big?: boolean }) {
  const url = api.projectFileUrl(slug, `assets/${x.file}`);
  if (x.kind === 'image' || x.kind === 'svg') {
    return (
      <span className={cx('ms-athumb', x.kind === 'svg' && 'ms-athumb-svg', mayBeTransparent(x) && (wantsDarkStage(x) ? 'ms-stage-dark' : 'ms-stage-light'))}>
        <SafeImg src={url} alt="" loading="lazy" small={!big} />
      </span>
    );
  }
  if (x.kind === 'video') return <span className="ms-athumb ms-athumb-video"><MediaThumb src={url} alt="" /><span className="ms-athumb-play"><Icon name="play" size={big ? 14 : 11} fill /></span></span>;
  if (x.kind === 'font') return <FontThumb url={url} name={baseName(x.file)} />;
  const ext = (x.file.split('.').pop() ?? '').toUpperCase();
  return (
    <span className="ms-athumb ms-athumb-file">
      <Icon name={x.kind === 'audio' ? 'play' : 'folder'} size={18} />
      <span>{ext}</span>
    </span>
  );
}

function FontThumb({ url, name }: { url: string; name: string }) {
  const preview = useFontPreview(url);
  const family = specimenFamily(preview);
  return (
    <span className="ms-athumb ms-athumb-font" style={{ fontFamily: family }}>
      <span className="ms-athumb-aa">Aa</span>
      <span className="ms-athumb-sample">{name.replace(/\.[a-z0-9]+$/i, '')}</span>
    </span>
  );
}
