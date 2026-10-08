# Motion Studio — Fase 5: App desktop, export e distribuzione — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Motion Studio diventa installabile come **app desktop Electron** (macOS, Windows, Linux) che avvia il core in-process, offre dialog nativi (scelta del workspace, delle codebase collegate, della cartella di export) e aggiornamenti automatici; l'utente può **esportare gli output di una versione in una cartella scelta** con nomi per canale e **aggiungere formati a una creatività riusando i sorgenti**; il pacchetto npm `motion-studio-app` (`npx motion-studio-app`) e le pipeline GitHub Actions (CI e release firmate) sono pronti. La pubblicazione (tag, release, npm) resta all'utente.

**Architecture:** Nuova app `apps/desktop` (Electron 44, `electron-builder` 26, `electron-updater` 6). Il main process risolve il `PATH` della shell di login (le app avviate dal Finder non lo ereditano), avvia `startServer` del core su `127.0.0.1` (porta 4318 o libera) e carica la UI da quell'URL in una `BrowserWindow` isolata (`contextIsolation`, `sandbox`, niente `nodeIntegration`); un preload espone solo `window.motionStudio` (`isDesktop`, `pickFolder`, `revealPath`). Il server MCP gira con il binario di Electron in modalità Node (`ELECTRON_RUN_AS_NODE=1`). La UI web rileva `window.motionStudio` e usa i dialog nativi, altrimenti un campo di testo.

**Tech Stack:** come Fase 4; nuovi: `electron@^44`, `electron-builder@^26`, `electron-updater@^6`.

**Spec:** `docs/superpowers/specs/2026-10-07-motion-studio-design.md` (§2 involucri, §6.2.6 re-render, §6.2.7 export, §11 distribuzione, §12 fase 5). Decisioni: `docs/decisions-log.md` (voci 64–65). Base: `main` dopo la Fase 4 (`fb83a80`).

## Global Constraints

- Tutti i vincoli delle fasi 1–4 restano validi (sandbox, approvazioni, loopback-only con Host/Origin, token UI della Fase 4 consegnato solo nell'URL aperto, chiavi solo nel core e mai nell'ambiente dell'agente, `.git`/`.claude`/`CLAUDE.md`/`.studio` protetti, copy in italiano, token CSS).
- **Nessuna pubblicazione**: niente tag `v*`, niente release GitHub, niente `npm publish`, niente firma/notarizzazione eseguita (le pipeline sono pronte e scattano solo su tag creati dall'utente). Il push su `main` dei file di workflow è consentito (la CI su push è innocua).
- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`; navigazione limitata all'origine del core (link esterni → browser di sistema); una sola istanza (`requestSingleInstanceLock`).
- La UI non chiama mai API di Electron direttamente: solo `window.motionStudio` (preload), con fallback web.
- Pacchetto npm: nome `motion-studio-app`, comando `motion-studio`.
- Export: mai sovrascrivere file esistenti nella destinazione (suffisso `-2`, `-3`…); destinazione assoluta, creata se manca; nessuna scrittura fuori dalla destinazione.

## Review Focus

1. **App avviata dal Finder senza PATH**: `claude`, `git`, `ffmpeg` installati via Homebrew/npm globale vengono trovati (PATH della shell di login); se la shell fallisce o va in timeout l'app parte comunque con il PATH di sistema e il Doctor lo segnala. → test in Task 1.
2. **Export ostile o scomodo** (destinazione relativa, file al posto della cartella, cartella non scrivibile, nomi già presenti, versione inesistente, output mancanti): errori chiari, nessuna sovrascrittura. → test in Task 2.
3. **Renderer compromesso** (contenuto dell'agente servito nella UI): non ottiene Node, non apre finestre arbitrarie, non naviga fuori dall'origine; il preload espone solo le tre funzioni. → test in Task 4.
4. **Porta occupata / seconda istanza**: la seconda istanza porta in primo piano la prima; se 4318 è occupata si usa una porta libera. → test in Task 4.
5. **Pacchetto incompleto**: l'app impacchettata contiene UI, server MCP fuori dall'asar e il modulo nativo del portachiavi; il pacchetto npm contiene `dist/` con UI e server MCP. → verifica in Task 6 e Task 8.

---

## File Structure

```
packages/core/src/
  shell-path.ts                 # resolveLoginShellPath()
  creatives/export.ts           # exportVersion()
  server/main.ts                # (modify) port fallback, mcpEnv, host-shell PATH option
  server/creative-routes.ts     # (modify) POST …/versions/:n/export
  creatives/creative-turns.ts   # (modify) formats-only regeneration request
packages/web/src/
  desktop.ts                    # window.motionStudio typing + helpers
  components/ExportDialog.tsx   # export UI
  screens/Onboarding.tsx  components/CodebaseList.tsx  screens/CreativePage.tsx  # (modify) native pickers
apps/desktop/
  package.json  tsconfig.json  tsup.config.ts  electron-builder.yml
  src/main.ts  src/preload.ts  src/window.ts  src/updater.ts
  build/icon.png  build/entitlements.mac.plist
  test/window.test.ts  test/smoke.test.ts
apps/cli/package.json           # (modify) name motion-studio-app, metadata
.github/workflows/ci.yml  .github/workflows/release.yml
LICENSE  CONTRIBUTING.md  docs/output-contract.md  docs/providers.md  docs/agent-backends.md  README.md
```

---

### Task 1: PATH della shell di login e opzioni di avvio del core

**Files:**
- Create: `packages/core/src/shell-path.ts`, `packages/core/test/shell-path.test.ts`, `packages/core/test/start-server.test.ts`
- Modify: `packages/core/src/server/main.ts`, `packages/core/src/server/app.ts` (+ launcher deps: `mcpEnv`), `packages/core/src/agent/launcher.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces (`shell-path.ts`):
  ```ts
  export function resolveLoginShellPath(opts?: { shell?: string; timeoutMs?: number; exec?: CommandExec; platform?: NodeJS.Platform; current?: string }): Promise<{ path: string; source: 'login-shell' | 'fallback'; error?: string }>;
    // darwin/linux: runs `<shell> -ilc 'printf "__MS_PATH__%s__MS_END__" "$PATH"'` (shell = opts.shell ?? process.env.SHELL ?? '/bin/zsh'), timeout 5 s;
    // extracts the value between the markers (shells may print banners); merges it before `current` (dedup, keep order);
    // on error/timeout/empty → { path: current + ':/opt/homebrew/bin:/usr/local/bin' (deduped), source: 'fallback', error };
    // win32 → { path: current, source: 'fallback' } without running anything
  ```
- `startServer` options gain:
  - `port?: number | 'auto'` — `'auto'` tries `4318` and, on `EADDRINUSE`, listens on port `0`;
  - `mcpEnv?: Record<string, string>` — merged into the MCP server's `env` in the generated MCP config (Electron passes `{ ELECTRON_RUN_AS_NODE: '1' }`); flows `startServer → buildServer (ServerDeps.mcpEnv) → AgentLauncher (LauncherDeps.mcpEnv)`;
  - the returned object gains `port: number`.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/shell-path.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { CommandExec } from '../src/exec.ts';
import { resolveLoginShellPath } from '../src/shell-path.ts';

const out = (stdout: string, code = 0): CommandExec => async () => ({ code, stdout, stderr: '', notFound: false });

describe('resolveLoginShellPath', () => {
  it('extracts PATH between markers and merges it before the current one', async () => {
    const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin:/bin', exec: out('Welcome!\n__MS_PATH__/opt/homebrew/bin:/usr/bin:/Users/me/.npm-global/bin__MS_END__') });
    expect(r).toEqual({ path: '/opt/homebrew/bin:/usr/bin:/Users/me/.npm-global/bin:/bin', source: 'login-shell' });
  });
  it('falls back when the shell fails', async () => {
    const r = await resolveLoginShellPath({ platform: 'darwin', current: '/usr/bin', exec: out('', 1) });
    expect(r.source).toBe('fallback');
    expect(r.path).toBe('/usr/bin:/opt/homebrew/bin:/usr/local/bin');
  });
  it('does nothing on Windows', async () => {
    expect(await resolveLoginShellPath({ platform: 'win32', current: 'C:\\x', exec: out('x') })).toEqual({ path: 'C:\\x', source: 'fallback' });
  });
});
```

`packages/core/test/start-server.test.ts`:
```ts
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startServer } from '../src/server/main.ts';

describe('startServer port auto', () => {
  it('uses 4318 when free and a random port when busy', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(4318, '127.0.0.1', () => r())).catch(() => {});
    const configDir = await mkdtemp(join(tmpdir(), 'ms-ss-'));
    const s = await startServer({ port: 'auto', configDir, claudeCommand: ['true'] });
    try {
      expect(s.port).not.toBe(4318);
      expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    } finally {
      await s.close();
      blocker.close();
    }
  });
});
```
(If 4318 cannot be bound by the test itself because something else already uses it, the assertion still holds.)

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/shell-path.test.ts packages/core/test/start-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa**

`shell-path.ts`:
```ts
import { execCommand, type CommandExec } from './exec.ts';

