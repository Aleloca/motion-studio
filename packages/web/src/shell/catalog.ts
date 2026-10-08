import type { CreativeSummary, ProjectListItem } from '@motion-studio/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';

export interface ProjectEntry { slug: string; name: string }
export interface Catalog {
  /** null until the first load. */
  projects: ProjectEntry[] | null;
  /** Creatives of the projects visited in this session, by project slug. */
  creatives: Record<string, CreativeSummary[]>;
  refresh(): void;
}

const entries = (items: ProjectListItem[]): ProjectEntry[] =>
  items.flatMap((p) => (p.ok ? [{ slug: p.slug, name: p.project.name }] : []));

/**
 * What the bars and the command palette know about: the project list and the creatives of the projects visited
 * (spec: the palette searches `listProjects` and `listCreatives` of visited projects). Reloaded when the current
 * project changes or one of its creatives/the project changes (live ticks), and on `refresh()`.
 */
export function useCatalog(current: string | null, tick: number): Catalog {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [creatives, setCreatives] = useState<Record<string, CreativeSummary[]>>({});
  const visited = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadProjects = useCallback(() => {
    // Through a promise: a synchronous failure (no API) is handled like a rejected request.
    Promise.resolve().then(() => api.listProjects()).then((items) => { if (alive.current) setProjects(entries(items)); }).catch(() => { /* keep what we had */ });
  }, []);
  const loadCreatives = useCallback((slug: string) => {
    Promise.resolve().then(() => api.listCreatives(slug))
      .then((items) => { if (alive.current) setCreatives((all) => ({ ...all, [slug]: items.flatMap((c) => (c.ok ? [c] : [])) })); })
      .catch(() => { /* keep what we had */ });
  }, []);

  // The current project may be new (just created): reload the list when it changes.
  useEffect(() => { loadProjects(); }, [loadProjects, current]);
  useEffect(() => {
    if (!current) return;
    visited.current.add(current);
    loadCreatives(current);
  }, [loadCreatives, current, tick]);

  const refresh = useCallback(() => {
    loadProjects();
    for (const slug of visited.current) loadCreatives(slug);
  }, [loadProjects, loadCreatives]);

  return useMemo(() => ({ projects, creatives, refresh }), [projects, creatives, refresh]);
}
