# Motion Studio — Fase 4: Sandbox, MCP `studio`, provider e approvazioni — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ogni turno dell'agente (creatività, analisi brand, descrizione asset, console) gira dentro la **sandbox di Claude Code**: scritture confinate al progetto, codebase collegate e file del brand protetti anche dagli interpreti, cartelle sensibili della home illeggibili, rete solo su whitelist (aperta all'analisi brand). Le azioni fuori perimetro chiedono **approvazione nella UI** (Consenti una volta / Sempre per questo progetto / Nega). Un server MCP `studio` espone all'agente: avanzamento, validazione degli output, brand kit, e i **provider** (OpenAI gpt-image-2, TTS OpenAI/ElevenLabs, Pexels, Unsplash, Google Fonts) con le chiavi custodite nel portachiavi del sistema e mai visibili all'agente.

**Architecture:** Un nuovo `AgentLauncher` nel core sostituisce le chiamate dirette a `runner.start`: calcola la **policy** del turno (`buildAgentPolicy`: settings della sandbox, regole allow/deny, domini), registra un **token di bridge** per il job e passa a `claude` `--settings`, `--mcp-config` (server `studio` via stdio) e `--permission-prompt-tool mcp__studio__approve`. Il server MCP (`packages/mcp-studio`, JavaScript senza dipendenze) inoltra ogni tool al core su loopback (`POST /api/bridge/<tool>` con header `x-motion-studio-bridge`); il core esegue (provider, validazione, approvazioni tramite `ApprovalBroker`) e risponde. Le approvazioni viaggiano verso la UI sul WebSocket esistente.

**Tech Stack:** come Fase 3. Nuovi: `@napi-rs/keyring` (portachiavi). Nessuna SDK di provider: `fetch` nativo con implementazione iniettabile per i test.

**Spec:** `docs/superpowers/specs/2026-10-07-motion-studio-design.md` (§2, §6.3, §7, §8.2 impostazioni/notifiche, §9). Decisioni di riferimento: `docs/decisions-log.md` voci 48–53 e le verifiche dal vivo. Base: `main` (Fase 3 completata, `25513f7`).

## Fatti verificati dal vivo (claude 2.1.29x) su cui si basa il piano

- `--settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true}}'`: `node`/`python3` lanciati da Bash ricevono EPERM scrivendo fuori dalla cwd (eccetto `/tmp` e le cartelle `--add-dir`).
- `sandbox.filesystem.denyWrite: [<path>]` → EPERM anche per gli interpreti su una cartella collegata con `--add-dir` (che resta leggibile).
- `sandbox.filesystem.denyRead: [<path>]` → `cat` e `python3` ricevono "Operation not permitted".
- `sandbox.network.allowedDomains`: assente → rete chiusa; `["registry.npmjs.org"]` → solo quello; `["*.python.org"]` → sottodomini; `["*"]` → tutto. Le violazioni di rete vengono negate subito (NON passano dal permission-prompt-tool).
- `--permission-prompt-tool mcp__studio__approve` (server stdio in `--mcp-config`): una Write fuori dal progetto arriva al tool con argomenti `{ "tool_name": "Write", "input": {…}, "tool_use_id": "…" }`; la risposta (contenuto testuale JSON) `{"behavior":"deny","message":"…"}` viene rispettata; `{"behavior":"allow","updatedInput":{…}}` consente.
- Nomi dei tool MCP visti dal modello: `mcp__<server>__<tool>`.

## Global Constraints

- Tutti i vincoli delle fasi 1–3 restano validi (tutto locale, `schemaVersion: 1`, JSON corrotti mai riscritti, git serializzato, loopback-only con Host/Origin, file serviti confinati con CSP sandbox, token CSS, copy in italiano, `AgentRunner` neutro).
- **Nessun punto del codice chiama `runner.start` direttamente** tranne `AgentLauncher` (e i test del runner).
- Sandbox: modalità `auto` (default: attiva se il sistema la supporta) o `off` (impostazione). Supporto: macOS se esiste `/usr/bin/sandbox-exec`; Linux se `bwrap` e `socat` rispondono; Windows mai. Senza sandbox effettiva si usa il comportamento della Fase 3 (liste di tool ristrette) e la UI lo segnala.
- Rete: creatività e console → `DEFAULT_ALLOWED_DOMAINS` + `settings.extraAllowedDomains`; analisi brand → `["*"]`; descrizione asset → nessuna.
- `denyRead` sempre sulle cartelle sensibili della home (lista `SENSITIVE_HOME_PATHS`) e sulla cartella di configurazione dell'app.
- `denyWrite` (sandbox) + `Edit(...)` deny (tool) sulle codebase collegate e sui file del brand protetti (`GUARDED_FILES`) nei job brand/descrizione.
- Approvazioni: timeout 10 minuti → negata con messaggio; job annullato → le sue approvazioni in sospeso vengono negate. "Sempre per questo progetto" salva una regola in `<progetto>/.studio/permissions.json`, usata come `--allowedTools` nei turni successivi.
- Chiavi API: solo nel core (`SecretsVault`): variabile d'ambiente → portachiavi (`@napi-rs/keyring`, servizio `Motion Studio`) → assente. Mai restituite dalle API, mai scritte su disco dal core, mai passate all'agente o al server MCP.
- Provider a pagamento (immagini, TTS): conferma nella UI prima di ogni chiamata se `settings.confirmPaidProviders` (default `true`); "Sempre per questo progetto" la salta per quel provider in quel progetto.
- File prodotti dai provider: salvati in `assets/generated/`, `assets/audio/`, `assets/stock/`, `assets/fonts/` con nomi unici, registrati in `assets.json` (`origin` `generated`/`stock`, `attribution` per lo stock).
- `MCP_TOOL_TIMEOUT=900000` nell'ambiente di `claude` (generazioni lunghe, approvazioni fino a 10 min).

## Review Focus

1. **Sandbox davvero attiva**: in ogni tipo di turno, con sandbox `auto` su macOS, gli argomenti includono `--settings` con `sandbox.enabled`, `denyRead` sensibili, `denyWrite` delle codebase, e i domini attesi; con `off` o sistema non supportato, gli argomenti sono quelli della Fase 3 e Doctor/UI lo dicono. → test in Task 2 e Task 5.
2. **Approvazioni affidabili**: richiesta in sospeso visibile, risposta una volta sola (seconda risposta 409), timeout → negata, job annullato o server chiuso → negata e nessuna promessa appesa; "Sempre" scrive una regola sicura e non duplicata. → test in Task 4 e Task 5.
3. **Bridge non sfruttabile**: senza token valido 401; token di un job finito non più valido; il bridge non accetta Origin non locali (guardia esistente); un tool non può leggere/scrivere fuori dal progetto del job (riferimenti immagine, nomi file). → test in Task 5, Task 7, Task 10.
4. **Chiavi mai esposte**: `GET /api/secrets` restituisce solo lo stato; log, errori dei provider e risposte del bridge non contengono la chiave (errori 401 dei provider → "Chiave non valida"). → test in Task 3 e Task 7–9.
5. **Provider che falliscono** (rete giù, 429, risposta malformata, file enorme): errore leggibile in italiano all'agente, nessun file parziale in `assets/`, nessuna voce in `assets.json`. → test in Task 7–9.

---

## File Structure

```
packages/shared/src/
  schemas.ts        # (modify) settings: sandboxMode, extraAllowedDomains, confirmPaidProviders
  events.ts         # (modify) AgentEvent 'progress', ApprovalRequest, ServerMessage approval/approval_resolved, snapshot approvals, DoctorCheck id 'sandbox'
  library.ts        # (modify) AssetEntry.attribution
  permissions.ts    # permissionsFileSchema, ProviderId, SecretStatus
packages/core/src/
  agent/sandbox.ts        # detectSandbox, SENSITIVE_HOME_PATHS, DEFAULT_ALLOWED_DOMAINS
  agent/policy.ts         # buildAgentPolicy (pure)
  agent/launcher.ts       # AgentLauncher
  agent/runner.ts         # (modify) settings, mcpConfig, permissionPromptTool, env
  agent/claude-code-runner.ts # (modify) args + env
  secrets/vault.ts        # SecretsVault, KeyringVault, MemoryVault
  approvals/broker.ts     # ApprovalBroker
  approvals/permissions-store.ts # PermissionsStore, ruleFor
  bridge/bridge.ts        # AgentBridge (tokens → job context)
  bridge/bridge-routes.ts # POST /api/bridge/:tool
  providers/http.ts       # fetchJson/fetchBytes with limits and safe errors
  providers/files.ts      # saveGeneratedFile
  providers/openai-images.ts  providers/tts.ts  providers/stock.ts  providers/google-fonts.ts
  server/settings-routes.ts   # secrets, approvals, permissions routes
  doctor.ts               # (modify) sandbox check
  creatives/creative-turns.ts  brand/brand-analysis.ts  server/app.ts  server/main.ts  # (modify) use AgentLauncher
packages/mcp-studio/
  package.json  src/server.mjs  test/server.test.ts
packages/web/src/
  screens/SettingsPage.tsx  components/ApprovalCard.tsx  components/ApprovalsIndicator.tsx  components/PermissionsList.tsx
  eventsReducer.ts routes.ts api.ts App.tsx  (modify)  components/AgentConsole.tsx ConversationPanel.tsx BrandPage.tsx AssetsPage.tsx ProjectSettings.tsx (modify)
```

---

### Task 1: Schemi condivisi della Fase 4

**Files:**
- Create: `packages/shared/src/permissions.ts`, `packages/shared/test/phase4.test.ts`
- Modify: `packages/shared/src/schemas.ts`, `packages/shared/src/events.ts`, `packages/shared/src/library.ts`, `packages/shared/src/index.ts`, `packages/web/src/eventsReducer.ts`

**Interfaces:**
- Produces:
  ```ts
  // schemas.ts — workspaceSettingsSchema gains (all with defaults, schemaVersion stays 1):
  sandboxMode: z.enum(['auto', 'off']).default('auto'),
  extraAllowedDomains: z.array(domainSchema).max(100).default([]),   // domainSchema: /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/i, lowercased
  confirmPaidProviders: z.boolean().default(true),
  // events.ts
  AgentEvent gains  | { kind: 'progress'; text: string }
  export type ApprovalKind = 'tool' | 'provider';
  export interface ApprovalRequest {
    id: string; jobId: string; projectSlug: string; creativeSlug: string | null; kind: ApprovalKind;
    title: string;            // Italian, e.g. "Scrivere un file fuori dal progetto"
    detail: string;           // the command / path / provider summary, plain text
    toolName: string;         // e.g. 'Bash', 'Write', 'provider:openai-images'
    alwaysRule: string | null;// rule saved by "Sempre per questo progetto" (null = not offered)
    createdAt: string; expiresAt: string;
  }
  export type ApprovalDecision = 'once' | 'always' | 'deny';
  ServerMessage: snapshot gains `approvals: ApprovalRequest[]`; new members
    | { type: 'approval'; approval: ApprovalRequest }
    | { type: 'approval_resolved'; id: string; decision: ApprovalDecision | 'expired' | 'cancelled' }
  DoctorCheck.id gains 'sandbox'
  // library.ts — assetEntrySchema gains attribution: z.string().max(500).nullable().default(null)
  // permissions.ts
  export const PROVIDER_IDS = ['openai', 'elevenlabs', 'pexels', 'unsplash'] as const;
  export type ProviderId = typeof PROVIDER_IDS[number];
  export interface SecretStatus { provider: ProviderId; configured: boolean; source: 'env' | 'keychain' | null }
  export const permissionsFileSchema = z.object({ schemaVersion: z.literal(1),
    allow: z.array(z.object({ rule: z.string().min(1).max(500), label: z.string().max(300), addedAt: z.iso.datetime() })).max(200).default([]) });
  export type PermissionsFile = z.infer<typeof permissionsFileSchema>;
  ```
- Web reducer: `EventsState` gains `approvals: Record<string, ApprovalRequest>`; `snapshot` replaces it from `msg.approvals`; `approval` adds; `approval_resolved` removes.

- [ ] **Step 1: Test che falliscono**

`packages/shared/test/phase4.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assetEntrySchema, permissionsFileSchema, workspaceSettingsSchema } from '../src/index.ts';

describe('phase 4 settings', () => {
  it('defaults sandbox, domains and paid confirmation', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1 })).toMatchObject({ sandboxMode: 'auto', extraAllowedDomains: [], confirmPaidProviders: true });
  });
  it('validates and lowercases domains', () => {
    expect(workspaceSettingsSchema.parse({ schemaVersion: 1, extraAllowedDomains: ['*.Example.com', 'api.acme.io'] }).extraAllowedDomains).toEqual(['*.example.com', 'api.acme.io']);
    for (const bad of ['*', 'http://x.com', 'x', '*.com', 'a b.com']) {
      expect(workspaceSettingsSchema.safeParse({ schemaVersion: 1, extraAllowedDomains: [bad] }).success, bad).toBe(false);
    }
  });
});

describe('asset attribution', () => {
  it('defaults to null', () => {
    const a = assetEntrySchema.parse({ file: 'a.png', kind: 'image', origin: 'stock', sourceUrl: null, description: '', tags: [], width: null, height: null, addedAt: '2026-10-08T10:00:00.000Z' });
    expect(a.attribution).toBeNull();
  });
});

describe('permissionsFileSchema', () => {
  it('defaults allow to []', () => {
    expect(permissionsFileSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1, allow: [] });
  });
});
```

Append to `packages/web/test/eventsReducer.test.ts`:
```ts
describe('approvals', () => {
  const approval = { id: 'a1', jobId: 'j', projectSlug: 'acme', creativeSlug: null, kind: 'tool' as const, title: 't', detail: 'd', toolName: 'Bash', alwaysRule: null, createdAt: 'x', expiresAt: 'y' };
  it('tracks pending approvals from snapshot, add and resolve', () => {
    let s = eventsReducer(initialEventsState, { type: 'snapshot', jobs: [], approvals: [approval] });
    expect(Object.keys(s.approvals)).toEqual(['a1']);
    s = eventsReducer(s, { type: 'approval_resolved', id: 'a1', decision: 'deny' });
    expect(s.approvals).toEqual({});
    s = eventsReducer(s, { type: 'approval', approval: { ...approval, id: 'a2' } });
    expect(Object.keys(s.approvals)).toEqual(['a2']);
  });
});
```
(Update existing snapshot literals in web tests to include `approvals: []`.)

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/shared packages/web/test/eventsReducer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa**

`schemas.ts` — before `workspaceSettingsSchema`:
```ts
export const domainSchema = z.string().trim().toLowerCase().regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/, 'dominio non valido (es. api.esempio.it o *.esempio.it)');
```
and add the three fields shown above to `workspaceSettingsSchema` (note: `.toLowerCase()` runs before `.regex`, so `*.Example.com` is accepted and stored lowercased).

`events.ts`: add the `progress` member to `AgentEvent`, the `ApprovalRequest`/`ApprovalKind`/`ApprovalDecision` types, the `ServerMessage` changes and `'sandbox'` in `DoctorCheck['id']` exactly as in Interfaces.

`library.ts`: add `attribution: z.string().max(500).nullable().default(null),` to `assetEntrySchema` (existing files without the key stay valid).

`permissions.ts`: as in Interfaces (import `z`). `index.ts`: `export * from './permissions.ts';`

`eventsReducer.ts`: add `approvals: Record<string, ApprovalRequest>` to `EventsState` and `initialEventsState`; in `snapshot` set `approvals: Object.fromEntries((msg.approvals ?? []).map((a) => [a.id, a]))`; add cases:
```ts
    case 'approval':
      return { ...state, approvals: { ...state.approvals, [msg.approval.id]: msg.approval } };
    case 'approval_resolved': {
      const { [msg.id]: _gone, ...rest } = state.approvals;
      return { ...state, approvals: rest };
    }
```
Core: the WS snapshot in `app.ts` must now send `approvals: []` (filled in Task 4) so types compile: `hub.send(socket, { type: 'snapshot', jobs: queue.list(), approvals: [] })`.

- [ ] **Step 4: Verifica**

Run: `pnpm test && pnpm typecheck`
Expected: tutti PASS (update any `EventsState` literal in web tests with `approvals: {}`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shared): phase 4 settings, approvals, progress events and asset attribution"
```

---

### Task 2: Sandbox, policy del turno e argomenti del runner

**Files:**
- Create: `packages/core/src/agent/sandbox.ts`, `packages/core/src/agent/policy.ts`, `packages/core/test/sandbox.test.ts`, `packages/core/test/policy.test.ts`
- Modify: `packages/core/src/agent/runner.ts`, `packages/core/src/agent/claude-code-runner.ts`, `packages/core/src/doctor.ts`, `packages/core/test/claude-code-runner.test.ts`, `packages/core/test/doctor.test.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces (`sandbox.ts`):
  ```ts
  export interface SandboxSupport { available: boolean; reason: string }   // Italian reason
  export function detectSandbox(opts?: { platform?: NodeJS.Platform; exec?: CommandExec; exists?: (p: string) => Promise<boolean> }): Promise<SandboxSupport>;
    // darwin: available iff /usr/bin/sandbox-exec exists; linux: iff `bwrap --version` and `socat -V` exit 0 (reason names what is missing, fix: "installa bubblewrap e socat");
    // win32 and others: false, reason "La sandbox di Claude Code non è disponibile su Windows"
  export const DEFAULT_ALLOWED_DOMAINS: readonly string[];  // see below
  export function sensitiveHomePaths(home: string): string[]; // see below
  ```
  `DEFAULT_ALLOWED_DOMAINS = ['registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'github.com', '*.github.com', '*.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com', 'remotion.dev', '*.remotion.dev']`.
  `sensitiveHomePaths(home)` = `['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gh', '.config/gcloud', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'Library/Keychains', 'Library/Application Support/Motion Studio', '.config/motion-studio']` mapped to `join(home, p)`.
- Produces (`policy.ts`):
  ```ts
  export type AgentJobKind = 'creative' | 'brand-analysis' | 'describe' | 'console';
  export interface PolicyInput {
    kind: AgentJobKind; sandbox: boolean; home: string; configDir: string;
    codebases: string[];          // existing linked codebases (absolute)
    protectedFiles: string[];     // absolute files no tool may edit (GUARDED_FILES for brand jobs; [] otherwise)
    extraDomains: string[]; projectAllowRules: string[]; mcpTools: string[]; // e.g. ['mcp__studio__report_progress', …]
  }
  export interface AgentPolicy { settings: Record<string, unknown> | null; allowedTools: string[]; disallowedTools: string[]; addDirs: string[] }
  export function buildAgentPolicy(i: PolicyInput): AgentPolicy;
  ```
  Rules:
  - `addDirs = codebases`.
  - `disallowedTools = readOnlyRules(codebases) ++ fileDenyRules(['Edit','Write','MultiEdit','NotebookEdit'], protectedFiles)` (both existing helpers in `codebases.ts`).
  - **sandbox true:** `settings = { sandbox: { enabled: true, autoAllowBashIfSandboxed: AUTO[kind], filesystem: { denyRead: [...sensitiveHomePaths(home), configDir], denyWrite: [...codebases, ...protectedFiles] }, network?: { allowedDomains } } }` where `allowedDomains` = `[...DEFAULT_ALLOWED_DOMAINS, ...extraDomains]` for creative/console, `['*']` for brand-analysis, and **no `network` key** for describe; `AUTO = { creative: true, console: true, 'brand-analysis': false, describe: false }`; `allowedTools = [...TOOLS[kind], ...projectAllowRules, ...mcpTools]` with `TOOLS = { creative: [], console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS }` (brand/describe keep their narrow lists: other Bash commands go to the approval tool).
  - **sandbox false (Fase 3 behaviour):** `settings = null`; `allowedTools = [...LEGACY[kind], ...projectAllowRules, ...mcpTools]` with `LEGACY = { creative: AGENT_ALLOWED_TOOLS, console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS }`.
  - Deduplicate `allowedTools` keeping order.
- Produces (`runner.ts`): `AgentTurnRequest` gains `settings?: Record<string, unknown>` (→ `--settings <json>`), `mcpConfig?: Record<string, unknown>` (→ `--mcp-config <json>` plus `--strict-mcp-config`), `permissionPromptTool?: string` (→ `--permission-prompt-tool <name>` **instead of** `--permission-prompts none`), `env?: Record<string, string>` (merged into the child env). `mcpConfigPath` is removed.
- Produces (`doctor.ts`): `runDoctor` options gain `sandbox?: () => Promise<SandboxSupport>`; a check `{ id: 'sandbox', label: 'Sandbox dell\'agente', required: false, ok, message: ok ? 'Disponibile: l\'agente lavora isolato nella cartella del progetto' : reason, fix?: … }` appended last.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/sandbox.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_DOMAINS, detectSandbox, sensitiveHomePaths } from '../src/agent/sandbox.ts';
import type { CommandExec } from '../src/exec.ts';

const ok: CommandExec = async () => ({ code: 0, stdout: '', stderr: '', notFound: false });
const missing: CommandExec = async () => ({ code: -1, stdout: '', stderr: '', notFound: true });

describe('detectSandbox', () => {
  it('macOS depends on sandbox-exec', async () => {
    expect(await detectSandbox({ platform: 'darwin', exists: async () => true })).toMatchObject({ available: true });
    expect((await detectSandbox({ platform: 'darwin', exists: async () => false })).available).toBe(false);
  });
  it('linux needs bwrap and socat', async () => {
    expect((await detectSandbox({ platform: 'linux', exec: ok })).available).toBe(true);
    const r = await detectSandbox({ platform: 'linux', exec: missing });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('bubblewrap');
  });
  it('windows is unsupported', async () => {
    expect(await detectSandbox({ platform: 'win32' })).toMatchObject({ available: false, reason: 'La sandbox di Claude Code non è disponibile su Windows' });
  });
});

describe('constants', () => {
  it('lists package registries and sensitive folders', () => {
    expect(DEFAULT_ALLOWED_DOMAINS).toContain('registry.npmjs.org');
    expect(sensitiveHomePaths('/Users/me')).toContain('/Users/me/.ssh');
  });
});
```

`packages/core/test/policy.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildAgentPolicy, type PolicyInput } from '../src/agent/policy.ts';
import { AGENT_ALLOWED_TOOLS, BRAND_ANALYSIS_TOOLS, DESCRIBE_TOOLS } from '../src/agent/runner.ts';

const base: PolicyInput = {
  kind: 'creative', sandbox: true, home: '/Users/me', configDir: '/Users/me/Library/Application Support/Motion Studio',
  codebases: ['/Users/me/dev/app [ios]'], protectedFiles: [], extraDomains: ['api.acme.io'],
  projectAllowRules: ['Bash(brew:*)'], mcpTools: ['mcp__studio__report_progress'],
};
type Sb = { sandbox: { enabled: boolean; autoAllowBashIfSandboxed: boolean; filesystem: { denyRead: string[]; denyWrite: string[] }; network?: { allowedDomains: string[] } } };

