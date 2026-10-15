// The bar button that opens the Languages panel. Only for a creative whose brief has languages (old briefs show nothing).
import type { CreativeDetail, FormatPreset, VersionEntry } from '@motion-studio/shared';
import { useState } from 'react';
import type { EventsState } from '../../eventsReducer.ts';
import { useT } from '../../i18n.tsx';
import { Button, Icon, Tooltip } from '../../ui/index.ts';
import { LanguagesPanel } from './LanguagesPanel.tsx';
import { creativeLocales } from './languagesModel.ts';

export function LanguagesButton({ slug, creative, detail, version, presets, live, onChanged }: {
  slug: string; creative: string; detail: CreativeDetail | null; version: VersionEntry | null | undefined; presets: FormatPreset[]; live: EventsState; onChanged?(): void;
}) {
  const l = useT().web.languages;
  const [open, setOpen] = useState(false);
  const langs = detail ? creativeLocales(detail.creative.brief) : null;
  if (!detail || !langs || langs.extra.length === 0 || !version) return null;
  return (
    <>
      <Tooltip label={l.button} whenHidden=".ms-bar-label"><Button variant="outline" className="ms-cv-languages ms-fold-2" aria-label={l.button} onClick={() => setOpen(true)}>
        <Icon name="globe" size={13} strokeWidth={1.7} /><span className="ms-bar-label">{l.button}</span>
      </Button></Tooltip>
      <LanguagesPanel open={open} onClose={() => setOpen(false)} slug={slug} creative={creative} detail={detail} version={version} presets={presets} live={live} {...(onChanged ? { onChanged } : {})} />
    </>
  );
}