const merge = (...parts: string[]) => [...new Set(parts.join(':').split(':').filter(Boolean))].join(':');

export async function resolveLoginShellPath(opts: { shell?: string; timeoutMs?: number; exec?: CommandExec; platform?: NodeJS.Platform; current?: string } = {}) {
  const platform = opts.platform ?? process.platform;
  const current = opts.current ?? process.env.PATH ?? '';
  if (platform === 'win32') return { path: current, source: 'fallback' as const };
  const exec = opts.exec ?? execCommand;
  const shell = opts.shell ?? process.env.SHELL ?? '/bin/zsh';
  const r = await exec(shell, ['-ilc', 'printf "__MS_PATH__%s__MS_END__" "$PATH"'], { timeoutMs: opts.timeoutMs ?? 5000 });
  const found = r.code === 0 ? r.stdout.match(/__MS_PATH__([\s\S]*?)__MS_END__/)?.[1]?.trim() : undefined;
  if (found) return { path: merge(found, current), source: 'login-shell' as const };
  return { path: merge(current, '/opt/homebrew/bin', '/usr/local/bin'), source: 'fallback' as const, error: r.stderr.trim() || `codice ${r.code}` };
}
```

`main.ts`: `port: opts.port === 'auto' ? await listenAuto(app) : …` where `listenAuto` tries `app.listen({ port: 4318, host })` and on `EADDRINUSE` `app.listen({ port: 0, host })`; return `port` from `app.server.address()`. Pass `mcpEnv` down: `ServerDeps.mcpEnv?: Record<string, string>` → `LauncherDeps.mcpEnv` → spread into `mcpServers.studio.env` (after the token variables, which must not be overridable: spread `mcpEnv` first, then the Motion Studio variables).

Export `resolveLoginShellPath` from `index.ts`.

- [ ] **Step 4: Verifica e commit**

Run: `pnpm vitest run packages/core && pnpm typecheck`
```bash
git add -A
git commit -m "feat(core): login-shell PATH resolution, automatic port and MCP env for embedding"
```

---

### Task 2: Export di una versione in una cartella scelta

**Files:**
- Create: `packages/core/src/creatives/export.ts`, `packages/core/test/export.test.ts`
- Modify: `packages/core/src/server/creative-routes.ts`, `packages/core/test/creative-routes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ExportResult { destination: string; files: Array<{ from: string; to: string }> }
  export function exportVersion(opts: { creativeDir: string; version: VersionEntry; destination: string; slug: string }): Promise<ExportResult>;
    // destination: absolute (else 400), created with mkdir -p; a file at that path → 400; not writable → 400
    // for each output: source <creativeDir>/outputs/v<n>/<file> must be a regular file (lstat, no symlink) else skipped and listed as missing → if none copied: 404 'Nessun output da esportare per v<n>'
    // target name: `<slug>-<format>-v<n>.<ext>` (slug = creative slug), unique in destination (claimName-style: -2, -3…, never overwrite: copyFile with COPYFILE_EXCL)
  ```
- Route: `POST /api/projects/:slug/creatives/:c/versions/:n/export` body `{ destination: string }` → `ExportResult` (404 unknown version; 400 invalid destination). `~` expanded with `expandHome`.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/export.test.ts`:
```ts
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { exportVersion } from '../src/creatives/export.ts';

let creativeDir: string;
let dest: string;
const version: VersionEntry = {
  n: 2, commit: 'c', sessionId: 's', status: 'complete', createdAt: '2026-10-08T10:00:00.000Z', request: 'r', problems: [], tools: [], renderCommand: null, basedOn: null,
  outputs: [
    { format: 'instagram-reel-9x16', file: 'instagram-reel-9x16.mp4', width: 1080, height: 1920, durationSec: 6, verified: true, preview: null },
    { format: 'web-banner-300x250', file: 'web-banner-300x250.png', width: 300, height: 250, durationSec: null, verified: true, preview: null },
  ],
};
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ms-exp è '));
  creativeDir = join(base, 'creative');
  dest = join(base, 'Consegna cliente');
  await mkdir(join(creativeDir, 'outputs', 'v2'), { recursive: true });
  await writeFile(join(creativeDir, 'outputs', 'v2', 'instagram-reel-9x16.mp4'), 'video');
  await writeFile(join(creativeDir, 'outputs', 'v2', 'web-banner-300x250.png'), 'png');
});

describe('exportVersion', () => {
  it('copies outputs with channel names and never overwrites', async () => {
    const a = await exportVersion({ creativeDir, version, destination: dest, slug: 'lancio' });
    expect(a.files.map((f) => f.to.split('/').pop())).toEqual(['lancio-instagram-reel-9x16-v2.mp4', 'lancio-web-banner-300x250-v2.png']);
    const b = await exportVersion({ creativeDir, version, destination: dest, slug: 'lancio' });
    expect(b.files[0]!.to.endsWith('lancio-instagram-reel-9x16-v2-2.mp4')).toBe(true);
    expect((await readdir(dest)).length).toBe(4);
    expect(await readFile(join(dest, 'lancio-web-banner-300x250-v2.png'), 'utf8')).toBe('png');
  });
  it('rejects relative destinations and files', async () => {
    expect((await exportVersion({ creativeDir, version, destination: 'rel/dir', slug: 'x' }).catch((e) => e)).status).toBe(400);
    await writeFile(dest, 'x');
    expect((await exportVersion({ creativeDir, version, destination: dest, slug: 'x' }).catch((e) => e)).status).toBe(400);
  });
  it('skips symlinked outputs and fails when nothing is exportable', async () => {
    const lonely = { ...version, outputs: [{ ...version.outputs[0]!, file: 'leak.mp4' }] };
    await symlink('/etc/hosts', join(creativeDir, 'outputs', 'v2', 'leak.mp4'));
    expect((await exportVersion({ creativeDir, version: lonely, destination: dest, slug: 'x' }).catch((e) => e)).status).toBe(404);
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a non-writable destination', async () => {
    await mkdir(dest);
    await chmod(dest, 0o500);
    const err = await exportVersion({ creativeDir, version, destination: dest, slug: 'x' }).catch((e) => e);
    await chmod(dest, 0o700);
    expect(err.status).toBe(400);
  });
});
```
Append to `creative-routes.test.ts` a route test: after generating v1, `POST …/versions/1/export { destination: <tmp> }` → 200 with 2 files; `…/versions/9/export` → 404.

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/export.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `export.ts`**