describe('buildAgentPolicy with sandbox', () => {
  it('creative: sandbox, read-only codebases, render domains, project rules and MCP tools', () => {
    const p = buildAgentPolicy(base);
    const s = p.settings as Sb;
    expect(s.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true });
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/Users/me/.ssh', base.configDir]));
    expect(s.sandbox.filesystem.denyWrite).toEqual(['/Users/me/dev/app [ios]']);
    expect(s.sandbox.network!.allowedDomains).toEqual(expect.arrayContaining(['registry.npmjs.org', 'api.acme.io']));
    expect(p.addDirs).toEqual(['/Users/me/dev/app [ios]']);
    expect(p.disallowedTools[0]).toBe('Edit(//Users/me/dev/app \\[ios\\]/**)');
    expect(p.allowedTools).toEqual(['Bash(brew:*)', 'mcp__studio__report_progress']);
  });
  it('brand analysis: open network, narrow tools, no auto-allowed Bash, protected files', () => {
    const p = buildAgentPolicy({ ...base, kind: 'brand-analysis', codebases: [], protectedFiles: ['/p/brand/brand-kit.json'] });
    const s = p.settings as Sb;
    expect(s.sandbox.network!.allowedDomains).toEqual(['*']);
    expect(s.sandbox.autoAllowBashIfSandboxed).toBe(false);
    expect(s.sandbox.filesystem.denyWrite).toEqual(['/p/brand/brand-kit.json']);
    expect(p.allowedTools.slice(0, BRAND_ANALYSIS_TOOLS.length)).toEqual([...BRAND_ANALYSIS_TOOLS]);
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Write(//p/brand/brand-kit.json)']));
  });
  it('describe: no network at all', () => {
    const s = buildAgentPolicy({ ...base, kind: 'describe', codebases: [] }).settings as Sb;
    expect(s.sandbox.network).toBeUndefined();
  });
});

describe('buildAgentPolicy without sandbox', () => {
  it('falls back to the phase 3 tool lists', () => {
    expect(buildAgentPolicy({ ...base, sandbox: false }).settings).toBeNull();
    expect(buildAgentPolicy({ ...base, sandbox: false, projectAllowRules: [], mcpTools: [] }).allowedTools).toEqual([...AGENT_ALLOWED_TOOLS]);
    expect(buildAgentPolicy({ ...base, kind: 'describe', sandbox: false, projectAllowRules: [], mcpTools: [] }).allowedTools).toEqual([...DESCRIBE_TOOLS]);
  });
});
```
(`fileDenyRules` must produce `Write(//p/brand/brand-kit.json)` for that path; if its exact format differs — it is the Phase 3 helper used by `guardRules` — adapt the expectation to its real output.)

Append to `packages/core/test/claude-code-runner.test.ts` (inside `describe('buildClaudeArgs')`):
```ts
  it('passes settings, inline MCP config and the permission prompt tool', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p', settings: { sandbox: { enabled: true } }, mcpConfig: { mcpServers: {} }, permissionPromptTool: 'mcp__studio__approve' });
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--settings') + 1]).toBe('{"sandbox":{"enabled":true}}');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__studio__approve');
    expect(args).not.toContain('--permission-prompts');
  });
  it('keeps --permission-prompts none without a prompt tool', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p' });
    expect(args.slice(args.indexOf('--permission-prompts'), args.indexOf('--permission-prompts') + 2)).toEqual(['--permission-prompts', 'none']);
  });
```
and a runner test that `env` reaches the child (fake claude records `process.env.MS_TEST_ENV` in the args file: add `env: process.env.MS_TEST_ENV ?? null` to the JSON written when `FAKE_CLAUDE_ARGS_FILE` is set):
```ts
  it('passes extra environment variables to claude', async () => {
    const argsFile = join(await mkdtemp(join(tmpdir(), 'ms-env-')), 'args.json');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const { handle } = await run('ok', 'x', { env: { MS_TEST_ENV: 'ciao' } });
    await handle.done;
    expect(JSON.parse(await readFile(argsFile, 'utf8')).env).toBe('ciao');
  });
```

Append to `packages/core/test/doctor.test.ts`:
```ts
  it('reports the sandbox as an optional check', async () => {
    const checks = await runDoctor({ exec: fakeExec(allGood), claudeCommand: ['claude'], nodeVersion: 'v24.9.0', sandbox: async () => ({ available: false, reason: 'manca bubblewrap' }) });
    expect(checks.at(-1)).toMatchObject({ id: 'sandbox', ok: false, required: false, message: 'manca bubblewrap' });
  });
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/sandbox.test.ts packages/core/test/policy.test.ts packages/core/test/claude-code-runner.test.ts packages/core/test/doctor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `sandbox.ts`**

```ts
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execCommand, type CommandExec } from '../exec.ts';

export interface SandboxSupport { available: boolean; reason: string }

export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
  'github.com', '*.github.com', '*.githubusercontent.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
  'esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com', 'remotion.dev', '*.remotion.dev',
];

const SENSITIVE = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gh', '.config/gcloud', '.netrc', '.npmrc',
  '.pypirc', '.git-credentials', 'Library/Keychains', 'Library/Application Support/Motion Studio', '.config/motion-studio'];
export const sensitiveHomePaths = (home: string) => SENSITIVE.map((p) => join(home, ...p.split('/')));

export async function detectSandbox(opts: { platform?: NodeJS.Platform; exec?: CommandExec; exists?: (p: string) => Promise<boolean> } = {}): Promise<SandboxSupport> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? execCommand;
  const exists = opts.exists ?? (async (p: string) => access(p).then(() => true, () => false));
  if (platform === 'darwin') {
    return (await exists('/usr/bin/sandbox-exec'))
      ? { available: true, reason: 'Disponibile' }
      : { available: false, reason: 'sandbox-exec non trovato: la sandbox di macOS non è disponibile' };
  }
  if (platform === 'linux') {
    const bwrap = (await exec('bwrap', ['--version'])).code === 0;
    const socat = (await exec('socat', ['-V'])).code === 0;
    if (bwrap && socat) return { available: true, reason: 'Disponibile' };
    return { available: false, reason: `Mancano ${[!bwrap && 'bubblewrap', !socat && 'socat'].filter(Boolean).join(' e ')}: installa bubblewrap e socat per isolare l'agente` };
  }
  return { available: false, reason: platform === 'win32' ? 'La sandbox di Claude Code non è disponibile su Windows' : `La sandbox non è supportata su ${platform}` };
}
```

- [ ] **Step 4: Implementa `policy.ts`**

```ts
import { fileDenyRules, readOnlyRules } from '../codebases.ts';
import { AGENT_ALLOWED_TOOLS, BRAND_ANALYSIS_TOOLS, DESCRIBE_TOOLS } from './runner.ts';
import { DEFAULT_ALLOWED_DOMAINS, sensitiveHomePaths } from './sandbox.ts';

export type AgentJobKind = 'creative' | 'brand-analysis' | 'describe' | 'console';
export interface PolicyInput {
  kind: AgentJobKind; sandbox: boolean; home: string; configDir: string;
  codebases: string[]; protectedFiles: string[];
  extraDomains: string[]; projectAllowRules: string[]; mcpTools: string[];
}
export interface AgentPolicy { settings: Record<string, unknown> | null; allowedTools: string[]; disallowedTools: string[]; addDirs: string[] }

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const SANDBOXED_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: [], console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS };
const LEGACY_TOOLS: Record<AgentJobKind, readonly string[]> = { creative: AGENT_ALLOWED_TOOLS, console: [], 'brand-analysis': BRAND_ANALYSIS_TOOLS, describe: DESCRIBE_TOOLS };
const AUTO_BASH: Record<AgentJobKind, boolean> = { creative: true, console: true, 'brand-analysis': false, describe: false };
const unique = (xs: string[]) => [...new Set(xs)];

export function buildAgentPolicy(i: PolicyInput): AgentPolicy {
  const disallowedTools = [...readOnlyRules(i.codebases), ...(i.protectedFiles.length ? fileDenyRules(EDIT_TOOLS, i.protectedFiles) : [])];
  const extra = [...i.projectAllowRules, ...i.mcpTools];
  if (!i.sandbox) {
    return { settings: null, allowedTools: unique([...LEGACY_TOOLS[i.kind], ...extra]), disallowedTools, addDirs: [...i.codebases] };
  }
  const network = i.kind === 'describe' ? undefined
    : { allowedDomains: i.kind === 'brand-analysis' ? ['*'] : unique([...DEFAULT_ALLOWED_DOMAINS, ...i.extraDomains]) };
  const settings = {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: AUTO_BASH[i.kind],
      filesystem: { denyRead: [...sensitiveHomePaths(i.home), i.configDir], denyWrite: [...i.codebases, ...i.protectedFiles] },
      ...(network ? { network } : {}),
    },
  };
  return { settings, allowedTools: unique([...SANDBOXED_TOOLS[i.kind], ...extra]), disallowedTools, addDirs: [...i.codebases] };
}
```

- [ ] **Step 5: Runner e Doctor**

`runner.ts`: replace `mcpConfigPath?: string;` with:
```ts
  /** Claude Code settings for this turn (e.g. the sandbox), passed as --settings <json>. */
  settings?: Record<string, unknown>;
  /** Inline MCP configuration ({ mcpServers: … }), passed with --strict-mcp-config. */
  mcpConfig?: Record<string, unknown>;
  /** MCP tool that answers permission prompts (replaces `--permission-prompts none`). */
  permissionPromptTool?: string;
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>;
```

`claude-code-runner.ts` — `buildClaudeArgs`:
```ts
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
  // Without a prompt tool anything that would prompt is denied; with one, prompts reach the app (phase 4 approvals).
  if (req.permissionPromptTool) args.push('--permission-prompt-tool', req.permissionPromptTool);
  else args.push('--permission-prompts', 'none');
```
then the existing resume/add-dir/model lines, then:
```ts
  if (req.settings) args.push('--settings', JSON.stringify(req.settings));
  if (req.mcpConfig) args.push('--strict-mcp-config', '--mcp-config', JSON.stringify(req.mcpConfig));
```
before the deny/allow groups (which stay last). In `start`, spawn with `env: { ...process.env, ...req.env }`.
Update the Phase 1 `buildClaudeArgs` expectations (order of the first flags) accordingly.

`doctor.ts`: accept `sandbox?: () => Promise<SandboxSupport>` and, when given, append:
```ts
  if (opts.sandbox) {
    const s = await opts.sandbox();
    checks.push(s.available
      ? { id: 'sandbox', label: 'Sandbox dell\'agente', required: false, ok: true, message: 'Disponibile: l\'agente lavora isolato nella cartella del progetto' }
      : { id: 'sandbox', label: 'Sandbox dell\'agente', required: false, ok: false, message: s.reason, fix: 'Senza sandbox Motion Studio usa permessi più ristretti; vedi il README' });
  }
```

Append to `packages/core/src/index.ts`: `export * from './agent/sandbox.ts'; export * from './agent/policy.ts';`

- [ ] **Step 6: Verifica**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): sandbox detection, per-job agent policy and runner settings/MCP/prompt-tool args"
```

---
### Task 3: SecretsVault e API delle chiavi

**Files:**
- Create: `packages/core/src/secrets/vault.ts`, `packages/core/src/server/settings-routes.ts`, `packages/core/test/vault.test.ts`, `packages/core/test/secrets-routes.test.ts`
- Modify: `packages/core/package.json` (dep `@napi-rs/keyring`), `apps/cli/package.json` (same dep, external in the bundle), `packages/core/src/server/app.ts`, `packages/core/src/server/main.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PROVIDER_ENV: Record<ProviderId, string> = { openai: 'OPENAI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', pexels: 'PEXELS_API_KEY', unsplash: 'UNSPLASH_ACCESS_KEY' };
  export interface SecretsVault {
    get(p: ProviderId): Promise<string | null>;             // env first, then the store
    set(p: ProviderId, value: string): Promise<void>;      // 400 if empty/whitespace/over 500 chars/contains newline
    delete(p: ProviderId): Promise<void>;
    status(): Promise<SecretStatus[]>;                     // one per PROVIDER_IDS, in order
  }
  export class KeyringVault implements SecretsVault { constructor(opts?: { env?: NodeJS.ProcessEnv; service?: string /* 'Motion Studio' */ }) }
  export class MemoryVault implements SecretsVault { constructor(env?: NodeJS.ProcessEnv) }   // for tests and as fallback
  export function redact(text: string, secrets: string[]): string;   // replaces every secret occurrence with '•••'
  ```
  `KeyringVault` uses `new AsyncEntry(service, provider)` from `@napi-rs/keyring` (`getPassword` → `string | undefined`, `setPassword`, `deletePassword` → boolean); keyring errors become `WorkspaceError(500 → message "Portachiavi del sistema non disponibile: <detail>")` on `set`, and `get` returns `null` (logged once with `console.warn`). On Linux pass `{ linux: { store: 'secret-service' } }` if the binding exposes that option; otherwise default.
- Routes (`settings-routes.ts`, `registerSettingsRoutes(app, ctx)`; `ctx.vault: SecretsVault`):
  | Method | Path | Body | Result |
  |---|---|---|---|
  | GET | `/api/secrets` | — | `SecretStatus[]` |
  | PUT | `/api/secrets/:provider` | `{ value: string }` | `SecretStatus` (400 unknown provider / invalid value; 409 `"La chiave arriva da una variabile d'ambiente: modificala lì"` when `source === 'env'`) |
  | DELETE | `/api/secrets/:provider` | — | `SecretStatus` (409 when from env) |
- `ServerDeps` gains `vault?: SecretsVault` (default `new MemoryVault()` so tests never touch the real keychain); `startServer` passes `new KeyringVault()`.

- [ ] **Step 1: Dipendenza**

Run: `pnpm --filter @motion-studio/core add @napi-rs/keyring@^2 && pnpm --filter motion-studio add @napi-rs/keyring@^2`
(In `apps/cli/tsup.config.ts`, `@napi-rs/keyring` must stay external — it is not matched by `noExternal: [/^@motion-studio\//]`, so nothing to change.)

- [ ] **Step 2: Test che falliscono**

`packages/core/test/vault.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MemoryVault, redact } from '../src/secrets/vault.ts';

describe('MemoryVault', () => {
  it('prefers env, stores, deletes and reports status without values', async () => {
    const v = new MemoryVault({ OPENAI_API_KEY: 'sk-env' });
    await v.set('pexels', '  pk-123  ');
    expect(await v.get('openai')).toBe('sk-env');
    expect(await v.get('pexels')).toBe('pk-123');
    expect(await v.status()).toEqual([
      { provider: 'openai', configured: true, source: 'env' },
      { provider: 'elevenlabs', configured: false, source: null },
      { provider: 'pexels', configured: true, source: 'keychain' },
      { provider: 'unsplash', configured: false, source: null },
    ]);
    await v.delete('pexels');
    expect(await v.get('pexels')).toBeNull();
  });
  it('rejects invalid values', async () => {
    const v = new MemoryVault({});
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(501)]) expect((await v.set('openai', bad).catch((e) => e)).status, JSON.stringify(bad)).toBe(400);
  });
});

describe('redact', () => {
  it('hides secrets in text', () => {
    expect(redact('Bearer sk-abc failed for sk-abc', ['sk-abc'])).toBe('Bearer ••• failed for •••');
    expect(redact('nothing', [])).toBe('nothing');
  });
});
```

`packages/core/test/secrets-routes.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { MemoryVault } from '../src/secrets/vault.ts';
import { buildServer } from '../src/server/app.ts';

let app: FastifyInstance;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ms-sec-'));
  app = await buildServer({ appConfig: new AppConfigStore(join(base, 'c')), git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner(['true']),
    vault: new MemoryVault({ UNSPLASH_ACCESS_KEY: 'env-key' }) });
});
afterEach(() => app.close());

describe('secrets API', () => {
  it('sets, reports and deletes keys without ever returning them', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/secrets/openai', payload: { value: 'sk-secret-123' } });
    expect(put.json()).toEqual({ provider: 'openai', configured: true, source: 'keychain' });
    const list = await app.inject('/api/secrets');
    expect(list.body).not.toContain('sk-secret-123');
    expect(list.json()[0]).toEqual({ provider: 'openai', configured: true, source: 'keychain' });
    expect((await app.inject({ method: 'DELETE', url: '/api/secrets/openai' })).json()).toEqual({ provider: 'openai', configured: false, source: null });
  });
  it('rejects unknown providers, invalid values and env-managed keys', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/nope', payload: { value: 'x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/openai', payload: { value: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/secrets/unsplash', payload: { value: 'x' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/secrets/unsplash' })).statusCode).toBe(409);
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/vault.test.ts packages/core/test/secrets-routes.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementa `vault.ts`**

```ts
import { PROVIDER_IDS, type ProviderId, type SecretStatus } from '@motion-studio/shared';
import { WorkspaceError } from '../workspace-store.ts';

export const PROVIDER_ENV: Record<ProviderId, string> = { openai: 'OPENAI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', pexels: 'PEXELS_API_KEY', unsplash: 'UNSPLASH_ACCESS_KEY' };

export interface SecretsVault {
  get(p: ProviderId): Promise<string | null>;
  set(p: ProviderId, value: string): Promise<void>;
  delete(p: ProviderId): Promise<void>;
  status(): Promise<SecretStatus[]>;
}

export function cleanSecret(value: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || v.length > 500 || /[\r\n]/.test(v)) throw new WorkspaceError(400, 'Chiave non valida: incolla la chiave del provider su una sola riga');
  return v;
}

export function redact(text: string, secrets: string[]): string {
  return secrets.filter((s) => s.length >= 4).reduce((t, s) => t.split(s).join('•••'), text);
}

abstract class BaseVault implements SecretsVault {
  constructor(protected readonly env: NodeJS.ProcessEnv) {}
  protected abstract read(p: ProviderId): Promise<string | null>;
  protected abstract write(p: ProviderId, v: string): Promise<void>;
  protected abstract remove(p: ProviderId): Promise<void>;
  private fromEnv(p: ProviderId) { const v = this.env[PROVIDER_ENV[p]]?.trim(); return v ? v : null; }
  async get(p: ProviderId) { return this.fromEnv(p) ?? (await this.read(p)); }
  async set(p: ProviderId, value: string) { await this.write(p, cleanSecret(value)); }
  async delete(p: ProviderId) { await this.remove(p); }
  async status(): Promise<SecretStatus[]> {
    return Promise.all(PROVIDER_IDS.map(async (provider) => {
      if (this.fromEnv(provider)) return { provider, configured: true, source: 'env' as const };
      return (await this.read(provider)) ? { provider, configured: true, source: 'keychain' as const } : { provider, configured: false, source: null };
    }));
  }
}

export class MemoryVault extends BaseVault {
  private readonly store = new Map<ProviderId, string>();
  constructor(env: NodeJS.ProcessEnv = {}) { super(env); }
  protected async read(p: ProviderId) { return this.store.get(p) ?? null; }
  protected async write(p: ProviderId, v: string) { this.store.set(p, v); }
  protected async remove(p: ProviderId) { this.store.delete(p); }
}

export class KeyringVault extends BaseVault {
  private readonly service: string;
  private warned = false;
  constructor(opts: { env?: NodeJS.ProcessEnv; service?: string } = {}) { super(opts.env ?? process.env); this.service = opts.service ?? 'Motion Studio'; }
  private async entry(p: ProviderId) {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(this.service, p);
  }
  protected async read(p: ProviderId) {
    try { return (await (await this.entry(p)).getPassword()) ?? null; }
    catch (e) { if (!this.warned) { this.warned = true; console.warn(`Portachiavi non disponibile: ${(e as Error).message}`); } return null; }
  }
  protected async write(p: ProviderId, v: string) {
    try { await (await this.entry(p)).setPassword(v); }
    catch (e) { throw new WorkspaceError(500 as never, `Portachiavi del sistema non disponibile: ${(e as Error).message}`); }
  }
  protected async remove(p: ProviderId) {
    try { await (await this.entry(p)).deletePassword(); } catch { /* already absent */ }
  }
}
```
(Widen `WorkspaceError.status` to include `500` and drop the cast.)

- [ ] **Step 5: Implementa le route e collega**

`settings-routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { PROVIDER_IDS, type ProviderId, type SecretStatus } from '@motion-studio/shared';
import type { SecretsVault } from '../secrets/vault.ts';
import { WorkspaceError } from '../workspace-store.ts';

export interface SettingsRoutesContext { vault: SecretsVault }

const providerOf = (p: string): ProviderId => {
  if (!(PROVIDER_IDS as readonly string[]).includes(p)) throw new WorkspaceError(400, `Provider sconosciuto: ${p}`);
  return p as ProviderId;
};

export function registerSettingsRoutes(app: FastifyInstance, ctx: SettingsRoutesContext) {
  const statusOf = async (p: ProviderId): Promise<SecretStatus> => (await ctx.vault.status()).find((s) => s.provider === p)!;
  const notEnv = async (p: ProviderId) => {
    if ((await statusOf(p)).source === 'env') throw new WorkspaceError(409, "La chiave arriva da una variabile d'ambiente: modificala lì");
  };
  app.get('/api/secrets', async () => ctx.vault.status());
  app.put<{ Params: { provider: string }; Body: { value?: unknown } }>('/api/secrets/:provider', async (req) => {
    const p = providerOf(req.params.provider);
    await notEnv(p);
    await ctx.vault.set(p, typeof req.body?.value === 'string' ? req.body.value : '');
    return statusOf(p);
  });
  app.delete<{ Params: { provider: string } }>('/api/secrets/:provider', async (req) => {
    const p = providerOf(req.params.provider);
    await notEnv(p);
    await ctx.vault.delete(p);
    return statusOf(p);
  });
}
```
In `app.ts`: `const vault = deps.vault ?? new MemoryVault();` and `registerSettingsRoutes(app, { vault });` (extended in Task 4). In `main.ts`: `vault: new KeyringVault(),`. Export both modules from `index.ts`.

- [ ] **Step 6: Verifica**

Run: `pnpm vitest run packages/core && pnpm typecheck && pnpm build`
Expected: tutti PASS; build ok (keyring resta esterno al bundle).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): API keys in the system keychain with env override, never returned by the API"
```

---

### Task 4: ApprovalBroker, permessi del progetto e API delle approvazioni

