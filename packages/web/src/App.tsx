import type { DoctorCheck, LanguageSetting, Locale, WorkspaceInfo, WorkspaceSettings } from '@motion-studio/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { ApprovalsIndicator } from './components/ApprovalsIndicator.tsx';
import { applyTheme, ThemeToggle } from './components/ThemeToggle.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { CreativePage } from './screens/CreativePage.tsx';
import { NewCreative } from './screens/NewCreative.tsx';
import { ProjectList } from './screens/ProjectList.tsx';
import { SettingsPage } from './screens/SettingsPage.tsx';
import { ProjectPage } from './screens/ProjectPage.tsx';
import { detectedLocale, I18nProvider, useLocale, useT, type LanguageState } from './i18n.tsx';
import { href, parseRoute } from './routes.ts';
import { usePairingNeeded } from './uiToken.ts';
import type { EventsState } from './eventsReducer.ts';
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

/** Owns the UI language: the snapshot and `locale` events set it, the language selector applies a change at once. */
export function App() {
  const live = useServerEvents();
  const [chosen, setChosen] = useState<LanguageState | null>(null);
  // A server message supersedes a choice made here (both carry the same value unless another client changed it).
  useEffect(() => { if (live.language) setChosen(live.language); }, [live.language]);
  const language = chosen ?? live.language;
  const locale = language?.locale ?? detectedLocale();
  return (
    <I18nProvider locale={locale}>
      <AppBody live={live} language={language?.setting ?? 'system'} systemLocale={language?.systemLocale ?? detectedLocale()} onLanguage={setChosen} />
    </I18nProvider>
  );
}

function AppBody({ live, language, systemLocale, onLanguage }: { live: EventsState; language: LanguageSetting; systemLocale: Locale; onLanguage(next: LanguageState): void }) {
  const t = useT();
  const locale = useLocale();
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const route = useHashRoute();
  const pairing = usePairingNeeded();
  const notified = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Only the pending requests are remembered: the set never grows beyond them.
    for (const id of notified.current) if (!live.approvals[id]) notified.current.delete(id);
    for (const a of Object.values(live.approvals)) {
      if (notified.current.has(a.id)) continue;
      notified.current.add(a.id);
      try {
        if (typeof Notification !== 'undefined' && document.visibilityState === 'hidden' && Notification.permission === 'granted') {
          new Notification(t.web.app.approvalNotificationTitle, { body: a.title });
        }
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  }, [live.approvals, t]);

  const refresh = useCallback(() => {
    setChecks(null);
    setLoadError(null);
    const fail = (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e));
    api.getDoctor().then(setChecks).catch(fail);
    api.getWorkspace().then((w) => { setWs(w); if (w.settings) applyTheme(w.settings.theme); }).catch(fail);
  }, []);
  useEffect(refresh, [refresh]);
  // The core writes the doctor texts in its current language: reload them after a switch (the first load is above).
  const doctorLocale = useRef(locale);
  useEffect(() => {
    if (doctorLocale.current === locale) return;
    doctorLocale.current = locale;
    let stale = false;
    // The previous checks stay on screen until the new ones arrive (no flash of the onboarding).
    api.getDoctor().then((c) => { if (!stale) setChecks(c); }).catch(() => { /* keep the previous checks */ });
    return () => { stale = true; };
  }, [locale]);
  // Paired again (a new link was pasted): reload what failed while the token was refused.
  const wasPairing = useRef(pairing);
  useEffect(() => {
    if (wasPairing.current && !pairing) refresh();
    wasPairing.current = pairing;
  }, [pairing, refresh]);

  const blocking = checks?.some((c) => c.required && !c.ok) ?? true;
  if (pairing) {
    return (
      <main className="page stack" style={{ maxWidth: 640 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Motion Studio</h1>
        <p role="alert" style={{ margin: 0 }}>{t.pairing.openFromLink}</p>
        <p className="muted" style={{ margin: 0 }}>{t.web.app.pairingHintBefore}<span className="mono">motion-studio --print-url</span>{t.web.app.pairingHintAfter}</p>
      </main>
    );
  }
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
      setSettingsError(t.web.app.settingsSaveFailed({ detail: e instanceof Error ? e.message : String(e) }));
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
        <ApprovalsIndicator approvals={Object.values(live.approvals)} />
        <span className="muted">{t.web.app.activity({ running, queued })}</span>
        <a href={href.settings()} style={{ color: 'inherit' }}>{t.web.app.settings}</a>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={settings.expertMode} onChange={(e) => void update({ expertMode: e.target.checked })} style={{ width: 16, height: 16 }} />
          {t.web.app.expertMode}
        </label>
        <ThemeToggle value={settings.theme} onChange={(theme) => void update({ theme })} />
      </header>
      {settingsError && <p role="alert" className="error page" style={{ margin: 0, paddingBottom: 0 }}>{settingsError}</p>}
      {r.name === 'project' && <ProjectPage key={r.slug} slug={r.slug} tab={r.tab} live={live} expert={settings.expertMode} />}
      {r.name === 'new-creative' && <NewCreative key={r.slug} slug={r.slug} />}
      {r.name === 'creative' && <CreativePage key={`${r.slug}/${r.creative}`} slug={r.slug} creative={r.creative} live={live} expert={settings.expertMode} />}
      {r.name === 'projects' && <ProjectList />}
      {r.name === 'settings' && <SettingsPage settings={settings} checks={checks} language={language} systemLocale={systemLocale} onLanguage={onLanguage} onSaved={(next) => { applyTheme(next.theme); setWs((prev) => (prev ? { ...prev, settings: next } : prev)); }} />}
    </>
  );
}
