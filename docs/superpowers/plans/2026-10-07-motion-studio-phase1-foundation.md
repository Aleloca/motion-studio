# Motion Studio — Fase 1: Fondamenta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un'app locale avviabile con `pnpm motion-studio` (e, impacchettata, `npx motion-studio`) che: verifica l'ambiente (Doctor), fa scegliere il workspace, crea/elenca progetti come cartelle git, e permette di lanciare un turno di Claude Code dentro un progetto vedendo gli eventi in streaming nella UI (vista semplice ed esperto), con coda di job e annullamento.

**Architecture:** Monorepo pnpm. `packages/shared` contiene schemi zod e tipi condivisi. `packages/core` è un server Fastify (HTTP + WebSocket) che legge/scrive solo file nel workspace, lancia la CLI `claude -p` in modalità stream-json tramite `ClaudeCodeRunner` (dietro l'interfaccia `AgentRunner`), e serializza il lavoro in una `JobQueue`. `packages/web` è una SPA React (Vite) con temi chiaro/scuro a token. `apps/cli` avvia il core, serve la build web e apre il browser. Electron arriva nella fase 5.

**Tech Stack:** Node ≥ 22 (sviluppato su 24), pnpm 10, TypeScript 5.9 (ESM), zod 4, Fastify 5 + @fastify/websocket 11 + @fastify/static 8, ws 8, React 19 + Vite 7, Vitest 3 + Testing Library, tsup 8, tsx 4.

**Spec:** `docs/superpowers/specs/2026-10-07-motion-studio-design.md` (questa è la fase 1 di §12; fasi 2–5 avranno piani propri).

## Global Constraints

- Tutto locale: nessun database, lo stato vive su file nel workspace (JSON/Markdown + git). L'unica eccezione è il file di config dell'app che ricorda il percorso del workspace.
- Ogni file JSON scritto dall'app ha `schemaVersion` (in questa fase: `1`).
- File JSON non validi o modificati a mano: validazione zod con messaggio puntuale; **mai sovrascrivere senza conferma**.
- Un progetto = una cartella = un repo git. Struttura cartella come in spec §3 (`project.json`, `brand/`, `assets/`, `references/`, `creatives/`, `.studio/context.md`, `CLAUDE.md` che importa `.studio/context.md`, `.gitignore` con `outputs/`, `node_modules/`, `.venv/`).
- L'agente è invocato come `claude -p --input-format stream-json --output-format stream-json --verbose`, `cwd` = cartella del progetto; il comando è configurabile (`MOTION_STUDIO_CLAUDE_COMMAND`, JSON array, default `["claude"]`) per i test con un finto `claude`.
- L'interfaccia `AgentRunner` è neutra rispetto all'agente (futuro `CodexRunner`); niente tipi specifici di Claude fuori da `packages/core/src/agent/claude-*`.
- Parallelismo: limite globale configurabile, default `2`; un solo job attivo per chiave (es. per creatività/progetto).
- Le operazioni git sono serializzate per progetto.
- Temi chiaro e scuro, con "segui il sistema"; tutti i colori della UI sono token CSS.
- Copy UI in italiano.
- Porta di default del server: `4317`, bind solo su `127.0.0.1`.

## Review Focus

1. **Percorso workspace scomodo** (spazi, accenti, inesistente, file al posto di cartella, non scrivibile): creato se manca; errore chiaro 400 per file/non scrivibile; spazi e Unicode funzionano anche nello spawn di `claude` (niente shell). → test in Task 5 e Task 8.
2. **`claude` non installato o non autenticato**: il Doctor lo segnala con il comando di fix; un turno lanciato comunque fallisce subito con messaggio leggibile ("Comando claude non trovato…"), senza crash del server. → test in Task 6 e Task 8.
3. **Stream spezzato o sporco**: una riga JSON divisa su più chunk viene ricomposta; una riga non-JSON produce un evento `parse_error` e lo stream prosegue. → test in Task 7 e Task 8.
4. **Processo che muore o resta appeso**: uscita senza evento `result` → job `failed` con coda di stderr; Annulla su un processo appeso → job `cancelled` e processo terminato (nessuno zombie). → test in Task 8 e Task 9.
5. **`project.json` corrotto o modificato a mano**: il progetto appare in elenco come "non leggibile" con il motivo, gli altri progetti restano visibili, il file non viene riscritto. → test in Task 5.

---

## File Structure

```
package.json                     # root: script workspace, devDeps comuni
pnpm-workspace.yaml
tsconfig.base.json
vitest.workspace.ts
.gitignore
README.md                        # avvio sviluppo
packages/shared/
  package.json  tsconfig.json
  src/index.ts                   # re-export
  src/schemas.ts                 # zod: AppConfig, WorkspaceSettings, ProjectFile
  src/events.ts                  # AgentEvent, JobSummary, ServerMessage, DoctorCheck, ProjectListItem
  test/schemas.test.ts
packages/core/
  package.json  tsconfig.json
  src/index.ts
  src/json-file.ts               # read/validate + write atomico
  src/keyed-mutex.ts
  src/git.ts
  src/exec.ts                    # CommandExec (execFile senza shell)
  src/app-config.ts              # config dell'app (percorso workspace)
  src/project-template.ts        # contenuti file iniziali del progetto
  src/workspace-store.ts         # workspace, settings, progetti
  src/doctor.ts
  src/agent/runner.ts            # interfaccia AgentRunner (neutra)
  src/agent/claude-stream-parser.ts
  src/agent/claude-code-runner.ts
  src/jobs/job-queue.ts
  src/server/event-hub.ts
  src/server/app.ts              # buildServer(deps)
  src/server/main.ts             # startServer(options)
  test/fixtures/fake-claude.mjs
  test/fixtures/claude-stream-sample.jsonl
  test/*.test.ts
packages/web/
  package.json  tsconfig.json  vite.config.ts  index.html
  src/main.tsx  src/App.tsx
  src/theme.css                  # token chiaro/scuro
  src/api.ts                     # client HTTP tipizzato
  src/useServerEvents.ts         # WebSocket + reducer
  src/eventsReducer.ts
  src/screens/Onboarding.tsx
  src/screens/ProjectList.tsx
  src/screens/ProjectPage.tsx
  src/components/AgentConsole.tsx
  src/components/ThemeToggle.tsx
  test/eventsReducer.test.ts
  test/AgentConsole.test.tsx
apps/cli/
  package.json  tsconfig.json  tsup.config.ts
  src/args.ts  src/main.ts
  test/args.test.ts
```

---

### Task 1: Scaffold del monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/test/smoke.test.ts`

**Interfaces:**
- Produces: workspace pnpm con pacchetti `@motion-studio/shared`, `@motion-studio/core`, `@motion-studio/web`, `motion-studio` (cli); i pacchetti interni esportano direttamente `src/index.ts` (consumati da tsx/vite/vitest/tsup).

- [ ] **Step 1: File root**

`package.json`:
```json
{
  "name": "motion-studio-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.9.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck",
    "build": "pnpm --filter @motion-studio/web build && pnpm --filter motion-studio build",
    "dev": "pnpm --parallel --filter @motion-studio/core --filter @motion-studio/web dev",
    "motion-studio": "pnpm build && node apps/cli/dist/main.js"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.2.0",
    "@types/node": "^24.0.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "verbatimModuleSyntax": true
  }
}
```

`vitest.workspace.ts`:
```ts
export default ['packages/*', 'apps/*'];
```

`.gitignore`:
```
node_modules/
dist/
coverage/
*.log
.DS_Store
```

- [ ] **Step 2: Pacchetto shared minimo**

`packages/shared/package.json`:
```json
{
  "name": "@motion-studio/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" },
  "dependencies": { "zod": "^4.0.0" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/shared/src/index.ts`:
```ts
export const APP_NAME = 'Motion Studio';
```

`packages/shared/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../src/index.ts';

describe('shared', () => {
  it('exports the app name', () => {
    expect(APP_NAME).toBe('Motion Studio');
  });
});
```

- [ ] **Step 3: Installa e lancia i test**

Run: `pnpm install && pnpm test`
Expected: 1 test PASS.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with shared package"
```

---

### Task 2: Schemi e tipi condivisi

**Files:**
- Create: `packages/shared/src/schemas.ts`, `packages/shared/src/events.ts`, `packages/shared/test/schemas.test.ts`
- Modify: `packages/shared/src/index.ts`
- Delete: `packages/shared/test/smoke.test.ts`

**Interfaces:**
- Produces:
  - `appConfigSchema`, `type AppConfig = { schemaVersion: 1; workspacePath: string | null }`
  - `workspaceSettingsSchema`, `type WorkspaceSettings = { schemaVersion: 1; maxConcurrentJobs: number /*1..8, default 2*/; expertMode: boolean; theme: 'system'|'light'|'dark'; model: string | null }`
  - `linkedCodebaseSchema` `{ path: string; note?: string }`
  - `projectFileSchema`, `type ProjectFile = { schemaVersion: 1; name: string; description: string; createdAt: string; updatedAt: string; linkedCodebases: LinkedCodebase[] }`
  - `type AgentEvent` (vedi codice), `type JobState`, `type JobSummary`, `type ServerMessage`, `type DoctorCheck`, `type ProjectListItem`

- [ ] **Step 1: Test che falliscono**

`packages/shared/test/schemas.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { appConfigSchema, projectFileSchema, workspaceSettingsSchema } from '../src/index.ts';

describe('workspaceSettingsSchema', () => {
  it('fills defaults from an empty versioned object', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1, maxConcurrentJobs: 2, expertMode: false, theme: 'system', model: null,
    });
  });
  it('rejects a concurrency outside 1..8', () => {
    expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, maxConcurrentJobs: 0 }).success).toBe(false);
    expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, maxConcurrentJobs: 9 }).success).toBe(false);
  });
});

describe('projectFileSchema', () => {
  const valid = {
    schemaVersion: 1, name: 'Acme', description: '', createdAt: '2026-10-07T10:00:00.000Z',
    updatedAt: '2026-10-07T10:00:00.000Z', linkedCodebases: [{ path: '/Users/me/dev/app', note: 'iOS' }],
  };
  it('accepts a valid project', () => {
    expect(projectFileSchema.parse(valid)).toEqual(valid);
  });
  it('rejects an empty name', () => {
    expect(projectFileSchema.safeParse({ ...valid, name: '  ' }).success).toBe(false);
  });
  it('rejects an unknown schemaVersion', () => {
    expect(projectFileSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  });
});

describe('appConfigSchema', () => {
  it('defaults workspacePath to null', () => {
    expect(appConfigSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1, workspacePath: null });
  });
});
```

Delete `packages/shared/test/smoke.test.ts`.

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/shared`
Expected: FAIL (`appConfigSchema` non esportato).

- [ ] **Step 3: Implementa**

`packages/shared/src/schemas.ts`:
```ts
import { z } from 'zod';

export const appConfigSchema = z.object({
  schemaVersion: z.literal(1),
  workspacePath: z.string().min(1).nullable().default(null),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

export const workspaceSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  maxConcurrentJobs: z.number().int().min(1).max(8).default(2),
  expertMode: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  model: z.string().min(1).nullable().default(null),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const linkedCodebaseSchema = z.object({
  path: z.string().min(1),
  note: z.string().optional(),
});
export type LinkedCodebase = z.infer<typeof linkedCodebaseSchema>;

export const projectFileSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
  description: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  linkedCodebases: z.array(linkedCodebaseSchema),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;
```

Note: `name` uses `.trim()`, so `parse` returns the trimmed name; the valid fixture has no surrounding spaces so equality holds.

`packages/shared/src/events.ts`:
```ts
import type { ProjectFile } from './schemas.ts';

/** Agent-neutral event stream produced by any AgentRunner. */
export type AgentEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | { kind: 'rate_limit'; status: string; resetsAt?: number }
  | { kind: 'stderr'; text: string }
  | { kind: 'parse_error'; line: string }
  | { kind: 'result'; ok: boolean; sessionId?: string; text?: string; costUsd?: number; error?: string };

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobSummary {
  id: string;
  key: string;
  label: string;
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export type ServerMessage =
  | { type: 'snapshot'; jobs: JobSummary[] }
  | { type: 'job'; job: JobSummary }
  | { type: 'agent'; jobId: string; event: AgentEvent };

export interface DoctorCheck {
  id: 'node' | 'git' | 'ffmpeg' | 'claude' | 'claude-auth';
  label: string;
  ok: boolean;
  required: boolean;
  version?: string;
  message: string;
  fix?: string;
}

export type ProjectListItem =
  | { slug: string; ok: true; project: ProjectFile }
  | { slug: string; ok: false; error: string };
```

`packages/shared/src/index.ts`:
```ts
export const APP_NAME = 'Motion Studio';
export * from './schemas.ts';
export * from './events.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/shared && pnpm typecheck`
Expected: PASS, nessun errore di tipo.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared): add zod schemas and shared event types"
```

---

### Task 3: File JSON validati e scrittura atomica

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/json-file.ts`, `packages/core/test/json-file.test.ts`

**Interfaces:**
- Consumes: zod schemas from `@motion-studio/shared`.
- Produces:
  - `class JsonFileError extends Error { path: string; reason: 'missing' | 'invalid-json' | 'schema'; }`
  - `readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T>`
  - `writeJsonFileAtomic(path: string, data: unknown): Promise<void>` (crea le cartelle mancanti; scrive su `<path>.<rand>.tmp` poi `rename`)

- [ ] **Step 1: Pacchetto core**

`packages/core/package.json`:
```json
{
  "name": "@motion-studio/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json",
    "dev": "tsx watch src/server/main.ts"
  },
  "dependencies": {
    "@motion-studio/shared": "workspace:*",
    "zod": "^4.0.0"
  },
  "devDependencies": { "tsx": "^4.20.0" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

Run: `pnpm install`

- [ ] **Step 2: Test che falliscono**

`packages/core/test/json-file.test.ts`:
```ts
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../src/json-file.ts';

const schema = z.object({ schemaVersion: z.literal(1), name: z.string() });
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ms-json-')); });