```ts
import { access, constants, copyFile, lstat, mkdir } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import type { VersionEntry } from '@motion-studio/shared';
import { WorkspaceError } from '../workspace-store.ts';

export interface ExportResult { destination: string; files: Array<{ from: string; to: string }> }

async function copyUnique(from: string, dir: string, stem: string, ext: string): Promise<string> {
  for (let i = 1; ; i++) {
    const to = join(dir, i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`);
    try { await copyFile(from, to, constants.COPYFILE_EXCL); return to; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
}

export async function exportVersion(opts: { creativeDir: string; version: VersionEntry; destination: string; slug: string }): Promise<ExportResult> {
  const dest = opts.destination.trim();
  if (!isAbsolute(dest)) throw new WorkspaceError(400, 'Scegli una cartella di destinazione (percorso assoluto)');
  const info = await lstat(dest).catch(() => null);
  if (info && !info.isDirectory()) throw new WorkspaceError(400, 'La destinazione è un file, non una cartella');
  try { await mkdir(dest, { recursive: true }); await access(dest, constants.W_OK); }
  catch { throw new WorkspaceError(400, `Impossibile scrivere nella cartella ${dest}`); }
  const n = opts.version.n;
  const files: ExportResult['files'] = [];
  for (const o of opts.version.outputs) {
    const from = join(opts.creativeDir, 'outputs', `v${n}`, o.file);
    if (!(await lstat(from).catch(() => null))?.isFile()) continue;
    const ext = extname(o.file).toLowerCase();
    files.push({ from, to: await copyUnique(from, dest, `${opts.slug}-${o.format}-v${n}`, ext) });
  }
  if (!files.length) throw new WorkspaceError(404, `Nessun output da esportare per v${n}`);
  return { destination: dest, files };
}
```
Route in `creative-routes.ts`:
```ts
  app.post<{ Params: { slug: string; c: string; n: string }; Body: { destination?: unknown } }>('/api/projects/:slug/creatives/:c/versions/:n/export', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const version = (await ref.store.readVersions(ref.creativeSlug)).find((v) => v.n === Number(req.params.n));
    if (!version) throw new WorkspaceError(404, 'Versione non trovata');
    const destination = typeof req.body?.destination === 'string' ? expandHome(req.body.destination) : '';
    return exportVersion({ creativeDir: ref.store.dir(ref.creativeSlug), version, destination, slug: ref.creativeSlug });
  });
