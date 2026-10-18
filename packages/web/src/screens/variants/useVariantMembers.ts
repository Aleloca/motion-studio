// The details of the other members of a variant group (Phase 15): their boards sit on the same canvas as the open creative's.
// Reloaded when a member changes (its live tick) or the list of members does. A member that cannot be read is simply absent.
import type { CreativeDetail, VariantGroup, VariantId } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api.ts';

export function useVariantMembers(project: string, group: VariantGroup | null, self: string, missing: readonly VariantId[], ticks: Record<string, number>): Record<string, CreativeDetail> {
  const [details, setDetails] = useState<Record<string, CreativeDetail>>({});
  const others = group ? group.members.filter((m) => m.slug !== self && !missing.includes(m.letter)).map((m) => m.slug) : [];
  const key = others.map((s) => `${s}:${ticks[`${project}/${s}`] ?? 0}`).join('|');
  useEffect(() => {
    if (others.length === 0) { setDetails((d) => (Object.keys(d).length ? {} : d)); return; }
    let alive = true;
    for (const slug of others) {
      Promise.resolve().then(() => api.getCreative(project, slug))
        .then((d) => { if (alive) setDetails((all) => ({ ...all, [slug]: d })); })
        .catch(() => { if (alive) setDetails((all) => { if (!(slug in all)) return all; const { [slug]: _gone, ...rest } = all; return rest; }); });
    }
    return () => { alive = false; };
  }, [project, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return details;
}