describe('readJsonFile', () => {
  it('returns parsed data', async () => {
    const p = join(dir, 'a.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1, name: 'x' }));
    await expect(readJsonFile(p, schema)).resolves.toEqual({ schemaVersion: 1, name: 'x' });
  });
  it('reports a missing file', async () => {
    const err = await readJsonFile(join(dir, 'nope.json'), schema).catch((e) => e);
    expect(err).toBeInstanceOf(JsonFileError);
    expect(err.reason).toBe('missing');
  });
  it('reports invalid JSON with the path in the message', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, '{ not json');
    const err = await readJsonFile(p, schema).catch((e) => e);
    expect(err.reason).toBe('invalid-json');
    expect(err.message).toContain(p);
  });
  it('reports schema violations naming the field', async () => {
    const p = join(dir, 'schema.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1, name: 42 }));
    const err = await readJsonFile(p, schema).catch((e) => e);
    expect(err.reason).toBe('schema');
    expect(err.message).toContain('name');
  });
});

describe('writeJsonFileAtomic', () => {
  it('creates parent folders, writes pretty JSON and leaves no temp files', async () => {
    const p = join(dir, 'nested', 'deep', 'b.json');
    await writeJsonFileAtomic(p, { a: 1 });
    expect(await readFile(p, 'utf8')).toBe('{\n  "a": 1\n}\n');
    expect(await readdir(join(dir, 'nested', 'deep'))).toEqual(['b.json']);
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/json-file.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 4: Implementa**

`packages/core/src/json-file.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';

export type JsonFileErrorReason = 'missing' | 'invalid-json' | 'schema';

export class JsonFileError extends Error {
  constructor(public readonly path: string, public readonly reason: JsonFileErrorReason, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'JsonFileError';
  }
}

export async function readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new JsonFileError(path, 'missing', 'file non trovato');
    throw e;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new JsonFileError(path, 'invalid-json', `JSON non valido (${(e as Error).message})`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`)
      .join('; ');
    throw new JsonFileError(path, 'schema', `contenuto non valido — ${detail}`);
  }
  return parsed.data;
}

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}
```

`packages/core/src/index.ts`:
```ts
export * from './json-file.ts';
```

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/core/test/json-file.test.ts`
Expected: 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): validated JSON reads and atomic writes"
```

---

### Task 4: Exec senza shell, mutex per chiave e git

**Files:**
- Create: `packages/core/src/exec.ts`, `packages/core/src/keyed-mutex.ts`, `packages/core/src/git.ts`, `packages/core/test/keyed-mutex.test.ts`, `packages/core/test/git.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `type CommandResult = { code: number; stdout: string; stderr: string; notFound: boolean }`
  - `type CommandExec = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<CommandResult>`; `execCommand: CommandExec` (usa `execFile`, mai shell; `notFound` true su ENOENT con `code: -1`)
  - `class KeyedMutex { run<T>(key: string, fn: () => Promise<T>): Promise<T> }`
  - `class Git { constructor(exec?: CommandExec); init(dir: string): Promise<void>; commitAll(dir: string, message: string): Promise<string | null> }` — `commitAll` è serializzato per `dir`, ritorna lo sha o `null` se non c'era nulla da committare.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/keyed-mutex.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/keyed-mutex.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes calls on the same key', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      m.run('a', async () => { log.push('1-start'); await sleep(20); log.push('1-end'); }),
      m.run('a', async () => { log.push('2-start'); log.push('2-end'); }),
    ]);
    expect(log).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });
  it('runs different keys concurrently', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      m.run('a', async () => { log.push('a-start'); await sleep(20); log.push('a-end'); }),
      m.run('b', async () => { log.push('b-start'); log.push('b-end'); }),
    ]);
    expect(log.indexOf('b-end')).toBeLessThan(log.indexOf('a-end'));
  });
  it('keeps going after a rejected task', async () => {
    const m = new KeyedMutex();
    await expect(m.run('a', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(m.run('a', async () => 42)).resolves.toBe(42);
  });
});
```

`packages/core/test/git.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';

describe('Git', () => {
  it('inits a repo and commits all files, returning the sha', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms git è '));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'a.txt'), 'hello');
    const sha = await git.commitAll(dir, 'first');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const log = await execCommand('git', ['log', '--format=%s'], { cwd: dir });
    expect(log.stdout.trim()).toBe('first');
  });
  it('returns null when there is nothing to commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-git-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'a.txt'), 'x');
    await git.commitAll(dir, 'first');
    await expect(git.commitAll(dir, 'again')).resolves.toBeNull();
  });
  it('serializes concurrent commits on the same repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-git-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'a.txt'), '1');
    await writeFile(join(dir, 'b.txt'), '2');
    const results = await Promise.all([git.commitAll(dir, 'c1'), git.commitAll(dir, 'c2')]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
});

describe('execCommand', () => {
  it('flags a missing binary instead of throwing', async () => {
    const r = await execCommand('definitely-not-a-binary-ms', ['--version']);
    expect(r.notFound).toBe(true);
    expect(r.code).toBe(-1);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/keyed-mutex.test.ts packages/core/test/git.test.ts`
Expected: FAIL (moduli inesistenti).

- [ ] **Step 3: Implementa**

`packages/core/src/exec.ts`:
```ts
import { execFile } from 'node:child_process';

export interface CommandResult { code: number; stdout: string; stderr: string; notFound: boolean }
export type CommandExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

export const execCommand: CommandExec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ code: -1, stdout: '', stderr: String(error.message), notFound: true });
          return;
        }
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', notFound: false });
      },
    );
  });
```

`packages/core/src/keyed-mutex.ts`:
```ts
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
```

`packages/core/src/git.ts`:
```ts
import { execCommand, type CommandExec } from './exec.ts';
import { KeyedMutex } from './keyed-mutex.ts';

const IDENTITY = ['-c', 'user.name=Motion Studio', '-c', 'user.email=motion-studio@localhost'];

export class Git {
  private readonly lock = new KeyedMutex();
  constructor(private readonly exec: CommandExec = execCommand) {}

  async init(dir: string): Promise<void> {
    await this.must(dir, ['init', '-q', '-b', 'main']);
  }

  commitAll(dir: string, message: string): Promise<string | null> {
    return this.lock.run(dir, async () => {
      await this.must(dir, ['add', '-A']);
      const status = await this.must(dir, ['status', '--porcelain']);
      if (status.trim() === '') return null;
      await this.must(dir, [...IDENTITY, 'commit', '-q', '-m', message]);
      return (await this.must(dir, ['rev-parse', 'HEAD'])).trim();
    });
  }

  private async must(cwd: string, args: string[]): Promise<string> {
    const r = await this.exec('git', args, { cwd });
    if (r.notFound) throw new Error('git non trovato: installalo per usare Motion Studio');
    if (r.code !== 0) throw new Error(`git ${args.filter((a) => !a.startsWith('user.')).join(' ')} fallito: ${r.stderr.trim()}`);
    return r.stdout;
  }
}
```

Note: the identity is passed with `-c` so commits work on machines without a global git identity; the user's own identity, if configured, is overridden only for app-made commits (they are app versions, not user commits).

`packages/core/src/index.ts`:
```ts
export * from './json-file.ts';
export * from './exec.ts';
export * from './keyed-mutex.ts';
export * from './git.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): shell-free exec, keyed mutex and serialized git commits"
```

---

### Task 5: Config dell'app e WorkspaceStore

**Files:**
- Create: `packages/core/src/app-config.ts`, `packages/core/src/project-template.ts`, `packages/core/src/workspace-store.ts`, `packages/core/test/app-config.test.ts`, `packages/core/test/workspace-store.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `readJsonFile`, `writeJsonFileAtomic`, `JsonFileError` (Task 3); `Git` (Task 4); schemas (Task 2).
- Produces:
  - `class AppConfigStore { constructor(configDir: string); read(): Promise<AppConfig>; setWorkspacePath(path: string): Promise<AppConfig> }` — file `<configDir>/config.json`; se manca ritorna il default.
  - `defaultConfigDir(): string` — `MOTION_STUDIO_CONFIG_DIR` se impostata, altrimenti `~/Library/Application Support/Motion Studio` (macOS), `%APPDATA%\Motion Studio` (Windows), `$XDG_CONFIG_HOME/motion-studio` o `~/.config/motion-studio` (Linux).
  - `class WorkspaceError extends Error { status: 400 | 404 | 409 }`
  - `slugify(name: string): string`
  - `class WorkspaceStore { constructor(root: string, git: Git); static open(root: string, git: Git): Promise<WorkspaceStore> /* crea cartella + .studio/settings.json se mancano; 400 se root è un file o non scrivibile */; readSettings(): Promise<WorkspaceSettings>; updateSettings(patch: Partial<Omit<WorkspaceSettings,'schemaVersion'>>): Promise<WorkspaceSettings>; listProjects(): Promise<ProjectListItem[]>; createProject(input: { name: string; description?: string }): Promise<{ slug: string; project: ProjectFile }>; getProject(slug: string): Promise<ProjectFile>; projectDir(slug: string): string }`

- [ ] **Step 1: Test che falliscono**

`packages/core/test/app-config.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppConfigStore } from '../src/app-config.ts';

describe('AppConfigStore', () => {
  it('returns defaults when no config exists, then persists the workspace path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-cfg-'));
    const store = new AppConfigStore(join(dir, 'nested'));
    expect(await store.read()).toEqual({ schemaVersion: 1, workspacePath: null });
    await store.setWorkspacePath('/tmp/ws');
    expect(await new AppConfigStore(join(dir, 'nested')).read()).toEqual({ schemaVersion: 1, workspacePath: '/tmp/ws' });
  });
});
```

`packages/core/test/workspace-store.test.ts`:
```ts
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { slugify, WorkspaceError, WorkspaceStore } from '../src/workspace-store.ts';

let base: string;
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'ms-ws-')); });

describe('slugify', () => {
  it('normalizes accents, spaces and symbols', () => {
    expect(slugify('  Lumen Caffè — Primavera 2026! ')).toBe('lumen-caffe-primavera-2026');
  });
  it('falls back to "progetto" for names without letters or digits', () => {
    expect(slugify('***')).toBe('progetto');
  });
});

describe('WorkspaceStore.open', () => {
  it('creates a missing workspace with default settings (path with spaces and accents)', async () => {
    const root = join(base, 'Il mio spazio è qui');
    const ws = await WorkspaceStore.open(root, new Git());
    expect(await ws.readSettings()).toMatchObject({ maxConcurrentJobs: 2, theme: 'system' });
    expect(JSON.parse(await readFile(join(root, '.studio', 'settings.json'), 'utf8')).schemaVersion).toBe(1);
  });
  it('rejects a path that is a file', async () => {
    const file = join(base, 'file.txt');
    await writeFile(file, 'x');
    const err = await WorkspaceStore.open(file, new Git()).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.status).toBe(400);
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects a non-writable folder', async () => {
    const ro = join(base, 'readonly');
    await WorkspaceStore.open(ro, new Git());
    await chmod(ro, 0o500);
    const err = await WorkspaceStore.open(join(ro, 'child'), new Git()).catch((e) => e);
    await chmod(ro, 0o700);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.status).toBe(400);
  });
});

describe('projects', () => {
  it('creates a project folder with the full skeleton and an initial commit', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const { slug, project } = await ws.createProject({ name: 'Acme', description: 'Campagne Acme' });
    expect(slug).toBe('acme');
    expect(project).toMatchObject({ schemaVersion: 1, name: 'Acme', description: 'Campagne Acme', linkedCodebases: [] });
    const dir = ws.projectDir(slug);
    for (const rel of ['project.json', 'brand', 'assets', 'references', 'creatives', '.studio/context.md', 'CLAUDE.md', '.gitignore']) {
      await expect(readFile(join(dir, rel)).catch((e) => e.code)).not.toBe('ENOENT');
    }
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('@.studio/context.md');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('outputs/');
    const log = await execCommand('git', ['log', '--format=%s'], { cwd: dir });
    expect(log.stdout.trim()).toBe('Crea progetto Acme');
  });
  it('gives unique slugs to projects with the same name', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const [a, b] = await Promise.all([ws.createProject({ name: 'Acme' }), ws.createProject({ name: 'Acme' })]);
    expect(new Set([a.slug, b.slug])).toEqual(new Set(['acme', 'acme-2']));
  });
  it('rejects an empty name with 400', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const err = await ws.createProject({ name: '   ' }).catch((e) => e);
    expect(err.status).toBe(400);
  });
  it('lists projects sorted by name and reports a corrupted one without rewriting it', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    await ws.createProject({ name: 'Orto Urbano' });
    const { slug } = await ws.createProject({ name: 'Acme' });
    const broken = join(ws.projectDir(slug), 'project.json');
    await writeFile(broken, '{ "schemaVersion": 1, "name": ');
    const items = await ws.listProjects();
    expect(items.map((i) => i.slug)).toEqual(['acme', 'orto-urbano']);
    const bad = items.find((i) => i.slug === 'acme');
    expect(bad).toMatchObject({ ok: false });
    expect(bad && !bad.ok && bad.error).toContain('JSON non valido');
    expect(await readFile(broken, 'utf8')).toBe('{ "schemaVersion": 1, "name": ');
  });
  it('ignores folders without project.json and the .studio folder', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    await (await import('node:fs/promises')).mkdir(join(base, 'ws', 'random-folder'));
    expect(await ws.listProjects()).toEqual([]);
  });
  it('getProject throws 404 for an unknown slug and 400 for path traversal', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    expect((await ws.getProject('nope').catch((e) => e)).status).toBe(404);
    expect((await ws.getProject('../etc').catch((e) => e)).status).toBe(400);
  });
  it('updates settings with validation', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    expect(await ws.updateSettings({ maxConcurrentJobs: 3 })).toMatchObject({ maxConcurrentJobs: 3 });
    expect((await ws.updateSettings({ maxConcurrentJobs: 99 }).catch((e) => e)).status).toBe(400);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/app-config.test.ts packages/core/test/workspace-store.test.ts`
Expected: FAIL (moduli inesistenti).

- [ ] **Step 3: Implementa `app-config.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appConfigSchema, type AppConfig } from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from './json-file.ts';

export function defaultConfigDir(): string {
  const override = process.env.MOTION_STUDIO_CONFIG_DIR;
  if (override) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Motion Studio');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Motion Studio');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'motion-studio');
}

export class AppConfigStore {
  private readonly file: string;
  constructor(configDir: string) { this.file = join(configDir, 'config.json'); }

  async read(): Promise<AppConfig> {
    try {
      return await readJsonFile(this.file, appConfigSchema);
    } catch (e) {
      if (e instanceof JsonFileError && e.reason === 'missing') return { schemaVersion: 1, workspacePath: null };
      throw e;
    }
  }

  async setWorkspacePath(path: string): Promise<AppConfig> {
    const next: AppConfig = { ...(await this.read()), workspacePath: path };
    await writeJsonFileAtomic(this.file, next);
    return next;
  }
}
```

