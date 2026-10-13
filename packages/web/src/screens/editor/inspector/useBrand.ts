// The brand kit the inspector draws on: its palette (colour swatches) and which fonts have a file. Read once per project;
// a kit that cannot be read leaves the swatches of the composition only and the fonts selectable (the core refuses a
// brand font without a file when it is staged).
import type { BrandFont } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../../../api.ts';

export interface BrandInfo { colors: string[]; fonts: BrandFont[] | null }

export function useBrand(slug: string): BrandInfo {
  const [info, setInfo] = useState<BrandInfo>({ colors: [], fonts: null });
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getBrand(slug)).then((b) => {
      if (alive) setInfo({ colors: b.kit.colors.map((c) => c.hex), fonts: b.kit.fonts });
    }).catch(() => {});
    return () => { alive = false; };
  }, [slug]);
  return info;
}
