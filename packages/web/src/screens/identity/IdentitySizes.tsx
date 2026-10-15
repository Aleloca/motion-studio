// "Dimensioni" of an identity format (Phase 14, spec §4.4): every picture of the file set at 1:1 (or zoomed), the contexts
// where a favicon or an app icon ends up (browser tab, iOS rounded corners, Android circle with its safe zone) and the set's
// warnings. Only token colours; the light/dark surfaces are tokens too.
import { ADAPTIVE_FOREGROUND_SCALE, type IdentitySetInfo, type IdentityOutputFile } from '@motion-studio/shared';
import { useState } from 'react';
import { useT } from '../../i18n.tsx';
import { Icon, Toggle } from '../../ui/index.ts';
import { outputUrl } from '../canvasModel.ts';
import './identity.css';

export type IdentityKind = 'logo' | 'favicon' | 'app-icon';

const isPicture = (f: IdentityOutputFile) => /\.(png|svg)$/i.test(f.path);
/** True size is shown up to this many CSS pixels; a larger picture is scaled down to it (zoomed: to the larger cap). */
const CAP = 160;
const CAP_ZOOM = 256;
const ZOOM = 3;

export interface IdentitySizesProps { slug: string; creative: string; n: number; set: IdentitySetInfo; kind: IdentityKind }

export function IdentitySizes({ slug, creative, n, set, kind }: IdentitySizesProps) {
  const i = useT().web.identity;
  const [zoomed, setZoomed] = useState(false);
  const url = (path: string) => outputUrl(slug, creative, n, `${set.dir}/${path}`);
  const has = (path: string) => set.files.some((f) => f.path === path);
  const pictures = set.files.filter(isPicture);
  const others = set.files.filter((f) => !isPicture(f));
  const shown = (f: IdentityOutputFile) => {
    const w = f.width ?? CAP;
    const cap = zoomed ? CAP_ZOOM : CAP;
    return Math.min(cap, Math.round(w * (zoomed ? ZOOM : 1)));
  };

  return (
    <div className="ms-idn-sizes">
      <div className="ms-idn-head">
        <h3>{i.sizesTitle}</h3>
        <span className="ms-idn-zoom"><Toggle size="sm" on={zoomed} onChange={setZoomed} label={i.zoomed} /><span aria-hidden="true">{i.zoomed}</span></span>
      </div>
      <p className="ms-idn-intro">{i.sizesIntro}</p>

      {set.warnings.length > 0 ? (
        <div className="ms-idn-warn" role="note">
          <b><Icon name="warn" size={13} />{i.warnings}</b>
          <ul>{set.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      ) : null}

      <ul className="ms-idn-grid" aria-label={i.sizesTitle}>
        {pictures.map((f) => {
          const name = f.path.split('/').pop() ?? f.path;
          const px = shown(f);
          return (
            <li key={f.path} className="ms-idn-tile">
              <span className="ms-idn-pic" style={{ width: px, height: f.width && f.height ? Math.round(px * f.height / f.width) : px }}>
                <img src={url(f.path)} alt={f.width && f.height ? i.fileSize({ name: f.path, w: f.width, h: f.height }) : f.path} draggable={false} />
              </span>
              <span className="ms-idn-cap"><b title={f.path}>{name}</b><span>{f.width && f.height ? `${f.width}×${f.height} px` : '—'}{zoomed ? '' : ` · ${i.oneToOne}`}</span></span>
            </li>
          );
        })}
      </ul>
      {others.length > 0 ? <p className="ms-idn-others">{others.map((f) => f.path).join(' · ')}</p> : null}

      {kind !== 'logo' ? (
        <>
          <h3 className="ms-idn-sub">{i.contexts}</h3>
          <div className="ms-idn-ctx">
            {kind === 'favicon' && has('favicon.svg') ? (
              <figure className="ms-idn-fig">
                <div className="ms-idn-tab" aria-hidden="true">
                  <img src={url('favicon.svg')} width={16} height={16} alt="" draggable={false} />
                  <span className="ms-idn-tabtitle" />
                  <img src={url('favicon.svg')} width={32} height={32} alt="" draggable={false} className="ms-idn-tab32" />
                </div>
                <figcaption>{i.browserTab} · 16 / 32 px</figcaption>
              </figure>
            ) : null}
            {kind === 'favicon' && has('apple-touch-icon.png') ? (
              <figure className="ms-idn-fig">
                <span className="ms-idn-mask ms-idn-ios" aria-hidden="true"><img src={url('apple-touch-icon.png')} alt="" draggable={false} /></span>
                <figcaption>{i.iosIcon} · 180 px</figcaption>
              </figure>
            ) : null}
            {kind === 'favicon' && has('icon-512-maskable.png') ? (
              <figure className="ms-idn-fig">
                <span className="ms-idn-mask ms-idn-circle" aria-hidden="true">
                  <img src={url('icon-512-maskable.png')} alt="" draggable={false} />
                  <span className="ms-idn-safe" style={{ inset: `${((1 - 0.8) / 2) * 100}%` }} />
                </span>
                <figcaption>{i.maskableIcon} · {i.safeZone} 80%</figcaption>
                <p className="ms-idn-safenote">{i.safeZoneNote({ pct: 80 })}</p>
              </figure>
            ) : null}
            {kind === 'app-icon' && has('AppIcon-1024.png') ? (
              <figure className="ms-idn-fig">
                <span className="ms-idn-mask ms-idn-ios" aria-hidden="true"><img src={url('AppIcon-1024.png')} alt="" draggable={false} /></span>
                <figcaption>{i.iosIcon}</figcaption>
              </figure>
            ) : null}
            {kind === 'app-icon' && has('ic_launcher_foreground.png') ? (
              <figure className="ms-idn-fig">
                <span className="ms-idn-mask ms-idn-circle" aria-hidden="true">
                  {has('ic_launcher_background.png') ? <img className="ms-idn-layer" src={url('ic_launcher_background.png')} alt="" draggable={false} /> : null}
                  <img className="ms-idn-layer" src={url('ic_launcher_foreground.png')} alt="" draggable={false} />
                  <span className="ms-idn-safe" style={{ inset: `${((1 - ADAPTIVE_FOREGROUND_SCALE) / 2) * 100}%` }} />
                </span>
                <figcaption>{i.androidIcon} · {i.safeZone} 66/108</figcaption>
                <p className="ms-idn-safenote">{i.safeZoneNote({ pct: Math.round(ADAPTIVE_FOREGROUND_SCALE * 100) })}</p>
              </figure>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