```

- [ ] **Step 4: Verifica e commit**

Run: `pnpm vitest run packages/core && pnpm typecheck`
```bash
git add -A
git commit -m "feat(core): export a version's outputs to a chosen folder with channel names"
```

---

### Task 3: Aggiungere formati riusando i sorgenti (spec §6.2.6)

**Files:**
- Modify: `packages/core/src/creatives/creative-turns.ts`, `packages/core/test/creative-turns.test.ts`

**Interfaces:**
- When a turn starts **without a message** and a previous version exists, compute `added = brief.formats − formats present in the latest version's outputs` and `removed = formats in the latest version − brief.formats`. If `added.length > 0` (formats-only change), the request text becomes:
  `Aggiungi i formati <id, id> riusando i sorgenti esistenti in work/ e lo stesso stile della versione <n>.` + (when the latest version has a `renderCommand`) ` Il comando di render della versione <n> era: <renderCommand>.` + ` Riconsegna tutti i formati richiesti.`
  Otherwise the existing `REGENERATE` text is used. The version's `request` records this text.

- [ ] **Step 1: Test che fallisce**

Append to `creative-turns.test.ts`:
```ts
  it('asks to add only the new formats reusing sources and the render command', async () => {
    await finalState((await service.start(ref)).id);
    await store.update(ref.creativeSlug, { brief: { ...brief, formats: [...brief.formats, 'instagram-reel-9x16'] } });
    await finalState((await service.start(ref)).id);
    const last = (await prompts()).at(-1)!;
    expect(last.prompt).toContain('Aggiungi i formati instagram-reel-9x16 riusando i sorgenti esistenti in work/ e lo stesso stile della versione 1.');
    expect(last.prompt).toContain('Il comando di render della versione 1 era: node render.js.');
    expect((await store.readVersions(ref.creativeSlug)).at(-1)!.request).toMatch(/^Aggiungi i formati instagram-reel-9x16/);
  });
```
(The fake claude writes `renderCommand: 'node render.js'` in the manifest.)

- [ ] **Step 2: Verifica che fallisca, implementa, verifica**

Implement the computation in `run()` where `request` is derived (before building the prompt). Run: `pnpm vitest run packages/core/test/creative-turns.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(core): adding formats to a creative reuses its sources and render command"
```

---

### Task 4: App Electron (`apps/desktop`)

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/tsup.config.ts`, `apps/desktop/src/main.ts`, `apps/desktop/src/window.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/test/window.test.ts`

**Interfaces:**
- `window.ts` (pure, testable without Electron):
  ```ts
  export const WEB_PREFERENCES: { contextIsolation: true; sandbox: true; nodeIntegration: false; webSecurity: true; preload: string };  // built by windowOptions(preloadPath)
  export function windowOptions(preloadPath: string): BrowserWindowConstructorOptions;   // 1440×900 min 1024×700, title 'Motion Studio', show: false, backgroundColor '#0E0F12' when dark else '#F4F4F1'
  export function isAppUrl(url: string, origin: string): boolean;                       // same origin only (protocol + host + port)
  export function externalUrlAllowed(url: string): boolean;                              // https: / http: / mailto: only
  ```
- `preload.ts` exposes via `contextBridge.exposeInMainWorld('motionStudio', { isDesktop: true, platform, pickFolder(title: string, defaultPath?: string): Promise<string | null>, revealPath(path: string): Promise<void> })` using `ipcRenderer.invoke('ms:pick-folder' | 'ms:reveal', …)`.
- `main.ts`:
  1. `app.requestSingleInstanceLock()`; second instance → focus the existing window.
  2. On `ready`: `const shell = await resolveLoginShellPath(); process.env.PATH = shell.path;` (log `shell.source`).
  3. `const { url, close } = await startServer({ port: 'auto', webDir: join(resourcesDir, 'web'), mcpServerPath: join(unpackedDir, 'mcp-studio.mjs'), mcpEnv: { ELECTRON_RUN_AS_NODE: '1' } })` where in dev `resourcesDir` points at `packages/web/dist` and `packages/mcp-studio/src/server.mjs`, and packaged at `process.resourcesPath/app.asar.unpacked/…` (see Task 6).
  4. `BrowserWindow(windowOptions(preload))`, `loadURL(<url with the UI token>)` — Phase 4 added a UI token delivered only in the opened URL (`#t=<token>`, stored in `<configDir>/ui-token`); use what `startServer` exposes for it (returned token or the file), never an HTTP endpoint, `ready-to-show` → show; `webContents.setWindowOpenHandler(({ url }) => (externalUrlAllowed(url) && shell.openExternal(url), { action: 'deny' }))`; `will-navigate` → `preventDefault()` unless `isAppUrl`; `session.setPermissionRequestHandler` → allow only `notifications`.
  5. IPC: `ms:pick-folder` → `dialog.showOpenDialog({ title, defaultPath, properties: ['openDirectory', 'createDirectory'] })` → path or null; `ms:reveal` → `shell.showItemInFolder(path)` only for absolute paths.
  6. Quit: `before-quit` → `await close()` once (prevent default until closed).
  7. Italian application menu (Modifica/Vista/Finestra/Aiuto with link to the GitHub repo).
  8. `--smoke-test` flag: start the server, `fetch(url + '/api/health')`, print `SMOKE_OK <url>` and `app.exit(0)` (exit 1 on failure) without opening a window.