- [ ] **Step 4: Implementa `project-template.ts`**

```ts
export const CONTEXT_MD = `# Contesto Motion Studio

Questa cartella è un progetto di **Motion Studio**: un'app locale che usa un agente di coding per produrre video in motion graphics e immagini.

## Struttura
- \`project.json\` — metadati del progetto (non modificarlo a mano).
- \`brand/\` — brand kit (\`brand-kit.json\`), linee guida (\`guidelines.md\`), sorgenti analizzate.
- \`assets/\` — asset del progetto con metadati in \`assets.json\`.
- \`references/\` — immagini di riferimento con note in \`references.json\`.
- \`creatives/<slug>/\` — una cartella per creatività: \`work/\` è il tuo spazio di lavoro, \`outputs/vN/\` gli output consegnati.

## Regole
- Lavora solo dentro la cartella della creatività che ti viene indicata.
- Le cartelle di codebase collegate sono in sola lettura.
- Installa dipendenze solo in locale nella cartella di lavoro.
`;

export const CLAUDE_MD = `@.studio/context.md
`;

export const GITIGNORE = `outputs/
node_modules/
.venv/
.cache/
*.tmp
.DS_Store
`;

export const PROJECT_DIRS = ['brand', 'assets', 'references', 'creatives'] as const;
```

- [ ] **Step 5: Implementa `workspace-store.ts`**

```ts
import { access, constants, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  projectFileSchema,
  workspaceSettingsSchema,
  type ProjectFile,
  type ProjectListItem,
  type WorkspaceSettings,
} from '@motion-studio/shared';
import type { Git } from './git.ts';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from './json-file.ts';
import { KeyedMutex } from './keyed-mutex.ts';
import { CLAUDE_MD, CONTEXT_MD, GITIGNORE, PROJECT_DIRS } from './project-template.ts';

export class WorkspaceError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'progetto';
}

export class WorkspaceStore {
  private readonly createLock = new KeyedMutex();
  private constructor(public readonly root: string, private readonly git: Git) {}

  static async open(root: string, git: Git): Promise<WorkspaceStore> {
    const info = await stat(root).catch(() => null);
    if (info && !info.isDirectory()) throw new WorkspaceError(400, `Il percorso ${root} è un file, non una cartella`);
    try {
      await mkdir(join(root, '.studio'), { recursive: true });
      await access(root, constants.W_OK);
    } catch {
      throw new WorkspaceError(400, `Impossibile scrivere nella cartella ${root}: controlla i permessi`);
    }
    const store = new WorkspaceStore(root, git);
    const settingsPath = store.settingsPath();
    if (!(await stat(settingsPath).catch(() => null))) {
      await writeJsonFileAtomic(settingsPath, workspaceSettingsSchema.parse({ schemaVersion: 1 }));
    }
    return store;
  }

  private settingsPath() { return join(this.root, '.studio', 'settings.json'); }

  readSettings(): Promise<WorkspaceSettings> {
    return readJsonFile(this.settingsPath(), workspaceSettingsSchema);
  }

  async updateSettings(patch: Partial<Omit<WorkspaceSettings, 'schemaVersion'>>): Promise<WorkspaceSettings> {
    const parsed = workspaceSettingsSchema.safeParse({ ...(await this.readSettings()), ...patch, schemaVersion: 1 });
    if (!parsed.success) throw new WorkspaceError(400, `Impostazioni non valide: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    await writeJsonFileAtomic(this.settingsPath(), parsed.data);
    return parsed.data;
  }

  projectDir(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new WorkspaceError(400, `Identificativo progetto non valido: ${slug}`);
    return join(this.root, slug);
  }

  async listProjects(): Promise<ProjectListItem[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const items: ProjectListItem[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
      try {
        items.push({ slug: e.name, ok: true, project: await readJsonFile(join(this.root, e.name, 'project.json'), projectFileSchema) });
      } catch (err) {
        if (err instanceof JsonFileError && err.reason === 'missing') continue;
        items.push({ slug: e.name, ok: false, error: (err as Error).message });
      }
    }
    return items.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async getProject(slug: string): Promise<ProjectFile> {
    const dir = this.projectDir(slug);
    try {
      return await readJsonFile(join(dir, 'project.json'), projectFileSchema);
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') throw new WorkspaceError(404, `Progetto ${slug} non trovato`);
      throw err;
    }
  }

  async createProject(input: { name: string; description?: string }): Promise<{ slug: string; project: ProjectFile }> {
    const name = input.name.trim();
    if (!name) throw new WorkspaceError(400, 'Il nome del progetto è obbligatorio');
    const { slug, dir } = await this.createLock.run('create', async () => {
      const base = slugify(name);
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        const candidateDir = join(this.root, candidate);
        try {
          await mkdir(candidateDir);
          return { slug: candidate, dir: candidateDir };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
    });
    const now = new Date().toISOString();
    const project: ProjectFile = { schemaVersion: 1, name, description: input.description?.trim() ?? '', createdAt: now, updatedAt: now, linkedCodebases: [] };
    for (const d of PROJECT_DIRS) {
      await mkdir(join(dir, d), { recursive: true });
      await writeFile(join(dir, d, '.gitkeep'), '');
    }
    await mkdir(join(dir, '.studio'), { recursive: true });
    await writeFile(join(dir, '.studio', 'context.md'), CONTEXT_MD);
    await writeFile(join(dir, 'CLAUDE.md'), CLAUDE_MD);
    await writeFile(join(dir, '.gitignore'), GITIGNORE);
    await writeJsonFileAtomic(join(dir, 'project.json'), project);
    await this.git.init(dir);
    await this.git.commitAll(dir, `Crea progetto ${name}`);
    return { slug, project };
  }
}
```

Note: the test `for (const rel of [...])` reads directories with `readFile`, which rejects with `EISDIR` (not `ENOENT`), so the assertion "not ENOENT" holds for both files and folders.

Append to `packages/core/src/index.ts`:
```ts
export * from './app-config.ts';
export * from './workspace-store.ts';
```

- [ ] **Step 6: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): app config and file-based workspace store with git-backed projects"
```

---

### Task 6: Doctor

**Files:**
- Create: `packages/core/src/doctor.ts`, `packages/core/test/doctor.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `CommandExec`, `CommandResult` (Task 4); `DoctorCheck` (Task 2).
- Produces: `runDoctor(opts: { exec: CommandExec; claudeCommand: string[]; nodeVersion?: string }): Promise<DoctorCheck[]>` — ordine: `node`, `git`, `ffmpeg`, `claude`, `claude-auth`. `required`: tutti tranne `ffmpeg`. `hasBlockingFailure(checks: DoctorCheck[]): boolean`.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/doctor.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hasBlockingFailure, runDoctor } from '../src/doctor.ts';
import type { CommandExec, CommandResult } from '../src/exec.ts';

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '', notFound: false });
const missing: CommandResult = { code: -1, stdout: '', stderr: 'ENOENT', notFound: true };

function fakeExec(table: Record<string, CommandResult>): CommandExec {
  return async (cmd, args) => table[[cmd, ...args].join(' ')] ?? missing;
}

const allGood = {
  'git --version': ok('git version 2.50.1'),
  'ffmpeg -version': ok('ffmpeg version 8.0.1 Copyright'),
  'claude --version': ok('2.1.292 (Claude Code)'),
  'claude auth status --json': ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })),
};

describe('runDoctor', () => {
  it('reports everything ok with versions', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    expect(checks.map((c) => [c.id, c.ok, c.version])).toEqual([
      ['node', true, '24.9.0'],
      ['git', true, '2.50.1'],
      ['ffmpeg', true, '8.0.1'],
      ['claude', true, '2.1.292'],
      ['claude-auth', true, undefined],
    ]);
    expect(hasBlockingFailure(checks)).toBe(false);
  });
  it('flags missing claude with an install fix and skips the auth probe', async () => {
    const { ['claude --version']: _, ['claude auth status --json']: __, ...rest } = allGood;
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    const claude = checks.find((c) => c.id === 'claude')!;
    expect(claude.ok).toBe(false);
    expect(claude.fix).toContain('npm install -g @anthropic-ai/claude-code');
    expect(checks.find((c) => c.id === 'claude-auth')).toMatchObject({ ok: false, message: 'Installa prima Claude Code' });
    expect(hasBlockingFailure(checks)).toBe(true);
  });
  it('flags a logged-out claude with the login command', async () => {
    const checks = await runDoctor({
      exec: fakeExec({ ...allGood, 'claude auth status --json': { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: '', notFound: false } }),
      claudeCommand: ['claude'], nodeVersion: 'v24.9.0',
    });
    expect(checks.find((c) => c.id === 'claude-auth')).toMatchObject({ ok: false, fix: 'claude auth login' });
  });
  it('treats missing ffmpeg as non-blocking', async () => {
    const { ['ffmpeg -version']: _, ...rest } = allGood;
    const checks = await runDoctor({ exec: fakeExec(rest), claudeCommand: ['claude'], nodeVersion: 'v24.9.0' });
    expect(checks.find((c) => c.id === 'ffmpeg')).toMatchObject({ ok: false, required: false });
    expect(hasBlockingFailure(checks)).toBe(false);
  });
  it('rejects node older than 22', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v20.11.0' });
    expect(checks[0]).toMatchObject({ id: 'node', ok: false, required: true });
  });
  it('uses a custom claude command prefix', async () => {
    const exec = fakeExec({
      ...allGood,
      'node /fake.mjs --version': ok('9.9.9 (Claude Code)'),
      'node /fake.mjs auth status --json': ok(JSON.stringify({ loggedIn: true })),
    });
    const checks = await runDoctor({ exec, claudeCommand: ['node', '/fake.mjs'], nodeVersion: 'v24.9.0' });
    expect(checks.find((c) => c.id === 'claude')).toMatchObject({ ok: true, version: '9.9.9' });
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/doctor.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementa**

`packages/core/src/doctor.ts`:
```ts
import type { DoctorCheck } from '@motion-studio/shared';
import type { CommandExec } from './exec.ts';

const versionIn = (s: string) => s.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];

export async function runDoctor(opts: { exec: CommandExec; claudeCommand: string[]; nodeVersion?: string }): Promise<DoctorCheck[]> {
  const { exec } = opts;
  const [claudeBin, ...claudePrefix] = opts.claudeCommand;
  if (!claudeBin) throw new Error('claudeCommand vuoto');
  const checks: DoctorCheck[] = [];

  const nodeVersion = (opts.nodeVersion ?? process.version).replace(/^v/, '');
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  checks.push({
    id: 'node', label: 'Node.js', required: true, version: nodeVersion, ok: nodeMajor >= 22,
    message: nodeMajor >= 22 ? 'Versione supportata' : 'Serve Node.js 22 o superiore',
    fix: nodeMajor >= 22 ? undefined : 'Installa Node.js 22+ da https://nodejs.org',
  });

  const git = await exec('git', ['--version']);
  checks.push(git.code === 0
    ? { id: 'git', label: 'Git', required: true, ok: true, version: versionIn(git.stdout), message: 'Installato' }
    : { id: 'git', label: 'Git', required: true, ok: false, message: 'Git non trovato', fix: 'Installa Git da https://git-scm.com' });

  const ffmpeg = await exec('ffmpeg', ['-version']);
  checks.push(ffmpeg.code === 0
    ? { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: true, version: versionIn(ffmpeg.stdout), message: 'Installato' }
    : { id: 'ffmpeg', label: 'FFmpeg', required: false, ok: false, message: 'Consigliato per montaggio e conversioni video', fix: 'Installa FFmpeg da https://ffmpeg.org (macOS: brew install ffmpeg)' });

  const claude = await exec(claudeBin, [...claudePrefix, '--version']);
  const claudeOk = claude.code === 0;
  checks.push(claudeOk
    ? { id: 'claude', label: 'Claude Code', required: true, ok: true, version: versionIn(claude.stdout), message: 'Installato' }
    : { id: 'claude', label: 'Claude Code', required: true, ok: false, message: 'Claude Code non trovato', fix: 'npm install -g @anthropic-ai/claude-code' });

  if (!claudeOk) {
    checks.push({ id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: false, message: 'Installa prima Claude Code' });
  } else {
    const auth = await exec(claudeBin, [...claudePrefix, 'auth', 'status', '--json']);
    let loggedIn = false;
    try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch { loggedIn = false; }
    checks.push(loggedIn
      ? { id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: true, message: 'Autenticato' }
      : { id: 'claude-auth', label: 'Accesso a Claude', required: true, ok: false, message: 'Claude Code non è autenticato', fix: 'claude auth login' });
  }
  return checks;
}

export const hasBlockingFailure = (checks: DoctorCheck[]) => checks.some((c) => c.required && !c.ok);
```

Append to `packages/core/src/index.ts`:
```ts
export * from './doctor.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core/test/doctor.test.ts`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): doctor checks for node, git, ffmpeg and claude"
```

---

### Task 7: Parser dello stream-json di Claude Code

**Files:**
- Create: `packages/core/src/agent/claude-stream-parser.ts`, `packages/core/test/fixtures/claude-stream-sample.jsonl`, `packages/core/test/claude-stream-parser.test.ts`

**Interfaces:**
- Consumes: `AgentEvent` (Task 2).
- Produces:
  - `class LineSplitter { push(chunk: string): string[]; flush(): string[] }` — ricompone righe spezzate tra chunk, ignora righe vuote, gestisce `\r\n`.
  - `parseClaudeLine(line: string): AgentEvent[]`

- [ ] **Step 1: Fixture registrata**

`packages/core/test/fixtures/claude-stream-sample.jsonl` (forma reale di `claude` 2.1.292 con `--verbose`, accorciata e anonimizzata; una riga per evento):
```
{"type":"system","subtype":"hook_started","hook_id":"h1","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"s-123"}
{"type":"system","subtype":"init","cwd":"/ws/acme","session_id":"s-123","tools":["Bash","Edit"],"model":"claude-haiku-4-5-20251001"}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"session_id":"s-123"}
{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"x"}]},"session_id":"s-123"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Creo la scena."},{"type":"tool_use","id":"tu_1","name":"Write","input":{"file_path":"work/a.txt","content":"hi"}}]},"session_id":"s-123"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"File created","is_error":false}]},"session_id":"s-123"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_2","content":[{"type":"text","text":"permission denied"}],"is_error":true}]},"session_id":"s-123"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791395400,"rateLimitType":"five_hour"},"session_id":"s-123"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":6731,"result":"ok","session_id":"s-123","total_cost_usd":0.0156526}
```

- [ ] **Step 2: Test che falliscono**

`packages/core/test/claude-stream-parser.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LineSplitter, parseClaudeLine } from '../src/agent/claude-stream-parser.ts';