**Files:**
- Create: `packages/core/src/approvals/broker.ts`, `packages/core/src/approvals/permissions-store.ts`, `packages/core/test/approvals.test.ts`, `packages/core/test/approval-routes.test.ts`
- Modify: `packages/core/src/server/settings-routes.ts`, `packages/core/src/server/app.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces (`permissions-store.ts`):
  ```ts
  export function ruleFor(toolName: string, input: unknown): { rule: string; label: string } | null;
    // Bash {command}: first word w (letters, digits, . _ -) → `Bash(${w}:*)`, label `Comandi "${w}"`; null when the command starts with sudo/rm/curl|sh patterns
    //   (i.e. w ∈ {'sudo','rm','sh','bash','zsh','eval','exec','chmod','chown'}) → no "Sempre"
    // Write/Edit/MultiEdit/NotebookEdit {file_path}: `Edit(/${escapeGlob(dirname(file_path))}/**)`, label `Modifiche in ${dirname}` (null if dirname is '/' or the home)
    // Read {file_path}: `Read(/${escapeGlob(dirname)}/**)` (same exclusions)
    // WebFetch {url}: `WebFetch(domain:${hostname})`
    // 'provider:<id>': rule `provider:<id>`, label `Uso di <id> senza conferma`
    // mcp__*: the tool name itself; anything else → null
  export class PermissionsStore {
    constructor(projectDir: string)                       // file <project>/.studio/permissions.json
    list(): Promise<PermissionsFile['allow']>             // missing → []; corrupt → JsonFileError
    add(rule: string, label: string): Promise<void>       // no duplicates; serialized (shared fileLock)
    remove(rule: string): Promise<void>                   // 404 unknown
    has(rule: string): Promise<boolean>
  }
  ```
  `escapeGlob` must be exported from `codebases.ts` (it is module-private today).
- Produces (`broker.ts`):
  ```ts
  export interface ApprovalInput { jobId: string; projectSlug: string; projectDir: string; creativeSlug: string | null; kind: ApprovalKind; toolName: string; input: unknown; title?: string; detail?: string }
  export interface ApprovalOutcome { decision: ApprovalDecision | 'expired' | 'cancelled' }
  export class ApprovalBroker {
    constructor(opts: { broadcast(m: ServerMessage): void; timeoutMs?: number /* 600_000 */; now?: () => Date })
    request(input: ApprovalInput): Promise<ApprovalOutcome>;  // broadcasts 'approval'; resolves on decide/timeout/cancelJob
    decide(id: string, decision: ApprovalDecision): Promise<ApprovalRequest>; // 404 unknown/already decided; 'always' adds ruleFor(...) to the project's PermissionsStore (if alwaysRule)
    cancelJob(jobId: string): void;        // resolves its pending requests as 'cancelled'
    cancelAll(): void;                     // on server close
    pending(): ApprovalRequest[];
  }
  export function describeRequest(toolName: string, input: unknown): { title: string; detail: string };
    // Bash → "Eseguire un comando" / command; Write|Edit|MultiEdit → "Modificare un file fuori dal progetto" / file_path;
    // Read → "Leggere un file fuori dal progetto" / file_path; WebFetch → "Aprire una pagina web" / url;
    // provider:* → the caller passes title/detail; other → `Usare lo strumento ${toolName}` / JSON (max 500 chars)
  ```
  Every resolution broadcasts `{ type: 'approval_resolved', id, decision }`. `request` sets `alwaysRule = ruleFor(toolName, input)?.rule ?? null`.
- Routes (added to `settings-routes.ts`; `ctx` gains `approvals: ApprovalBroker; requireWorkspace`):
  | Method | Path | Body | Result |
  |---|---|---|---|
  | GET | `/api/approvals` | — | `ApprovalRequest[]` |
  | POST | `/api/approvals/:id` | `{ decision: 'once' \| 'always' \| 'deny' }` | `ApprovalRequest` (404 / 400) |
  | GET | `/api/projects/:slug/permissions` | — | `PermissionsFile['allow']` |
  | DELETE | `/api/projects/:slug/permissions` | `{ rule }` | `{ ok: true }` |
- `app.ts`: one `ApprovalBroker` (broadcast via the hub); WS snapshot sends `approvals: broker.pending()`; `preClose` calls `broker.cancelAll()` before cancelling jobs.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/approvals.test.ts`:
```ts
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker, describeRequest } from '../src/approvals/broker.ts';
import { PermissionsStore, ruleFor } from '../src/approvals/permissions-store.ts';

let projectDir: string;
let messages: ServerMessage[];
beforeEach(async () => { projectDir = await mkdtemp(join(tmpdir(), 'ms-appr è ')); messages = []; });
const input = (over = {}) => ({ jobId: 'j1', projectSlug: 'acme', projectDir, creativeSlug: 'c1', kind: 'tool' as const, toolName: 'Bash', input: { command: 'brew install ffmpeg' }, ...over });

describe('ruleFor', () => {
  it.each([
    ['Bash', { command: 'brew install ffmpeg' }, 'Bash(brew:*)'],
    ['Bash', { command: 'sudo rm -rf /' }, null],
    ['Bash', { command: 'rm -rf build' }, null],
    ['Write', { file_path: '/Users/me/Desktop/out [1]/a.png' }, 'Edit(//Users/me/Desktop/out \\[1\\]/**)'],
    ['Write', { file_path: '/a.txt' }, null],
    ['WebFetch', { url: 'https://www.python.org/about' }, 'WebFetch(domain:www.python.org)'],
    ['provider:openai-images', {}, 'provider:openai-images'],
    ['mcp__other__x', {}, 'mcp__other__x'],
    ['Unknown', {}, null],
  ])('%s %j → %s', (tool, inp, rule) => { expect(ruleFor(tool, inp)?.rule ?? null).toBe(rule); });
});

describe('describeRequest', () => {
  it('summarizes in Italian', () => {
    expect(describeRequest('Bash', { command: 'brew install ffmpeg' })).toEqual({ title: 'Eseguire un comando', detail: 'brew install ffmpeg' });
    expect(describeRequest('Write', { file_path: '/x/a.txt' })).toEqual({ title: 'Modificare un file fuori dal progetto', detail: '/x/a.txt' });
  });
});

describe('ApprovalBroker', () => {
  it('broadcasts, resolves once and records "always" rules', async () => {
    const broker = new ApprovalBroker({ broadcast: (m) => messages.push(m) });
    const p = broker.request(input());
    const [req] = broker.pending();
    expect(req).toMatchObject({ projectSlug: 'acme', creativeSlug: 'c1', title: 'Eseguire un comando', alwaysRule: 'Bash(brew:*)' });
    expect(messages[0]).toMatchObject({ type: 'approval' });
    await broker.decide(req!.id, 'always');
    expect(await p).toEqual({ decision: 'always' });
    expect(await new PermissionsStore(projectDir).list()).toEqual([expect.objectContaining({ rule: 'Bash(brew:*)', label: 'Comandi "brew"' })]);
    expect(messages.at(-1)).toEqual({ type: 'approval_resolved', id: req!.id, decision: 'always' });
    expect((await broker.decide(req!.id, 'deny').catch((e) => e)).status).toBe(404);
  });
  it('expires after the timeout', async () => {
    const broker = new ApprovalBroker({ broadcast: (m) => messages.push(m), timeoutMs: 30 });
    expect(await broker.request(input())).toEqual({ decision: 'expired' });
    expect(broker.pending()).toEqual([]);
  });
  it('cancels the requests of a job and everything on close', async () => {
    const broker = new ApprovalBroker({ broadcast: () => {} });
    const a = broker.request(input());
    const b = broker.request(input({ jobId: 'j2' }));
    broker.cancelJob('j1');
    expect(await a).toEqual({ decision: 'cancelled' });
    broker.cancelAll();
    expect(await b).toEqual({ decision: 'cancelled' });
  });
});

describe('PermissionsStore', () => {
  it('adds without duplicates, removes and never rewrites a corrupt file', async () => {
    const s = new PermissionsStore(projectDir);
    await s.add('Bash(brew:*)', 'x');
    await s.add('Bash(brew:*)', 'x');
    expect(await s.list()).toHaveLength(1);
    expect(await s.has('Bash(brew:*)')).toBe(true);
    await s.remove('Bash(brew:*)');
    expect((await s.remove('Bash(brew:*)').catch((e) => e)).status).toBe(404);
    await mkdir(join(projectDir, '.studio'), { recursive: true });
    await writeFile(join(projectDir, '.studio', 'permissions.json'), '{bad');
    await expect(s.add('Bash(x:*)', 'x')).rejects.toMatchObject({ reason: 'invalid-json' });
    expect(await readFile(join(projectDir, '.studio', 'permissions.json'), 'utf8')).toBe('{bad');
  });
});
```

`packages/core/test/approval-routes.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

let app: FastifyInstance;
let broker: ApprovalBroker;
let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-ar-'));
  broker = new ApprovalBroker({ broadcast: () => {} });
  app = await buildServer({ appConfig: new AppConfigStore(join(base, 'c')), git: new Git(), doctor: async () => [], runner: new ClaudeCodeRunner(['true']), approvals: broker });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(() => app.close());

describe('approvals API', () => {
  it('lists, decides and manages project permissions', async () => {
    const pending = broker.request({ jobId: 'j', projectSlug: 'acme', projectDir: join(base, 'ws', 'acme'), creativeSlug: null, kind: 'tool', toolName: 'Bash', input: { command: 'brew install x' } });
    const [req] = (await app.inject('/api/approvals')).json();
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${req.id}`, payload: { decision: 'maybe' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/approvals/${req.id}`, payload: { decision: 'always' } })).statusCode).toBe(200);
    expect(await pending).toEqual({ decision: 'always' });
    expect((await app.inject('/api/projects/acme/permissions')).json()).toEqual([expect.objectContaining({ rule: 'Bash(brew:*)' })]);
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/acme/permissions', payload: { rule: 'Bash(brew:*)' } })).json()).toEqual({ ok: true });
  });
});
```
(`ServerDeps` gains `approvals?: ApprovalBroker` so tests can inject one; default: a broker created in `buildServer` broadcasting on the hub.)

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/approvals.test.ts packages/core/test/approval-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `permissions-store.ts`**

```ts
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { permissionsFileSchema, type PermissionsFile } from '@motion-studio/shared';
import { escapeGlob } from '../codebases.ts';
import { fileLock } from '../file-locks.ts';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { WorkspaceError } from '../workspace-store.ts';

const RISKY_COMMANDS = new Set(['sudo', 'rm', 'sh', 'bash', 'zsh', 'eval', 'exec', 'chmod', 'chown', 'dd', 'mkfs']);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function dirRule(tool: 'Edit' | 'Read', filePath: string) {
  const dir = dirname(filePath);
  if (!filePath.startsWith('/') || dir === '/' || dir === homedir()) return null;
  return { rule: `${tool}(/${escapeGlob(dir)}/**)`, label: `${tool === 'Edit' ? 'Modifiche' : 'Letture'} in ${dir}` };
}

export function ruleFor(toolName: string, input: unknown): { rule: string; label: string } | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash') {
    const word = str(i.command).trim().split(/\s+/)[0] ?? '';
    if (!/^[A-Za-z0-9._-]+$/.test(word) || RISKY_COMMANDS.has(word)) return null;
    return { rule: `Bash(${word}:*)`, label: `Comandi "${word}"` };
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return dirRule('Edit', str(i.file_path));
  if (toolName === 'Read') return dirRule('Read', str(i.file_path));
  if (toolName === 'WebFetch') {
    try { const host = new URL(str(i.url)).hostname; return host ? { rule: `WebFetch(domain:${host})`, label: `Pagine di ${host}` } : null; } catch { return null; }
  }
  if (toolName.startsWith('provider:')) return { rule: toolName, label: `Uso di ${toolName.slice(9)} senza conferma` };
  if (toolName.startsWith('mcp__')) return { rule: toolName, label: `Strumento ${toolName}` };
  return null;
}

export class PermissionsStore {
  private readonly file: string;
  constructor(projectDir: string) { this.file = join(projectDir, '.studio', 'permissions.json'); }

  async list(): Promise<PermissionsFile['allow']> {
    try { return (await readJsonFile(this.file, permissionsFileSchema)).allow; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }
  async has(rule: string) { return (await this.list()).some((r) => r.rule === rule); }
  add(rule: string, label: string): Promise<void> {
    return fileLock.run(this.file, async () => {
      const allow = await this.list();
      if (allow.some((r) => r.rule === rule)) return;
      await writeJsonFileAtomic(this.file, { schemaVersion: 1, allow: [...allow, { rule, label, addedAt: new Date().toISOString() }] });
    });
  }
  remove(rule: string): Promise<void> {
    return fileLock.run(this.file, async () => {
      const allow = await this.list();
      if (!allow.some((r) => r.rule === rule)) throw new WorkspaceError(404, 'Permesso non trovato');
      await writeJsonFileAtomic(this.file, { schemaVersion: 1, allow: allow.filter((r) => r.rule !== rule) });
    });
  }
}
```
(If `fileLock.run`'s write counter is used elsewhere to detect app writes, keep using it the same way as the Phase 3 stores do.)

- [ ] **Step 4: Implementa `broker.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalKind, ApprovalRequest, ServerMessage } from '@motion-studio/shared';
import { WorkspaceError } from '../workspace-store.ts';
import { PermissionsStore, ruleFor } from './permissions-store.ts';

export interface ApprovalInput { jobId: string; projectSlug: string; projectDir: string; creativeSlug: string | null; kind: ApprovalKind; toolName: string; input: unknown; title?: string; detail?: string }
export interface ApprovalOutcome { decision: ApprovalDecision | 'expired' | 'cancelled' }

export function describeRequest(toolName: string, input: unknown): { title: string; detail: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  if (toolName === 'Bash') return { title: 'Eseguire un comando', detail: s(i.command) };
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return { title: 'Modificare un file fuori dal progetto', detail: s(i.file_path) };
  if (toolName === 'Read') return { title: 'Leggere un file fuori dal progetto', detail: s(i.file_path) };
  if (toolName === 'WebFetch') return { title: 'Aprire una pagina web', detail: s(i.url) };
  return { title: `Usare lo strumento ${toolName}`, detail: JSON.stringify(input ?? {}).slice(0, 500) };
}

interface Pending { request: ApprovalRequest; alwaysLabel: string; projectDir: string; resolve(o: ApprovalOutcome): void; timer: NodeJS.Timeout }

export class ApprovalBroker {
  private readonly items = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  constructor(private readonly opts: { broadcast(m: ServerMessage): void; timeoutMs?: number; now?: () => Date }) {
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.now = opts.now ?? (() => new Date());
  }

  request(input: ApprovalInput): Promise<ApprovalOutcome> {
    const described = describeRequest(input.toolName, input.input);
    const always = ruleFor(input.toolName, input.input);
    const created = this.now();
    const request: ApprovalRequest = {
      id: randomUUID(), jobId: input.jobId, projectSlug: input.projectSlug, creativeSlug: input.creativeSlug, kind: input.kind,
      title: input.title ?? described.title, detail: (input.detail ?? described.detail).slice(0, 2000), toolName: input.toolName,
      alwaysRule: always?.rule ?? null,
      createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + this.timeoutMs).toISOString(),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(request.id, 'expired'), this.timeoutMs);
      timer.unref();
      this.items.set(request.id, { request, alwaysLabel: always?.label ?? '', projectDir: input.projectDir, resolve, timer });
      this.opts.broadcast({ type: 'approval', approval: request });
    });
  }

  async decide(id: string, decision: ApprovalDecision): Promise<ApprovalRequest> {
    const item = this.items.get(id);
    if (!item) throw new WorkspaceError(404, 'Richiesta di approvazione non trovata o già gestita');
    if (decision === 'always' && item.request.alwaysRule) {
      await new PermissionsStore(item.projectDir).add(item.request.alwaysRule, item.alwaysLabel);
    }
    this.finish(id, decision);
    return item.request;
  }

  cancelJob(jobId: string) { for (const [id, i] of this.items) if (i.request.jobId === jobId) this.finish(id, 'cancelled'); }
  cancelAll() { for (const id of [...this.items.keys()]) this.finish(id, 'cancelled'); }
  pending(): ApprovalRequest[] { return [...this.items.values()].map((i) => i.request); }

  private finish(id: string, decision: ApprovalOutcome['decision']) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    clearTimeout(item.timer);
    item.resolve({ decision });
    this.opts.broadcast({ type: 'approval_resolved', id, decision });
  }
}
```
The label shown and stored for "always" is the one computed by `ruleFor` at request time.

- [ ] **Step 5: Route e collegamento**

Extend `registerSettingsRoutes` (ctx gains `approvals: ApprovalBroker; requireWorkspace: () => WorkspaceStore`):
```ts
  app.get('/api/approvals', async () => ctx.approvals.pending());
  app.post<{ Params: { id: string }; Body: { decision?: unknown } }>('/api/approvals/:id', async (req) => {
    const d = req.body?.decision;
    if (d !== 'once' && d !== 'always' && d !== 'deny') throw new WorkspaceError(400, 'Decisione non valida');
    return ctx.approvals.decide(req.params.id, d);
  });
  app.get<{ Params: { slug: string } }>('/api/projects/:slug/permissions', async (req) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    return new PermissionsStore(ws.projectDir(req.params.slug)).list();
  });
  app.delete<{ Params: { slug: string }; Body: { rule?: unknown } }>('/api/projects/:slug/permissions', async (req) => {
    if (typeof req.body?.rule !== 'string') throw new WorkspaceError(400, 'Regola mancante');
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    await new PermissionsStore(ws.projectDir(req.params.slug)).remove(req.body.rule);
    return { ok: true };
  });
```
`app.ts`: `const approvals = deps.approvals ?? new ApprovalBroker({ broadcast: (m) => hub.broadcast(m) });`; snapshot `approvals: approvals.pending()`; in `preClose` call `approvals.cancelAll()` first; pass `{ vault, approvals, requireWorkspace }` to `registerSettingsRoutes`. Export `escapeGlob` from `codebases.ts`; export the new modules from `index.ts`.

- [ ] **Step 6: Verifica**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): approval broker with timeouts, per-project allow rules and approvals API"
```

---

### Task 5: AgentBridge, AgentLauncher e migrazione di tutti i punti che lanciano l'agente

**Files:**
- Create: `packages/core/src/bridge/bridge.ts`, `packages/core/src/bridge/bridge-routes.ts`, `packages/core/src/agent/launcher.ts`, `packages/core/test/helpers/launcher.ts`, `packages/core/test/launcher.test.ts`, `packages/core/test/bridge-routes.test.ts`
- Modify: `packages/core/src/creatives/creative-turns.ts`, `packages/core/src/brand/brand-analysis.ts`, `packages/core/src/server/app.ts`, `packages/core/src/server/main.ts`, every core test that builds `CreativeTurnService`/`BrandService` (use the helper), `packages/core/src/index.ts`

**Interfaces:**
- Produces (`bridge.ts`):
  ```ts
  export interface BridgeContext {
    jobId: string; kind: AgentJobKind; projectSlug: string; projectDir: string; creativeSlug: string | null;
    emit(e: AgentEvent): void;                         // same sink as the turn's onEvent
    validate?: () => Promise<{ problems: string[]; outputs: unknown[] }>;  // creative turns only
  }
  export class AgentBridge {
    origin: string | null;                             // e.g. 'http://127.0.0.1:4317', set after listen
    setOrigin(url: string): void;
    register(ctx: BridgeContext): string;              // 64 hex chars (randomBytes(32))
    unregister(token: string): void;
    resolve(token: string | undefined): BridgeContext | null;  // constant-time compare not needed (map lookup), but reject non-hex/length ≠ 64
  }
  ```
- Produces (`launcher.ts`):
  ```ts
  export const MCP_SERVER = 'studio';
  export const MCP_TOOLS: Record<AgentJobKind, string[]> = {
    creative: ['report_progress', 'validate_output', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
    console: ['report_progress', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
    'brand-analysis': ['report_progress', 'read_brand_kit', 'fonts_fetch'],
    describe: ['report_progress'],
  };
  export interface LauncherDeps {
    runner: AgentRunner; bridge: AgentBridge; approvals: ApprovalBroker;
    sandbox: () => Promise<SandboxSupport>;            // cached by the caller
    settings: () => Promise<WorkspaceSettings>;
    configDir: string; home?: string;                  // home defaults to os.homedir()
    mcpCommand: string[] | null;                       // e.g. [process.execPath, '/…/server.mjs']; null disables MCP and approvals
  }
  export interface LaunchInput {
    kind: AgentJobKind; jobId: string; projectSlug: string; projectDir: string; creativeSlug?: string | null;
    codebases?: string[]; protectedFiles?: string[];
    request: Pick<AgentTurnRequest, 'prompt' | 'resumeSessionId' | 'forkSession' | 'model'>;
    onEvent(e: AgentEvent): void;
    validate?: BridgeContext['validate'];
  }
  export class AgentLauncher {
    constructor(deps: LauncherDeps)
    start(i: LaunchInput): Promise<AgentRun>;   // returns a run whose done/cancel also unregister the token and cancel the job's approvals
    sandboxActive(): Promise<boolean>;          // settings.sandboxMode === 'auto' && sandbox().available
  }
  ```
  `start`:
  1. `sandbox = await sandboxActive()`; `rules = (await new PermissionsStore(projectDir).list().catch(() => [])).map((r) => r.rule).filter((r) => !r.startsWith('provider:'))`.
  2. `mcpOn = Boolean(bridge.origin && mcpCommand)`; `mcpTools = mcpOn ? MCP_TOOLS[kind].map((t) => `mcp__${MCP_SERVER}__${t}`) : []`.
  3. `policy = buildAgentPolicy({ kind, sandbox, home, configDir, codebases, protectedFiles, extraDomains: settings.extraAllowedDomains, projectAllowRules: rules, mcpTools })`.
  4. If `mcpOn`: `token = bridge.register({...})`; `mcpConfig = { mcpServers: { studio: { type: 'stdio', command: mcpCommand[0], args: mcpCommand.slice(1), env: { MOTION_STUDIO_BRIDGE_URL: bridge.origin, MOTION_STUDIO_BRIDGE_TOKEN: token, MOTION_STUDIO_TOOLS: MCP_TOOLS[kind].join(',') } } } }`, `permissionPromptTool = 'mcp__studio__approve'`.
  5. `runner.start({ cwd: projectDir, ...request, ...policy-fields (settings only if non-null), mcpConfig, permissionPromptTool, env: { MCP_TOOL_TIMEOUT: '900000' } }, onEvent)`.
  6. Wrap: `done` → `.finally(() => { token && bridge.unregister(token); approvals.cancelJob(jobId); })`; `cancel()` → `approvals.cancelJob(jobId)` then the runner's cancel.
- Produces (`bridge-routes.ts`): `registerBridgeRoutes(app, { bridge, approvals })` — `POST /api/bridge/:tool`, header `x-motion-studio-bridge: <token>` (401 `"Accesso al bridge non valido"` otherwise), JSON body = the tool arguments. Tools handled here (providers come in Task 10; unknown tool → 404):
  - `approve` `{ tool_name, input, tool_use_id }` → `approvals.request({ jobId, projectSlug, projectDir, creativeSlug, kind: 'tool', toolName: tool_name, input })` → `once|always` ⇒ `{ behavior: 'allow', updatedInput: input }`; `deny` ⇒ `{ behavior: 'deny', message: "L'utente ha negato questa azione." }`; `expired` ⇒ `{ behavior: 'deny', message: 'Nessuna risposta entro 10 minuti: azione negata.' }`; `cancelled` ⇒ `{ behavior: 'deny', message: 'Il lavoro è stato annullato.' }`.
  - `report_progress` `{ message }` (1..300 chars, else 400) → `ctx.emit({ kind: 'progress', text })` → `{ ok: true }`.
  - `validate_output` `{}` → `ctx.validate ? await ctx.validate() : 400 "Validazione disponibile solo nelle creatività"`.
  - `read_brand_kit` `{}` → `{ kit, guidelines }` (guidelines truncated to 50 000 chars; a corrupt kit → `{ kit: null, error }`).
- `ServerDeps` gains `bridge?: AgentBridge` (default new), `mcpCommand?: string[] | null` (default `null`), `configDir?: string` (default `defaultConfigDir()`), `sandbox?: () => Promise<SandboxSupport>` (default cached `detectSandbox()`); `buildServer` creates the `AgentLauncher` and passes it to `CreativeTurnService`/`BrandService` (deps `runner` → `launcher`) and to the console route; the doctor dep also receives the sandbox check. `startServer` creates the bridge, passes `mcpCommand: [process.execPath, mcpServerPath]` (`opts.mcpServerPath` or the dev path `fileURLToPath(new URL('../../../mcp-studio/src/server.mjs', import.meta.url))`), and calls `bridge.setOrigin(url)` after `listen`.

- [ ] **Step 1: Helper per i test e test che falliscono**

`packages/core/test/helpers/launcher.ts`:
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceSettingsSchema, type WorkspaceSettings } from '@motion-studio/shared';
import { AgentLauncher, type LauncherDeps } from '../../src/agent/launcher.ts';
import type { AgentRunner } from '../../src/agent/runner.ts';
import { ApprovalBroker } from '../../src/approvals/broker.ts';
import { AgentBridge } from '../../src/bridge/bridge.ts';

/** Phase 3-equivalent launcher: no sandbox, no MCP (tests keep driving the fake claude exactly as before). */
export function testLauncher(runner: AgentRunner, over: Partial<LauncherDeps> & { settings?: Partial<WorkspaceSettings> } = {}) {
  const settings = workspaceSettingsSchema.parse({ schemaVersion: 1, ...over.settings });
  return new AgentLauncher({
    runner, bridge: new AgentBridge(), approvals: new ApprovalBroker({ broadcast: () => {} }),
    sandbox: async () => ({ available: false, reason: 'test' }), configDir: mkdtempSync(join(tmpdir(), 'ms-cfg-')), mcpCommand: null,
    ...over, settings: async () => settings,
  });
}
```
Update every `new CreativeTurnService({ … runner: X … })` / `new BrandService({ … runner: X … })` in tests to `launcher: testLauncher(X)`; their assertions stay valid (no sandbox ⇒ Phase 3 tool lists).

`packages/core/test/launcher.test.ts`:
```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { testLauncher } from './helpers/launcher.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
afterEach(() => { delete process.env.FAKE_CLAUDE_ARGS_FILE; });

async function launch(over: Parameters<typeof testLauncher>[1], kind: 'creative' | 'brand-analysis' = 'creative') {
  const projectDir = await mkdtemp(join(tmpdir(), 'ms-launch è '));
  await new PermissionsStore(projectDir).add('Bash(brew:*)', 'x');
  await new PermissionsStore(projectDir).add('provider:openai', 'x');
  const argsFile = join(projectDir, 'args.json');
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  const launcher = testLauncher(new ClaudeCodeRunner([process.execPath, FAKE]), over);
  const run = await launcher.start({ kind, jobId: 'j1', projectSlug: 'acme', projectDir, codebases: [], request: { prompt: 'ciao' }, onEvent: () => {} });
  await run.done;
  const { args, env } = JSON.parse(await readFile(argsFile, 'utf8'));
  return { args: args as string[], env, launcher };
}

describe('AgentLauncher', () => {
  it('without sandbox and MCP keeps the phase 3 behaviour plus project rules (never provider rules)', async () => {
    const { args } = await launch({});
    expect(args).toContain('--permission-prompts');
    expect(args).not.toContain('--settings');
    expect(args).toContain('Bash(brew:*)');
    expect(args).not.toContain('provider:openai');
  });
  it('with sandbox passes the sandbox settings', async () => {
    const { args } = await launch({ sandbox: async () => ({ available: true, reason: 'ok' }) });
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.sandbox.enabled).toBe(true);
  });
  it('honours sandboxMode off', async () => {
    const { args } = await launch({ sandbox: async () => ({ available: true, reason: 'ok' }), settings: { sandboxMode: 'off' } });
    expect(args).not.toContain('--settings');
  });
  it('with a bridge origin wires the MCP server, the prompt tool, the env and frees the token at the end', async () => {
    const bridge = new AgentBridge();
    bridge.setOrigin('http://127.0.0.1:4317');
    const { args, env, } = await launch({ bridge, mcpCommand: ['node', '/x/server.mjs'] });
    const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
    expect(cfg.mcpServers.studio).toMatchObject({ type: 'stdio', command: 'node', args: ['/x/server.mjs'] });
    const token = cfg.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.mcpServers.studio.env.MOTION_STUDIO_TOOLS).toContain('validate_output');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__studio__approve');
    expect(args).toContain('mcp__studio__report_progress');
    expect(env).toBe(null); // MS_TEST_ENV unset; MCP_TOOL_TIMEOUT checked below
    expect(bridge.resolve(token)).toBeNull();
  });
});
```
(Extend the fake claude args file with `mcpTimeout: process.env.MCP_TOOL_TIMEOUT ?? null` and assert `'900000'` in the last test.)

`packages/core/test/bridge-routes.test.ts`:
```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentEvent } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { AgentBridge } from '../src/bridge/bridge.ts';
import { registerBridgeRoutes } from '../src/bridge/bridge-routes.ts';
import { BrandStore } from '../src/brand/brand-store.ts';