- `package.json`: name `motion-studio-desktop`, private, `main: dist/main.cjs`, scripts `build` (tsup → `dist/main.cjs`, `dist/preload.cjs`; Electron main/preload as CommonJS bundles with `@motion-studio/*` bundled and `electron` external), `dev` (`electron .`), `smoke` (`electron . --smoke-test`); deps `electron-updater`; devDeps `electron`, `electron-builder`, `tsup`.

- [ ] **Step 1: Test che falliscono**

`apps/desktop/test/window.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { externalUrlAllowed, isAppUrl, windowOptions } from '../src/window.ts';

describe('window security', () => {
  it('locks down the renderer', () => {
    const o = windowOptions('/p/preload.cjs');
    expect(o.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: '/p/preload.cjs' });
  });
  it('keeps navigation on the core origin', () => {
    expect(isAppUrl('http://127.0.0.1:4318/#/p/acme', 'http://127.0.0.1:4318')).toBe(true);
    expect(isAppUrl('http://127.0.0.1:9999/', 'http://127.0.0.1:4318')).toBe(false);
    expect(isAppUrl('https://evil.example/', 'http://127.0.0.1:4318')).toBe(false);
    expect(isAppUrl('file:///etc/passwd', 'http://127.0.0.1:4318')).toBe(false);
  });
  it('opens only web and mail links externally', () => {
    expect(externalUrlAllowed('https://github.com/Aleloca/motion-studio')).toBe(true);
    expect(externalUrlAllowed('mailto:a@b.it')).toBe(true);
    expect(externalUrlAllowed('file:///Applications/Calculator.app')).toBe(false);
    expect(externalUrlAllowed('javascript:alert(1)')).toBe(false);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm install && pnpm vitest run apps/desktop`
Expected: FAIL.

- [ ] **Step 3: Implementa `window.ts`, `preload.ts`, `main.ts`**

`window.ts`:
```ts
import type { BrowserWindowConstructorOptions } from 'electron';

export function windowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1440, height: 900, minWidth: 1024, minHeight: 700, title: 'Motion Studio', show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, preload: preloadPath },
  };
}

export function isAppUrl(url: string, origin: string): boolean {
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

export function externalUrlAllowed(url: string): boolean {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; }
}
```
(`backgroundColor` per theme is set in `main.ts` with `nativeTheme.shouldUseDarkColors`.)

`preload.ts`:
```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('motionStudio', {
  isDesktop: true,
  platform: process.platform,
  pickFolder: (title: string, defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('ms:pick-folder', { title, defaultPath }),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('ms:reveal', path),
});
```

`main.ts` — implement the numbered behaviour above with Electron APIs (`app`, `BrowserWindow`, `dialog`, `ipcMain`, `Menu`, `nativeTheme`, `session`, `shell`); keep it under ~200 lines; every IPC handler validates its arguments (`typeof title === 'string'`, absolute paths only) and ignores calls from frames whose URL is not the app origin (`event.senderFrame.url`).

- [ ] **Step 4: Avvio in sviluppo**