describe('LineSplitter', () => {
  it('rejoins lines split across chunks and drops blanks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n\n{"b":2}\r\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.flush()).toEqual(['{"c"']);
    expect(s.flush()).toEqual([]);
  });
});

describe('parseClaudeLine', () => {
  it('maps the recorded sample to agent events', async () => {
    const raw = await readFile(new URL('./fixtures/claude-stream-sample.jsonl', import.meta.url), 'utf8');
    const events = raw.split('\n').filter(Boolean).flatMap(parseClaudeLine);
    expect(events).toEqual([
      { kind: 'session', sessionId: 's-123', model: 'claude-haiku-4-5-20251001' },
      { kind: 'text', text: 'Creo la scena.' },
      { kind: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: 'work/a.txt', content: 'hi' } },
      { kind: 'tool_result', toolUseId: 'tu_1', isError: false, content: 'File created' },
      { kind: 'tool_result', toolUseId: 'tu_2', isError: true, content: 'permission denied' },
      { kind: 'rate_limit', status: 'allowed', resetsAt: 1791395400 },
      { kind: 'result', ok: true, sessionId: 's-123', text: 'ok', costUsd: 0.0156526 },
    ]);
  });
  it('turns an error result into a failed result with the error text', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached', session_id: 's' });
    expect(parseClaudeLine(line)).toEqual([{ kind: 'result', ok: false, sessionId: 's', text: 'Usage limit reached', error: 'Usage limit reached' }]);
  });
  it('emits parse_error for non-JSON lines (truncated to 500 chars)', () => {
    const [ev] = parseClaudeLine('x'.repeat(800));
    expect(ev).toEqual({ kind: 'parse_error', line: 'x'.repeat(500) });
  });
  it('ignores unknown event types', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'something_new', foo: 1 }))).toEqual([]);
  });
  it('truncates very long tool results to 4000 chars', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'y'.repeat(5000) }] } });
    const [ev] = parseClaudeLine(line);
    expect(ev && ev.kind === 'tool_result' && ev.content.length).toBe(4000);
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/claude-stream-parser.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 4: Implementa**

`packages/core/src/agent/claude-stream-parser.ts`:
```ts
import type { AgentEvent } from '@motion-studio/shared';

export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  }
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}

const MAX_TOOL_RESULT = 4000;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  }
  return JSON.stringify(content ?? '');
}

export function parseClaudeLine(line: string): AgentEvent[] {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return [{ kind: 'parse_error', line: line.slice(0, 500) }];
  }
  if (!isObj(msg)) return [{ kind: 'parse_error', line: line.slice(0, 500) }];

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
        return [{ kind: 'session', sessionId: msg.session_id, ...(typeof msg.model === 'string' ? { model: msg.model } : {}) }];
      }
      return [];
    case 'assistant': {
      const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      const out: AgentEvent[] = [];
      for (const c of content) {
        if (!isObj(c)) continue;
        if (c.type === 'text' && typeof c.text === 'string' && c.text !== '') out.push({ kind: 'text', text: c.text });
        if (c.type === 'tool_use') out.push({ kind: 'tool_use', id: String(c.id), name: String(c.name), input: c.input });
      }
      return out;
    }
    case 'user': {
      const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      return content.filter((c): c is Json => isObj(c) && c.type === 'tool_result').map((c) => ({
        kind: 'tool_result' as const,
        toolUseId: String(c.tool_use_id),
        isError: c.is_error === true,
        content: toolResultText(c.content).slice(0, MAX_TOOL_RESULT),
      }));
    }
    case 'rate_limit_event': {
      const info = isObj(msg.rate_limit_info) ? msg.rate_limit_info : {};
      return [{ kind: 'rate_limit', status: String(info.status ?? 'unknown'), ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}) }];
    }
    case 'result': {
      const ok = msg.is_error !== true && msg.subtype === 'success';
      const text = typeof msg.result === 'string' ? msg.result : undefined;
      return [{
        kind: 'result',
        ok,
        ...(typeof msg.session_id === 'string' ? { sessionId: msg.session_id } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(typeof msg.total_cost_usd === 'number' ? { costUsd: msg.total_cost_usd } : {}),
        ...(!ok ? { error: text ?? `Turno terminato con esito ${String(msg.subtype)}` } : {}),
      }];
    }
    default:
      return [];
  }
}
```

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/core/test/claude-stream-parser.test.ts`
Expected: 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): parse Claude Code stream-json into agent-neutral events"
```

---

### Task 8: AgentRunner e ClaudeCodeRunner (con finto `claude`)

**Files:**
- Create: `packages/core/src/agent/runner.ts`, `packages/core/src/agent/claude-code-runner.ts`, `packages/core/test/fixtures/fake-claude.mjs`, `packages/core/test/claude-code-runner.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `LineSplitter`, `parseClaudeLine` (Task 7); `AgentEvent` (Task 2).
- Produces (`runner.ts`, neutro):
  ```ts
  export interface AgentTurnRequest { cwd: string; prompt: string; resumeSessionId?: string; addDirs?: string[]; model?: string; mcpConfigPath?: string }
  export interface AgentRunResult { status: 'succeeded' | 'failed' | 'cancelled'; sessionId?: string; error?: string }
  export interface AgentRun { done: Promise<AgentRunResult>; cancel(): void }
  export interface AgentRunner { start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun }
  ```
- Produces (`claude-code-runner.ts`): `buildClaudeArgs(req: AgentTurnRequest): string[]`; `class ClaudeCodeRunner implements AgentRunner { constructor(claudeCommand?: string[] /* default ['claude'] */, opts?: { killGraceMs?: number }) }`; `claudeCommandFromEnv(): string[]` (legge `MOTION_STUDIO_CLAUDE_COMMAND` come array JSON).

- [ ] **Step 1: Finto `claude`**

`packages/core/test/fixtures/fake-claude.mjs`:
```js
#!/usr/bin/env node
// Test double for the `claude` CLI. Scenario via FAKE_CLAUDE_SCENARIO: ok | tool | crash | hang | garbage | error_result
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_FILE) writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd() }));
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN !== '0';
  console.log(JSON.stringify({ loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'ok';
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : 'fake-session-1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rl = createInterface({ input: process.stdin });
rl.once('line', async (line) => {
  const msg = JSON.parse(line);
  const prompt = typeof msg.message?.content === 'string' ? msg.message.content : '';
  if (scenario === 'crash') { process.stderr.write('boom: something failed\n'); process.exit(2); }
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model' });
  if (scenario === 'garbage') process.stdout.write('this is not json\n');
  if (scenario === 'hang') { setInterval(() => {}, 1000); return; }
  if (scenario === 'tool') {
    out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] } });
    out({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }] } });
  }
  if (scenario === 'error_result') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached', session_id: sessionId });
    process.exit(1);
  }
  const text = JSON.stringify({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${prompt}` }] } });
  process.stdout.write(text.slice(0, 10));
  await sleep(20);
  process.stdout.write(text.slice(10) + '\n');
  out({ type: 'result', subtype: 'success', is_error: false, result: `echo: ${prompt}`, session_id: sessionId, total_cost_usd: 0 });
  process.exit(0);
});
```

- [ ] **Step 2: Test che falliscono**

`packages/core/test/claude-code-runner.test.ts`:
```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@motion-studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs, claudeCommandFromEnv, ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const runner = () => new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 });

async function run(scenario: string, prompt = 'ciao', extra: Partial<Parameters<ClaudeCodeRunner['start']>[0]> = {}) {
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const cwd = await mkdtemp(join(tmpdir(), 'ms run è '));
  const events: AgentEvent[] = [];
  const handle = runner().start({ cwd, prompt, ...extra }, (e) => events.push(e));
  return { handle, events, cwd };
}

afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_ARGS_FILE; });

describe('buildClaudeArgs', () => {
  it('builds headless stream-json args with optional flags', () => {
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p' })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    ]);
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p', resumeSessionId: 's1', addDirs: ['/a b', '/c'], model: 'sonnet', mcpConfigPath: '/m.json' })).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--resume', 's1', '--add-dir', '/a b', '--add-dir', '/c', '--model', 'sonnet', '--mcp-config', '/m.json',
    ]);
  });
});

describe('claudeCommandFromEnv', () => {
  it('defaults to ["claude"] and parses a JSON array override', () => {
    delete process.env.MOTION_STUDIO_CLAUDE_COMMAND;
    expect(claudeCommandFromEnv()).toEqual(['claude']);
    process.env.MOTION_STUDIO_CLAUDE_COMMAND = '["node","/fake.mjs"]';
    expect(claudeCommandFromEnv()).toEqual(['node', '/fake.mjs']);
    delete process.env.MOTION_STUDIO_CLAUDE_COMMAND;
  });
});

describe('ClaudeCodeRunner', () => {
  it('streams events (including a line split across chunks) and succeeds', async () => {
    const { handle, events } = await run('ok', 'ciao mondo');
    await expect(handle.done).resolves.toEqual({ status: 'succeeded', sessionId: 'fake-session-1' });
    expect(events.map((e) => e.kind)).toEqual(['session', 'text', 'result']);
    expect(events[1]).toEqual({ kind: 'text', text: 'echo: ciao mondo' });
  });
  it('runs in the requested cwd (with spaces) and passes resume', async () => {
    const argsFile = join(await mkdtemp(join(tmpdir(), 'ms-args-')), 'args.json');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const { handle, cwd } = await run('ok', 'x', { resumeSessionId: 'abc' });
    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded', sessionId: 'abc' });
    const recorded = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(recorded.args).toContain('--resume');
    expect(await import('node:fs/promises').then((f) => f.realpath(recorded.cwd))).toBe(await import('node:fs/promises').then((f) => f.realpath(cwd)));
  });
  it('emits parse_error for garbage and still succeeds', async () => {
    const { handle, events } = await run('garbage');
    await expect(handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(events.some((e) => e.kind === 'parse_error')).toBe(true);
  });
  it('fails with the stderr tail when the process exits without a result', async () => {
    const { handle, events } = await run('crash');
    const res = await handle.done;
    expect(res.status).toBe('failed');
    expect(res.error).toContain('codice 2');
    expect(res.error).toContain('boom: something failed');
    expect(events).toContainEqual({ kind: 'stderr', text: 'boom: something failed' });
  });
  it('fails with the result error text on an error result', async () => {
    const { handle } = await run('error_result');
    await expect(handle.done).resolves.toMatchObject({ status: 'failed', error: 'Usage limit reached', sessionId: 'fake-session-1' });
  });
  it('cancels a hanging process and reports cancelled', async () => {
    const { handle, events } = await run('hang');
    await new Promise((r) => setTimeout(r, 300));
    expect(events[0]?.kind).toBe('session');
    handle.cancel();
    await expect(handle.done).resolves.toMatchObject({ status: 'cancelled' });
  });
  it('fails clearly when the claude binary does not exist', async () => {
    const r = new ClaudeCodeRunner(['definitely-not-claude-ms']);
    const res = await r.start({ cwd: tmpdir(), prompt: 'x' }, () => {}).done;
    expect(res).toEqual({ status: 'failed', error: 'Comando claude non trovato (definitely-not-claude-ms). Installa Claude Code o controlla il Doctor.' });
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/claude-code-runner.test.ts`
Expected: FAIL (moduli inesistenti).

- [ ] **Step 4: Implementa**

`packages/core/src/agent/runner.ts`:
```ts
import type { AgentEvent } from '@motion-studio/shared';

export interface AgentTurnRequest {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  addDirs?: string[];
  model?: string;
  mcpConfigPath?: string;
}

export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  sessionId?: string;
  error?: string;
}

export interface AgentRun {
  done: Promise<AgentRunResult>;
  cancel(): void;
}

/** Agent-neutral contract; ClaudeCodeRunner is the first implementation. */
export interface AgentRunner {
  start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun;
}
```

`packages/core/src/agent/claude-code-runner.ts`:
```ts
import { spawn } from 'node:child_process';
import type { AgentEvent } from '@motion-studio/shared';
import { LineSplitter, parseClaudeLine } from './claude-stream-parser.ts';
import type { AgentRun, AgentRunner, AgentRunResult, AgentTurnRequest } from './runner.ts';

export function buildClaudeArgs(req: AgentTurnRequest): string[] {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    // Phase 1: edits auto-accepted, anything that would prompt is denied. Phase 4 replaces this with UI approvals.
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
  ];
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  for (const d of req.addDirs ?? []) args.push('--add-dir', d);
  if (req.model) args.push('--model', req.model);
  if (req.mcpConfigPath) args.push('--mcp-config', req.mcpConfigPath);
  return args;
}

export function claudeCommandFromEnv(): string[] {
  const raw = process.env.MOTION_STUDIO_CLAUDE_COMMAND;
  if (!raw) return ['claude'];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === 'string')) {
    throw new Error('MOTION_STUDIO_CLAUDE_COMMAND deve essere un array JSON di stringhe');
  }
  return parsed;
}

const STDERR_TAIL = 20;

export class ClaudeCodeRunner implements AgentRunner {
  private readonly killGraceMs: number;
  constructor(private readonly claudeCommand: string[] = ['claude'], opts: { killGraceMs?: number } = {}) {
    this.killGraceMs = opts.killGraceMs ?? 3000;
  }

  start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun {
    const [bin, ...prefix] = this.claudeCommand;
    if (!bin) throw new Error('claudeCommand vuoto');
    const child = spawn(bin, [...prefix, ...buildClaudeArgs(req)], { cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let cancelled = false;
    let sessionId = req.resumeSessionId;
    let result: Extract<AgentEvent, { kind: 'result' }> | undefined;
    const stderrTail: string[] = [];
    const stdout = new LineSplitter();
    const stderr = new LineSplitter();

    const emit = (e: AgentEvent) => {
      if (e.kind === 'session') sessionId = e.sessionId;
      if (e.kind === 'result') { result = e; if (e.sessionId) sessionId = e.sessionId; }
      onEvent(e);
    };
    child.stdout.setEncoding('utf8').on('data', (c: string) => stdout.push(c).flatMap(parseClaudeLine).forEach(emit));
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      for (const text of stderr.push(c)) {
        stderrTail.push(text);
        if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
        emit({ kind: 'stderr', text });
      }
    });
    child.stdin.on('error', () => { /* process may exit before reading stdin */ });
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: req.prompt } })}\n`);

    const done = new Promise<AgentRunResult>((resolve) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        resolve(err.code === 'ENOENT'
          ? { status: 'failed', error: `Comando claude non trovato (${bin}). Installa Claude Code o controlla il Doctor.` }
          : { status: 'failed', error: `Impossibile avviare claude: ${err.message}` });
      });
      child.on('close', (code, signal) => {
        stdout.flush().flatMap(parseClaudeLine).forEach(emit);
        const withSession = <T extends AgentRunResult>(r: T): T => (sessionId ? { ...r, sessionId } : r);
        if (cancelled) return resolve(withSession({ status: 'cancelled' }));
        if (result?.ok) return resolve(withSession({ status: 'succeeded' }));
        if (result) return resolve(withSession({ status: 'failed', error: result.error ?? 'Turno non riuscito' }));
        const tail = stderrTail.join('\n');
        resolve(withSession({ status: 'failed', error: `claude è terminato con codice ${code ?? signal} senza risultato${tail ? `: ${tail}` : ''}` }));
      });
    });

    return {
      done,
      cancel: () => {
        if (cancelled || child.exitCode !== null) return;
        cancelled = true;
        child.kill('SIGTERM');
        const t = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, this.killGraceMs);
        t.unref();
      },
    };
  }
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './agent/runner.ts';
export * from './agent/claude-stream-parser.ts';
export * from './agent/claude-code-runner.ts';
```

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/core/test/claude-code-runner.test.ts`
Expected: 9 PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): agent-neutral runner interface and Claude Code runner"
```

---

### Task 9: JobQueue

**Files:**
- Create: `packages/core/src/jobs/job-queue.ts`, `packages/core/test/job-queue.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `JobSummary`, `JobState` (Task 2).
- Produces:
  ```ts
  export class JobConflictError extends Error {}
  export interface JobSpec { key: string; label: string; run: (signal: AbortSignal, jobId: string) => Promise<void> }
  export class JobQueue {
    constructor(opts: { concurrency: number; onUpdate?: (job: JobSummary) => void })
    enqueue(spec: JobSpec): JobSummary          // throws JobConflictError if a job with the same key is queued/running
    cancel(id: string): boolean                 // false if unknown or already finished
    list(): JobSummary[]                        // newest first, max 100 kept
    setConcurrency(n: number): void
    whenIdle(): Promise<void>                   // resolves when nothing is queued or running
  }
  ```
  A job whose `run` rejects becomes `failed` with `error = err.message`, unless it was cancelled (→ `cancelled`).

