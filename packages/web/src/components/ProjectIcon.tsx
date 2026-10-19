// Report 44: a project's icon (an image of its library, automatic or chosen) in a rounded square, the picture contained on a
// neutral background; the initials (`children`) when there is none or its file cannot be read.
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api.ts';
import { cx } from '../ui/index.ts';

export function ProjectIconBox({ slug, icon, className, style, children }: {
  slug: string | undefined; icon: string | null | undefined; className: string; style?: CSSProperties | undefined; children: ReactNode;
}) {
  const src = slug && icon ? api.projectFileUrl(slug, icon) : null;
  const [broken, setBroken] = useState<string | null>(null);
  if (src && broken !== src) {
    return <span className={cx(className, 'ms-has-icon')} aria-hidden="true"><img src={src} alt="" onError={() => setBroken(src)} /></span>;
  }
  return <span className={className} style={style} aria-hidden="true">{children}</span>;
}
