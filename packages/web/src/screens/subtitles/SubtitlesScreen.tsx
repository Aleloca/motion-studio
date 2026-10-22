import type { LocaleTag } from '@motion-studio/shared';
import { useT } from '../../i18n.tsx';
import { href } from '../../routes.ts';
import { go } from '../../shell/ShellContext.tsx';
import { Button, Icon } from '../../ui/index.ts';

/** The subtitle editor (spec §6.3, layout B). The shell for now: the title and the way back; the next tasks fill it. */
export function SubtitlesScreen({ slug, creative, lang }: { slug: string; creative: string; lang?: LocaleTag }) {
  const t = useT();
  return (
    <main className="ms-subs" data-lang={lang}>
      <Button variant="ghost" size="sm" onClick={() => go(href.creative(slug, creative))}><Icon name="back" size={13} />{t.subtitles.backToCreative}</Button>
      <h1 className="ms-subs-title">{t.subtitles.editorTitle}</h1>
    </main>
  );
}