let app: FastifyInstance;
let bridge: AgentBridge;
let approvals: ApprovalBroker;
let events: AgentEvent[];
let token: string;

beforeEach(async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'ms-br-'));
  await new BrandStore(projectDir).writeKit({ schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: { kind: 'manual', ref: null } }] });
  bridge = new AgentBridge();
  approvals = new ApprovalBroker({ broadcast: () => {} });
  events = [];
  token = bridge.register({ jobId: 'j1', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c1', emit: (e) => events.push(e), validate: async () => ({ problems: ['Manca il formato X'], outputs: [] }) });
  app = Fastify();
  registerBridgeRoutes(app, { bridge, approvals });
});
afterEach(() => app.close());
const call = (tool: string, payload: unknown, t: string | undefined = token) =>
  app.inject({ method: 'POST', url: `/api/bridge/${tool}`, payload: payload as object, headers: t ? { 'x-motion-studio-bridge': t } : {} });

describe('bridge', () => {
  it('rejects missing, malformed and unknown tokens', async () => {
    expect((await call('report_progress', { message: 'x' }, undefined)).statusCode).toBe(401);
    expect((await call('report_progress', { message: 'x' }, 'abc')).statusCode).toBe(401);
    expect((await call('report_progress', { message: 'x' }, 'f'.repeat(64))).statusCode).toBe(401);
  });
  it('turns progress into agent events', async () => {
    expect((await call('report_progress', { message: 'Rendering 9:16' })).json()).toEqual({ ok: true });
    expect(events).toEqual([{ kind: 'progress', text: 'Rendering 9:16' }]);
    expect((await call('report_progress', { message: '' })).statusCode).toBe(400);
  });
  it('asks the user and answers the permission prompt', async () => {
    const pending = call('approve', { tool_name: 'Bash', input: { command: 'brew install ffmpeg' }, tool_use_id: 't1' });
    await new Promise((r) => setTimeout(r, 20));
    const [req] = approvals.pending();
    expect(req).toMatchObject({ jobId: 'j1', creativeSlug: 'c1', toolName: 'Bash' });
    await approvals.decide(req!.id, 'once');
    expect((await pending).json()).toEqual({ behavior: 'allow', updatedInput: { command: 'brew install ffmpeg' } });
    const denied = call('approve', { tool_name: 'Write', input: { file_path: '/x' }, tool_use_id: 't2' });
    await new Promise((r) => setTimeout(r, 20));
    await approvals.decide(approvals.pending()[0]!.id, 'deny');
    expect((await denied).json()).toEqual({ behavior: 'deny', message: "L'utente ha negato questa azione." });
  });
  it('validates outputs and reads the brand kit', async () => {
    expect((await call('validate_output', {})).json()).toEqual({ problems: ['Manca il formato X'], outputs: [] });
    expect((await call('read_brand_kit', {})).json().kit.colors[0].hex).toBe('#1E3A5F');
    expect((await call('nope', {})).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/launcher.test.ts packages/core/test/bridge-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `bridge.ts`, `launcher.ts`, `bridge-routes.ts`**

`bridge.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { AgentEvent } from '@motion-studio/shared';
import type { AgentJobKind } from '../agent/policy.ts';

export interface BridgeContext {
  jobId: string; kind: AgentJobKind; projectSlug: string; projectDir: string; creativeSlug: string | null;
  emit(e: AgentEvent): void;
  validate?: () => Promise<{ problems: string[]; outputs: unknown[] }>;
}

export class AgentBridge {
  origin: string | null = null;
  private readonly contexts = new Map<string, BridgeContext>();
  setOrigin(url: string) { this.origin = url.replace(/\/+$/, ''); }
  register(ctx: BridgeContext): string { const t = randomBytes(32).toString('hex'); this.contexts.set(t, ctx); return t; }
  unregister(token: string) { this.contexts.delete(token); }
  resolve(token: string | undefined): BridgeContext | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    return this.contexts.get(token) ?? null;
  }
}
```

`launcher.ts`:
```ts
import { homedir } from 'node:os';
import type { AgentEvent, WorkspaceSettings } from '@motion-studio/shared';
import { PermissionsStore } from '../approvals/permissions-store.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import type { AgentBridge, BridgeContext } from '../bridge/bridge.ts';
import { buildAgentPolicy, type AgentJobKind } from './policy.ts';
import type { AgentRun, AgentRunner, AgentTurnRequest } from './runner.ts';
import type { SandboxSupport } from './sandbox.ts';

export const MCP_SERVER = 'studio';
export const MCP_TOOLS: Record<AgentJobKind, string[]> = {
  creative: ['report_progress', 'validate_output', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
  console: ['report_progress', 'read_brand_kit', 'generate_image', 'tts', 'stock_search', 'stock_download', 'fonts_fetch'],
  'brand-analysis': ['report_progress', 'read_brand_kit', 'fonts_fetch'],
  describe: ['report_progress'],
};

export interface LauncherDeps {
  runner: AgentRunner; bridge: AgentBridge; approvals: ApprovalBroker;
  sandbox: () => Promise<SandboxSupport>; settings: () => Promise<WorkspaceSettings>;
  configDir: string; home?: string; mcpCommand: string[] | null;
}
export interface LaunchInput {
  kind: AgentJobKind; jobId: string; projectSlug: string; projectDir: string; creativeSlug?: string | null;
  codebases?: string[]; protectedFiles?: string[];
  request: Pick<AgentTurnRequest, 'prompt' | 'resumeSessionId' | 'forkSession' | 'model'>;
  onEvent(e: AgentEvent): void;
  validate?: BridgeContext['validate'];
}

export class AgentLauncher {
  constructor(private readonly deps: LauncherDeps) {}

  async sandboxActive(): Promise<boolean> {
    const s = await this.deps.settings();
    return s.sandboxMode === 'auto' && (await this.deps.sandbox()).available;
  }

  async start(i: LaunchInput): Promise<AgentRun> {
    const settings = await this.deps.settings();
    const sandbox = await this.sandboxActive();
    const rules = (await new PermissionsStore(i.projectDir).list().catch(() => [])).map((r) => r.rule).filter((r) => !r.startsWith('provider:'));
    const { bridge, mcpCommand } = this.deps;
    const mcpOn = Boolean(bridge.origin && mcpCommand?.length);
    const policy = buildAgentPolicy({
      kind: i.kind, sandbox, home: this.deps.home ?? homedir(), configDir: this.deps.configDir,
      codebases: i.codebases ?? [], protectedFiles: i.protectedFiles ?? [], extraDomains: settings.extraAllowedDomains,
      projectAllowRules: rules, mcpTools: mcpOn ? MCP_TOOLS[i.kind].map((t) => `mcp__${MCP_SERVER}__${t}`) : [],
    });
    let token: string | null = null;
    let mcp: Pick<AgentTurnRequest, 'mcpConfig' | 'permissionPromptTool'> = {};
    if (mcpOn && mcpCommand) {
      token = bridge.register({ jobId: i.jobId, kind: i.kind, projectSlug: i.projectSlug, projectDir: i.projectDir, creativeSlug: i.creativeSlug ?? null, emit: i.onEvent, validate: i.validate });
      mcp = {
        mcpConfig: { mcpServers: { [MCP_SERVER]: { type: 'stdio', command: mcpCommand[0], args: mcpCommand.slice(1),
          env: { MOTION_STUDIO_BRIDGE_URL: bridge.origin!, MOTION_STUDIO_BRIDGE_TOKEN: token, MOTION_STUDIO_TOOLS: MCP_TOOLS[i.kind].join(',') } } } },
        permissionPromptTool: `mcp__${MCP_SERVER}__approve`,
      };
    }
    const run = this.deps.runner.start({
      cwd: i.projectDir, ...i.request,
      addDirs: policy.addDirs, allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools,
      ...(policy.settings ? { settings: policy.settings } : {}), ...mcp,
      env: { MCP_TOOL_TIMEOUT: '900000' },
    }, i.onEvent);
    const cleanup = () => { if (token) bridge.unregister(token); this.deps.approvals.cancelJob(i.jobId); };
    return { done: run.done.finally(cleanup), cancel: () => { this.deps.approvals.cancelJob(i.jobId); run.cancel(); } };
  }
}
```

`bridge-routes.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { BrandStore } from '../brand/brand-store.ts';
import { WorkspaceError } from '../workspace-store.ts';
import type { AgentBridge, BridgeContext } from './bridge.ts';

export type BridgeHandler = (ctx: BridgeContext, args: Record<string, unknown>) => Promise<unknown>;
export interface BridgeRoutesContext { bridge: AgentBridge; approvals: ApprovalBroker; extraTools?: Record<string, BridgeHandler> }

const DENY_MESSAGES = { deny: "L'utente ha negato questa azione.", expired: 'Nessuna risposta entro 10 minuti: azione negata.', cancelled: 'Il lavoro è stato annullato.' } as const;

export function registerBridgeRoutes(app: FastifyInstance, ctx: BridgeRoutesContext) {
  const tools: Record<string, BridgeHandler> = {
    approve: async (c, a) => {
      const input = (a.input ?? a.tool_input ?? {}) as Record<string, unknown>;
      const toolName = typeof a.tool_name === 'string' ? a.tool_name : 'sconosciuto';
      const { decision } = await ctx.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'tool', toolName, input });
      return decision === 'once' || decision === 'always'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: DENY_MESSAGES[decision] };
    },
    report_progress: async (c, a) => {
      const text = typeof a.message === 'string' ? a.message.trim() : '';
      if (!text || text.length > 300) throw new WorkspaceError(400, 'Messaggio di avanzamento non valido (1-300 caratteri)');
      c.emit({ kind: 'progress', text });
      return { ok: true };
    },
    validate_output: async (c) => {
      if (!c.validate) throw new WorkspaceError(400, 'Validazione disponibile solo nelle creatività');
      return c.validate();
    },
    read_brand_kit: async (c) => {
      const store = new BrandStore(c.projectDir);
      const guidelines = (await store.readGuidelines().catch(() => '')).slice(0, 50_000);
      try { return { kit: await store.readKit(), guidelines }; }
      catch (e) { return { kit: null, guidelines, error: (e as Error).message }; }
    },
    ...ctx.extraTools,
  };

  app.post<{ Params: { tool: string } }>('/api/bridge/:tool', async (req: FastifyRequest<{ Params: { tool: string } }>, reply) => {
    const c = ctx.bridge.resolve(req.headers['x-motion-studio-bridge'] as string | undefined);
    if (!c) return reply.status(401).send({ error: 'Accesso al bridge non valido' });
    const handler = Object.hasOwn(tools, req.params.tool) ? tools[req.params.tool] : undefined;
    if (!handler) return reply.status(404).send({ error: `Strumento sconosciuto: ${req.params.tool}` });
    return handler(c, (req.body ?? {}) as Record<string, unknown>);
  });
}
```

- [ ] **Step 4: Migra i punti di lancio**

1. `CreativeTurnService`: `CreativeTurnDeps.runner` → `launcher: AgentLauncher`. In `run()`, replace `this.deps.runner.start({...}, cb)` with
```ts
        const run = await this.deps.launcher.start({
          kind: 'creative', jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, creativeSlug: slug, codebases: existing,
          request: { prompt, resumeSessionId, forkSession, model },
          onEvent: cb,
          validate: async () => validateOutputs({ dir: store.outputsDir(slug, n), requested: creative.brief.formats, presets, durationSec: creative.brief.durationSec, media: this.deps.media }),
        });
```
where `cb` is the existing event callback; persist `progress` events like the others (they already flow through `cb`). Remove the direct `AGENT_ALLOWED_TOOLS` / `readOnlyRules` usage (the policy computes both).
2. `BrandService`: deps `runner` → `launcher`; `runAgent` becomes `await this.deps.launcher.start({ kind, jobId, projectSlug: ref.projectSlug, projectDir: ref.projectDir, protectedFiles: GUARDED_FILES.map(abs) (both the project path and its realpath, as `guardRules` does), request: { prompt, model }, onEvent })` with `kind` `'brand-analysis'` or `'describe'`; keep the tamper snapshot/restore exactly as today (defence in depth). `guardRules` is no longer passed separately (the policy builds the same deny rules from `protectedFiles`).
3. Console (`app.ts`): use `launcher.start({ kind: 'console', …, codebases: existing project codebases (checkCodebases + filter exists), request: { prompt, resumeSessionId, model } })`.
4. `app.ts`: build `const sandboxCheck = deps.sandbox ?? memo(() => detectSandbox())`, `const bridge = deps.bridge ?? new AgentBridge()`, the `AgentLauncher` (settings → current workspace settings, or defaults when none), `registerBridgeRoutes(app, { bridge, approvals })`; the `/api/doctor` route passes the sandbox check (`deps.doctor` gains an optional argument or `buildServer` appends the sandbox check to its result).
5. `main.ts`: create the bridge, pass `bridge`, `mcpCommand`, `configDir`, then `bridge.setOrigin(url)` after `listen`; `startServer` accepts `mcpServerPath?: string`.

- [ ] **Step 5: Verifica**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS (le suite delle fasi 2–3 invariate grazie a `testLauncher`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): agent launcher with sandbox policy, MCP bridge and UI permission prompts for every agent job"
```

---

### Task 6: Server MCP `studio` (senza dipendenze)

**Files:**
- Create: `packages/mcp-studio/package.json`, `packages/mcp-studio/src/server.mjs`, `packages/mcp-studio/test/server.test.ts`
- Modify: `apps/cli/package.json` (build copies the server), `apps/cli/src/main.ts` (passes `mcpServerPath`)

**Interfaces:**
- Produces: an MCP stdio server (newline-delimited JSON-RPC 2.0) reading `MOTION_STUDIO_BRIDGE_URL`, `MOTION_STUDIO_BRIDGE_TOKEN`, `MOTION_STUDIO_TOOLS` (comma list). Handles `initialize` (echoes the client's `protocolVersion`, `capabilities: { tools: {} }`, `serverInfo: { name: 'studio', version }`), `notifications/*` (ignored), `ping` (→ `{}`), `tools/list` (the `approve` tool always + the tools in `MOTION_STUDIO_TOOLS`), `tools/call` → `POST <url>/api/bridge/<name>` with header `x-motion-studio-bridge` and the arguments as JSON body; HTTP 2xx → `{ content: [{ type: 'text', text: JSON.stringify(body) }] }`; non-2xx or network error → `{ content: [{ type: 'text', text: body.error ?? message }], isError: true }`. Unknown methods with an id → JSON-RPC error `-32601`. Tool descriptions and input schemas (Italian descriptions):
  - `approve` — "Uso interno di Motion Studio (richieste di permesso)". `{ tool_name: string, input: object, tool_use_id: string }`.
  - `report_progress` — "Comunica all'utente a che punto sei (una frase breve)". `{ message: string (≤300) }`, required.
  - `validate_output` — "Controlla gli output della versione corrente rispetto al contratto e restituisce i problemi". `{}`.
  - `read_brand_kit` — "Legge brand kit e linee guida del progetto". `{}`.
  - `generate_image` — "Genera o modifica un'immagine con gpt-image-2 (a pagamento; può chiedere conferma all'utente)". `{ prompt: string, width: integer, height: integer, quality?: 'low'|'medium'|'high'|'auto', background?: 'transparent'|'opaque'|'auto', references?: string[] (percorsi di immagini del progetto, max 16), name?: string }`, required prompt,width,height.
  - `tts` — "Genera una voce fuori campo (a pagamento; può chiedere conferma)". `{ text: string, provider?: 'openai'|'elevenlabs', voice?: string, instructions?: string, format?: 'mp3'|'wav', name?: string }`, required text.
  - `stock_search` — "Cerca foto o video su Pexels/Unsplash". `{ provider: 'pexels'|'unsplash', query: string, kind?: 'photo'|'video', orientation?: 'landscape'|'portrait'|'square', limit?: integer (1-20) }`, required provider,query.
  - `stock_download` — "Scarica un risultato di stock negli asset del progetto (con attribuzione)". `{ provider, id: string, kind?: 'photo'|'video' }`, required provider,id.
  - `fonts_fetch` — "Scarica un font da Google Fonts negli asset del progetto". `{ family: string, weights?: integer[], italic?: boolean }`, required family.
- `apps/cli`: build script also copies `../../packages/mcp-studio/src/server.mjs` to `dist/mcp-studio.mjs`; `main.ts` passes `mcpServerPath: join(dirname(fileURLToPath(import.meta.url)), 'mcp-studio.mjs')` to `startServer`.

- [ ] **Step 1: Test che falliscono**

`packages/mcp-studio/package.json`:
```json
{ "name": "@motion-studio/mcp-studio", "version": "0.0.0", "private": true, "type": "module", "scripts": { "typecheck": "true" } }
```

`packages/mcp-studio/test/server.test.ts`:
```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
let http: Server;
let calls: Array<{ url: string; token: string | undefined; body: unknown }>;
let child: ChildProcessWithoutNullStreams;
let responses: Map<number, any>;

beforeEach(async () => {
  calls = [];
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      calls.push({ url: req.url!, token: req.headers['x-motion-studio-bridge'] as string, body: JSON.parse(raw || '{}') });
      if (req.url === '/api/bridge/validate_output') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Validazione disponibile solo nelle creatività' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/bridge/approve' ? { behavior: 'deny', message: 'no' } : { ok: true }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, MOTION_STUDIO_BRIDGE_URL: `http://127.0.0.1:${port}`, MOTION_STUDIO_BRIDGE_TOKEN: 'tok', MOTION_STUDIO_TOOLS: 'report_progress,validate_output' } });
  responses = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); responses.set(m.id, m); });
});
afterEach(() => { child.kill(); http.close(); });

const rpc = async (id: number, method: string, params: unknown = {}) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  for (let i = 0; i < 200 && !responses.has(id); i++) await new Promise((r) => setTimeout(r, 10));
  return responses.get(id);
};

describe('mcp-studio server', () => {
  it('initializes and lists approve plus the enabled tools only', async () => {
    expect((await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'studio' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const names = (await rpc(2, 'tools/list')).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['approve', 'report_progress', 'validate_output']);
  });
  it('forwards calls with the token and maps errors', async () => {
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
    const ok = await rpc(2, 'tools/call', { name: 'report_progress', arguments: { message: 'ciao' } });
    expect(ok.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    expect(calls[0]).toEqual({ url: '/api/bridge/report_progress', token: 'tok', body: { message: 'ciao' } });
    const bad = await rpc(3, 'tools/call', { name: 'validate_output', arguments: {} });
    expect(bad.result).toEqual({ content: [{ type: 'text', text: 'Validazione disponibile solo nelle creatività' }], isError: true });
    const approve = await rpc(4, 'tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'x' }, tool_use_id: 'u' } });
    expect(JSON.parse(approve.result.content[0].text)).toEqual({ behavior: 'deny', message: 'no' });
    expect((await rpc(5, 'nope/method')).error.code).toBe(-32601);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm install && pnpm vitest run packages/mcp-studio`
Expected: FAIL (server mancante).

- [ ] **Step 3: Implementa `server.mjs`**

```js
#!/usr/bin/env node
// Motion Studio MCP server: a dependency-free stdio bridge. Every tool call is forwarded to the Motion Studio core
// on loopback with the per-job token; the core holds the API keys and does the work.
import { createInterface } from 'node:readline';

const URL_BASE = (process.env.MOTION_STUDIO_BRIDGE_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MOTION_STUDIO_BRIDGE_TOKEN ?? '';
const ENABLED = new Set((process.env.MOTION_STUDIO_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const TOOLS = [
  { name: 'approve', description: 'Uso interno di Motion Studio (richieste di permesso).', inputSchema: { type: 'object', properties: { tool_name: str('Strumento'), input: { type: 'object' }, tool_use_id: str('Id') }, additionalProperties: true } },
  { name: 'report_progress', description: "Comunica all'utente a che punto sei (una frase breve).", inputSchema: { type: 'object', properties: { message: str('Frase breve', { maxLength: 300 }) }, required: ['message'] } },
  { name: 'validate_output', description: 'Controlla gli output della versione corrente rispetto al contratto e restituisce i problemi.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_brand_kit', description: 'Legge brand kit e linee guida del progetto.', inputSchema: { type: 'object', properties: {} } },
  { name: 'generate_image', description: "Genera o modifica un'immagine con gpt-image-2 (a pagamento; può chiedere conferma all'utente). Restituisce il percorso del file salvato negli asset.", inputSchema: { type: 'object', properties: { prompt: str('Descrizione'), width: { type: 'integer' }, height: { type: 'integer' }, quality: { enum: ['low', 'medium', 'high', 'auto'] }, background: { enum: ['transparent', 'opaque', 'auto'] }, references: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Immagini del progetto da usare come riferimento' }, name: str('Nome file (facoltativo)') }, required: ['prompt', 'width', 'height'] } },
  { name: 'tts', description: 'Genera una voce fuori campo (a pagamento; può chiedere conferma). Restituisce il percorso del file audio.', inputSchema: { type: 'object', properties: { text: str('Testo da leggere'), provider: { enum: ['openai', 'elevenlabs'] }, voice: str('Voce'), instructions: str('Tono e stile (solo OpenAI)'), format: { enum: ['mp3', 'wav'] }, name: str('Nome file (facoltativo)') }, required: ['text'] } },
  { name: 'stock_search', description: 'Cerca foto o video su Pexels o Unsplash.', inputSchema: { type: 'object', properties: { provider: { enum: ['pexels', 'unsplash'] }, query: str('Ricerca (in inglese funziona meglio)'), kind: { enum: ['photo', 'video'] }, orientation: { enum: ['landscape', 'portrait', 'square'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['provider', 'query'] } },
  { name: 'stock_download', description: "Scarica un risultato di stock negli asset del progetto, con l'attribuzione richiesta.", inputSchema: { type: 'object', properties: { provider: { enum: ['pexels', 'unsplash'] }, id: str('Id del risultato'), kind: { enum: ['photo', 'video'] } }, required: ['provider', 'id'] } },
  { name: 'fonts_fetch', description: 'Scarica un font da Google Fonts negli asset del progetto.', inputSchema: { type: 'object', properties: { family: str('Famiglia, es. "Manrope"'), weights: { type: 'array', items: { type: 'integer' } }, italic: { type: 'boolean' } }, required: ['family'] } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const listed = () => TOOLS.filter((t) => t.name === 'approve' || ENABLED.has(t.name));

async function call(name, args) {
  if (!listed().some((t) => t.name === name)) return { content: [{ type: 'text', text: `Strumento non disponibile: ${name}` }], isError: true };
  try {
    const res = await fetch(`${URL_BASE}/api/bridge/${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-motion-studio-bridge': TOKEN }, body: JSON.stringify(args ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { content: [{ type: 'text', text: body.error ?? `Errore ${res.status}` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Motion Studio non raggiungibile: ${err.message}` }], isError: true };
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'studio', version: '0.4.0' } } });
    case 'ping':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: msg.id, result: { tools: listed() } });
    case 'tools/call':
      return send({ jsonrpc: '2.0', id: msg.id, result: await call(msg.params?.name, msg.params?.arguments) });
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Metodo non supportato: ${msg.method}` } });
  }
});
```

- [ ] **Step 4: CLI**

`apps/cli/package.json` build script: append `&& node -e "require('node:fs').copyFileSync('../../packages/mcp-studio/src/server.mjs','dist/mcp-studio.mjs')"`. In `apps/cli/src/main.ts` pass `mcpServerPath: join(dirname(fileURLToPath(import.meta.url)), 'mcp-studio.mjs')` to `startServer`.

- [ ] **Step 5: Verifica**

Run: `pnpm vitest run packages/mcp-studio && pnpm build && ls apps/cli/dist/mcp-studio.mjs`
Expected: PASS; il file esiste nel bundle.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(mcp-studio): dependency-free MCP server bridging agent tools to the core"
```

---

### Task 7: Infrastruttura provider e OpenAI gpt-image-2

**Files:**
- Create: `packages/core/src/providers/http.ts`, `packages/core/src/providers/files.ts`, `packages/core/src/providers/openai-images.ts`, `packages/core/test/providers-http.test.ts`, `packages/core/test/openai-images.test.ts`
- Modify: `packages/core/src/library/library-store.ts` (`registerAssets` items accept `attribution?: string | null`), `packages/core/src/index.ts`

**Interfaces:**
- Produces (`http.ts`):
  ```ts
  export class ProviderError extends Error { constructor(public readonly status: number, message: string) }
  export interface HttpDeps { fetch: typeof fetch; timeoutMs?: number /* 120_000 */ }
  export function requestJson<T>(deps: HttpDeps, url: string, init: RequestInit, opts: { provider: string; secrets: string[] }): Promise<T>;
  export function requestBytes(deps: HttpDeps, url: string, init: RequestInit, opts: { provider: string; secrets: string[]; maxBytes: number }): Promise<{ bytes: Buffer; contentType: string }>;
  ```
  Error mapping (all messages Italian, passed through `redact(…, secrets)`): network/timeout → `ProviderError(502, '<provider> non raggiungibile: <msg>')`; 401/403 → `ProviderError(401, 'Chiave <provider> non valida o senza permessi')`; 429 → `ProviderError(429, 'Limite di richieste raggiunto per <provider>: riprova più tardi')`; other non-2xx → `ProviderError(502, '<provider> ha risposto <status>: <body.error.message ?? body.message ?? text, max 300 chars>')`; invalid JSON → `ProviderError(502, 'Risposta non valida da <provider>')`; body over `maxBytes` (stream counted, aborted) → `ProviderError(413, 'File troppo grande da <provider>')`. Timeout via `AbortSignal.timeout(timeoutMs)`.
- Produces (`files.ts`):
  ```ts
  export type GeneratedDir = 'generated' | 'audio' | 'stock' | 'fonts';
  export function saveGeneratedFile(projectDir: string, dir: GeneratedDir, name: string, bytes: Buffer): Promise<string>;
    // writes `.<name>.<rand>.part` in <project>/assets/<dir>/ (created), claims a unique final name with claimName(sanitizeFileName(name)), removes the temp in finally;
    // returns the path relative to assets/ (e.g. 'generated/logo-2.png')
  ```
- Produces (`openai-images.ts`):
  ```ts
  export function normalizeImageSize(width: number, height: number): { width: number; height: number };
    // ratio clamped to [1/3, 3]; total pixels clamped to [655_360, 8_294_400]; each side rounded to a multiple of 16; longest side ≤ 3840 (scaled down keeping the ratio); 400 for non-positive input
  export interface ImageRequest { prompt: string; width: number; height: number; quality?: 'low' | 'medium' | 'high' | 'auto'; background?: 'transparent' | 'opaque' | 'auto'; references?: Array<{ name: string; bytes: Buffer }> }
  export function generateImage(deps: HttpDeps & { apiKey: string }, req: ImageRequest): Promise<{ bytes: Buffer; width: number; height: number; revisedPrompt: string | null }>;
    // no references → POST https://api.openai.com/v1/images/generations JSON { model: 'gpt-image-2', prompt, size: `${w}x${h}`, quality: quality ?? 'auto', background: background ?? 'auto', output_format: 'png', n: 1 }
    // references → POST https://api.openai.com/v1/images/edits multipart: model, prompt, size, quality, background, output_format=png, one `image[]` per reference (Blob with type image/png|image/jpeg|image/webp from the name)
    // response data[0].b64_json (missing → ProviderError 502 'Risposta non valida da OpenAI'); revised_prompt optional
  ```
  The size passed to the API is `normalizeImageSize(width, height)`.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/providers-http.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProviderError, requestBytes, requestJson } from '../src/providers/http.ts';

const res = (status: number, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
const deps = (r: Response | Error) => ({ fetch: (async () => { if (r instanceof Error) throw r; return r; }) as typeof fetch });

describe('requestJson', () => {
  it('returns JSON and maps errors without leaking the key', async () => {
    expect(await requestJson(deps(res(200, { a: 1 })), 'u', {}, { provider: 'OpenAI', secrets: ['sk-1234'] })).toEqual({ a: 1 });
    const unauthorized = await requestJson(deps(res(401, { error: { message: 'bad key sk-1234' } })), 'u', {}, { provider: 'OpenAI', secrets: ['sk-1234'] }).catch((e) => e);
    expect(unauthorized).toBeInstanceOf(ProviderError);
    expect(unauthorized.message).toBe('Chiave OpenAI non valida o senza permessi');
    expect((await requestJson(deps(res(429, {})), 'u', {}, { provider: 'Pexels', secrets: [] }).catch((e) => e)).message).toBe('Limite di richieste raggiunto per Pexels: riprova più tardi');
    const other = await requestJson(deps(res(500, { error: { message: 'boom with sk-1234' } })), 'u', {}, { provider: 'OpenAI', secrets: ['sk-1234'] }).catch((e) => e);
    expect(other.message).toBe('OpenAI ha risposto 500: boom with •••');
    expect((await requestJson(deps(res(200, 'not json', { 'content-type': 'text/plain' })), 'u', {}, { provider: 'X', secrets: [] }).catch((e) => e)).message).toBe('Risposta non valida da X');
    expect((await requestJson(deps(new Error('ECONNREFUSED')), 'u', {}, { provider: 'X', secrets: [] }).catch((e) => e)).message).toBe('X non raggiungibile: ECONNREFUSED');
  });
});

describe('requestBytes', () => {
  it('enforces the size limit', async () => {
    const ok = await requestBytes(deps(res(200, new Uint8Array([1, 2, 3]), { 'content-type': 'image/png' })), 'u', {}, { provider: 'X', secrets: [], maxBytes: 10 });
    expect([...ok.bytes]).toEqual([1, 2, 3]);
    expect(ok.contentType).toBe('image/png');
    const big = await requestBytes(deps(res(200, new Uint8Array(20))), 'u', {}, { provider: 'X', secrets: [], maxBytes: 10 }).catch((e) => e);
    expect(big).toMatchObject({ status: 413, message: 'File troppo grande da X' });
  });
});
```

`packages/core/test/openai-images.test.ts`:
```ts
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveGeneratedFile } from '../src/providers/files.ts';
import { generateImage, normalizeImageSize } from '../src/providers/openai-images.ts';

describe('normalizeImageSize', () => {
  it.each([
    [1080, 1920, 1088, 1920],
    [3840, 2160, 3840, 2160],
    [300, 250, 880, 736],
    [728, 90, 1408, 464],
    [8000, 8000, 2880, 2880],
  ])('%i×%i → %i×%i', (w, h, ew, eh) => {
    const r = normalizeImageSize(w, h);
    expect(r).toEqual({ width: ew, height: eh });
    expect(r.width % 16 + r.height % 16).toBe(0);
  });
  it('rejects non-positive sizes', () => {
    expect(() => normalizeImageSize(0, 100)).toThrow();
  });
});

describe('generateImage', () => {
  it('calls generations without references and edits with references', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const png = Buffer.from('fake-png');
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64'), revised_prompt: 'rp' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const a = await generateImage({ fetch: fetchImpl, apiKey: 'sk-x' }, { prompt: 'Banner blu', width: 300, height: 250 });
    expect(a).toMatchObject({ width: 880, height: 736, revisedPrompt: 'rp' });
    expect(a.bytes.equals(png)).toBe(true);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ model: 'gpt-image-2', size: '880x736', output_format: 'png', n: 1 });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-x');
    await generateImage({ fetch: fetchImpl, apiKey: 'sk-x' }, { prompt: 'Come questo', width: 1024, height: 1024, references: [{ name: 'ref.jpg', bytes: Buffer.from('j') }] });
    expect(calls[1]!.url).toBe('https://api.openai.com/v1/images/edits');
    const form = calls[1]!.init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2');
    expect((form.getAll('image[]')[0] as File).type).toBe('image/jpeg');
  });
});

describe('saveGeneratedFile', () => {
  it('saves under assets/<dir> with unique names and no temp files', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ms-gen è '));
    expect(await saveGeneratedFile(project, 'generated', 'Logo Blu.png', Buffer.from('a'))).toBe('generated/Logo-Blu.png');
    expect(await saveGeneratedFile(project, 'generated', 'Logo Blu.png', Buffer.from('b'))).toBe('generated/Logo-Blu-2.png');
    expect(await readFile(join(project, 'assets', 'generated', 'Logo-Blu-2.png'), 'utf8')).toBe('b');
    expect((await readdir(join(project, 'assets', 'generated'))).sort()).toEqual(['Logo-Blu-2.png', 'Logo-Blu.png']);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/providers-http.test.ts packages/core/test/openai-images.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `http.ts`**

```ts
import { redact } from '../secrets/vault.ts';

export class ProviderError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ProviderError'; }
}
export interface HttpDeps { fetch: typeof fetch; timeoutMs?: number }
interface Opts { provider: string; secrets: string[] }

async function send(deps: HttpDeps, url: string, init: RequestInit, o: Opts): Promise<Response> {
  let res: Response;
  try { res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000) }); }
  catch (e) { throw new ProviderError(502, redact(`${o.provider} non raggiungibile: ${(e as Error).message}`, o.secrets)); }
  if (res.ok) return res;
  if (res.status === 401 || res.status === 403) throw new ProviderError(401, `Chiave ${o.provider} non valida o senza permessi`);
  if (res.status === 429) throw new ProviderError(429, `Limite di richieste raggiunto per ${o.provider}: riprova più tardi`);
  const text = await res.text().catch(() => '');
  let detail = text;
  try { const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string; detail?: unknown }; detail = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message ?? text; } catch { /* plain text */ }
  throw new ProviderError(502, redact(`${o.provider} ha risposto ${res.status}: ${String(detail).slice(0, 300)}`, o.secrets));
}

