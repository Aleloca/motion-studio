import type { ApprovalRequest, DoctorCheck, LanguageSetting, Locale, WorkspaceInfo, WorkspaceSettings } from '@motion-studio/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from './api.ts';
import { detectedLocale, I18nProvider, useLocale, type LanguageState } from './i18n.tsx';
import { PageHost } from './motion/index.ts';
import { depthOf, href, parseRoute, projectOf, routeKey, type ProjectTab, type Route } from './routes.ts';
import { CreativePage } from './screens/CreativePage.tsx';
import { NewCreative } from './screens/NewCreative.tsx';
import { Pairing } from './screens/Pairing.tsx';
import { ProjectList } from './screens/ProjectList.tsx';
import { ProjectPage } from './screens/ProjectPage.tsx';
import { SettingsPage } from './screens/SettingsPage.tsx';
import { Welcome } from './screens/Welcome.tsx';
import { useCatalog } from './shell/catalog.ts';
import { CommandPalette } from './shell/CommandPalette.tsx';
import { go, isMac, ShellContext, type ActivityTab, type Shell } from './shell/ShellContext.tsx';
import { TopBar } from './shell/TopBars.tsx';
import { useAttention } from './shell/useAttention.ts';
import { applyTheme } from './theme.ts';
import { Spinner, Toasts } from './ui/index.ts';
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
      {/* The one toast stack of the app (spec §4.3), above every screen including the setup. */}
      <Toasts />
    </I18nProvider>
  );
}

/** `seq` grows with every request to show a tab, so a request reaches an activity center that is already open. */
interface ActivityState { open: boolean; tab: ActivityTab | null; seq: number }
interface Props { live: EventsState; language: LanguageSetting; systemLocale: Locale; onLanguage(next: LanguageState): void }

function AppBody({ live, language, systemLocale, onLanguage }: Props) {
  const locale = useLocale();
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const hash = useHashRoute();
  // One route object per hash: the page hosts compare it by identity.
  const route = useMemo(() => parseRoute(hash), [hash]);
  const pairing = usePairingNeeded();

  // Attention signals (title, Dock badge, notification, toast) follow the pending approvals on every screen.
  const [activity, setActivity] = useState<ActivityState>({ open: false, tab: null, seq: 0 });
  const approvals = useMemo(() => Object.values(live.approvals), [live.approvals]);
  // "Review": the creative's conversation shows the request in context; otherwise (or when already there) the
  // activity center opens on Needs you.
  const review = useCallback((a: ApprovalRequest) => {
    const target = a.creativeSlug ? href.creative(a.projectSlug, a.creativeSlug) : null;
    if (target && location.hash !== target) go(target);
    else setActivity((a) => ({ open: true, tab: 'needs', seq: a.seq + 1 }));
  }, []);
  useAttention(approvals.length, approvals, { onReview: review, snapshot: live.snapshots ?? 0 });

  const refresh = useCallback(() => {
    setChecks(null);
    setLoadError(null);
    const fail = (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e));
    api.getDoctor().then(setChecks).catch(fail);
    // The stored theme is applied on load (the switch itself lives in Settings).
    api.getWorkspace().then((w) => { setWs(w); if (w.settings) applyTheme(w.settings.theme); }).catch(fail);
  }, []);
  useEffect(refresh, [refresh]);
  // The core writes the doctor texts in its current language: reload them after a switch (the first load is above).
  const doctorLocale = useRef(locale);
  useEffect(() => {
    if (doctorLocale.current === locale) return;
    doctorLocale.current = locale;
    let stale = false;
    // The previous checks stay on screen until the new ones arrive (no flash of the setup).
    api.getDoctor().then((c) => { if (!stale) setChecks(c); }).catch(() => { /* keep the previous checks */ });
    return () => { stale = true; };
  }, [locale]);
  // Paired again (a new link was pasted): reload what failed while the token was refused.
  const wasPairing = useRef(pairing);
  useEffect(() => {
    if (wasPairing.current && !pairing) refresh();
    wasPairing.current = pairing;
  }, [pairing, refresh]);

  // The setup shows when the workspace is missing or a required check fails (and on Replay setup). Once it opened
  // for a missing setup it stays until the user finishes it: saving the workspace at step 2 must not skip step 3.
  const loaded = checks !== null && ws !== null;
  const blocking = checks?.some((c) => c.required && !c.ok) ?? true;
  const needsSetup = !ws || !ws.settings || blocking;
  const [setupOpen, setSetupOpen] = useState(false);
  useEffect(() => { if (loaded && needsSetup) setSetupOpen(true); }, [loaded, needsSetup]);
  const finishSetup = useCallback((hash: string) => {
    setSetupOpen(false);
    if (location.hash !== hash) go(hash);
  }, []);

  if (pairing) return <Pairing />;
  if (route.name === 'welcome' || setupOpen || (loaded && needsSetup) || loadError) {
    return (
      <Welcome
        checks={checks} loadError={loadError} workspace={ws} step={route.name === 'welcome' ? route.step : undefined}
        canLeave={loaded && !needsSetup} language={language} systemLocale={systemLocale} onLanguage={onLanguage}
        onRecheck={refresh} onFinish={finishSetup}
        onWorkspace={(next) => { applyTheme(next.settings.theme); setWs({ path: next.path, settings: next.settings, error: null }); }}
      />
    );
  }
  // First load: nothing to show yet (no flash of the setup when everything is in place).
  if (!checks || !ws?.settings) return <div className="ms-boot"><Spinner size={18} /></div>;
  return (
    <AppShell
      route={route} live={live} settings={ws.settings} checks={checks} activity={activity} setActivity={setActivity}
      language={language} systemLocale={systemLocale} onLanguage={onLanguage}
      onSettings={(next) => { applyTheme(next.theme); setWs((prev) => (prev ? { ...prev, settings: next } : prev)); }}
    />
  );
}

