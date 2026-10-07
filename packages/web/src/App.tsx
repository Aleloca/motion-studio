import type { DoctorCheck, WorkspaceInfo, WorkspaceSettings } from '@motion-studio/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { applyTheme, ThemeToggle } from './components/ThemeToggle.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { CreativePage } from './screens/CreativePage.tsx';
import { NewCreative } from './screens/NewCreative.tsx';
import { ProjectList } from './screens/ProjectList.tsx';
import { ProjectPage } from './screens/ProjectPage.tsx';
import { parseRoute } from './routes.ts';
import { useServerEvents } from './useServerEvents.ts';

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const live = useServerEvents();
  const route = useHashRoute();

  const refresh = useCallback(() => {
    setChecks(null);
    setLoadError(null);
    const fail = (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e));
    api.getDoctor().then(setChecks).catch(fail);
    api.getWorkspace().then((w) => { setWs(w); if (w.settings) applyTheme(w.settings.theme); }).catch(fail);
  }, []);
  useEffect(refresh, [refresh]);

  const blocking = checks?.some((c) => c.required && !c.ok) ?? true;
  if (!ws || !ws.settings || blocking) {
    return (
      <Onboarding checks={checks} workspacePath={ws?.path ?? null} workspaceError={ws?.error ?? null} error={loadError}
        onRecheck={refresh} onWorkspaceSet={refresh} />
    );
  }
  const settings = ws.settings;
  const update = async (patch: Partial<WorkspaceSettings>) => {
    setSettingsError(null);
    try {
      const next = await api.updateSettings(patch);
      applyTheme(next.theme);
      setWs((prev) => (prev ? { ...prev, settings: next } : prev));
    } catch (e) {
      setSettingsError(`Impossibile salvare le impostazioni: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const running = Object.values(live.jobs).filter((j) => j.state === 'running').length;
  const queued = Object.values(live.jobs).filter((j) => j.state === 'queued').length;
  const r = parseRoute(route);

  return (
    <>
      <header className="topbar">
        <a href="#/" style={{ fontWeight: 800, color: 'inherit', textDecoration: 'none' }}>Motion Studio</a>
        <span className="muted mono">{ws.path}</span>
        <div style={{ flex: 1 }} />
        <span className="muted">{running} in lavorazione · {queued} in coda</span>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={settings.expertMode} onChange={(e) => void update({ expertMode: e.target.checked })} style={{ width: 16, height: 16 }} />
          Modalità esperto
        </label>
        <ThemeToggle value={settings.theme} onChange={(theme) => void update({ theme })} />
      </header>
      {settingsError && <p role="alert" className="error page" style={{ margin: 0, paddingBottom: 0 }}>{settingsError}</p>}
      {r.name === 'project' && <ProjectPage key={r.slug} slug={r.slug} tab={r.tab} live={live} expert={settings.expertMode} />}
      {r.name === 'new-creative' && <NewCreative key={r.slug} slug={r.slug} />}
      {r.name === 'creative' && <CreativePage key={`${r.slug}/${r.creative}`} slug={r.slug} creative={r.creative} live={live} expert={settings.expertMode} />}
      {r.name === 'projects' && <ProjectList />}
    </>
  );
}