export async function requestJson<T>(deps: HttpDeps, url: string, init: RequestInit, o: Opts): Promise<T> {
  const res = await send(deps, url, init, o);
  try { return (await res.json()) as T; } catch { throw new ProviderError(502, `Risposta non valida da ${o.provider}`); }
}

export async function requestBytes(deps: HttpDeps, url: string, init: RequestInit, o: Opts & { maxBytes: number }): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await send(deps, url, init, o);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > o.maxBytes) { await reader.cancel().catch(() => {}); throw new ProviderError(413, `File troppo grande da ${o.provider}`); }
      chunks.push(Buffer.from(value));
    }
  }
  return { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' };
}
```

- [ ] **Step 4: Implementa `files.ts` e `openai-images.ts`**

`files.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claimName, sanitizeFileName } from '../library/upload.ts';

export type GeneratedDir = 'generated' | 'audio' | 'stock' | 'fonts';

export async function saveGeneratedFile(projectDir: string, dir: GeneratedDir, name: string, bytes: Buffer): Promise<string> {
  const target = join(projectDir, 'assets', dir);
  await mkdir(target, { recursive: true });
  const clean = sanitizeFileName(name);
  const tmp = join(target, `.${clean}.${randomBytes(4).toString('hex')}.part`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    return `${dir}/${await claimName(target, tmp, clean)}`;
  } finally {
    await rm(tmp, { force: true });
  }
}
```

`openai-images.ts`:
```ts
import { ProviderError, requestJson, type HttpDeps } from './http.ts';

const MIN_PIXELS = 655_360, MAX_PIXELS = 8_294_400, MAX_EDGE = 3840;
const r16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

export function normalizeImageSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) throw new ProviderError(400, 'Dimensioni immagine non valide');
  const ratio = Math.min(3, Math.max(1 / 3, width / height));
  const pixels = Math.min(MAX_PIXELS, Math.max(MIN_PIXELS, width * height));
  let w = Math.sqrt(pixels * ratio);
  let h = w / ratio;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  w *= scale; h *= scale;
  return { width: r16(w), height: r16(h) };
}

export interface ImageRequest {
  prompt: string; width: number; height: number;
  quality?: 'low' | 'medium' | 'high' | 'auto'; background?: 'transparent' | 'opaque' | 'auto';
  references?: Array<{ name: string; bytes: Buffer }>;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export async function generateImage(deps: HttpDeps & { apiKey: string }, req: ImageRequest) {
  const { width, height } = normalizeImageSize(req.width, req.height);
  const common = { model: 'gpt-image-2', prompt: req.prompt.slice(0, 32_000), size: `${width}x${height}`, quality: req.quality ?? 'auto', background: req.background ?? 'auto', output_format: 'png' };
  const auth = { authorization: `Bearer ${deps.apiKey}` };
  type Out = { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
  let out: Out;
  if (!req.references?.length) {
    out = await requestJson<Out>(deps, 'https://api.openai.com/v1/images/generations', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ ...common, n: 1 }) }, { provider: 'OpenAI', secrets: [deps.apiKey] });
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(common)) form.append(k, String(v));
    for (const r of req.references.slice(0, 16)) {
      const type = MIME[r.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png';
      form.append('image[]', new Blob([r.bytes], { type }), r.name);
    }
    out = await requestJson<Out>(deps, 'https://api.openai.com/v1/images/edits', { method: 'POST', headers: auth, body: form }, { provider: 'OpenAI', secrets: [deps.apiKey] });
  }
  const b64 = out.data?.[0]?.b64_json;
  if (!b64) throw new ProviderError(502, 'Risposta non valida da OpenAI');
  return { bytes: Buffer.from(b64, 'base64'), width, height, revisedPrompt: out.data?.[0]?.revised_prompt ?? null };
}
```
Note: the `normalizeImageSize` table in the test comes from this algorithm (e.g. `300×250` → ratio 1.2, raised to 655 360 px → 886.8×739 → 880×736). If an expected value differs by one 16-px step because of rounding, recompute it from the algorithm rather than changing the algorithm, and update the table.

`library-store.ts`: `registerAssets` item type gains `attribution?: string | null` and the entry sets `attribution: item.attribution ?? existing?.attribution ?? null`.

Export the three modules from `index.ts`.

- [ ] **Step 5: Verifica**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): provider HTTP helpers with safe errors, generated-file storage and gpt-image-2 client"
```

---

### Task 8: Provider TTS (OpenAI ed ElevenLabs)

**Files:**
- Create: `packages/core/src/providers/tts.ts`, `packages/core/test/tts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TtsRequest { text: string; voice?: string; instructions?: string; format: 'mp3' | 'wav' }
  export function openaiSpeech(deps: HttpDeps & { apiKey: string }, req: TtsRequest): Promise<{ bytes: Buffer; voice: string }>;
    // POST https://api.openai.com/v1/audio/speech JSON { model: 'gpt-4o-mini-tts', input (≤4096, else 400 'Testo troppo lungo per OpenAI (massimo 4096 caratteri)'), voice: voice ?? 'marin', instructions?, response_format: format }
  export function elevenlabsSpeech(deps: HttpDeps & { apiKey: string }, req: TtsRequest): Promise<{ bytes: Buffer; voice: string }>;
    // voice id: req.voice ?? first of GET https://api.elevenlabs.io/v2/voices?page_size=10 (voices[0].voice_id; none → ProviderError 502 'Nessuna voce disponibile su ElevenLabs')
    // POST https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=(mp3 → mp3_44100_128 | wav → wav_44100) JSON { text (≤5000), model_id: 'eleven_multilingual_v2' }, header xi-api-key
  ```
  Both use `requestBytes` with `maxBytes: 50 MB`.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/tts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { elevenlabsSpeech, openaiSpeech } from '../src/providers/tts.ts';

const recorder = (responses: Response[]) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return responses.shift()!; }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};
const audio = () => new Response(new Uint8Array([7, 7]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });

describe('openaiSpeech', () => {
  it('posts the request and returns audio', async () => {
    const { calls, fetchImpl } = recorder([audio()]);
    const r = await openaiSpeech({ fetch: fetchImpl, apiKey: 'sk' }, { text: 'Ciao', instructions: 'Tono energico', format: 'mp3' });
    expect([...r.bytes]).toEqual([7, 7]);
    expect(r.voice).toBe('marin');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ model: 'gpt-4o-mini-tts', input: 'Ciao', voice: 'marin', instructions: 'Tono energico', response_format: 'mp3' });
  });
  it('rejects text over 4096 characters', async () => {
    const { fetchImpl } = recorder([]);
    expect((await openaiSpeech({ fetch: fetchImpl, apiKey: 'sk' }, { text: 'x'.repeat(4097), format: 'mp3' }).catch((e) => e)).status).toBe(400);
  });
});