Run: `pnpm --filter @motion-studio/web build && pnpm --filter motion-studio-desktop build && pnpm --filter motion-studio-desktop smoke`
Expected: output `SMOKE_OK http://127.0.0.1:<port>` e codice 0. (Electron needs no display for `--smoke-test` because no window is created; on Linux CI use `xvfb-run` if needed.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(desktop): Electron shell running the core in-process with a locked-down renderer"
```

---

### Task 5: UI — dialog nativi ed export

**Files:**
- Create: `packages/web/src/desktop.ts`, `packages/web/src/components/ExportDialog.tsx`, `packages/web/test/ExportDialog.test.tsx`, `packages/web/test/desktop.test.ts`
- Modify: `packages/web/src/screens/Onboarding.tsx`, `packages/web/src/components/CodebaseList.tsx`, `packages/web/src/screens/CreativePage.tsx`, `packages/web/src/api.ts`

**Interfaces:**
- `desktop.ts`:
  ```ts
  export interface DesktopBridge { isDesktop: true; platform: string; pickFolder(title: string, defaultPath?: string): Promise<string | null>; revealPath(path: string): Promise<void> }
  export function desktop(): DesktopBridge | null;   // window.motionStudio when it has isDesktop === true and the functions, else null
  ```
- `api.exportVersion(slug, c, n, destination): Promise<{ destination: string; files: Array<{ from: string; to: string }> }>`.
- `Onboarding`: when `desktop()` exists, a button `Scegli cartella…` next to the input fills it with the picked path (the text input stays editable).
- `CodebaseList`: same `Scegli cartella…` button (desktop only) filling the path field.
- `<ExportDialog slug creative version onClose />` (opened by a new `Esporta…` button in `CreativePage`'s header, enabled when a version is selected): destination field (desktop: `Scegli cartella…`; web: text input `Cartella di destinazione (percorso assoluto)`), `Esporta` → `api.exportVersion`; success shows `Esportati <n> file in <destination>` and, on desktop, `Mostra nella cartella` → `desktop().revealPath(destination)`; errors as `role="alert"`; `role="dialog"`, Escape closes.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/desktop.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { desktop } from '../src/desktop.ts';

afterEach(() => { delete (window as unknown as { motionStudio?: unknown }).motionStudio; });

describe('desktop()', () => {
  it('is null in the browser and returns the bridge in the app', () => {
    expect(desktop()).toBeNull();
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => '/x', revealPath: async () => {} };
    expect(desktop()?.platform).toBe('darwin');
  });
  it('ignores a malformed bridge', () => {
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true };
    expect(desktop()).toBeNull();
  });
});
```

`packages/web/test/ExportDialog.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = { exportVersion: vi.fn(async () => ({ destination: '/Users/me/Consegna', files: [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }] })) };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ExportDialog } = await import('../src/components/ExportDialog.tsx');

afterEach(() => { delete (window as unknown as { motionStudio?: unknown }).motionStudio; vi.clearAllMocks(); });

describe('ExportDialog', () => {
  it('exports to a typed folder in the browser', async () => {
    render(<ExportDialog slug="acme" creative="c1" version={2} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Cartella di destinazione (percorso assoluto)'), '/Users/me/Consegna');
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    await waitFor(() => expect(screen.getByText('Esportati 2 file in /Users/me/Consegna')).toBeTruthy());
    expect(api.exportVersion).toHaveBeenCalledWith('acme', 'c1', 2, '/Users/me/Consegna');
    expect(screen.queryByRole('button', { name: 'Mostra nella cartella' })).toBeNull();
  });
  it('uses the native picker and reveal in the app', async () => {
    const revealPath = vi.fn(async () => {});
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => '/Users/me/Consegna', revealPath };
    render(<ExportDialog slug="acme" creative="c1" version={2} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Esporta' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mostra nella cartella' }));
    expect(revealPath).toHaveBeenCalledWith('/Users/me/Consegna');
  });
});
```
Add to `Onboarding`/`CodebaseList` tests: with a fake bridge, clicking `Scegli cartella…` fills the input.

- [ ] **Step 2: Verifica che falliscano, implementa, verifica**

`desktop.ts`:
```ts
export interface DesktopBridge { isDesktop: true; platform: string; pickFolder(title: string, defaultPath?: string): Promise<string | null>; revealPath(path: string): Promise<void> }

export function desktop(): DesktopBridge | null {
  const b = (window as unknown as { motionStudio?: Partial<DesktopBridge> }).motionStudio;
  return b?.isDesktop === true && typeof b.pickFolder === 'function' && typeof b.revealPath === 'function' ? (b as DesktopBridge) : null;
}
```
Implement `ExportDialog` per Interfaces (same visual language as `FocusView`: overlay with `--scrim`, card), the pickers in `Onboarding`/`CodebaseList`, `api.exportVersion`, and the `Esporta…` button in `CreativePage`.

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(web): native folder pickers in the desktop app and export dialog"
```

---

### Task 6: Pacchetti desktop con electron-builder (build locale non firmata)

**Files:**
- Create: `apps/desktop/electron-builder.yml`, `apps/desktop/build/icon.png` (1024×1024), `apps/desktop/build/entitlements.mac.plist`, `apps/desktop/scripts/make-icon.mjs`
- Modify: `apps/desktop/package.json` (scripts `dist`, `dist:mac`, `dist:win`, `dist:linux`, `prepare-resources`), `apps/desktop/src/main.ts` (packaged resource paths)

**Interfaces:**
- `prepare-resources` copies `packages/web/dist` → `apps/desktop/resources/web` and `packages/mcp-studio/src/server.mjs` → `apps/desktop/resources/mcp-studio.mjs`.
- `electron-builder.yml`:
  ```yaml
  appId: io.github.aleloca.motionstudio
  productName: Motion Studio
  directories: { output: release, buildResources: build }
  files: [dist/**, package.json]
  extraResources:
    - { from: resources/web, to: web }
    - { from: resources/mcp-studio.mjs, to: mcp-studio.mjs }
  asarUnpack: ["**/node_modules/@napi-rs/keyring*/**"]
  mac: { category: public.app-category.video, target: [dmg, zip], hardenedRuntime: true, entitlements: build/entitlements.mac.plist, entitlementsInherit: build/entitlements.mac.plist }
  win: { target: [nsis] }
  linux: { target: [AppImage], category: Video }
  publish: { provider: github, owner: Aleloca, repo: motion-studio, releaseType: draft }
  ```
  In `main.ts`, packaged paths: `webDir = join(process.resourcesPath, 'web')`, `mcpServerPath = join(process.resourcesPath, 'mcp-studio.mjs')` (outside the asar, so the Electron binary in Node mode can execute it).
- `entitlements.mac.plist`: `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation` (needed by the native keyring module), `com.apple.security.network.client`, `com.apple.security.network.server`.
- `make-icon.mjs`: writes `build/icon.png` 1024×1024 (accent violet `#6D28D9` rounded square with a white play triangle) using `ffmpeg -f lavfi` + `drawbox`/a polygon via `geq`, or a minimal PNG encoder with `zlib` — whichever works offline; commit the generated PNG.

- [ ] **Step 1: Configurazione e icona**

Create the files above; run `node apps/desktop/scripts/make-icon.mjs`.

- [ ] **Step 2: Build locale non firmata (macOS)**

Run (on macOS): `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter motion-studio-desktop dist:mac -- --dir`
Expected: `apps/desktop/release/mac*/Motion Studio.app` creato (`--dir` evita dmg per velocità).

- [ ] **Step 3: Smoke test dell'app impacchettata**

Run: `"apps/desktop/release/mac-arm64/Motion Studio.app/Contents/MacOS/Motion Studio" --smoke-test` (path for the host arch)
Expected: `SMOKE_OK http://127.0.0.1:<port>` e codice 0. Verify also that `Contents/Resources/mcp-studio.mjs` and `Contents/Resources/web/index.html` exist and that `app.asar.unpacked/node_modules/@napi-rs/keyring*` contains the `.node` binary for the host arch.

- [ ] **Step 4: Ignora gli artefatti e commit**

Add `apps/desktop/release/` and `apps/desktop/resources/` to `.gitignore`.
```bash
git add -A
git commit -m "build(desktop): electron-builder config, icon and unsigned local packaging with smoke test"
```

---

### Task 7: Aggiornamenti automatici

**Files:**
- Create: `apps/desktop/src/updater.ts`, `apps/desktop/test/updater.test.ts`
- Modify: `apps/desktop/src/main.ts`

**Interfaces:**
- `updater.ts`:
  ```ts
  export interface UpdaterLike { checkForUpdates(): Promise<unknown>; on(event: 'update-downloaded', cb: (info: { version: string }) => void): void; quitAndInstall(): void; autoDownload: boolean }
  export function setupUpdates(opts: { updater: UpdaterLike; isPackaged: boolean; notify(message: string, onRestart: () => void): void; log(msg: string): void }): void;
    // not packaged → nothing; packaged → autoDownload = true, checkForUpdates() (errors logged, never thrown — no releases yet is normal),
    // on 'update-downloaded' → notify(`È disponibile Motion Studio ${version}: riavvia per aggiornare`, () => updater.quitAndInstall())
  ```
  In `main.ts`, `notify` shows a native `Notification` with a click handler that calls `onRestart` (and a menu item "Riavvia per aggiornare" when an update is ready).

- [ ] **Step 1: Test che falliscono**

`apps/desktop/test/updater.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { setupUpdates, type UpdaterLike } from '../src/updater.ts';

const fake = (check: () => Promise<unknown>) => {
  const handlers: Record<string, (i: { version: string }) => void> = {};
  const u: UpdaterLike & { fire(v: string): void } = {
    autoDownload: false, checkForUpdates: vi.fn(check), quitAndInstall: vi.fn(),
    on: (e, cb) => { handlers[e] = cb; }, fire: (v) => handlers['update-downloaded']!({ version: v }),
  };
  return u;
};

describe('setupUpdates', () => {
  it('does nothing in development', () => {
    const u = fake(async () => ({}));
    setupUpdates({ updater: u, isPackaged: false, notify: vi.fn(), log: vi.fn() });
    expect(u.checkForUpdates).not.toHaveBeenCalled();
  });
  it('checks, survives errors and offers a restart', async () => {
    const u = fake(async () => { throw new Error('no releases'); });
    const notify = vi.fn();
    const log = vi.fn();
    setupUpdates({ updater: u, isPackaged: true, notify, log });
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no releases'));
    u.fire('0.5.0');
    expect(notify.mock.calls[0]![0]).toBe('È disponibile Motion Studio 0.5.0: riavvia per aggiornare');
    notify.mock.calls[0]![1]();
    expect(u.quitAndInstall).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implementa, verifica, commit**

```ts
export interface UpdaterLike { checkForUpdates(): Promise<unknown>; on(event: 'update-downloaded', cb: (info: { version: string }) => void): void; quitAndInstall(): void; autoDownload: boolean }

export function setupUpdates(opts: { updater: UpdaterLike; isPackaged: boolean; notify(message: string, onRestart: () => void): void; log(msg: string): void }): void {
  if (!opts.isPackaged) return;
  opts.updater.autoDownload = true;
  opts.updater.on('update-downloaded', (info) => opts.notify(`È disponibile Motion Studio ${info.version}: riavvia per aggiornare`, () => opts.updater.quitAndInstall()));
  opts.updater.checkForUpdates().catch((e: unknown) => opts.log(`Controllo aggiornamenti non riuscito: ${e instanceof Error ? e.message : String(e)}`));
}
```
Wire it in `main.ts` with `autoUpdater` from `electron-updater`.
Run: `pnpm vitest run apps/desktop && pnpm --filter motion-studio-desktop build`
```bash
git add -A
git commit -m "feat(desktop): automatic updates from GitHub releases"
```

---

### Task 8: Pacchetto npm `motion-studio-app`, licenza e metadati

**Files:**
- Create: `LICENSE` (MIT, `Copyright (c) 2026 Aleloca`)
- Modify: `apps/cli/package.json`, `README.md` (install line), `apps/cli/src/main.ts` (HELP mentions `npx motion-studio-app`)

**Interfaces:**
- `apps/cli/package.json`: `"name": "motion-studio-app"`, `"version": "0.5.0"`, `"bin": { "motion-studio": "dist/main.js" }`, `"files": ["dist", "README.md", "LICENSE"]`, `"repository": { "type": "git", "url": "git+https://github.com/Aleloca/motion-studio.git", "directory": "apps/cli" }`, `"homepage"`, `"bugs"`, `"keywords": ["motion graphics", "video", "claude code", "ai", "remotion"]`, `"scripts": { …, "prepack": "pnpm run build && node -e \"…copy ../../README.md and ../../LICENSE…\"" }`. Root `package.json` scripts referring to `--filter motion-studio` change to `--filter motion-studio-app`.

- [ ] **Step 1: Aggiorna e verifica il contenuto del pacchetto**

Run: `pnpm --filter motion-studio-app build && cd apps/cli && npm pack --dry-run 2>&1 | tee /tmp/ms-pack.txt; cd -`
Expected: the list contains `dist/main.js`, `dist/mcp-studio.mjs`, `dist/web/index.html`, `README.md`, `LICENSE` and nothing from `src/` or `test/`.

- [ ] **Step 2: Installazione dal tarball in una cartella temporanea**

Run:
```bash
cd apps/cli && npm pack && cd - && T=$(mktemp -d) && cd "$T" && npm init -y >/dev/null && npm install "$OLDPWD/apps/cli/motion-studio-app-0.5.0.tgz" && MOTION_STUDIO_CONFIG_DIR="$(mktemp -d)" npx motion-studio --port 4397 --no-open & sleep 5; curl -s localhost:4397/api/health; kill %1
```
Expected: `{"ok":true}`. Remove the tarball afterwards (`apps/cli/*.tgz` in `.gitignore`).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "build(cli): publishable motion-studio-app package with license and metadata"
```

---

### Task 9: GitHub Actions (CI e release)

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: CI**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
permissions: { contents: read }
jobs:
  test:
    strategy:
      fail-fast: false
      matrix: { os: [ubuntu-latest, macos-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - name: Install ffmpeg
        run: ${{ matrix.os == 'macos-latest' && 'brew install ffmpeg' || 'sudo apt-get update && sudo apt-get install -y ffmpeg' }}
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Release (solo su tag creati dall'utente)**

`.github/workflows/release.yml`:
```yaml
name: Release
on:
  push: { tags: ['v*'] }
permissions: { contents: write }
jobs:
  desktop:
    strategy:
      fail-fast: false
      matrix: { os: [macos-latest, windows-latest, ubuntu-latest] }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Package and publish draft release
        run: pnpm --filter motion-studio-desktop dist -- --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ secrets.MAC_CERT_P12_BASE64 }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          WIN_CSC_LINK: ${{ secrets.WIN_CERT_PFX_BASE64 }}
          WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
          CSC_IDENTITY_AUTO_DISCOVERY: ${{ secrets.MAC_CERT_P12_BASE64 != '' }}
  npm:
    needs: desktop
    runs-on: ubuntu-latest
    if: ${{ secrets.NPM_TOKEN != '' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, registry-url: 'https://registry.npmjs.org', cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter motion-studio-app publish --access public --no-git-checks
        env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }
```
Note: GitHub does not allow `secrets` in `if:` at job level in every context; if the workflow linter rejects it, expose `NPM_TOKEN` as a job `env` and gate the publish step with `if: env.NPM_TOKEN != ''`. Validate the YAML with `npx --yes @action-validator/cli .github/workflows/*.yml` (or `actionlint` if available).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "ci: test workflow on push and tag-triggered signed release workflow"
```

---

### Task 10: Documentazione per utenti e contributori

**Files:**
- Create: `CONTRIBUTING.md`, `docs/output-contract.md`, `docs/providers.md`, `docs/agent-backends.md`
- Modify: `README.md`

- [ ] **Step 1: README**

Restructure `README.md` (Italian):
1. One-paragraph pitch + screenshot placeholder line `<!-- screenshot: aggiungere -->`.
2. **Installazione**: app desktop (download from GitHub Releases once published; unsigned builds note: macOS "apri con clic destro → Apri" the first time), oppure `npx motion-studio-app`, oppure dai sorgenti (`pnpm install && pnpm motion-studio`).
3. **Requisiti**: Claude Code installato e autenticato, Git, FFmpeg consigliato.
4. **Come funziona** (progetti, brand, asset, creatività, versioni, export) — keep the existing sections, add Export and "Aggiungere formati".
5. **Sicurezza** and **Provider** (from Phase 4, unchanged).
6. **Sviluppo** (pnpm scripts incl. `pnpm --filter motion-studio-desktop dev` / `smoke`).
7. **Rilascio** (maintainers): create tag `vX.Y.Z` → release workflow; required secrets list.
8. **Licenza** MIT.

- [ ] **Step 2: Guide**

- `docs/output-contract.md`: the contract of spec §4 as implemented (folder layout, `manifest.json` schema with an example, naming, validation rules and their Italian messages, auto-fix attempts, MCP `validate_output`).
- `docs/providers.md`: one section per provider (what it does, key, costs/confirmation, limits, attribution), how keys are stored, how to add a provider (interface in `packages/core/src/providers/*`, bridge tool in `provider-tools.ts`, MCP tool schema in `server.mjs`, tests with injected `fetch`).
- `docs/agent-backends.md`: the `AgentRunner` contract, `AgentLauncher` and the policy, the stream-event normalization, what a `CodexRunner` would need (spec principle 4).
- `CONTRIBUTING.md`: setup, monorepo map, TDD expectation, tests with the fake `claude`, commit style, no secrets in tests.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: installation, release process and contributor guides"
```

---

### Task 11: Verifica finale

**Files:** nessuno (solo verifica).

- [ ] **Step 1:** `pnpm test && pnpm typecheck && pnpm build` → tutto verde.
- [ ] **Step 2:** `pnpm --filter motion-studio-desktop smoke` (sviluppo) e smoke dell'app impacchettata (Task 6 Step 3) → `SMOKE_OK`.
- [ ] **Step 3:** App avviata con PATH ridotto, che simula il lancio dal Finder: `env -i HOME="$HOME" SHELL="$SHELL" PATH=/usr/bin:/bin "<app>/Contents/MacOS/Motion Studio" --smoke-test`. Deve mostrare `SMOKE_OK`; il PATH della shell di login viene risolto (log `login-shell`), quindi il Doctor trova `claude`. Verifica il Doctor con una variante `--smoke-test=doctor` che stampi gli id dei check ok, aggiunta al main se serve.
- [ ] **Step 4:** Installazione dal tarball npm (Task 8 Step 2) → `{"ok":true}`.
- [ ] **Step 5:** Export reale. Con il core avviato dal CLI e un workspace temporaneo, genera una creatività col finto claude (`FAKE_CLAUDE_SCENARIO=render`). Poi `POST …/versions/1/export {"destination":"<tmp>/Consegna"}` deve restituire 2 file con i nomi per canale.
- [ ] **Step 6:** Rapporto. Riporta gli esiti, le dimensioni degli artefatti e cosa resta all'utente: firma, notarizzazione, release, npm publish, segreti da configurare su GitHub, prova visiva dell'app.