interface ShellProps extends Props {
  route: Route;
  settings: NonNullable<WorkspaceInfo['settings']>;
  checks: DoctorCheck[] | null;
  activity: ActivityState;
  setActivity: Dispatch<SetStateAction<ActivityState>>;
  onSettings(next: WorkspaceSettings): void;
}

/**
 * The app shell (spec §6.1, §7): the bar of the current route over a full-height stage where pages change with T1
 * (direction from the route depth) and project tabs with T2. Old screens render inside until later tasks replace them.
 */
function AppShell({ route, live, settings, checks, activity, setActivity, language, systemLocale, onLanguage, onSettings }: ShellProps) {
  const current = projectOf(route);
  const tick = current ? (live.projectTicks[current] ?? 0) + Object.entries(live.creativeTicks).filter(([k]) => k.startsWith(`${current}/`)).reduce((a, [, v]) => a + v, 0) : 0;
  const catalog = useCatalog(current, tick);
  const [palette, setPalette] = useState(false);

  // ⌘K / Ctrl+K toggles the command palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      // ⌘ on Mac (where Ctrl+K is a text-field shortcut), Ctrl elsewhere.
      const mac = isMac();
      if (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // A page change closes the activity center (its rows navigate).
  const key = routeKey(route);
  useEffect(() => { setActivity((a) => (a.open ? { ...a, open: false } : a)); }, [key, setActivity]);

  const shell = useMemo((): Shell => ({
    route,
    live,
    catalog,
    activity: {
      ...activity,
      show: (tab) => setActivity((a) => ({ open: true, tab: tab ?? null, seq: a.seq + 1 })),
      hide: () => setActivity((a) => ({ ...a, open: false })),
      toggle: () => setActivity((a) => ({ open: !a.open, tab: null, seq: a.seq })),
    },
    openPalette: () => setPalette(true),
  }), [route, live, catalog, activity, setActivity]);

  const expert = settings.expertMode;
  const render = (r: Route) => {
    switch (r.name) {
      case 'projects': return <ProjectList />;
      case 'project': return <ProjectHost route={r} live={live} expert={expert} />;
      case 'new-creative': return <NewCreative key={r.slug} slug={r.slug} />;
      // The format view (Task 13) opens on the creative until then.
      case 'creative': case 'format': return <CreativePage key={`${r.slug}/${r.creative}`} slug={r.slug} creative={r.creative} live={live} />;
      // Every section maps to the current settings page until the new one (Task 15).
      case 'settings': return <SettingsPage settings={settings} checks={checks} language={language} systemLocale={systemLocale} onLanguage={onLanguage} onSaved={onSettings} />;
      // The setup is a full page of its own, outside the shell (AppBody renders it).
      case 'welcome': return null;
    }
  };

  return (
    <ShellContext.Provider value={shell}>
      <div className="ms-app">
        <TopBar />
        <div className="ms-main">
          <PageHost route={route} keyOf={routeKey} depthOf={depthOf} render={render} />
        </div>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} catalog={catalog} route={route} />
    </ShellContext.Provider>
  );
}

/** A project page: its tabs change in place with T2 (soft fade and 6 px lift). */
function ProjectHost({ route, live, expert }: { route: Extract<Route, { name: 'project' }>; live: EventsState; expert: boolean }) {
  return (
    <PageHost
      route={route}
      keyOf={(r) => r.tab}
      soft
      render={(r) => <ProjectPage key={r.slug} slug={r.slug} tab={r.tab as ProjectTab} live={live} expert={expert} embedded />}
    />
  );
}