describe('elevenlabsSpeech', () => {
  it('picks the first voice when none is given', async () => {
    const voices = new Response(JSON.stringify({ voices: [{ voice_id: 'v1', name: 'Bella' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { calls, fetchImpl } = recorder([voices, audio()]);
    const r = await elevenlabsSpeech({ fetch: fetchImpl, apiKey: 'xi' }, { text: 'Ciao', format: 'wav' });
    expect(r.voice).toBe('v1');
    expect(calls[1]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=wav_44100');
    expect((calls[1]!.init.headers as Record<string, string>)['xi-api-key']).toBe('xi');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/tts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa**

```ts
import { ProviderError, requestBytes, requestJson, type HttpDeps } from './http.ts';

export interface TtsRequest { text: string; voice?: string; instructions?: string; format: 'mp3' | 'wav' }
const MAX = 50 * 1024 * 1024;

export async function openaiSpeech(deps: HttpDeps & { apiKey: string }, req: TtsRequest) {
  if (req.text.length > 4096) throw new ProviderError(400, 'Testo troppo lungo per OpenAI (massimo 4096 caratteri)');
  const voice = req.voice ?? 'marin';
  const body = { model: 'gpt-4o-mini-tts', input: req.text, voice, ...(req.instructions ? { instructions: req.instructions } : {}), response_format: req.format };
  const { bytes } = await requestBytes(deps, 'https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { provider: 'OpenAI', secrets: [deps.apiKey], maxBytes: MAX });
  return { bytes, voice };
}

export async function elevenlabsSpeech(deps: HttpDeps & { apiKey: string }, req: TtsRequest) {
  if (req.text.length > 5000) throw new ProviderError(400, 'Testo troppo lungo per ElevenLabs (massimo 5000 caratteri)');
  const headers = { 'xi-api-key': deps.apiKey };
  let voice = req.voice;
  if (!voice) {
    const list = await requestJson<{ voices?: Array<{ voice_id: string }> }>(deps, 'https://api.elevenlabs.io/v2/voices?page_size=10', { headers }, { provider: 'ElevenLabs', secrets: [deps.apiKey] });
    voice = list.voices?.[0]?.voice_id;
    if (!voice) throw new ProviderError(502, 'Nessuna voce disponibile su ElevenLabs');
  }
  const format = req.format === 'wav' ? 'wav_44100' : 'mp3_44100_128';
  const { bytes } = await requestBytes(deps, `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${format}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: req.text, model_id: 'eleven_multilingual_v2' }),
  }, { provider: 'ElevenLabs', secrets: [deps.apiKey], maxBytes: MAX });
  return { bytes, voice };
}
```
Export from `index.ts`.

- [ ] **Step 4: Verifica e commit**

Run: `pnpm vitest run packages/core/test/tts.test.ts && pnpm typecheck`
```bash
git add -A
git commit -m "feat(core): OpenAI and ElevenLabs text-to-speech clients"
```

---

### Task 9: Stock (Pexels, Unsplash) e Google Fonts

**Files:**
- Create: `packages/core/src/providers/stock.ts`, `packages/core/src/providers/google-fonts.ts`, `packages/core/test/stock.test.ts`, `packages/core/test/google-fonts.test.ts`

**Interfaces:**
- Produces (`stock.ts`):
  ```ts
  export type StockProvider = 'pexels' | 'unsplash';
  export interface StockResult { id: string; provider: StockProvider; kind: 'photo' | 'video'; width: number; height: number; durationSec: number | null; thumb: string; author: string; pageUrl: string }
  export function stockSearch(deps: HttpDeps & { apiKey: string }, q: { provider: StockProvider; query: string; kind: 'photo' | 'video'; orientation?: 'landscape' | 'portrait' | 'square'; limit: number }): Promise<StockResult[]>;
    // pexels photo: GET https://api.pexels.com/v1/search?query&per_page&orientation  (Authorization: <key>)
    // pexels video: GET https://api.pexels.com/videos/search?…
    // unsplash photo: GET https://api.unsplash.com/search/photos?query&per_page&orientation (square→squarish)  (Authorization: Client-ID <key>, Accept-Version: v1)
    // unsplash video → ProviderError(400, 'Unsplash non offre video: usa Pexels')
  export function stockDownload(deps: HttpDeps & { apiKey: string }, d: { provider: StockProvider; id: string; kind: 'photo' | 'video' }): Promise<{ bytes: Buffer; ext: string; attribution: string; sourceUrl: string; author: string }>;
    // pexels photo: GET /v1/photos/{id} → src.original; attribution `Foto di <photographer> su Pexels`; sourceUrl = photo.url
    // pexels video: GET /videos/videos/{id} → video_files: mp4 with the largest width ≤ 1920 (else the smallest) → link; attribution `Video di <user.name> su Pexels`
    // unsplash: GET /photos/{id} → GET links.download_location (tracking, with auth) → { url } → bytes of that url;
    //   attribution `Foto di <user.name> su Unsplash`, sourceUrl `${links.html}?utm_source=motion_studio&utm_medium=referral`
    // ids: /^[A-Za-z0-9_-]{1,64}$/ else 400; download maxBytes 200 MB; ext from content-type (jpeg→jpg, png, mp4) default jpg/mp4
  ```
- Produces (`google-fonts.ts`):
  ```ts
  export interface FontFile { weight: number; italic: boolean; url: string }
  export function parseFontCss(css: string): FontFile[];   // @font-face blocks: font-weight, font-style, src url(...) (first url)
  export function fetchGoogleFont(deps: HttpDeps, q: { family: string; weights: number[]; italic: boolean }): Promise<Array<{ weight: number; italic: boolean; bytes: Buffer; ext: string }>>;
    // family /^[A-Za-z0-9 ]{1,60}$/ else 400; weights 100..900 multiples of 100, max 9, default [400, 700]
    // GET https://fonts.googleapis.com/css2?family=<Family+With+Pluses>:wght@400;700  (italic: :ital,wght@0,400;0,700;1,400;1,700) with header user-agent 'curl/8' (→ TTF urls)
    // 400 from Google → ProviderError(404, 'Font "<family>" non trovato su Google Fonts'); each file maxBytes 10 MB; ext from url (.ttf/.woff2)
  ```

- [ ] **Step 1: Test che falliscono**

`packages/core/test/stock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { stockDownload, stockSearch } from '../src/providers/stock.ts';

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const bytes = (type: string) => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': type } });
const recorder = (handler: (url: string) => Response) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return { calls, fetchImpl: (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return handler(url); }) as unknown as typeof fetch };
};

describe('stockSearch', () => {
  it('maps Pexels photos and Unsplash photos', async () => {
    const { calls, fetchImpl } = recorder((u) => (u.includes('pexels')
      ? json({ photos: [{ id: 1, width: 4000, height: 3000, url: 'https://pexels.com/p/1', photographer: 'Ana', src: { medium: 'https://img/m.jpg' } }] })
      : json({ results: [{ id: 'abc', width: 3000, height: 2000, user: { name: 'Bo' }, links: { html: 'https://unsplash.com/photos/abc' }, urls: { small: 'https://img/s.jpg' } }] })));
    expect(await stockSearch({ fetch: fetchImpl, apiKey: 'pk' }, { provider: 'pexels', query: 'caffè', kind: 'photo', orientation: 'square', limit: 5 }))
      .toEqual([{ id: '1', provider: 'pexels', kind: 'photo', width: 4000, height: 3000, durationSec: null, thumb: 'https://img/m.jpg', author: 'Ana', pageUrl: 'https://pexels.com/p/1' }]);
    expect(calls[0]!.url).toBe('https://api.pexels.com/v1/search?query=caff%C3%A8&per_page=5&orientation=square');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('pk');
    const u = await stockSearch({ fetch: fetchImpl, apiKey: 'uk' }, { provider: 'unsplash', query: 'coffee', kind: 'photo', orientation: 'square', limit: 3 });
    expect(u[0]).toMatchObject({ id: 'abc', author: 'Bo' });
    expect(calls[1]!.url).toContain('orientation=squarish');
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Client-ID uk');
  });
  it('refuses Unsplash videos', async () => {
    const { fetchImpl } = recorder(() => json({}));
    expect((await stockSearch({ fetch: fetchImpl, apiKey: 'k' }, { provider: 'unsplash', query: 'x', kind: 'video', limit: 1 }).catch((e) => e)).status).toBe(400);
  });
});

describe('stockDownload', () => {
  it('downloads a Pexels video picking an HD mp4', async () => {
    const { calls, fetchImpl } = recorder((u) => (u.includes('/videos/videos/')
      ? json({ id: 9, url: 'https://pexels.com/v/9', user: { name: 'Cy' }, video_files: [
        { width: 3840, file_type: 'video/mp4', link: 'https://v/4k.mp4' }, { width: 1920, file_type: 'video/mp4', link: 'https://v/hd.mp4' }, { width: 640, file_type: 'video/mp4', link: 'https://v/sd.mp4' }] })
      : bytes('video/mp4')));
    const d = await stockDownload({ fetch: fetchImpl, apiKey: 'pk' }, { provider: 'pexels', id: '9', kind: 'video' });
    expect(calls[1]!.url).toBe('https://v/hd.mp4');
    expect(d).toMatchObject({ ext: 'mp4', attribution: 'Video di Cy su Pexels', sourceUrl: 'https://pexels.com/v/9' });
  });
  it('tracks Unsplash downloads', async () => {
    const { calls, fetchImpl } = recorder((u) => {
      if (u.endsWith('/photos/abc')) return json({ id: 'abc', user: { name: 'Bo' }, links: { html: 'https://unsplash.com/photos/abc', download_location: 'https://api.unsplash.com/photos/abc/download?ixid=1' } });
      if (u.includes('/download')) return json({ url: 'https://images.unsplash.com/raw.jpg' });
      return bytes('image/jpeg');
    });
    const d = await stockDownload({ fetch: fetchImpl, apiKey: 'uk' }, { provider: 'unsplash', id: 'abc', kind: 'photo' });
    expect(calls.map((c) => c.url)).toEqual(['https://api.unsplash.com/photos/abc', 'https://api.unsplash.com/photos/abc/download?ixid=1', 'https://images.unsplash.com/raw.jpg']);
    expect(d).toMatchObject({ ext: 'jpg', attribution: 'Foto di Bo su Unsplash', sourceUrl: 'https://unsplash.com/photos/abc?utm_source=motion_studio&utm_medium=referral' });
  });
  it('rejects odd ids', async () => {
    const { fetchImpl } = recorder(() => json({}));
    expect((await stockDownload({ fetch: fetchImpl, apiKey: 'k' }, { provider: 'pexels', id: '../x', kind: 'photo' }).catch((e) => e)).status).toBe(400);
  });
});
```

`packages/core/test/google-fonts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fetchGoogleFont, parseFontCss } from '../src/providers/google-fonts.ts';

const CSS = `@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 400;
  src: url(https://fonts.gstatic.com/s/manrope/v1/a.ttf) format('truetype');
}
@font-face {
  font-family: 'Manrope';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/manrope/v1/b.ttf) format('truetype');
}`;

describe('parseFontCss', () => {
  it('extracts weight, style and url', () => {
    expect(parseFontCss(CSS)).toEqual([
      { weight: 400, italic: false, url: 'https://fonts.gstatic.com/s/manrope/v1/a.ttf' },
      { weight: 700, italic: false, url: 'https://fonts.gstatic.com/s/manrope/v1/b.ttf' },
    ]);
  });
});

describe('fetchGoogleFont', () => {
  it('requests the css2 API and downloads the files', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      urls.push(url);
      if (url.startsWith('https://fonts.googleapis.com/')) {
        expect((init.headers as Record<string, string>)['user-agent']).toBe('curl/8');
        return new Response(CSS, { status: 200, headers: { 'content-type': 'text/css' } });
      }
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'font/ttf' } });
    }) as unknown as typeof fetch;
    const files = await fetchGoogleFont({ fetch: fetchImpl }, { family: 'Source Sans 3', weights: [400, 700], italic: false });
    expect(urls[0]).toBe('https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;700');
    expect(files.map((f) => [f.weight, f.ext])).toEqual([[400, 'ttf'], [700, 'ttf']]);
  });
  it('validates the family and maps unknown fonts', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    expect((await fetchGoogleFont({ fetch: fetchImpl }, { family: 'Bad;Name', weights: [400], italic: false }).catch((e) => e)).status).toBe(400);
    expect((await fetchGoogleFont({ fetch: fetchImpl }, { family: 'Nope Font', weights: [400], italic: false }).catch((e) => e)).message).toBe('Font "Nope Font" non trovato su Google Fonts');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/stock.test.ts packages/core/test/google-fonts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `stock.ts`**

```ts
import { ProviderError, requestBytes, requestJson, type HttpDeps } from './http.ts';

export type StockProvider = 'pexels' | 'unsplash';
export interface StockResult { id: string; provider: StockProvider; kind: 'photo' | 'video'; width: number; height: number; durationSec: number | null; thumb: string; author: string; pageUrl: string }
const MAX = 200 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const extOf = (type: string, fallback: string) => (type.includes('png') ? 'png' : type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('mp4') ? 'mp4' : type.includes('webp') ? 'webp' : fallback);

const headers = (p: StockProvider, key: string): Record<string, string> => (p === 'pexels' ? { authorization: key } : { authorization: `Client-ID ${key}`, 'accept-version': 'v1' });
const name = (p: StockProvider) => (p === 'pexels' ? 'Pexels' : 'Unsplash');

export async function stockSearch(deps: HttpDeps & { apiKey: string }, q: { provider: StockProvider; query: string; kind: 'photo' | 'video'; orientation?: 'landscape' | 'portrait' | 'square'; limit: number }): Promise<StockResult[]> {
  const o = { provider: name(q.provider), secrets: [deps.apiKey] };
  const limit = Math.min(20, Math.max(1, Math.trunc(q.limit)));
  const params = new URLSearchParams({ query: q.query, per_page: String(limit) });
  if (q.provider === 'unsplash') {
    if (q.kind === 'video') throw new ProviderError(400, 'Unsplash non offre video: usa Pexels');
    if (q.orientation) params.set('orientation', q.orientation === 'square' ? 'squarish' : q.orientation);
    type U = { results?: Array<{ id: string; width: number; height: number; user?: { name?: string }; links?: { html?: string }; urls?: { small?: string } }> };
    const r = await requestJson<U>(deps, `https://api.unsplash.com/search/photos?${params}`, { headers: headers('unsplash', deps.apiKey) }, o);
    return (r.results ?? []).map((p) => ({ id: p.id, provider: 'unsplash', kind: 'photo', width: p.width, height: p.height, durationSec: null, thumb: p.urls?.small ?? '', author: p.user?.name ?? '', pageUrl: p.links?.html ?? '' }));
  }
  if (q.orientation) params.set('orientation', q.orientation);
  if (q.kind === 'video') {
    type V = { videos?: Array<{ id: number; width: number; height: number; duration?: number; url: string; image?: string; user?: { name?: string } }> };
    const r = await requestJson<V>(deps, `https://api.pexels.com/videos/search?${params}`, { headers: headers('pexels', deps.apiKey) }, o);
    return (r.videos ?? []).map((v) => ({ id: String(v.id), provider: 'pexels', kind: 'video', width: v.width, height: v.height, durationSec: v.duration ?? null, thumb: v.image ?? '', author: v.user?.name ?? '', pageUrl: v.url }));
  }
  type P = { photos?: Array<{ id: number; width: number; height: number; url: string; photographer?: string; src?: { medium?: string } }> };
  const r = await requestJson<P>(deps, `https://api.pexels.com/v1/search?${params}`, { headers: headers('pexels', deps.apiKey) }, o);
  return (r.photos ?? []).map((p) => ({ id: String(p.id), provider: 'pexels', kind: 'photo', width: p.width, height: p.height, durationSec: null, thumb: p.src?.medium ?? '', author: p.photographer ?? '', pageUrl: p.url }));
}

export async function stockDownload(deps: HttpDeps & { apiKey: string }, d: { provider: StockProvider; id: string; kind: 'photo' | 'video' }) {
  if (!ID.test(d.id)) throw new ProviderError(400, 'Identificativo di stock non valido');
  const o = { provider: name(d.provider), secrets: [deps.apiKey] };
  const h = headers(d.provider, deps.apiKey);
  if (d.provider === 'unsplash') {
    if (d.kind === 'video') throw new ProviderError(400, 'Unsplash non offre video: usa Pexels');
    type U = { user?: { name?: string }; links?: { html?: string; download_location?: string } };
    const p = await requestJson<U>(deps, `https://api.unsplash.com/photos/${d.id}`, { headers: h }, o);
    if (!p.links?.download_location?.startsWith('https://api.unsplash.com/')) throw new ProviderError(502, 'Risposta non valida da Unsplash');
    const tracked = await requestJson<{ url?: string }>(deps, p.links.download_location, { headers: h }, o);
    if (!tracked.url?.startsWith('https://')) throw new ProviderError(502, 'Risposta non valida da Unsplash');
    const { bytes, contentType } = await requestBytes(deps, tracked.url, {}, { ...o, maxBytes: MAX });
    const author = p.user?.name ?? 'autore sconosciuto';
    return { bytes, ext: extOf(contentType, 'jpg'), author, attribution: `Foto di ${author} su Unsplash`, sourceUrl: `${p.links.html ?? 'https://unsplash.com'}?utm_source=motion_studio&utm_medium=referral` };
  }
  if (d.kind === 'video') {
    type V = { url: string; user?: { name?: string }; video_files?: Array<{ width?: number; file_type?: string; link: string }> };
    const v = await requestJson<V>(deps, `https://api.pexels.com/videos/videos/${d.id}`, { headers: h }, o);
    const mp4 = (v.video_files ?? []).filter((f) => f.file_type === 'video/mp4' && f.link.startsWith('https://'));
    const hd = mp4.filter((f) => (f.width ?? 0) <= 1920).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
      ?? mp4.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
    if (!hd) throw new ProviderError(502, 'Nessun file video scaricabile su Pexels');
    const { bytes } = await requestBytes(deps, hd.link, {}, { ...o, maxBytes: MAX });
    const author = v.user?.name ?? 'autore sconosciuto';
    return { bytes, ext: 'mp4', author, attribution: `Video di ${author} su Pexels`, sourceUrl: v.url };
  }
  type P = { url: string; photographer?: string; src?: { original?: string } };
  const p = await requestJson<P>(deps, `https://api.pexels.com/v1/photos/${d.id}`, { headers: h }, o);
  if (!p.src?.original?.startsWith('https://')) throw new ProviderError(502, 'Risposta non valida da Pexels');
  const { bytes, contentType } = await requestBytes(deps, p.src.original, {}, { ...o, maxBytes: MAX });
  const author = p.photographer ?? 'autore sconosciuto';
  return { bytes, ext: extOf(contentType, 'jpg'), author, attribution: `Foto di ${author} su Pexels`, sourceUrl: p.url };
}
```

- [ ] **Step 4: Implementa `google-fonts.ts`**

```ts
import { ProviderError, requestBytes, type HttpDeps } from './http.ts';

export interface FontFile { weight: number; italic: boolean; url: string }

export function parseFontCss(css: string): FontFile[] {
  const out: FontFile[] = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const weight = Number(block.match(/font-weight:\s*(\d+)/)?.[1] ?? 400);
    const italic = /font-style:\s*italic/.test(block);
    const url = block.match(/url\(([^)]+)\)/)?.[1]?.replace(/['"]/g, '');
    if (url?.startsWith('https://fonts.gstatic.com/')) out.push({ weight, italic, url });
  }
  return out;
}

export async function fetchGoogleFont(deps: HttpDeps, q: { family: string; weights: number[]; italic: boolean }) {
  const family = q.family.trim();
  if (!/^[A-Za-z0-9 ]{1,60}$/.test(family)) throw new ProviderError(400, 'Nome del font non valido');
  const weights = [...new Set(q.weights.length ? q.weights : [400, 700])].filter((w) => Number.isInteger(w) && w >= 100 && w <= 900 && w % 100 === 0).slice(0, 9).sort((a, b) => a - b);
  if (!weights.length) throw new ProviderError(400, 'Pesi del font non validi');
  const axis = q.italic ? `ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(';')}` : `wght@${weights.join(';')}`;
  const url = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:${axis}`;
  let css: string;
  try {
    const { bytes } = await requestBytes(deps, url, { headers: { 'user-agent': 'curl/8' } }, { provider: 'Google Fonts', secrets: [], maxBytes: 1024 * 1024 });
    css = bytes.toString('utf8');
  } catch (e) {
    if (e instanceof ProviderError && e.status === 502) throw new ProviderError(404, `Font "${family}" non trovato su Google Fonts`);
    throw e;
  }
  const files = parseFontCss(css);
  if (!files.length) throw new ProviderError(404, `Font "${family}" non trovato su Google Fonts`);
  const out: Array<{ weight: number; italic: boolean; bytes: Buffer; ext: string }> = [];
  for (const f of files) {
    const { bytes } = await requestBytes(deps, f.url, {}, { provider: 'Google Fonts', secrets: [], maxBytes: 10 * 1024 * 1024 });
    out.push({ weight: f.weight, italic: f.italic, bytes, ext: f.url.endsWith('.woff2') ? 'woff2' : 'ttf' });
  }
  return out;
}
```
(`requestBytes` maps the 400 from Google to `ProviderError(502, …)`; the catch converts it to the 404 message.)

Export both from `index.ts`.

- [ ] **Step 5: Verifica e commit**

Run: `pnpm vitest run packages/core/test/stock.test.ts packages/core/test/google-fonts.test.ts && pnpm typecheck`
```bash
git add -A
git commit -m "feat(core): Pexels/Unsplash stock with attribution and keyless Google Fonts download"
```

---

### Task 10: Strumenti dei provider nel bridge, conferma dei costi e contesto per l'agente

**Files:**
- Create: `packages/core/src/bridge/provider-tools.ts`, `packages/core/test/provider-tools.test.ts`
- Modify: `packages/core/src/server/app.ts` (passes `extraTools`), `packages/core/src/creatives/prompt.ts` (+ `CreativeContext.tools`), `packages/core/src/creatives/creative-turns.ts`, `packages/core/src/project-template.ts`, `packages/core/test/prompt.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProviderToolsDeps {
    vault: SecretsVault; approvals: ApprovalBroker; media: MediaTools;
    settings: () => Promise<WorkspaceSettings>; fetch?: typeof fetch;    // default globalThis.fetch
    broadcast: (m: ServerMessage) => void;                               // 'library' after registering assets
  }
  export function providerTools(deps: ProviderToolsDeps): Record<string, BridgeHandler>;
    // generate_image, tts, stock_search, stock_download, fonts_fetch
  export async function availableTools(vault: SecretsVault): Promise<string[]>;   // Italian lines for the prompt (see below)
  ```
  Common rules for every handler:
  - Allowed only for job kinds that list the tool in `MCP_TOOLS` (else 403 `Strumento non disponibile in questo lavoro`).
  - Missing key → 400 `Configura la chiave <Provider> nelle Impostazioni di Motion Studio`.
  - Paid tools (`generate_image` → rule `provider:openai-images`; `tts` → `provider:tts-<provider>`): when `settings.confirmPaidProviders` and the project's `PermissionsStore` does not have the rule, `approvals.request({ kind: 'provider', toolName: <rule>, input: {}, title, detail })`; anything but `once`/`always` → 403 `L'utente non ha approvato l'uso del provider`.
  - Saved files go through `saveGeneratedFile` and `LibraryStore.registerAssets` (origin `generated` for images/tts, `stock` for stock, `website` for fonts with `sourceUrl: 'https://fonts.google.com/specimen/<Family>'`), then `broadcast({ type: 'library', project })`. On any error after the provider call, nothing is registered and the saved file (if any) is removed.
  - `ProviderError` → HTTP status of the error with its message; other errors → 500 with a generic Italian message.
  - Responses:
    - `generate_image` → `{ file: 'assets/generated/<name>.png', width, height, note }` where `note` explains when the size differs from the request (`"Dimensione supportata più vicina: ridimensiona o ritaglia l'immagine se serve"`). `references` must be project-relative regular image files (png/jpg/jpeg/webp, ≤ 50 MB, real path inside the project) → else 400.
    - `tts` → `{ file: 'assets/audio/<name>.<mp3|wav>', provider, voice }`; provider default: OpenAI if configured, else ElevenLabs, else the missing-key error.
    - `stock_search` → `{ results: StockResult[] }`; `stock_download` → `{ file: 'assets/stock/<provider>-<id>.<ext>', attribution }` (asset `attribution` and `sourceUrl` set).
    - `fonts_fetch` → `{ files: ['assets/fonts/<Family>-<weight>[-italic].<ext>', …], license: 'Google Fonts: licenza OFL o Apache 2.0, uso commerciale consentito' }`.
  - `availableTools(vault)` → lines such as `- generate_image: immagini con gpt-image-2 (pronto)` / `(non configurato: la chiave OpenAI manca)`, `- tts: voce fuori campo con OpenAI o ElevenLabs (…)`, `- stock_search / stock_download: foto e video Pexels/Unsplash (…)`, `- fonts_fetch: font di Google Fonts (pronto)`, `- report_progress, validate_output, read_brand_kit (pronti)`.
- `CreativeContext` gains `tools: string[]`; `contextSections` adds, when not empty, `## Strumenti Motion Studio (MCP)` with those lines plus `Chiama report_progress all'inizio di ogni fase e validate_output prima di chiudere il turno.`. `CreativeTurnService` fills it only when the launcher has MCP active (`launcher.mcpActive()` — add this method: `Boolean(bridge.origin && mcpCommand?.length)`).
- `CONTEXT_MD` gains a short `## Strumenti Motion Studio` section saying that the tools are available only when listed in the request, that generated/downloaded files land in `assets/` and are already registered, and that stock attributions must be kept.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/provider-tools.test.ts`:
```ts
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceSettingsSchema, type ServerMessage } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approvals/broker.ts';
import { PermissionsStore } from '../src/approvals/permissions-store.ts';
import type { BridgeContext } from '../src/bridge/bridge.ts';
import { availableTools, providerTools } from '../src/bridge/provider-tools.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { MemoryVault } from '../src/secrets/vault.ts';