- [ ] **Step 1: Test che falliscono**

`packages/core/test/job-queue.test.ts`:
```ts
import type { JobSummary } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { JobConflictError, JobQueue } from '../src/jobs/job-queue.ts';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('JobQueue', () => {
  it('respects the concurrency limit', async () => {
    const q = new JobQueue({ concurrency: 2 });
    const ds = [deferred(), deferred(), deferred()];
    const jobs = ds.map((d, i) => q.enqueue({ key: `k${i}`, label: `j${i}`, run: () => d.promise }));
    await tick();
    expect(q.list().filter((j) => j.state === 'running')).toHaveLength(2);
    ds[0]!.resolve();
    await tick(); await tick();
    expect(q.list().find((j) => j.id === jobs[2]!.id)?.state).toBe('running');
    ds[1]!.resolve(); ds[2]!.resolve();
    await q.whenIdle();
    expect(q.list().every((j) => j.state === 'succeeded')).toBe(true);
  });
  it('rejects a second active job with the same key', () => {
    const q = new JobQueue({ concurrency: 1 });
    q.enqueue({ key: 'same', label: 'a', run: () => deferred().promise });
    expect(() => q.enqueue({ key: 'same', label: 'b', run: async () => {} })).toThrow(JobConflictError);
  });
  it('allows the same key again after the first finishes', async () => {
    const q = new JobQueue({ concurrency: 1 });
    q.enqueue({ key: 'k', label: 'a', run: async () => {} });
    await q.whenIdle();
    expect(() => q.enqueue({ key: 'k', label: 'b', run: async () => {} })).not.toThrow();
  });
  it('marks failures with the error message', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const job = q.enqueue({ key: 'k', label: 'a', run: async () => { throw new Error('nope'); } });
    await q.whenIdle();
    expect(q.list().find((j) => j.id === job.id)).toMatchObject({ state: 'failed', error: 'nope' });
  });
  it('cancels a running job via its AbortSignal and a queued job without running it', async () => {
    const q = new JobQueue({ concurrency: 1 });
    let ran = false;
    const running = q.enqueue({
      key: 'a', label: 'a',
      run: (signal) => new Promise<void>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    const queued = q.enqueue({ key: 'b', label: 'b', run: async () => { ran = true; } });
    await tick();
    expect(q.cancel(queued.id)).toBe(true);
    expect(q.cancel(running.id)).toBe(true);
    await q.whenIdle();
    expect(ran).toBe(false);
    expect(q.list().map((j) => j.state).sort()).toEqual(['cancelled', 'cancelled']);
    expect(q.cancel(running.id)).toBe(false);
  });
  it('reports every state change through onUpdate', async () => {
    const updates: JobSummary[] = [];
    const q = new JobQueue({ concurrency: 1, onUpdate: (j) => updates.push(j) });
    q.enqueue({ key: 'k', label: 'a', run: async () => {} });
    await q.whenIdle();
    expect(updates.map((u) => u.state)).toEqual(['queued', 'running', 'succeeded']);
  });
  it('starts waiting jobs when concurrency is raised', async () => {
    const q = new JobQueue({ concurrency: 1 });
    const d1 = deferred(); const d2 = deferred();
    q.enqueue({ key: 'a', label: 'a', run: () => d1.promise });
    q.enqueue({ key: 'b', label: 'b', run: () => d2.promise });
    await tick();
    q.setConcurrency(2);
    await tick();
    expect(q.list().filter((j) => j.state === 'running')).toHaveLength(2);
    d1.resolve(); d2.resolve();
    await q.whenIdle();
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/job-queue.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementa**

`packages/core/src/jobs/job-queue.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { JobSummary } from '@motion-studio/shared';

export class JobConflictError extends Error {
  constructor(key: string) {
    super(`C'è già un lavoro attivo per ${key}`);
    this.name = 'JobConflictError';
  }
}

export interface JobSpec {
  key: string;
  label: string;
  run: (signal: AbortSignal, jobId: string) => Promise<void>;
}

interface Entry { summary: JobSummary; spec: JobSpec; controller: AbortController }

const MAX_KEPT = 100;
const ACTIVE = new Set(['queued', 'running']);

export class JobQueue {
  private concurrency: number;
  private readonly onUpdate?: (job: JobSummary) => void;
  private readonly entries: Entry[] = [];
  private idleWaiters: Array<() => void> = [];

  constructor(opts: { concurrency: number; onUpdate?: (job: JobSummary) => void }) {
    this.concurrency = opts.concurrency;
    this.onUpdate = opts.onUpdate;
  }

  enqueue(spec: JobSpec): JobSummary {
    if (this.entries.some((e) => e.spec.key === spec.key && ACTIVE.has(e.summary.state))) throw new JobConflictError(spec.key);
    const entry: Entry = {
      spec,
      controller: new AbortController(),
      summary: { id: randomUUID(), key: spec.key, label: spec.label, state: 'queued', createdAt: new Date().toISOString() },
    };
    this.entries.unshift(entry);
    this.trim();
    this.update(entry);
    this.pump();
    return { ...entry.summary };
  }

  cancel(id: string): boolean {
    const entry = this.entries.find((e) => e.summary.id === id);
    if (!entry || !ACTIVE.has(entry.summary.state)) return false;
    if (entry.summary.state === 'queued') {
      this.finish(entry, 'cancelled');
      this.pump();
    } else {
      entry.controller.abort();
    }
    return true;
  }

  list(): JobSummary[] { return this.entries.map((e) => ({ ...e.summary })); }

  setConcurrency(n: number): void {
    this.concurrency = n;
    this.pump();
  }

  whenIdle(): Promise<void> {
    if (!this.entries.some((e) => ACTIVE.has(e.summary.state))) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    const running = this.entries.filter((e) => e.summary.state === 'running').length;
    const waiting = this.entries.filter((e) => e.summary.state === 'queued').reverse();
    for (const entry of waiting.slice(0, Math.max(0, this.concurrency - running))) this.start(entry);
    if (!this.entries.some((e) => ACTIVE.has(e.summary.state))) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private start(entry: Entry): void {
    entry.summary.state = 'running';
    entry.summary.startedAt = new Date().toISOString();
    this.update(entry);
    entry.spec.run(entry.controller.signal, entry.summary.id).then(
      () => this.finish(entry, entry.controller.signal.aborted ? 'cancelled' : 'succeeded'),
      (err: Error) => this.finish(entry, entry.controller.signal.aborted ? 'cancelled' : 'failed', err.message),
    ).finally(() => this.pump());
  }

  private finish(entry: Entry, state: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
    entry.summary.state = state;
    entry.summary.finishedAt = new Date().toISOString();
    if (error && state === 'failed') entry.summary.error = error;
    this.update(entry);
  }

  private update(entry: Entry): void { this.onUpdate?.({ ...entry.summary }); }

  private trim(): void {
    for (let i = this.entries.length - 1; i >= 0 && this.entries.length > MAX_KEPT; i--) {
      if (!ACTIVE.has(this.entries[i]!.summary.state)) this.entries.splice(i, 1);
    }
  }
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './jobs/job-queue.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core/test/job-queue.test.ts`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): job queue with concurrency limit, per-key exclusivity and cancel"
```

---

### Task 10: Server HTTP + WebSocket

**Files:**
- Create: `packages/core/src/server/event-hub.ts`, `packages/core/src/server/app.ts`, `packages/core/src/server/main.ts`, `packages/core/test/server.test.ts`
- Modify: `packages/core/package.json` (deps), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `AppConfigStore`, `defaultConfigDir` (Task 5); `WorkspaceStore`, `WorkspaceError` (Task 5); `Git` (Task 4); `runDoctor`, `hasBlockingFailure` (Task 6); `AgentRunner` (Task 8); `JobQueue`, `JobConflictError` (Task 9); `ServerMessage`, `DoctorCheck` (Task 2); `JsonFileError` (Task 3).
- Produces:
  - `class EventHub { add(socket: WebSocketLike): void; broadcast(msg: ServerMessage): void }` where `WebSocketLike = { send(data: string): void; readyState: number; on(event: 'close', cb: () => void): void }`
  - `buildServer(deps: ServerDeps): Promise<FastifyInstance>` with
    `ServerDeps = { appConfig: AppConfigStore; git: Git; runner: AgentRunner; doctor: () => Promise<DoctorCheck[]>; webDir?: string }`
  - `startServer(opts: { port?: number; host?: string; configDir?: string; webDir?: string; claudeCommand?: string[] }): Promise<{ url: string; close(): Promise<void> }>`
  - REST API (all JSON, errors as `{ error: string }`):
    | Method | Path | Body | Result |
    |---|---|---|---|
    | GET | `/api/health` | — | `{ ok: true }` |
    | GET | `/api/doctor` | — | `DoctorCheck[]` |
    | GET | `/api/workspace` | — | `{ path: string \| null; settings: WorkspaceSettings \| null }` |
    | PUT | `/api/workspace` | `{ path: string }` (assoluto) | `{ path, settings }`; 400 se relativo/non valido |
    | PUT | `/api/settings` | `Partial<WorkspaceSettings>` | `WorkspaceSettings` (aggiorna anche la concorrenza della coda) |
    | GET | `/api/projects` | — | `ProjectListItem[]`; 409 se workspace non configurato |
    | POST | `/api/projects` | `{ name: string; description?: string }` | `{ slug, project }` 201 |
    | GET | `/api/projects/:slug` | — | `{ slug, project }` |
    | POST | `/api/projects/:slug/turns` | `{ prompt: string; resumeSessionId?: string }` | `JobSummary` 202; 409 se c'è già un turno attivo sul progetto |
    | GET | `/api/jobs` | — | `JobSummary[]` |
    | POST | `/api/jobs/:id/cancel` | — | `{ cancelled: boolean }` |
    | WS | `/api/events` | — | invia `{type:'snapshot'}` alla connessione, poi `job` e `agent` |

- [ ] **Step 1: Dipendenze**

Run: `pnpm --filter @motion-studio/core add fastify@^5 @fastify/websocket@^11 @fastify/static@^8 && pnpm --filter @motion-studio/core add -D ws@^8 @types/ws@^8`

- [ ] **Step 2: Test che falliscono**

`packages/core/test/server.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-srv-'));
  app = await buildServer({
    appConfig: new AppConfigStore(join(base, 'config')),
    git: new Git(),
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
    doctor: async () => [{ id: 'git', label: 'Git', ok: true, required: true, message: 'ok' }],
  });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; });

const setWorkspace = (path = join(base, 'Spazio di lavoro')) =>
  app.inject({ method: 'PUT', url: '/api/workspace', payload: { path } });

describe('workspace', () => {
  it('starts unconfigured and returns 409 for projects', async () => {
    expect((await app.inject('/api/workspace')).json()).toEqual({ path: null, settings: null });
    const res = await app.inject('/api/projects');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('workspace');
  });
  it('configures a workspace (creating it) and returns settings', async () => {
    const res = await setWorkspace();
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ maxConcurrentJobs: 2 });
  });
  it('rejects relative paths and files', async () => {
    expect((await setWorkspace('relative/path')).statusCode).toBe(400);
    const file = join(base, 'f.txt');
    await writeFile(file, 'x');
    expect((await setWorkspace(file)).statusCode).toBe(400);
  });
  it('validates settings updates', async () => {
    await setWorkspace();
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentJobs: 4 } })).json()).toMatchObject({ maxConcurrentJobs: 4 });
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { maxConcurrentJobs: 0 } })).statusCode).toBe(400);
  });
});

describe('projects', () => {
  it('creates, lists and reads projects', async () => {
    await setWorkspace();
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Lumen Caffè' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().slug).toBe('lumen-caffe');
    expect((await app.inject('/api/projects')).json()).toHaveLength(1);
    expect((await app.inject('/api/projects/lumen-caffe')).json().project.name).toBe('Lumen Caffè');
    expect((await app.inject('/api/projects/nope')).statusCode).toBe(404);
  });
  it('returns 400 for an empty name', async () => {
    await setWorkspace();
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '' } })).statusCode).toBe(400);
  });
});

