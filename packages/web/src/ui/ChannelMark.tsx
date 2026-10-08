import { siAppstore, siFacebook, siGoogleplay, siInstagram, siPinterest, siTiktok, siX, siYoutube } from 'simple-icons';
import { useT } from '../i18n.tsx';
import { cx } from './cx.ts';
import { ICONS } from './icons.ts';

export const CHANNELS = ['instagram', 'tiktok', 'youtube', 'facebook', 'linkedin', 'x', 'pinterest', 'appstore', 'googleplay', 'web'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Brand tile colours (data, not theme tokens): from the prototype's channel chips, chosen so the white glyph reads
 * on every tile. Exported so screens can reuse them without literal colours of their own.
 */
export const CHANNEL_COLORS: Readonly<Record<Channel, string>> = {
  instagram: '#C13584',
  tiktok: '#111111',
  youtube: '#E62117',
  facebook: '#1877F2',
  linkedin: '#0A66C2',
  x: '#111111',
  pinterest: '#E60023',
  appstore: '#0D96F6',
  googleplay: '#01875F',
  web: '#525252',
};

/** Glyph colour on every brand tile (data, like the tile colours). */
export const CHANNEL_GLYPH_COLOR = '#FFFFFF';

/**
 * LinkedIn is not in Simple Icons any more (removed at the brand's request), so its "in" glyph is drawn here in the
 * same 24×24 box as the other marks.
 */
const LINKEDIN_IN = 'M5.3 3.4a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2ZM3.5 9.1h3.6v11.5H3.5ZM9.4 9.1h3.45v1.57h.05c.48-.91 1.65-1.87 3.4-1.87 3.64 0 4.3 2.4 4.3 5.5v6.3h-3.59v-5.58c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.95v5.67H9.4Z';

const PATHS: Readonly<Record<Exclude<Channel, 'web'>, string>> = {
  instagram: siInstagram.path,
  tiktok: siTiktok.path,
  youtube: siYoutube.path,
  facebook: siFacebook.path,
  linkedin: LINKEDIN_IN,
  x: siX.path,
  pinterest: siPinterest.path,
  appstore: siAppstore.path,
  googleplay: siGoogleplay.path,
};

export interface ChannelMarkProps { channel: Channel; size?: 16 | 20; className?: string }

/** Official channel logo (Simple Icons, CC0) in white on a tile of the brand colour; `web` shows the globe icon. */
export function ChannelMark({ channel, size = 16, className }: ChannelMarkProps) {
  const t = useT();
  const names: Record<Channel, string> = {
    instagram: t.channels.instagram, tiktok: t.channels.tikTok, youtube: t.channels.youTube, facebook: t.channels.facebook,
    linkedin: t.channels.linkedIn, x: t.channels.x, pinterest: t.channels.pinterest, appstore: t.channels.appStore,
    googleplay: t.channels.playStore, web: t.channels.web,
  };
  const glyph = size === 20 ? 12 : 10;
  return (
    <span className={cx('ms-ch', size === 20 && 'ms-lg', className)} style={{ background: CHANNEL_COLORS[channel], color: CHANNEL_GLYPH_COLOR }} role="img" aria-label={names[channel]}>
      {channel === 'web' ? (
        <svg width={glyph} height={glyph} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={ICONS.globe} /></svg>
      ) : (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d={PATHS[channel]} /></svg>
      )}
    </span>
  );
}