let projectDir: string;
let ctx: BridgeContext;
let messages: ServerMessage[];
let approvals: ApprovalBroker;
const png = Buffer.from('png-bytes');
const fakeFetch = (async (url: string) => {
  if (url.includes('/images/')) return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://fonts.googleapis.com/')) return new Response("@font-face { font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/a.ttf) format('truetype'); }", { status: 200 });
  return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'font/ttf' } });
}) as unknown as typeof fetch;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-pt è '));
  messages = [];
  approvals = new ApprovalBroker({ broadcast: () => {} });
  ctx = { jobId: 'j1', kind: 'creative', projectSlug: 'acme', projectDir, creativeSlug: 'c1', emit: () => {} };
});
const tools = (settings = {}, env = { OPENAI_API_KEY: 'sk-test' }) => providerTools({
  vault: new MemoryVault(env), approvals, media: NoMediaTools, fetch: fakeFetch, broadcast: (m) => messages.push(m),
  settings: async () => workspaceSettingsSchema.parse({ schemaVersion: 1, ...settings }),
});

describe('generate_image', () => {
  it('asks for confirmation, saves and registers the image', async () => {
    const t = tools();
    const pending = t.generate_image!(ctx, { prompt: 'Banner blu', width: 300, height: 250, name: 'banner' });
    await new Promise((r) => setTimeout(r, 20));
    const [req] = approvals.pending();
    expect(req).toMatchObject({ kind: 'provider', toolName: 'provider:openai-images' });
    await approvals.decide(req!.id, 'once');
    const out = await pending as { file: string; width: number; height: number };
    expect(out).toMatchObject({ file: 'assets/generated/banner.png', width: 880, height: 736 });
    expect((await readFile(join(projectDir, out.file))).equals(png)).toBe(true);
    expect((await new LibraryStore(projectDir, NoMediaTools).listAssets())[0]).toMatchObject({ file: 'generated/banner.png', origin: 'generated', description: 'Banner blu' });
    expect(messages).toContainEqual({ type: 'library', project: 'acme' });
  });
  it('skips the confirmation when disabled or always-allowed for the project', async () => {
    await new PermissionsStore(projectDir).add('provider:openai-images', 'x');
    await tools().generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await tools({ confirmPaidProviders: false }).generate_image!(ctx, { prompt: 'y', width: 1024, height: 1024 });
    expect(approvals.pending()).toEqual([]);
  });
  it('refuses when denied, without a key, for other job kinds and for outside references', async () => {
    const t = tools();
    const denied = t.generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024 });
    await new Promise((r) => setTimeout(r, 20));
    await approvals.decide(approvals.pending()[0]!.id, 'deny');
    expect(await denied.catch((e) => e.statusCode ?? e.status)).toBe(403);
    expect(await tools({}, {}).generate_image!(ctx, { prompt: 'x', width: 1, height: 1 }).catch((e) => e.message)).toBe('Configura la chiave OpenAI nelle Impostazioni di Motion Studio');
    expect(await tools().generate_image!({ ...ctx, kind: 'describe' }, { prompt: 'x', width: 1, height: 1 }).catch((e) => e.status)).toBe(403);
    expect(await tools({ confirmPaidProviders: false }).generate_image!(ctx, { prompt: 'x', width: 1024, height: 1024, references: ['../secret.png'] }).catch((e) => e.status)).toBe(400);
    expect(await stat(join(projectDir, 'assets', 'generated')).then((s) => s.isDirectory()).catch(() => false)).toBe(false);
  });
});

describe('fonts_fetch', () => {
  it('downloads the font into assets/fonts without a key', async () => {
    const out = await tools({}, {}).fonts_fetch!(ctx, { family: 'Manrope', weights: [400] }) as { files: string[] };
    expect(out.files).toEqual(['assets/fonts/Manrope-400.ttf']);
    expect((await new LibraryStore(projectDir, NoMediaTools).listAssets())[0]).toMatchObject({ kind: 'font', origin: 'website', sourceUrl: 'https://fonts.google.com/specimen/Manrope' });
  });
});

describe('availableTools', () => {
  it('reports configured and missing providers', async () => {
    const lines = await availableTools(new MemoryVault({ OPENAI_API_KEY: 'k' }));
    expect(lines.find((l) => l.startsWith('- generate_image'))).toContain('(pronto)');
    expect(lines.find((l) => l.startsWith('- stock_search'))).toContain('non configurato');
  });
});
```
(`await writeFile(join(projectDir, 'secret.png'), 'x')` is not needed: `../secret.png` is rejected by the path rule before any read.)

Append to `packages/core/test/prompt.test.ts` (inside the brand/codebase describe):
```ts
  it('lists the Motion Studio tools when given', () => {
    const p = buildCreativePrompt({ ...base, kind: 'first', context: { ...context, tools: ['- fonts_fetch: font di Google Fonts (pronto)'] } });
    expect(p).toContain('## Strumenti Motion Studio (MCP)');
    expect(p).toContain('validate_output prima di chiudere il turno');
  });
```
(Add `tools: []` to the existing `context` fixtures.)

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/provider-tools.test.ts packages/core/test/prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `provider-tools.ts`**

```ts
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { relativeFileSchema, type ServerMessage, type WorkspaceSettings } from '@motion-studio/shared';
import { MCP_TOOLS } from '../agent/launcher.ts';
import type { ApprovalBroker } from '../approvals/broker.ts';
import { PermissionsStore } from '../approvals/permissions-store.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { saveGeneratedFile } from '../providers/files.ts';
import { fetchGoogleFont } from '../providers/google-fonts.ts';
import { ProviderError } from '../providers/http.ts';
import { generateImage, normalizeImageSize } from '../providers/openai-images.ts';
import { stockDownload, stockSearch, type StockProvider } from '../providers/stock.ts';
import { elevenlabsSpeech, openaiSpeech } from '../providers/tts.ts';
import type { SecretsVault } from '../secrets/vault.ts';
import type { BridgeContext } from './bridge.ts';
import type { BridgeHandler } from './bridge-routes.ts';

export interface ProviderToolsDeps {
  vault: SecretsVault; approvals: ApprovalBroker; media: MediaTools;
  settings: () => Promise<WorkspaceSettings>; fetch?: typeof fetch; broadcast: (m: ServerMessage) => void;
}

const LABEL = { openai: 'OpenAI', elevenlabs: 'ElevenLabs', pexels: 'Pexels', unsplash: 'Unsplash' } as const;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const s = (v: unknown, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slug = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';

export function providerTools(deps: ProviderToolsDeps): Record<string, BridgeHandler> {
  const http = { fetch: deps.fetch ?? globalThis.fetch };
  const allowed = (c: BridgeContext, tool: string) => {
    if (!MCP_TOOLS[c.kind].includes(tool)) throw new ProviderError(403, 'Strumento non disponibile in questo lavoro');
  };
  const keyOf = async (p: keyof typeof LABEL) => {
    const k = await deps.vault.get(p);
    if (!k) throw new ProviderError(400, `Configura la chiave ${LABEL[p]} nelle Impostazioni di Motion Studio`);
    return k;
  };
  const confirmPaid = async (c: BridgeContext, rule: string, title: string, detail: string) => {
    if (!(await deps.settings()).confirmPaidProviders) return;
    if (await new PermissionsStore(c.projectDir).has(rule).catch(() => false)) return;
    const { decision } = await deps.approvals.request({ jobId: c.jobId, projectSlug: c.projectSlug, projectDir: c.projectDir, creativeSlug: c.creativeSlug, kind: 'provider', toolName: rule, input: {}, title, detail });
    if (decision !== 'once' && decision !== 'always') throw new ProviderError(403, "L'utente non ha approvato l'uso del provider");
  };
  const register = async (c: BridgeContext, files: string[], item: (f: string) => Parameters<LibraryStore['registerAssets']>[0][number]) => {
    try {
      await new LibraryStore(c.projectDir, deps.media).registerAssets(files.map(item));
    } catch (e) {
      await Promise.all(files.map((f) => rm(join(c.projectDir, 'assets', ...f.split('/')), { force: true })));
      throw e;
    }
    deps.broadcast({ type: 'library', project: c.projectSlug });
  };
  const reference = async (c: BridgeContext, rel: string) => {
    if (!relativeFileSchema.safeParse(rel).success || !IMAGE_EXT.has(extname(rel).toLowerCase())) throw new ProviderError(400, `Riferimento non valido: ${rel}`);
    const abs = join(c.projectDir, ...rel.split('/'));
    const info = await lstat(abs).catch(() => null);
    const [real, root] = await Promise.all([realpath(abs).catch(() => null), realpath(c.projectDir)]);
    if (!info?.isFile() || info.size > 50 * 1024 * 1024 || !real || !real.startsWith(root + sep)) throw new ProviderError(400, `Riferimento non valido: ${rel}`);
    return { name: rel.split('/').pop()!, bytes: await readFile(abs) };
  };

  return {
    generate_image: async (c, a) => {
      allowed(c, 'generate_image');
      const prompt = s(a.prompt, 32_000);
      if (!prompt) throw new ProviderError(400, 'Descrivi l\'immagine da generare');
      const apiKey = await keyOf('openai');
      const size = normalizeImageSize(Number(a.width), Number(a.height));
      const refs = Array.isArray(a.references) ? await Promise.all(a.references.slice(0, 16).map((r) => reference(c, String(r)))) : [];
      await confirmPaid(c, 'provider:openai-images', "Generare un'immagine con gpt-image-2", `${size.width}×${size.height}${refs.length ? `, ${refs.length} riferimenti` : ''}: ${prompt.slice(0, 300)}`);
      const img = await generateImage({ ...http, apiKey }, { prompt, width: size.width, height: size.height, quality: a.quality as never, background: a.background as never, references: refs });
      const file = await saveGeneratedFile(c.projectDir, 'generated', `${s(a.name, 60) || slug(prompt)}.png`, img.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: prompt.slice(0, 2000), tags: ['gpt-image-2'] }));
      const changed = size.width !== Number(a.width) || size.height !== Number(a.height);
      return { file: `assets/${file}`, width: img.width, height: img.height, ...(changed ? { note: "Dimensione supportata più vicina: ridimensiona o ritaglia l'immagine se serve" } : {}) };
    },
    tts: async (c, a) => {
      allowed(c, 'tts');
      const text = s(a.text, 5000);
      if (!text) throw new ProviderError(400, 'Scrivi il testo da leggere');
      const requested = a.provider === 'openai' || a.provider === 'elevenlabs' ? a.provider : null;
      const provider = requested ?? ((await deps.vault.get('openai')) ? 'openai' : (await deps.vault.get('elevenlabs')) ? 'elevenlabs' : 'openai');
      const apiKey = await keyOf(provider);
      const format = a.format === 'wav' ? 'wav' : 'mp3';
      await confirmPaid(c, `provider:tts-${provider}`, `Generare una voce con ${LABEL[provider]}`, text.slice(0, 300));
      const req = { text, voice: s(a.voice, 100) || undefined, instructions: s(a.instructions, 1000) || undefined, format } as const;
      const out = provider === 'openai' ? await openaiSpeech({ ...http, apiKey }, req) : await elevenlabsSpeech({ ...http, apiKey }, req);
      const file = await saveGeneratedFile(c.projectDir, 'audio', `${s(a.name, 60) || slug(text)}.${format}`, out.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'generated', description: text.slice(0, 2000), tags: ['voce', provider], attribution: `Voce generata con AI (${LABEL[provider]})` }));
      return { file: `assets/${file}`, provider, voice: out.voice };
    },
    stock_search: async (c, a) => {
      allowed(c, 'stock_search');
      const provider = (a.provider === 'unsplash' ? 'unsplash' : 'pexels') as StockProvider;
      const query = s(a.query, 200);
      if (!query) throw new ProviderError(400, 'Indica cosa cercare');
      const results = await stockSearch({ ...http, apiKey: await keyOf(provider) }, { provider, query, kind: a.kind === 'video' ? 'video' : 'photo', orientation: a.orientation as never, limit: Number(a.limit) || 10 });
      return { results };
    },
    stock_download: async (c, a) => {
      allowed(c, 'stock_download');
      const provider = (a.provider === 'unsplash' ? 'unsplash' : 'pexels') as StockProvider;
      const id = s(a.id, 64);
      const d = await stockDownload({ ...http, apiKey: await keyOf(provider) }, { provider, id, kind: a.kind === 'video' ? 'video' : 'photo' });
      const file = await saveGeneratedFile(c.projectDir, 'stock', `${provider}-${id}.${d.ext}`, d.bytes);
      await register(c, [file], (f) => ({ file: f, origin: 'stock', sourceUrl: d.sourceUrl, description: d.attribution, tags: ['stock', provider], attribution: d.attribution }));
      return { file: `assets/${file}`, attribution: d.attribution };
    },
    fonts_fetch: async (c, a) => {
      allowed(c, 'fonts_fetch');
      const family = s(a.family, 60);
      const weights = Array.isArray(a.weights) ? a.weights.map(Number) : [];
      const fonts = await fetchGoogleFont(http, { family, weights, italic: a.italic === true });
      const files: string[] = [];
      try {
        for (const f of fonts) files.push(await saveGeneratedFile(c.projectDir, 'fonts', `${family.replace(/ /g, '')}-${f.weight}${f.italic ? '-italic' : ''}.${f.ext}`, f.bytes));
      } catch (e) {
        await Promise.all(files.map((f) => rm(join(c.projectDir, 'assets', ...f.split('/')), { force: true })));
        throw e;
      }
      await register(c, files, (f) => ({ file: f, origin: 'website', sourceUrl: `https://fonts.google.com/specimen/${family.replace(/ /g, '+')}`, description: `Font ${family}`, tags: ['font', family] }));
      return { files: files.map((f) => `assets/${f}`), license: 'Google Fonts: licenza OFL o Apache 2.0, uso commerciale consentito' };
    },
  };
}

export async function availableTools(vault: SecretsVault): Promise<string[]> {
  const has = async (p: keyof typeof LABEL) => Boolean(await vault.get(p));
  const st = (ok: boolean, missing: string) => (ok ? '(pronto)' : `(non configurato: ${missing})`);
  const [openai, eleven, pexels, unsplash] = await Promise.all([has('openai'), has('elevenlabs'), has('pexels'), has('unsplash')]);
  return [
    `- generate_image: immagini con gpt-image-2 ${st(openai, 'la chiave OpenAI manca')}`,
    `- tts: voce fuori campo con OpenAI o ElevenLabs ${st(openai || eleven, 'nessuna chiave TTS')}`,
    `- stock_search / stock_download: foto e video da Pexels e Unsplash ${st(pexels || unsplash, 'nessuna chiave Pexels o Unsplash')}`,
    '- fonts_fetch: font di Google Fonts (pronto)',
    '- report_progress, validate_output, read_brand_kit (pronti)',
  ];
}
```
Map `ProviderError` to HTTP in `bridge-routes.ts`: wrap the handler call in try/catch → `reply.status(e.status).send({ error: e.message })` for `ProviderError`/`WorkspaceError`, else `500 { error: 'Errore interno di Motion Studio' }`. In `app.ts` pass `extraTools: providerTools({ vault, approvals, media, settings: …, broadcast })`.

- [ ] **Step 4: Prompt e contesto**

`prompt.ts`: `CreativeContext.tools: string[]`; at the end of `contextSections`:
```ts
  if (c.tools.length) out.push('', '## Strumenti Motion Studio (MCP)', ...c.tools, "Chiama report_progress all'inizio di ogni fase e validate_output prima di chiudere il turno.");
```
`creative-turns.ts`: in `buildContext`, `tools: this.deps.launcher.mcpActive() ? await availableTools(this.deps.vault) : []` (add `vault` to `CreativeTurnDeps`; the test helper passes a `MemoryVault`).
`project-template.ts` — append to `CONTEXT_MD`:
```md

## Strumenti Motion Studio
Quando la richiesta elenca gli strumenti Motion Studio (MCP) puoi usarli: generare immagini (gpt-image-2), voci fuori campo, cercare e scaricare foto/video stock, scaricare font di Google Fonts. I file finiscono in \`assets/\` e sono già registrati in \`assets/assets.json\`. Conserva l'attribuzione degli asset di stock (campo \`attribution\`). Usa \`report_progress\` per dire a che punto sei e \`validate_output\` per controllare gli output prima di chiudere il turno.
```

- [ ] **Step 5: Verifica**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): provider tools over the MCP bridge with paid-call confirmation and agent tool listing"
```

---

### Task 11: Web — Impostazioni (chiavi, sicurezza, domini) e permessi del progetto

**Files:**
- Create: `packages/web/src/screens/SettingsPage.tsx`, `packages/web/src/components/PermissionsList.tsx`, `packages/web/test/SettingsPage.test.tsx`, `packages/web/test/PermissionsList.test.tsx`
- Modify: `packages/web/src/routes.ts` (`#/settings`), `packages/web/src/api.ts`, `packages/web/src/App.tsx` (link "Impostazioni" in the topbar; theme/expert stay there), `packages/web/src/screens/ProjectSettings.tsx`

**Interfaces:**
- `Route` gains `{ name: 'settings' }` (`#/settings`), `href.settings()`.
- `api` gains: `getSecrets(): Promise<SecretStatus[]>`, `setSecret(p, value)`, `deleteSecret(p)`, `getApprovals(): Promise<ApprovalRequest[]>`, `decideApproval(id, decision)`, `getPermissions(slug)`, `deletePermission(slug, rule)`; `updateSettings` accepts the new fields.
- `<SettingsPage settings: WorkspaceSettings; checks: DoctorCheck[] | null; onSaved(next: WorkspaceSettings): void />`:
  - **Chiavi dei provider**: one row per provider (OpenAI, ElevenLabs, Pexels, Unsplash) with status (`Configurata nel portachiavi` / `Da variabile d'ambiente` / `Non configurata`), `<input type="password" autocomplete="off">` labelled `Nuova chiave <Provider>`, `Salva` (clears the field after success), `Rimuovi` (only when `source === 'keychain'`); env-managed rows show the input disabled with the hint `Gestita da <ENV_NAME>`; Google Fonts row: `Non serve una chiave`.
  - **Costi**: checkbox `Chiedi conferma prima di usare provider a pagamento` → `updateSettings({ confirmPaidProviders })`.
  - **Sicurezza**: the `sandbox` doctor check (ok → `Sandbox attiva: l'agente lavora isolato nella cartella del progetto`; else its message in `.warn`), select `Isolamento dell'agente` with `Automatico (consigliato)` / `Disattivato` (`sandboxMode`); choosing `Disattivato` shows `Senza isolamento l'agente può scrivere ovunque con i comandi consentiti.`.
  - **Rete**: list of `extraAllowedDomains` with add (`Dominio da consentire`, e.g. `api.esempio.it` or `*.esempio.it`) and remove, plus the text `Sempre consentiti: registri di pacchetti (npm, PyPI), GitHub, CDN e Google Fonts.`; server 400 errors shown in `role="alert"`.
  - **Agente**: `Modello` (text, empty = default), `Lavori in parallelo` (1–8).