describe('doctor', () => {
  it('returns the checks', async () => {
    expect((await app.inject('/api/doctor')).json()[0]).toMatchObject({ id: 'git', ok: true });
  });
});

describe('turns over WebSocket', () => {
  async function connect(): Promise<{ messages: ServerMessage[]; ws: WebSocket }> {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(`${address.replace('http', 'ws')}/api/events`);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    return { messages, ws };
  }
  const waitFor = async (cond: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('runs a turn and streams job + agent events', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const res = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'ciao' } });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().id;
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === jobId && m.job.state === 'succeeded'));
    expect(messages[0]).toMatchObject({ type: 'snapshot' });
    const agentKinds = messages.filter((m) => m.type === 'agent' && m.jobId === jobId).map((m) => (m as any).event.kind);
    expect(agentKinds).toEqual(['session', 'text', 'result']);
    ws.close();
  });
  it('rejects a second concurrent turn on the same project, and cancels a hanging one', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const first = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'a' } });
    const second = await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'b' } });
    expect(second.statusCode).toBe(409);
    const id = first.json().id;
    await waitFor(() => messages.some((m) => m.type === 'agent' && m.jobId === id));
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel` })).json()).toEqual({ cancelled: true });
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'cancelled'));
    ws.close();
  });
  it('marks the job failed with a readable error when claude crashes', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    const { messages, ws } = await connect();
    const id = (await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: 'a' } })).json().id;
    await waitFor(() => messages.some((m) => m.type === 'job' && m.job.id === id && m.job.state === 'failed'));
    const failed = messages.find((m) => m.type === 'job' && m.job.id === id && m.job.state === 'failed');
    expect(failed && failed.type === 'job' && failed.job.error).toContain('boom');
    ws.close();
  });
  it('rejects an empty prompt with 400', async () => {
    await setWorkspace();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
    expect((await app.inject({ method: 'POST', url: '/api/projects/acme/turns', payload: { prompt: '  ' } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/server.test.ts`
Expected: FAIL (moduli inesistenti).

- [ ] **Step 4: Implementa `event-hub.ts`**

```ts
import type { ServerMessage } from '@motion-studio/shared';

export interface WebSocketLike {
  send(data: string): void;
  readonly readyState: number;
  on(event: 'close', cb: () => void): void;
}

const OPEN = 1;

export class EventHub {
  private readonly sockets = new Set<WebSocketLike>();

  add(socket: WebSocketLike): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  send(socket: WebSocketLike, msg: ServerMessage): void {
    if (socket.readyState === OPEN) socket.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.sockets) if (s.readyState === OPEN) s.send(data);
  }
}
```

- [ ] **Step 5: Implementa `app.ts`**

```ts
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DoctorCheck, WorkspaceSettings } from '@motion-studio/shared';
import type { AgentRunner } from '../agent/runner.ts';
import type { AppConfigStore } from '../app-config.ts';
import type { Git } from '../git.ts';
import { JobConflictError, JobQueue } from '../jobs/job-queue.ts';
import { JsonFileError } from '../json-file.ts';
import { WorkspaceError, WorkspaceStore } from '../workspace-store.ts';
import { EventHub } from './event-hub.ts';

export interface ServerDeps {
  appConfig: AppConfigStore;
  git: Git;
  runner: AgentRunner;
  doctor: () => Promise<DoctorCheck[]>;
  webDir?: string;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hub = new EventHub();
  const queue = new JobQueue({ concurrency: 2, onUpdate: (job) => hub.broadcast({ type: 'job', job }) });
  let workspace: WorkspaceStore | null = null;

  const configured = (await deps.appConfig.read()).workspacePath;
  if (configured) {
    try {
      workspace = await WorkspaceStore.open(configured, deps.git);
      queue.setConcurrency((await workspace.readSettings()).maxConcurrentJobs);
    } catch {
      workspace = null; // surfaced to the UI as "workspace not configured"
    }
  }

  const requireWorkspace = () => {
    if (!workspace) throw new WorkspaceError(409, 'Nessun workspace configurato: scegli una cartella di lavoro');
    return workspace;
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof WorkspaceError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof JobConflictError) return reply.status(409).send({ error: err.message });
    if (err instanceof JsonFileError) return reply.status(422).send({ error: err.message });
    if ((err as { validation?: unknown }).validation) return reply.status(400).send({ error: err.message });
    return reply.status(500).send({ error: err.message });
  });

  await app.register(fastifyWebsocket);

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/doctor', async () => deps.doctor());

  app.get('/api/workspace', async () => ({
    path: workspace?.root ?? null,
    settings: workspace ? await workspace.readSettings() : null,
  }));

  app.put<{ Body: { path?: unknown } }>('/api/workspace', async (req) => {
    const path = req.body?.path;
    if (typeof path !== 'string' || !isAbsolute(path)) throw new WorkspaceError(400, 'Indica un percorso assoluto per il workspace');
    const ws = await WorkspaceStore.open(path, deps.git);
    await deps.appConfig.setWorkspacePath(path);
    workspace = ws;
    const settings = await ws.readSettings();
    queue.setConcurrency(settings.maxConcurrentJobs);
    return { path, settings };
  });

  app.put<{ Body: Partial<WorkspaceSettings> }>('/api/settings', async (req) => {
    const { schemaVersion: _ignored, ...patch } = (req.body ?? {}) as Partial<WorkspaceSettings>;
    const settings = await requireWorkspace().updateSettings(patch);
    queue.setConcurrency(settings.maxConcurrentJobs);
    return settings;
  });

  app.get('/api/projects', async () => requireWorkspace().listProjects());

  app.post<{ Body: { name?: unknown; description?: unknown } }>('/api/projects', async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const description = typeof req.body?.description === 'string' ? req.body.description : undefined;
    const created = await requireWorkspace().createProject({ name, description });
    return reply.status(201).send(created);
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug', async (req) => {
    const project = await requireWorkspace().getProject(req.params.slug);
    return { slug: req.params.slug, project };
  });

  app.post<{ Params: { slug: string }; Body: { prompt?: unknown; resumeSessionId?: unknown } }>(
    '/api/projects/:slug/turns',
    async (req, reply) => {
      const ws = requireWorkspace();
      const { slug } = req.params;
      const project = await ws.getProject(slug);
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) throw new WorkspaceError(400, 'Scrivi una richiesta per l\'agente');
      const resumeSessionId = typeof req.body?.resumeSessionId === 'string' ? req.body.resumeSessionId : undefined;
      const settings = await ws.readSettings();
      const cwd = ws.projectDir(slug);
      const job = queue.enqueue({
        key: `project:${slug}`,
        label: `Turno · ${project.name}`,
        run: async (signal, jobId) => {
          const run = deps.runner.start(
            {
              cwd,
              prompt,
              resumeSessionId,
              addDirs: project.linkedCodebases.map((c) => c.path),
              model: settings.model ?? undefined,
            },
            (event) => hub.broadcast({ type: 'agent', jobId, event }),
          );
          signal.addEventListener('abort', () => run.cancel(), { once: true });
          const result = await run.done;
          if (result.status === 'failed') throw new Error(result.error ?? 'Turno non riuscito');
        },
      });
      return reply.status(202).send(job);
    },
  );

  app.get('/api/jobs', async () => queue.list());
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => ({ cancelled: queue.cancel(req.params.id) }));

  app.get('/api/events', { websocket: true }, (socket) => {
    hub.add(socket);
    hub.send(socket, { type: 'snapshot', jobs: queue.list() });
  });

  if (deps.webDir && (await stat(deps.webDir).catch(() => null))?.isDirectory()) {
    await app.register(fastifyStatic, { root: deps.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Non trovato' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
```

- [ ] **Step 6: Implementa `main.ts`**

```ts
import { ClaudeCodeRunner, claudeCommandFromEnv } from '../agent/claude-code-runner.ts';
import { AppConfigStore, defaultConfigDir } from '../app-config.ts';
import { runDoctor } from '../doctor.ts';
import { execCommand } from '../exec.ts';
import { Git } from '../git.ts';
import { buildServer } from './app.ts';

export async function startServer(opts: { port?: number; host?: string; configDir?: string; webDir?: string; claudeCommand?: string[] } = {}) {
  const claudeCommand = opts.claudeCommand ?? claudeCommandFromEnv();
  const app = await buildServer({
    appConfig: new AppConfigStore(opts.configDir ?? defaultConfigDir()),
    git: new Git(),
    runner: new ClaudeCodeRunner(claudeCommand),
    doctor: () => runDoctor({ exec: execCommand, claudeCommand }),
    webDir: opts.webDir,
  });
  const url = await app.listen({ port: opts.port ?? 4317, host: opts.host ?? '127.0.0.1' });
  return { url, close: () => app.close() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer({ port: Number(process.env.PORT ?? 4317) }).then(({ url }) => console.log(`Motion Studio core su ${url}`));
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './server/event-hub.ts';
export * from './server/app.ts';
export * from './server/main.ts';
```

- [ ] **Step 7: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): HTTP + WebSocket server for workspace, projects, doctor and agent turns"
```

---

### Task 11: Frontend web — fondamenta, temi, client e reducer degli eventi

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/theme.css`, `packages/web/src/api.ts`, `packages/web/src/eventsReducer.ts`, `packages/web/src/useServerEvents.ts`, `packages/web/src/components/ThemeToggle.tsx`, `packages/web/test/eventsReducer.test.ts`, `packages/web/test/setup.ts`

**Interfaces:**
- Consumes: REST/WS API (Task 10); tipi da `@motion-studio/shared`.
- Produces:
  - `api` object: `getDoctor(): Promise<DoctorCheck[]>`, `getWorkspace(): Promise<{path: string|null; settings: WorkspaceSettings|null}>`, `setWorkspace(path: string)`, `updateSettings(patch)`, `listProjects(): Promise<ProjectListItem[]>`, `createProject(name: string, description?: string): Promise<{slug: string; project: ProjectFile}>`, `getProject(slug)`, `startTurn(slug: string, prompt: string, resumeSessionId?: string): Promise<JobSummary>`, `cancelJob(id: string)`. Errors throw `ApiError { status: number; message: string }`.
  - `type EventsState = { jobs: Record<string, JobSummary>; events: Record<string, AgentEvent[]> }`; `initialEventsState`; `eventsReducer(state, msg: ServerMessage): EventsState`; `sessionIdOf(events: AgentEvent[]): string | undefined`.
  - `useServerEvents(): EventsState` (riconnessione automatica ogni 1s).
  - `applyTheme(theme: 'system'|'light'|'dark')` sets `data-theme` on `<html>`; `<ThemeToggle value onChange />`.

- [ ] **Step 1: Pacchetto web**

`packages/web/package.json`:
```json
{
  "name": "@motion-studio/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@motion-studio/shared": "workspace:*",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^26.1.0",
    "vite": "^7.0.0"
  }
}
```

`packages/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2023", "DOM", "DOM.Iterable"], "module": "ESNext", "moduleResolution": "Bundler", "types": ["vite/client"] },
  "include": ["src", "test", "vite.config.ts"]
}
```

`packages/web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4317', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] },
} as never);
```

`packages/web/test/setup.ts`:
```ts
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
```

`packages/web/index.html`:
```html
<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Motion Studio</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run: `pnpm install`

- [ ] **Step 2: Token di tema**

`packages/web/src/theme.css` (valori dalla variante ibrida approvata):
```css
:root {
  --bg: #F4F4F1; --dot: #D4D4CE; --surface: #FFFFFF; --surface-2: #ECECE8; --border: #D6D6D1;
  --text: #18181B; --muted: #52525B; --accent: #6D28D9; --accent-soft: #EDE7FB; --accent-ink: #5B21B6;
  --on-accent: #FFFFFF; --ok: #15803D; --danger: #B42318;
  --warn-bg: #FFF6EC; --warn-border: #F3D3AE; --warn-text: #5A3300;
  --font: 'Manrope', system-ui, sans-serif; --mono: 'JetBrains Mono', ui-monospace, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg: #0E0F12; --dot: #262830; --surface: #17181C; --surface-2: #1F2026; --border: #2E3038;
    --text: #ECECEF; --muted: #A1A1AA; --accent: #7C3AED; --accent-soft: #2A2140; --accent-ink: #C4B5FD;
    --ok: #4ADE80; --danger: #FCA5A5; --warn-bg: #2A1F12; --warn-border: #5A3A1E; --warn-text: #FFD2B8;
    color-scheme: dark;
  }
}
:root[data-theme='dark'] {
  --bg: #0E0F12; --dot: #262830; --surface: #17181C; --surface-2: #1F2026; --border: #2E3038;
  --text: #ECECEF; --muted: #A1A1AA; --accent: #7C3AED; --accent-soft: #2A2140; --accent-ink: #C4B5FD;
  --ok: #4ADE80; --danger: #FCA5A5; --warn-bg: #2A1F12; --warn-border: #5A3A1E; --warn-text: #FFD2B8;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); }
button, input, textarea { font: inherit; color: inherit; }
button { min-height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; }
button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 700; }
button:disabled { opacity: 0.55; cursor: not-allowed; }
input, textarea { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); font-size: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.page { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
.topbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 10px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
.badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; background: var(--surface-2); }
.badge.ok { color: var(--ok); } .badge.err { color: var(--danger); } .badge.run { background: var(--accent-soft); color: var(--accent-ink); }
.error { color: var(--danger); }
.warn { background: var(--warn-bg); border: 1px solid var(--warn-border); color: var(--warn-text); border-radius: 12px; padding: 12px; }
```

- [ ] **Step 3: Test del reducer che falliscono**

`packages/web/test/eventsReducer.test.ts`:
```ts
import type { JobSummary } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { eventsReducer, initialEventsState, sessionIdOf } from '../src/eventsReducer.ts';

const job = (id: string, state: JobSummary['state']): JobSummary => ({ id, key: 'k', label: 'l', state, createdAt: '2026-10-07T10:00:00.000Z' });