- `<PermissionsList slug />` in `ProjectSettings`: heading `Permessi sempre consentiti`, rows `label` + rule (mono) + `Revoca` → `api.deletePermission`; empty state `Nessun permesso salvato: le richieste dell'agente arrivano come approvazioni.`; a corrupt file shows the API error.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/SettingsPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { workspaceSettingsSchema } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const statuses = [
  { provider: 'openai', configured: true, source: 'keychain' },
  { provider: 'elevenlabs', configured: false, source: null },
  { provider: 'pexels', configured: true, source: 'env' },
  { provider: 'unsplash', configured: false, source: null },
];
const api = {
  getSecrets: vi.fn(async () => statuses),
  setSecret: vi.fn(async () => ({ provider: 'elevenlabs', configured: true, source: 'keychain' })),
  deleteSecret: vi.fn(async () => ({ provider: 'openai', configured: false, source: null })),
  updateSettings: vi.fn(async (patch: object) => workspaceSettingsSchema.parse({ schemaVersion: 1, ...patch })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { SettingsPage } = await import('../src/screens/SettingsPage.tsx');
const settings = workspaceSettingsSchema.parse({ schemaVersion: 1 });
const checks = [{ id: 'sandbox' as const, label: 'Sandbox', ok: true, required: false, message: 'ok' }];

beforeEach(() => vi.clearAllMocks());

describe('SettingsPage', () => {
  it('shows key status without values and saves a new key', async () => {
    render(<SettingsPage settings={settings} checks={checks} onSaved={() => {}} />);
    await waitFor(() => screen.getByText('Configurata nel portachiavi'));
    expect(screen.getByText('Gestita da PEXELS_API_KEY')).toBeTruthy();
    expect((screen.getByLabelText('Nuova chiave Pexels') as HTMLInputElement).disabled).toBe(true);
    const input = screen.getByLabelText('Nuova chiave ElevenLabs') as HTMLInputElement;
    expect(input.type).toBe('password');
    await userEvent.type(input, 'xi-123');
    await userEvent.click(screen.getByRole('button', { name: 'Salva chiave ElevenLabs' }));
    await waitFor(() => expect(api.setSecret).toHaveBeenCalledWith('elevenlabs', 'xi-123'));
    expect(input.value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi chiave OpenAI' }));
    expect(api.deleteSecret).toHaveBeenCalledWith('openai');
  });
  it('updates security, costs and domains', async () => {
    const onSaved = vi.fn();
    render(<SettingsPage settings={settings} checks={checks} onSaved={onSaved} />);
    expect(screen.getByText("Sandbox attiva: l'agente lavora isolato nella cartella del progetto")).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Chiedi conferma prima di usare provider a pagamento'));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ confirmPaidProviders: false }));
    await userEvent.selectOptions(screen.getByLabelText("Isolamento dell'agente"), 'off');
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ sandboxMode: 'off' }));
    await userEvent.type(screen.getByLabelText('Dominio da consentire'), 'api.acme.io');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi dominio' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ extraAllowedDomains: ['api.acme.io'] }));
    expect(onSaved).toHaveBeenCalled();
  });
});
```

`packages/web/test/PermissionsList.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const api = {
  getPermissions: vi.fn(async () => [{ rule: 'Bash(brew:*)', label: 'Comandi "brew"', addedAt: '2026-10-08T10:00:00.000Z' }]),
  deletePermission: vi.fn(async () => ({ ok: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { PermissionsList } = await import('../src/components/PermissionsList.tsx');

describe('PermissionsList', () => {
  it('lists and revokes rules', async () => {
    render(<PermissionsList slug="acme" />);
    await waitFor(() => screen.getByText('Comandi "brew"'));
    await userEvent.click(screen.getByRole('button', { name: 'Revoca Comandi "brew"' }));
    expect(api.deletePermission).toHaveBeenCalledWith('acme', 'Bash(brew:*)');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web/test/SettingsPage.test.tsx packages/web/test/PermissionsList.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementa**

`SettingsPage.tsx` — structure (Italian copy exactly as in Interfaces; every async action wrapped with an error state rendered as `role="alert"`):
```tsx
import type { DoctorCheck, ProviderId, SecretStatus, WorkspaceSettings } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';

const PROVIDERS: Array<[ProviderId, string, string]> = [['openai', 'OpenAI', 'OPENAI_API_KEY'], ['elevenlabs', 'ElevenLabs', 'ELEVENLABS_API_KEY'], ['pexels', 'Pexels', 'PEXELS_API_KEY'], ['unsplash', 'Unsplash', 'UNSPLASH_ACCESS_KEY']];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function KeyRow({ id, label, env, status, onChange }: { id: ProviderId; label: string; env: string; status?: SecretStatus; onChange(s: SecretStatus): void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fromEnv = status?.source === 'env';
  const run = async (fn: () => Promise<SecretStatus>) => { setError(null); try { onChange(await fn()); setValue(''); } catch (e) { setError(msg(e)); } };
  return (
    <div className="row" style={{ gap: 8 }}>
      <strong style={{ width: 110 }}>{label}</strong>
      <span className={`badge ${status?.configured ? 'ok' : ''}`}>{fromEnv ? 'Da variabile d\'ambiente' : status?.configured ? 'Configurata nel portachiavi' : 'Non configurata'}</span>
      <input type="password" autoComplete="off" aria-label={`Nuova chiave ${label}`} value={value} disabled={fromEnv} onChange={(e) => setValue(e.target.value)} style={{ flex: '1 1 220px', width: 'auto' }} />
      <button type="button" aria-label={`Salva chiave ${label}`} disabled={fromEnv || !value.trim()} onClick={() => void run(() => api.setSecret(id, value))}>Salva</button>
      {status?.source === 'keychain' && <button type="button" aria-label={`Rimuovi chiave ${label}`} onClick={() => void run(() => api.deleteSecret(id))}>Rimuovi</button>}
      {fromEnv && <span className="muted" style={{ fontSize: 12 }}>Gestita da {env}</span>}
      {error && <p role="alert" className="error" style={{ margin: 0, flexBasis: '100%' }}>{error}</p>}
    </div>
  );
}

export function SettingsPage({ settings, checks, onSaved }: { settings: WorkspaceSettings; checks: DoctorCheck[] | null; onSaved(next: WorkspaceSettings): void }) {
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [domain, setDomain] = useState('');
  const [model, setModel] = useState(settings.model ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.getSecrets().then(setSecrets).catch((e: unknown) => setError(msg(e))); }, []);
  const save = async (patch: Partial<WorkspaceSettings>) => { setError(null); try { onSaved(await api.updateSettings(patch)); } catch (e) { setError(msg(e)); } };
  const sandbox = checks?.find((c) => c.id === 'sandbox');
  return (
    <main className="page stack" style={{ maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Impostazioni</h1>
      {error && <p role="alert" className="error">{error}</p>}
      <section className="card stack" aria-label="Chiavi dei provider">
        <h2 style={{ margin: 0, fontSize: 17 }}>Chiavi dei provider</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Le chiavi restano nel portachiavi del sistema: l'agente non le vede mai.</p>
        {PROVIDERS.map(([id, label, env]) => (
          <KeyRow key={id} id={id} label={label} env={env} status={secrets.find((s) => s.provider === id)} onChange={(s) => setSecrets((all) => all.map((x) => (x.provider === s.provider ? s : x)))} />
        ))}
        <div className="row" style={{ gap: 8 }}><strong style={{ width: 110 }}>Google Fonts</strong><span className="muted">Non serve una chiave</span></div>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={settings.confirmPaidProviders} onChange={(e) => void save({ confirmPaidProviders: e.target.checked })} style={{ width: 16, height: 16 }} />
          Chiedi conferma prima di usare provider a pagamento
        </label>
      </section>
      <section className="card stack" aria-label="Sicurezza">
        <h2 style={{ margin: 0, fontSize: 17 }}>Sicurezza</h2>
        {sandbox?.ok ? <p style={{ margin: 0 }}>Sandbox attiva: l'agente lavora isolato nella cartella del progetto</p> : <p className="warn" style={{ margin: 0 }}>{sandbox?.message ?? 'Stato della sandbox non disponibile'}</p>}
        <label className="row" style={{ gap: 6 }}>Isolamento dell'agente
          <select aria-label="Isolamento dell'agente" value={settings.sandboxMode} onChange={(e) => void save({ sandboxMode: e.target.value as WorkspaceSettings['sandboxMode'] })}>
            <option value="auto">Automatico (consigliato)</option>
            <option value="off">Disattivato</option>
          </select>
        </label>
        {settings.sandboxMode === 'off' && <p className="warn" style={{ margin: 0 }}>Senza isolamento l'agente può scrivere ovunque con i comandi consentiti.</p>}
      </section>
      <section className="card stack" aria-label="Rete">
        <h2 style={{ margin: 0, fontSize: 17 }}>Rete consentita all'agente</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Sempre consentiti: registri di pacchetti (npm, PyPI), GitHub, CDN e Google Fonts.</p>
        {settings.extraAllowedDomains.map((d) => (
          <div key={d} className="row" style={{ gap: 8 }}>
            <span className="mono" style={{ flex: 1 }}>{d}</span>
            <button type="button" aria-label={`Rimuovi dominio ${d}`} onClick={() => void save({ extraAllowedDomains: settings.extraAllowedDomains.filter((x) => x !== d) })}>Rimuovi</button>
          </div>
        ))}
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void save({ extraAllowedDomains: [...settings.extraAllowedDomains, domain.trim()] }).then(() => setDomain('')); }}>
          <input aria-label="Dominio da consentire" placeholder="api.esempio.it o *.esempio.it" value={domain} onChange={(e) => setDomain(e.target.value)} style={{ flex: 1, width: 'auto' }} />
          <button type="submit" disabled={!domain.trim()}>Aggiungi dominio</button>
        </form>
      </section>
      <section className="card stack" aria-label="Agente">
        <h2 style={{ margin: 0, fontSize: 17 }}>Agente</h2>
        <label className="row" style={{ gap: 6 }}>Modello
          <input value={model} placeholder="predefinito di Claude Code" onChange={(e) => setModel(e.target.value)} onBlur={() => void save({ model: model.trim() || null })} style={{ width: 240 }} />
        </label>
        <label className="row" style={{ gap: 6 }}>Lavori in parallelo
          <input type="number" min={1} max={8} value={settings.maxConcurrentJobs} onChange={(e) => void save({ maxConcurrentJobs: Number(e.target.value) })} style={{ width: 80 }} />
        </label>
      </section>
    </main>
  );
}
```
Make `save` return `true` on success and `false` on error, and clear the domain input only when it returns `true`.

`PermissionsList.tsx`: load `api.getPermissions(slug)` with `useProjectData`; rows with `Revoca` (`aria-label={`Revoca ${p.label}`}`) → `api.deletePermission(slug, p.rule)` then reload; empty state as in Interfaces. Render it at the end of `ProjectSettings`.

`App.tsx`: the topbar gets `<a href={href.settings()}>Impostazioni</a>`; route `settings` renders `<SettingsPage settings={settings} checks={checks} onSaved={(next) => { applyTheme(next.theme); setWs((p) => (p ? { ...p, settings: next } : p)); }} />`.

- [ ] **Step 4: Verifica e commit**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
```bash
git add -A
git commit -m "feat(web): settings page for provider keys, sandbox, network and project permissions"
```

---

### Task 12: Web — approvazioni, avanzamento e attribuzioni

**Files:**
- Create: `packages/web/src/components/ApprovalCard.tsx`, `packages/web/src/components/ApprovalsIndicator.tsx`, `packages/web/test/ApprovalCard.test.tsx`, `packages/web/test/ApprovalsIndicator.test.tsx`
- Modify: `packages/web/src/App.tsx` (indicator in the topbar + browser notifications), `packages/web/src/components/ConversationPanel.tsx`, `packages/web/src/screens/BrandPage.tsx`, `packages/web/src/screens/ProjectPage.tsx` (console), `packages/web/src/components/AgentConsole.tsx` (progress lines), `packages/web/src/components/StatusBadge.tsx`, `packages/web/src/screens/AssetsPage.tsx` (attribution), `packages/web/src/screens/CreativeList.tsx`

**Interfaces:**
- `<ApprovalCard approval: ApprovalRequest />`: `role="group"`, `aria-label={approval.title}`; shows title, detail (mono, pre-wrap, max 6 lines with scroll), the countdown text `Scade alle <HH:MM>`; buttons `Consenti una volta`, `Sempre per questo progetto` (only when `alwaysRule`; title attribute = the rule), `Nega` → `api.decideApproval(id, 'once' | 'always' | 'deny')`; buttons disabled while the request runs; a 404 (already handled) shows `Richiesta già gestita`. Provider approvals (`kind: 'provider'`) use the button label `Genera` instead of `Consenti una volta`.
- `<ApprovalsIndicator approvals: ApprovalRequest[] />`: hidden when empty; otherwise a button `<n> approvazioni in attesa` that toggles a popover listing each approval (title + project/creative + link to the creative `href.creative(projectSlug, creativeSlug)` or the project page) with its `ApprovalCard`.
- Placement:
  - `ConversationPanel`: approvals whose `jobId === job?.id` rendered at the top of the live progress card; while any is pending the card label is `In attesa della tua approvazione`.
  - `BrandPage` (analysis/description job) and `ProjectConsole`: approvals of their job above the progress/console.
  - `StatusBadge` gains an optional `waiting` prop: when true it renders `In attesa di approvazione` (class `warn-badge`); `CreativeList` and `CreativePage` pass `waiting` when a pending approval has that `creativeSlug`.
- `AgentConsole` simple mode renders `progress` events as `→ <text>` lines (class `muted`); expert mode `ExpertLine` handles `progress` with tag `progress`.
- Browser notifications (`App.tsx`): when a new approval arrives and `document.visibilityState === 'hidden'` and `Notification.permission === 'granted'`, show `new Notification('Motion Studio: serve la tua approvazione', { body: approval.title })`; the indicator popover has a button `Attiva le notifiche` when permission is `default` (calls `Notification.requestPermission()`); guarded with `typeof Notification !== 'undefined'`.
- `AssetsPage` detail shows `attribution` (`Attribuzione: …`) and the card tooltip includes it.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/ApprovalCard.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalRequest } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }
const api = { decideApproval: vi.fn(async () => ({})) };
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { ApprovalCard } = await import('../src/components/ApprovalCard.tsx');

const base: ApprovalRequest = { id: 'a1', jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool', title: 'Eseguire un comando', detail: 'brew install ffmpeg', toolName: 'Bash', alwaysRule: 'Bash(brew:*)', createdAt: '2026-10-08T10:00:00.000Z', expiresAt: '2026-10-08T10:10:00.000Z' };
beforeEach(() => vi.clearAllMocks());

describe('ApprovalCard', () => {
  it('sends the three decisions', async () => {
    render(<ApprovalCard approval={base} />);
    expect(screen.getByText('brew install ffmpeg')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sempre per questo progetto' }));
    expect(api.decideApproval).toHaveBeenCalledWith('a1', 'always');
  });
  it('hides "always" without a rule and labels provider approvals', () => {
    render(<ApprovalCard approval={{ ...base, kind: 'provider', alwaysRule: null, title: "Generare un'immagine con gpt-image-2" }} />);
    expect(screen.queryByRole('button', { name: 'Sempre per questo progetto' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Genera' })).toBeTruthy();
  });
  it('reports a request already handled', async () => {
    api.decideApproval.mockRejectedValueOnce(new ApiError(404, 'x'));
    render(<ApprovalCard approval={base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Nega' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Richiesta già gestita'));
  });
});
```

`packages/web/test/ApprovalsIndicator.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.ts', () => ({ api: { decideApproval: vi.fn() }, ApiError: class extends Error {} }));
const { ApprovalsIndicator } = await import('../src/components/ApprovalsIndicator.tsx');
const a = (id: string) => ({ id, jobId: 'j', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool' as const, title: `Richiesta ${id}`, detail: 'd', toolName: 'Bash', alwaysRule: null, createdAt: 'x', expiresAt: '2026-10-08T10:10:00.000Z' });

describe('ApprovalsIndicator', () => {
  it('is hidden without approvals and lists them on click', async () => {
    const { rerender, container } = render(<ApprovalsIndicator approvals={[]} />);
    expect(container.textContent).toBe('');
    rerender(<ApprovalsIndicator approvals={[a('1'), a('2')]} />);
    await userEvent.click(screen.getByRole('button', { name: '2 approvazioni in attesa' }));
    expect(screen.getAllByRole('group')).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Apri' })[0]!.getAttribute('href')).toBe('#/p/acme/c/c1');
  });
});
```

Append to `packages/web/test/AgentConsole.test.tsx`:
```tsx
  it('shows progress events in simple mode', () => {
    render(<AgentConsole job={job('running')} events={[{ kind: 'progress', text: 'Rendering 9:16' }]} expert={false} onCancel={() => {}} />);
    expect(screen.getByText('→ Rendering 9:16')).toBeTruthy();
  });
```

Append to `packages/web/test/ConversationPanel.test.tsx`:
```tsx
  it('shows pending approvals of the running job', () => {
    const approval = { id: 'a1', jobId: 'j1', projectSlug: 'acme', creativeSlug: 'c1', kind: 'tool' as const, title: 'Eseguire un comando', detail: 'brew install ffmpeg', toolName: 'Bash', alwaysRule: null, createdAt: 'x', expiresAt: '2026-10-08T10:10:00.000Z' };
    render(<ConversationPanel {...base} detail={detail()} conversation={[]} job={running} approvals={[approval]} />);
    expect(screen.getByText('In attesa della tua approvazione')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Eseguire un comando' })).toBeTruthy();
  });
```
(`ConversationPanelProps` gains `approvals: ApprovalRequest[]` — the approvals of this creative; existing tests pass `approvals={[]}` via `base`; `CreativePage` passes `Object.values(live.approvals).filter((a) => a.creativeSlug === creative && a.projectSlug === slug)`.)

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web`
Expected: FAIL.

- [ ] **Step 3: Implementa**

`ApprovalCard.tsx`:
```tsx
import type { ApprovalDecision, ApprovalRequest } from '@motion-studio/shared';
import { useState } from 'react';
import { api, ApiError } from '../api.ts';

export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (d: ApprovalDecision) => {
    setBusy(true); setError(null);
    try { await api.decideApproval(approval.id, d); }
    catch (e) { setError(e instanceof ApiError && e.status === 404 ? 'Richiesta già gestita' : e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const expires = new Date(approval.expiresAt);
  return (
    <div role="group" aria-label={approval.title} className="warn stack" style={{ gap: 8 }}>
      <strong>{approval.title}</strong>
      <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: '7.5em', overflow: 'auto' }}>{approval.detail}</pre>
      {!Number.isNaN(expires.getTime()) && <span style={{ fontSize: 12 }}>Scade alle {expires.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>}
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="primary" disabled={busy} onClick={() => void decide('once')}>{approval.kind === 'provider' ? 'Genera' : 'Consenti una volta'}</button>
        {approval.alwaysRule && <button type="button" disabled={busy} title={approval.alwaysRule} onClick={() => void decide('always')}>Sempre per questo progetto</button>}
        <button type="button" disabled={busy} onClick={() => void decide('deny')}>Nega</button>
      </div>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
```

`ApprovalsIndicator.tsx`:
```tsx
import type { ApprovalRequest } from '@motion-studio/shared';
import { useState } from 'react';
import { href } from '../routes.ts';
import { ApprovalCard } from './ApprovalCard.tsx';

export function ApprovalsIndicator({ approvals }: { approvals: ApprovalRequest[] }) {
  const [open, setOpen] = useState(false);
  if (approvals.length === 0) return null;
  const canAsk = typeof Notification !== 'undefined' && Notification.permission === 'default';
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="badge warn-badge" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {approvals.length === 1 ? '1 approvazione in attesa' : `${approvals.length} approvazioni in attesa`}
      </button>
      {open && (
        <div className="card stack" style={{ position: 'absolute', right: 0, top: '110%', width: 380, zIndex: 40 }}>
          {canAsk && <button type="button" onClick={() => void Notification.requestPermission()}>Attiva le notifiche</button>}
          {approvals.map((a) => (
            <div key={a.id} className="stack" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>{a.projectSlug}{a.creativeSlug ? ` · ${a.creativeSlug}` : ''} <a href={a.creativeSlug ? href.creative(a.projectSlug, a.creativeSlug) : href.project(a.projectSlug)}>Apri</a></span>
              <ApprovalCard approval={a} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```
(The single-approval label `1 approvazione in attesa` is grammatical Italian; the test uses two approvals.)

`App.tsx`: render `<ApprovalsIndicator approvals={Object.values(live.approvals)} />` in the topbar; a `useEffect` on `live.approvals` keeps a `useRef<Set<string>>` of notified ids and fires the browser notification for new ones when the tab is hidden and permission is granted.

`AgentConsole.tsx`: in `SimpleLine` add `if (e.kind === 'progress') return <p className="muted" style={{ margin: 0 }}>→ {e.text}</p>;`; in `ExpertLine` add `case 'progress': return <div>{tag('progress')}{e.text}</div>;`.

`ConversationPanel.tsx`: new prop `approvals`; in the live card, before the progress lines, render `{props.approvals.filter((a) => a.jobId === active.id).map((a) => <ApprovalCard key={a.id} approval={a} />)}` and change the badge text to `In attesa della tua approvazione` when that list is not empty. Render `progress` events of `liveEvents` as `→ <text>` lines (same as text lines).

`StatusBadge.tsx`: `export function StatusBadge({ status, waiting }: { status: CreativeStatus; waiting?: boolean })` → when `waiting`, `<span className="badge warn-badge">In attesa di approvazione</span>`.

`BrandPage`/`ProjectConsole`: show `ApprovalCard`s for approvals whose `jobId` is the job they display.

`AssetsPage`: in `Detail`, under the origin line, `{asset.attribution && <span style={{ fontSize: 13 }}>Attribuzione: {asset.attribution}</span>}`; card `title={asset.attribution ?? undefined}`.

- [ ] **Step 4: Verifica e commit**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
```bash
git add -A
git commit -m "feat(web): approval cards, global approvals indicator with notifications, progress lines and attributions"
```

---

### Task 13: README, sicurezza e Doctor in UI

**Files:**
- Modify: `README.md`, `packages/web/src/screens/Onboarding.tsx` (the sandbox check is optional: shown with the `Consigliato` badge like ffmpeg)

- [ ] **Step 1: README**

Update the status line to `> Stato: fase 4 (sandbox, strumenti MCP, provider e approvazioni).` Replace the "Sicurezza nella fase 2" section and the analysis warnings with:
```markdown
## Sicurezza
- **Sandbox dell'agente** (macOS; Linux con `bubblewrap` e `socat`): ogni lavoro dell'agente gira isolato. Può scrivere solo nella cartella del progetto, non può leggere cartelle sensibili (`~/.ssh`, credenziali cloud, portachiavi, configurazione di Motion Studio) e usa la rete solo verso registri di pacchetti, CDN e i domini che aggiungi in **Impostazioni → Rete** (l'analisi brand può raggiungere qualsiasi sito, la descrizione degli asset nessuno).
- **Codebase collegate**: leggibili, mai scrivibili (anche dagli interpreti, grazie alla sandbox); Motion Studio segnala comunque se una codebase git cambia durante un turno.
- **Approvazioni**: tutto ciò che esce dal perimetro (es. installare un programma, scrivere fuori dal progetto) compare come richiesta nella pagina del lavoro e in alto a destra: *Consenti una volta*, *Sempre per questo progetto* (revocabile in Impostazioni del progetto) o *Nega*. Senza risposta entro 10 minuti la richiesta viene negata.
- **Chiavi API**: nel portachiavi del sistema (o nelle variabili d'ambiente `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`); l'agente non le vede mai: gli strumenti MCP chiedono a Motion Studio di chiamare i provider.
- **Costi**: generazioni di immagini e voci chiedono conferma prima di ogni chiamata (disattivabile in Impostazioni).
- **Senza sandbox** (Windows, Linux senza bubblewrap, o isolamento disattivato): Motion Studio usa l'elenco ristretto di comandi della fase precedente e lo segnala nel Doctor.

## Provider
| Strumento | Provider | Chiave |
|---|---|---|
| Immagini | OpenAI gpt-image-2 | `OPENAI_API_KEY` |
| Voce fuori campo | OpenAI TTS, ElevenLabs | `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` |
| Foto e video stock | Pexels, Unsplash | `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` |
| Font | Google Fonts | nessuna |

Gli asset di stock conservano l'attribuzione richiesta da Pexels e Unsplash (campo `attribution` in `assets/assets.json`).
```
Keep the "Limiti" line updated: `App desktop, export in cartella scelta e pacchetti firmati arrivano nella fase 5.`

- [ ] **Step 2: Onboarding**

The onboarding already renders optional checks with the `Consigliato` badge; verify the `sandbox` check appears there with its message and fix text, and that it never blocks (it is `required: false`). Add a test in `packages/web/test/App.test.tsx` that a failing sandbox check does not show the onboarding when the other checks pass.

- [ ] **Step 3: Verifica e commit**

Run: `pnpm test && pnpm typecheck && pnpm build`
```bash
git add -A
git commit -m "docs: security model, providers and approvals (phase 4)"
```

---

### Task 14: Verifica end-to-end con il vero Claude Code

**Files:** nessuno (solo verifica; eventuali correzioni con test e commit dedicati).

- [ ] **Step 1: Controlli automatici**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: tutto verde.

- [ ] **Step 2: Avvio reale**

`MOTION_STUDIO_CONFIG_DIR="$(mktemp -d)" node apps/cli/dist/main.js --port 4398 --no-open` (questo avvia anche il server MCP dal bundle). Via curl: workspace temporaneo, progetto "Prova Sandbox", `GET /api/doctor` mostra `sandbox` ok (macOS).

- [ ] **Step 3: Sandbox nelle creatività**

Creatività con formato `web-banner-300x250`, brief breve, `generate: true`. Verifica:
1. gli argomenti reali del turno (registrali con un wrapper di `claude` nello scratchpad, come in fase 3) contengono `--settings` con `sandbox.enabled`, `denyRead` con `~/.ssh`, `--mcp-config` con il server `studio` e `--permission-prompt-tool mcp__studio__approve`;
2. la versione arriva a `complete` (il render funziona dentro la sandbox, senza allow-list di comandi);
3. nella conversazione compaiono eventi `progress` se l'agente usa `report_progress`.

- [ ] **Step 4: Approvazioni dal vivo**

Turno di iterazione: "Scrivi anche una copia del banner in /Users/Shared/ms-test-banner.png". Deve comparire un'approvazione (`GET /api/approvals`) per una scrittura fuori dal progetto: negala con `POST /api/approvals/<id> {"decision":"deny"}` e verifica che il file non esista e che l'agente riporti il diniego. Ripeti con un comando fuori sandbox se l'agente lo propone. Verifica anche che, annullando il job mentre un'approvazione è in sospeso, la richiesta sparisca da `/api/approvals` (la scadenza a 10 minuti è coperta dai test automatici).

- [ ] **Step 5: Strumenti MCP**

1. `fonts_fetch` (nessuna chiave): turno "Scarica il font Manrope 400 e 700 con lo strumento fonts_fetch e usalo nel banner" → file in `assets/fonts/`, registrati in `assets.json` con `sourceUrl` di Google Fonts.
2. Se `OPENAI_API_KEY` è nell'ambiente (non leggerne il valore, solo la presenza): `generate_image` con conferma (`Genera`) → file in `assets/generated/`; altrimenti verifica che l'agente riceva il messaggio "Configura la chiave OpenAI…".
3. Se `PEXELS_API_KEY` o `UNSPLASH_ACCESS_KEY` sono presenti: `stock_search` + `stock_download` con attribuzione; altrimenti annota "non verificato per assenza di chiave".

- [ ] **Step 6: Analisi brand nella sandbox**

Analisi di `https://www.python.org` (rete aperta solo per l'analisi): proposta `open` con colori e loghi; verifica negli argomenti `allowedDomains: ["*"]` e `autoAllowBashIfSandboxed: false`.

- [ ] **Step 7: Rapporto**

Annota tempi, costi stimati, esiti, eventuali differenze tra documentazione e comportamento reale (es. formato degli argomenti del permission prompt), e cosa non è stato verificabile per mancanza di chiavi. I controlli visivi (Impostazioni, approvazioni nella UI, notifiche del browser) restano all'utente.