describe('eventsReducer', () => {
  it('replaces jobs on snapshot and keeps events', () => {
    let s = eventsReducer(initialEventsState, { type: 'agent', jobId: 'a', event: { kind: 'text', text: 'hi' } });
    s = eventsReducer(s, { type: 'snapshot', jobs: [job('a', 'running')] });
    expect(s.jobs).toEqual({ a: job('a', 'running') });
    expect(s.events.a).toHaveLength(1);
  });
  it('upserts jobs and appends events per job', () => {
    let s = eventsReducer(initialEventsState, { type: 'job', job: job('a', 'queued') });
    s = eventsReducer(s, { type: 'job', job: job('a', 'running') });
    s = eventsReducer(s, { type: 'agent', jobId: 'a', event: { kind: 'session', sessionId: 's1' } });
    s = eventsReducer(s, { type: 'agent', jobId: 'a', event: { kind: 'text', text: 'x' } });
    expect(s.jobs.a?.state).toBe('running');
    expect(s.events.a?.map((e) => e.kind)).toEqual(['session', 'text']);
  });
  it('caps stored events per job at 2000', () => {
    let s = initialEventsState;
    for (let i = 0; i < 2010; i++) s = eventsReducer(s, { type: 'agent', jobId: 'a', event: { kind: 'text', text: String(i) } });
    expect(s.events.a).toHaveLength(2000);
    expect(s.events.a?.[0]).toEqual({ kind: 'text', text: '10' });
  });
});

describe('sessionIdOf', () => {
  it('prefers the result session id, then the session event', () => {
    expect(sessionIdOf([{ kind: 'session', sessionId: 's1' }])).toBe('s1');
    expect(sessionIdOf([{ kind: 'session', sessionId: 's1' }, { kind: 'result', ok: true, sessionId: 's2' }])).toBe('s2');
    expect(sessionIdOf([])).toBeUndefined();
  });
});
```

- [ ] **Step 4: Verifica che falliscano**

Run: `pnpm vitest run packages/web`
Expected: FAIL (modulo inesistente).

- [ ] **Step 5: Implementa reducer, client, hook, tema**

`packages/web/src/eventsReducer.ts`:
```ts
import type { AgentEvent, JobSummary, ServerMessage } from '@motion-studio/shared';

export interface EventsState { jobs: Record<string, JobSummary>; events: Record<string, AgentEvent[]> }
export const initialEventsState: EventsState = { jobs: {}, events: {} };
const MAX_EVENTS = 2000;

export function eventsReducer(state: EventsState, msg: ServerMessage): EventsState {
  switch (msg.type) {
    case 'snapshot':
      return { ...state, jobs: Object.fromEntries(msg.jobs.map((j) => [j.id, j])) };
    case 'job':
      return { ...state, jobs: { ...state.jobs, [msg.job.id]: msg.job } };
    case 'agent': {
      const list = [...(state.events[msg.jobId] ?? []), msg.event];
      return { ...state, events: { ...state.events, [msg.jobId]: list.length > MAX_EVENTS ? list.slice(-MAX_EVENTS) : list } };
    }
  }
}

export function sessionIdOf(events: AgentEvent[]): string | undefined {
  let id: string | undefined;
  for (const e of events) {
    if (e.kind === 'session') id = e.sessionId;
    if (e.kind === 'result' && e.sessionId) id = e.sessionId;
  }
  return id;
}
```

`packages/web/src/api.ts`:
```ts
import type { DoctorCheck, JobSummary, ProjectFile, ProjectListItem, WorkspaceSettings } from '@motion-studio/shared';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Errore ${res.status}`);
  return data as T;
}

export const api = {
  getDoctor: () => request<DoctorCheck[]>('GET', '/api/doctor'),
  getWorkspace: () => request<{ path: string | null; settings: WorkspaceSettings | null }>('GET', '/api/workspace'),
  setWorkspace: (path: string) => request<{ path: string; settings: WorkspaceSettings }>('PUT', '/api/workspace', { path }),
  updateSettings: (patch: Partial<WorkspaceSettings>) => request<WorkspaceSettings>('PUT', '/api/settings', patch),
  listProjects: () => request<ProjectListItem[]>('GET', '/api/projects'),
  createProject: (name: string, description?: string) =>
    request<{ slug: string; project: ProjectFile }>('POST', '/api/projects', { name, description }),
  getProject: (slug: string) => request<{ slug: string; project: ProjectFile }>('GET', `/api/projects/${encodeURIComponent(slug)}`),
  startTurn: (slug: string, prompt: string, resumeSessionId?: string) =>
    request<JobSummary>('POST', `/api/projects/${encodeURIComponent(slug)}/turns`, { prompt, resumeSessionId }),
  cancelJob: (id: string) => request<{ cancelled: boolean }>('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
};
```

`packages/web/src/useServerEvents.ts`:
```ts
import type { ServerMessage } from '@motion-studio/shared';
import { useEffect, useReducer } from 'react';
import { eventsReducer, initialEventsState, type EventsState } from './eventsReducer.ts';

export function useServerEvents(): EventsState {
  const [state, dispatch] = useReducer(eventsReducer, initialEventsState);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/events`);
      ws.onmessage = (e) => dispatch(JSON.parse(String(e.data)) as ServerMessage);
      ws.onclose = () => { if (!stopped) retry = setTimeout(connect, 1000); };
    };
    connect();
    return () => { stopped = true; clearTimeout(retry); ws?.close(); };
  }, []);
  return state;
}
```

`packages/web/src/components/ThemeToggle.tsx`:
```tsx
import type { WorkspaceSettings } from '@motion-studio/shared';

type Theme = WorkspaceSettings['theme'];

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const LABELS: Record<Theme, string> = { system: 'Sistema', light: 'Chiaro', dark: 'Scuro' };

export function ThemeToggle({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <div role="radiogroup" aria-label="Tema" className="row" style={{ gap: 4 }}>
      {(Object.keys(LABELS) as Theme[]).map((t) => (
        <button key={t} type="button" role="radio" aria-checked={value === t} className={value === t ? 'primary' : ''} onClick={() => onChange(t)}>
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}
```

`packages/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './theme.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

Temporary `packages/web/src/App.tsx` (replaced in Task 12):
```tsx
export function App() {
  return <div className="page">Motion Studio</div>;
}
```

- [ ] **Step 6: Verifica che passino e che la build funzioni**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: 4 PASS, build in `packages/web/dist`, nessun errore di tipo.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): vite app foundation with theme tokens, API client and event reducer"
```

---

### Task 12: Frontend web — schermate (Onboarding/Doctor, Progetti, Progetto con console agente)

**Files:**
- Create: `packages/web/src/screens/Onboarding.tsx`, `packages/web/src/screens/ProjectList.tsx`, `packages/web/src/screens/ProjectPage.tsx`, `packages/web/src/components/AgentConsole.tsx`, `packages/web/test/AgentConsole.test.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError`, `useServerEvents`, `sessionIdOf`, `applyTheme`, `ThemeToggle` (Task 11).
- Produces:
  - `<AgentConsole job?: JobSummary; events: AgentEvent[]; expert: boolean; onCancel(): void />` — vista semplice: testo dell'agente, una riga "Usa lo strumento X" per tool, esito finale; vista esperto: tutte le righe in monospace (`tool_use` con input JSON, `tool_result`, `stderr`, `parse_error`).
  - Routing hash: `#/` progetti, `#/p/<slug>` progetto. L'onboarding appare finché il Doctor ha errori bloccanti o il workspace non è configurato.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/AgentConsole.test.tsx`:
```tsx
import type { AgentEvent, JobSummary } from '@motion-studio/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentConsole } from '../src/components/AgentConsole.tsx';

const job = (state: JobSummary['state'], error?: string): JobSummary => ({ id: 'j', key: 'k', label: 'Turno · Acme', state, createdAt: '2026-10-07T10:00:00.000Z', error });
const events: AgentEvent[] = [
  { kind: 'session', sessionId: 's1' },
  { kind: 'text', text: 'Creo la scena.' },
  { kind: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'work/a.txt' } },
  { kind: 'tool_result', toolUseId: 't1', isError: false, content: 'File created' },
  { kind: 'stderr', text: 'warning: x' },
];

describe('AgentConsole', () => {
  it('shows agent text and friendly tool steps in simple mode, hiding raw output', () => {
    render(<AgentConsole job={job('running')} events={events} expert={false} onCancel={() => {}} />);
    expect(screen.getByText('Creo la scena.')).toBeTruthy();
    expect(screen.getByText('Usa lo strumento Write')).toBeTruthy();
    expect(screen.queryByText('File created')).toBeNull();
    expect(screen.queryByText('warning: x')).toBeNull();
  });
  it('shows raw tool input/results and stderr in expert mode', () => {
    render(<AgentConsole job={job('running')} events={events} expert onCancel={() => {}} />);
    expect(screen.getByText(/"file_path": "work\/a.txt"/)).toBeTruthy();
    expect(screen.getByText('File created')).toBeTruthy();
    expect(screen.getByText('warning: x')).toBeTruthy();
  });
  it('offers cancel only while queued or running', async () => {
    const onCancel = vi.fn();
    const { rerender } = render(<AgentConsole job={job('running')} events={[]} expert={false} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(<AgentConsole job={job('succeeded')} events={[]} expert={false} onCancel={onCancel} />);
    expect(screen.queryByRole('button', { name: 'Annulla' })).toBeNull();
  });
  it('shows the job error when failed', () => {
    render(<AgentConsole job={job('failed', 'claude è terminato con codice 2')} events={[]} expert={false} onCancel={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('claude è terminato con codice 2');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web/test/AgentConsole.test.tsx`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementa `AgentConsole.tsx`**

```tsx
import type { AgentEvent, JobSummary } from '@motion-studio/shared';

const STATE_LABEL: Record<JobSummary['state'], string> = {
  queued: 'In coda', running: 'In lavorazione', succeeded: 'Completato', failed: 'Errore', cancelled: 'Annullato',
};
const STATE_CLASS: Record<JobSummary['state'], string> = { queued: 'run', running: 'run', succeeded: 'ok', failed: 'err', cancelled: '' };

function SimpleLine({ e }: { e: AgentEvent }) {
  if (e.kind === 'text') return <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.text}</p>;
  if (e.kind === 'tool_use') return <p className="muted" style={{ margin: 0 }}>Usa lo strumento {e.name}</p>;
  if (e.kind === 'rate_limit' && e.status !== 'allowed') return <p className="warn" style={{ margin: 0 }}>Limite di utilizzo: {e.status}</p>;
  return null;
}

function ExpertLine({ e }: { e: AgentEvent }) {
  const tag = (t: string) => <span style={{ color: 'var(--accent-ink)', minWidth: 90, display: 'inline-block' }}>{t}</span>;
  switch (e.kind) {
    case 'session': return <div>{tag('session')}{e.sessionId}</div>;
    case 'text': return <div>{tag('text')}<span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span></div>;
    case 'tool_use': return <div>{tag(`tool ${e.name}`)}<pre style={{ margin: 0, display: 'inline', whiteSpace: 'pre-wrap' }}>{JSON.stringify(e.input, null, 2)}</pre></div>;
    case 'tool_result': return <div>{tag(e.isError ? 'result ✗' : 'result')}<span style={{ whiteSpace: 'pre-wrap' }}>{e.content}</span></div>;
    case 'stderr': return <div>{tag('stderr')}<span className="error">{e.text}</span></div>;
    case 'parse_error': return <div>{tag('parse')}<span className="error">{e.line}</span></div>;
    case 'rate_limit': return <div>{tag('limit')}{e.status}</div>;
    case 'result': return <div>{tag('done')}{e.ok ? 'ok' : e.error}{e.costUsd !== undefined ? ` · $${e.costUsd.toFixed(4)}` : ''}</div>;
  }
}

export function AgentConsole({ job, events, expert, onCancel }: { job?: JobSummary; events: AgentEvent[]; expert: boolean; onCancel: () => void }) {
  const active = job && (job.state === 'queued' || job.state === 'running');
  return (
    <section className="card stack" aria-label="Attività dell'agente">
      {job && (
        <div className="row">
          <span className={`badge ${STATE_CLASS[job.state]}`}>{STATE_LABEL[job.state]}</span>
          <span className="muted">{job.label}</span>
          <div style={{ flex: 1 }} />
          {active && <button type="button" onClick={onCancel}>Annulla</button>}
        </div>
      )}
      {job?.state === 'failed' && <p role="alert" className="error" style={{ margin: 0 }}>{job.error}</p>}
      <div className={expert ? 'mono stack' : 'stack'} style={{ gap: expert ? 4 : 8 }}>
        {events.map((e, i) => (expert ? <ExpertLine key={i} e={e} /> : <SimpleLine key={i} e={e} />))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Implementa le schermate**

`packages/web/src/screens/Onboarding.tsx`:
```tsx
import type { DoctorCheck } from '@motion-studio/shared';
import { useState } from 'react';
import { api, ApiError } from '../api.ts';

export function Onboarding({ checks, workspacePath, onRecheck, onWorkspaceSet }: {
  checks: DoctorCheck[] | null;
  workspacePath: string | null;
  onRecheck: () => void;
  onWorkspaceSet: () => void;
}) {
  const [path, setPath] = useState(workspacePath ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true); setError(null);
    try { await api.setWorkspace(path.trim()); onWorkspaceSet(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <main className="page stack" style={{ maxWidth: 720 }}>
      <h1 style={{ margin: 0, fontSize: 28 }}>Benvenuto in Motion Studio</h1>
      <section className="card stack" aria-label="Controllo ambiente">
        <div className="row"><strong>Controllo ambiente</strong><div style={{ flex: 1 }} /><button type="button" onClick={onRecheck}>Ricontrolla</button></div>
        {!checks && <p className="muted">Controllo in corso…</p>}
        {checks?.map((c) => (
          <div key={c.id} className="row" style={{ alignItems: 'flex-start' }}>
            <span className={`badge ${c.ok ? 'ok' : c.required ? 'err' : ''}`}>{c.ok ? 'OK' : c.required ? 'Manca' : 'Consigliato'}</span>
            <div className="stack" style={{ gap: 2, flex: 1 }}>
              <span><strong>{c.label}</strong>{c.version ? <span className="muted"> · {c.version}</span> : null} — {c.message}</span>
              {c.fix && <code className="mono">{c.fix}</code>}
            </div>
          </div>
        ))}
      </section>
      <section className="card stack" aria-label="Workspace">
        <label htmlFor="ws-path"><strong>Cartella di lavoro</strong></label>
        <p className="muted" style={{ margin: 0 }}>Qui Motion Studio salva tutti i progetti. Se non esiste, viene creata.</p>
        <input id="ws-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/tuonome/MotionStudio" />
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
        <div className="row"><button type="button" className="primary" disabled={busy || !path.trim()} onClick={save}>Usa questa cartella</button></div>
      </section>
    </main>
  );
}
```

`packages/web/src/screens/ProjectList.tsx`:
```tsx
import type { ProjectListItem } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';

export function ProjectList() {
  const [items, setItems] = useState<ProjectListItem[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listProjects().then(setItems).catch((e) => setError(String(e.message)));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError(null);
    try {
      const { slug } = await api.createProject(name);
      location.hash = `#/p/${slug}`;
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };

  return (
    <main className="page stack">
      <div className="row"><h1 style={{ margin: 0, fontSize: 24 }}>Progetti</h1></div>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label htmlFor="new-project" className="muted">Nuovo progetto</label>
        <input id="new-project" value={name} onChange={(e) => setName(e.target.value)} placeholder="Es. Acme" style={{ flex: '1 1 240px', width: 'auto' }} />
        <button type="submit" className="primary" disabled={!name.trim()}>Crea</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {items?.length === 0 && <p className="muted">Nessun progetto ancora: creane uno per iniziare.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {items?.map((it) =>
          it.ok ? (
            <a key={it.slug} href={`#/p/${it.slug}`} className="card stack" style={{ textDecoration: 'none', color: 'inherit', gap: 4 }}>
              <strong>{it.project.name}</strong>
              <span className="muted">{it.project.description || 'Nessuna descrizione'}</span>
              <span className="muted" style={{ fontSize: 12 }}>Aggiornato {new Date(it.project.updatedAt).toLocaleDateString('it-IT')}</span>
            </a>
          ) : (
            <div key={it.slug} className="card stack" style={{ gap: 4 }}>
              <strong>{it.slug}</strong>
              <span className="badge err" style={{ alignSelf: 'flex-start' }}>Non leggibile</span>
              <span className="mono" style={{ overflowWrap: 'anywhere' }}>{it.error}</span>
            </div>
          ),
        )}
      </div>
    </main>
  );
}
```

`packages/web/src/screens/ProjectPage.tsx`:
```tsx
import type { ProjectFile } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { AgentConsole } from '../components/AgentConsole.tsx';
import { sessionIdOf, type EventsState } from '../eventsReducer.ts';

export function ProjectPage({ slug, live, expert }: { slug: string; live: EventsState; expert: boolean }) {
  const [project, setProject] = useState<ProjectFile | null>(null);
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.getProject(slug).then((r) => setProject(r.project)).catch((e) => setError(String(e.message))); }, [slug]);

  const job = jobId ? live.jobs[jobId] : undefined;
  const events = useMemo(() => (jobId ? live.events[jobId] ?? [] : []), [jobId, live.events]);
  const busy = job?.state === 'queued' || job?.state === 'running';

  const send = async () => {
    setError(null);
    try {
      const j = await api.startTurn(slug, prompt, sessionIdOf(events));
      setJobId(j.id);
      setPrompt('');
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };

  return (
    <main className="page stack">
      <a href="#/" className="muted">← Progetti</a>
      <h1 style={{ margin: 0, fontSize: 24 }}>{project?.name ?? slug}</h1>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label htmlFor="prompt"><strong>Chiedi all'agente</strong> <span className="muted">(sessione di prova nella cartella del progetto)</span></label>
        <textarea id="prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Es. elenca i file del progetto" />
        <div className="row">
          {sessionIdOf(events) && <span className="muted mono">sessione {sessionIdOf(events)}</span>}
          <div style={{ flex: 1 }} />
          <button type="submit" className="primary" disabled={busy || !prompt.trim()}>Invia</button>
        </div>
        {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      </form>
      {jobId && <AgentConsole job={job} events={events} expert={expert} onCancel={() => void api.cancelJob(jobId)} />}
    </main>
  );
}
```

`packages/web/src/App.tsx`:
```tsx
import type { DoctorCheck, WorkspaceSettings } from '@motion-studio/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { applyTheme, ThemeToggle } from './components/ThemeToggle.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { ProjectList } from './screens/ProjectList.tsx';
import { ProjectPage } from './screens/ProjectPage.tsx';
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
  const [ws, setWs] = useState<{ path: string | null; settings: WorkspaceSettings | null } | null>(null);
  const live = useServerEvents();
  const route = useHashRoute();

  const refresh = useCallback(() => {
    setChecks(null);
    void api.getDoctor().then(setChecks);
    void api.getWorkspace().then((w) => { setWs(w); if (w.settings) applyTheme(w.settings.theme); });
  }, []);
  useEffect(refresh, [refresh]);

  const blocking = checks?.some((c) => c.required && !c.ok) ?? true;
  if (!ws || !ws.settings || blocking) {
    return <Onboarding checks={checks} workspacePath={ws?.path ?? null} onRecheck={refresh} onWorkspaceSet={refresh} />;
  }
  const settings = ws.settings;
  const update = async (patch: Partial<WorkspaceSettings>) => {
    const next = await api.updateSettings(patch);
    applyTheme(next.theme);
    setWs({ ...ws, settings: next });
  };
  const running = Object.values(live.jobs).filter((j) => j.state === 'running').length;
  const queued = Object.values(live.jobs).filter((j) => j.state === 'queued').length;
  const projectSlug = route.match(/^#\/p\/([a-z0-9-]+)/)?.[1];

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
      {projectSlug ? <ProjectPage slug={projectSlug} live={live} expert={settings.expertMode} /> : <ProjectList />}
    </>
  );
}
```

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: tutti PASS, build OK.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): onboarding with doctor, project list and agent console"
```

---

### Task 13: Launcher CLI (`motion-studio`) e README

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/tsup.config.ts`, `apps/cli/src/args.ts`, `apps/cli/src/main.ts`, `apps/cli/test/args.test.ts`, `README.md`

**Interfaces:**
- Consumes: `startServer` (Task 10); build web in `packages/web/dist` (Task 11/12).
- Produces: `parseCliArgs(argv: string[]): { port: number; open: boolean; help: boolean }` (`--port <n>` default 4317, `--no-open`, `--help`; porta non valida → errore). Binario `motion-studio` che serve la UI da `dist/web` accanto a `dist/main.js`.

- [ ] **Step 1: Pacchetto**

`apps/cli/package.json`:
```json
{
  "name": "motion-studio",
  "version": "0.1.0",
  "description": "Motion Studio: crea video in motion graphics e immagini con il tuo agente di coding locale",
  "license": "MIT",
  "type": "module",
  "bin": { "motion-studio": "dist/main.js" },
  "files": ["dist"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsup && node -e \"require('node:fs').cpSync('../../packages/web/dist','dist/web',{recursive:true})\"",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@fastify/static": "^8.0.0",
    "@fastify/websocket": "^11.0.0",
    "fastify": "^5.0.0",
    "open": "^10.1.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@motion-studio/core": "workspace:*",
    "tsup": "^8.5.0"
  }
}
```

Note: the build script uses `node -e` with `require` inside a CommonJS eval, which works regardless of the package `type`.

`apps/cli/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "tsup.config.ts"] }
```

`apps/cli/tsup.config.ts`:
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  noExternal: [/^@motion-studio\//],
});
```

Run: `pnpm install`

- [ ] **Step 2: Test che falliscono**

`apps/cli/test/args.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/args.ts';

describe('parseCliArgs', () => {
  it('uses defaults', () => {
    expect(parseCliArgs([])).toEqual({ port: 4317, open: true, help: false });
  });
  it('parses --port, --no-open and --help', () => {
    expect(parseCliArgs(['--port', '5000', '--no-open'])).toEqual({ port: 5000, open: false, help: false });
    expect(parseCliArgs(['--help']).help).toBe(true);
  });
  it('rejects an invalid port', () => {
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow('Porta non valida');
    expect(() => parseCliArgs(['--port', '70000'])).toThrow('Porta non valida');
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run apps/cli`
Expected: FAIL (modulo inesistente).

- [ ] **Step 4: Implementa**

`apps/cli/src/args.ts`:
```ts
import { parseArgs } from 'node:util';

export function parseCliArgs(argv: string[]): { port: number; open: boolean; help: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '4317' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Porta non valida: ${values.port}`);
  return { port, open: !values['no-open'], help: values.help ?? false };
}
```

`apps/cli/src/main.ts`:
```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import open from 'open';
import { startServer } from '@motion-studio/core';
import { parseCliArgs } from './args.ts';

const HELP = `Uso: motion-studio [--port 4317] [--no-open]

Avvia Motion Studio in locale e apre il browser.
Variabili: MOTION_STUDIO_CONFIG_DIR, MOTION_STUDIO_CLAUDE_COMMAND (array JSON)`;

async function main() {
  let args;
  try { args = parseCliArgs(process.argv.slice(2)); }
  catch (e) { console.error((e as Error).message); console.error(HELP); process.exit(1); }
  if (args.help) { console.log(HELP); return; }
  const webDir = join(dirname(fileURLToPath(import.meta.url)), 'web');
  try {
    const { url, close } = await startServer({ port: args.port, webDir });
    console.log(`Motion Studio è attivo su ${url}`);
    if (args.open) await open(url);
    const stop = async () => { await close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === 'EADDRINUSE' ? `La porta ${args.port} è già in uso: riprova con --port <altra>` : err.message);
    process.exit(1);
  }
}

void main();
```

- [ ] **Step 5: Verifica test e build completa**

Run: `pnpm vitest run apps/cli && pnpm build && node apps/cli/dist/main.js --help`
Expected: 3 PASS; la build crea `apps/cli/dist/main.js` e `apps/cli/dist/web/index.html`; `--help` stampa l'uso.

- [ ] **Step 6: Smoke test end-to-end con il finto `claude`**

Run (in un terminale):
```bash
MOTION_STUDIO_CONFIG_DIR="$(mktemp -d)" \
MOTION_STUDIO_CLAUDE_COMMAND="[\"node\",\"$PWD/packages/core/test/fixtures/fake-claude.mjs\"]" \
node apps/cli/dist/main.js --port 4399 --no-open
```
In un altro terminale:
```bash
curl -s localhost:4399/api/health
curl -s -X PUT localhost:4399/api/workspace -H 'content-type: application/json' -d "{\"path\":\"$(mktemp -d)/ws prova\"}"
curl -s -X POST localhost:4399/api/projects -H 'content-type: application/json' -d '{"name":"Acme"}'
curl -s -X POST localhost:4399/api/projects/acme/turns -H 'content-type: application/json' -d '{"prompt":"ciao"}'
sleep 1; curl -s localhost:4399/api/jobs
curl -s localhost:4399/ | head -c 200
```
Expected: `{"ok":true}`; workspace con settings; progetto `acme` creato; job `202`; `/api/jobs` mostra `"state":"succeeded"`; `/` restituisce l'`index.html` della UI. Ferma il server con Ctrl+C.

- [ ] **Step 7: README**

`README.md`:
````markdown
# Motion Studio

App locale e open-source per creare video in motion graphics e immagini usando il tuo agente di coding (inizialmente **Claude Code**). Tutto resta sul tuo computer: i progetti sono cartelle con file JSON/Markdown versionate con git.

> Stato: fase 1 (fondamenta). Vedi `docs/superpowers/specs/` per il design completo.

## Requisiti
- Node.js 22+
- Git
- [Claude Code](https://docs.claude.com/claude-code) installato e autenticato (`claude auth login`)
- FFmpeg (consigliato)

## Avvio
```bash
pnpm install
pnpm motion-studio        # build + avvio su http://127.0.0.1:4317
```

## Sviluppo
```bash
pnpm dev                  # core (tsx watch, porta 4317) + web (Vite, porta 5173 con proxy /api)
pnpm test                 # tutti i test (usano un finto `claude`, nessun consumo di quota)
pnpm typecheck
```

Variabili utili:
- `MOTION_STUDIO_CONFIG_DIR` — dove salvare la config dell'app (percorso del workspace).
- `MOTION_STUDIO_CLAUDE_COMMAND` — comando dell'agente come array JSON, es. `["node","/percorso/fake-claude.mjs"]`.

## Licenza
MIT
````

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cli): motion-studio launcher serving the web UI, plus README"
```

---

### Task 14: Verifica finale con Claude Code reale

**Files:** nessuno (solo verifica manuale).

- [ ] **Step 1: Tutti i controlli automatici**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: tutto verde.

- [ ] **Step 2: Smoke manuale con il vero `claude`**

Run: `MOTION_STUDIO_CONFIG_DIR="$(mktemp -d)" node apps/cli/dist/main.js`
Nel browser:
1. Il Doctor mostra Node, Git, FFmpeg, Claude Code e "Accesso a Claude" come OK.
2. Imposta come workspace una cartella temporanea con uno spazio nel nome.
3. Crea il progetto "Prova Motion".
4. Nella pagina del progetto invia: `Elenca i file di questa cartella e dimmi cosa contiene CLAUDE.md`.
5. Vista semplice: testo dell'agente e righe "Usa lo strumento …"; stato finale "Completato".
6. Attiva "Modalità esperto": compaiono tool call, risultati e id sessione.
7. Invia una seconda richiesta: l'id sessione resta lo stesso (resume).
8. Invia `Esegui il comando sleep 60` e premi **Annulla**: lo stato diventa "Annullato" e `ps aux | grep "claude -p"` non mostra processi residui.
9. Cambia tema Chiaro/Scuro/Sistema: tutti i colori cambiano, il tema è ricordato dopo il reload.

- [ ] **Step 3: Annota eventuali differenze**

Se il formato reale dello stream differisce dalla fixture, aggiorna `packages/core/test/fixtures/claude-stream-sample.jsonl` con righe reali anonimizzate, adegua `parseClaudeLine` con un test che lo copra e committa:
```bash
git add -A
git commit -m "fix(core): align stream parser with real Claude Code output"
```

---

## Piani successivi (fuori da questo documento)

Ogni fase avrà il suo piano, scritto quando la precedente è completata:

- **Fase 2 — Creatività:** catalogo formati (`formats.json`), brief guidato, `creative.json`/`conversation.jsonl`/`versions.json`, contratto di output con `validate_output`, versioni = commit, riparti da versione (`--fork-session`), anteprime (poster frame con ffmpeg), tavola dei formati + vista focus + pannello conversazione.
- **Fase 3 — Brand e asset:** brand kit strutturato con fonte per campo, analisi siti/immagini con diff approvabile, estrazione asset, gestione asset/riferimenti, codebase collegate (sola lettura via permessi generati).
- **Fase 4 — MCP `studio` e approvazioni:** server MCP per sessione, provider (gpt-image-2, TTS, Pexels/Unsplash, Google Fonts) con chiavi nel portachiavi OS, `report_progress`, `request_approval` + permission prompt tool → ApprovalBroker → UI.
- **Fase 5 — Electron e distribuzione:** shell Electron (dialog nativo per il workspace, notifiche), packaging firmato, release GitHub Actions, pacchetto npm.
