# Backend dell'agente

Motion Studio non parla con un agente in modo diretto: passa da un contratto neutro (`AgentRunner`), così il primo backend (Claude Code) non è l'unico possibile. Questa guida descrive il contratto com'è oggi.

## AgentRunner (`packages/core/src/agent/runner.ts`)

```ts
interface AgentRunner { start(req: AgentTurnRequest, onEvent: (e: AgentEvent) => void): AgentRun }
interface AgentRun { done: Promise<AgentRunResult>; cancel(): void }
interface AgentRunResult { status: 'succeeded' | 'failed' | 'cancelled'; sessionId?: string; error?: string }
```

`AgentTurnRequest` descrive un turno: `cwd`, `prompt`, `resumeSessionId` (e `forkSession` per ripartire da una sessione passata), `addDirs` (cartelle in sola lettura), `model`, `settings` (sandbox), `mcpConfigPath` (file privato con il server MCP `studio`), `permissionPromptTool`, `env` e `unsetEnv` (variabili tolte), `allowedTools` e `disallowedTools` (regole di permesso). Un runner deve: avviare il turno, emettere eventi normalizzati man mano, risolvere `done` una sola volta, e fermare davvero il processo e i suoi discendenti su `cancel()`.

## Eventi normalizzati (`AgentEvent`, `packages/shared/src/events.ts`)
`session` (id sessione, modello), `text`, `tool_use`, `tool_result`, `rate_limit`, `progress` (da `report_progress`), `stderr`, `parse_error`, `result` (`ok`, `sessionId`, `text`, `costUsd`, `error`). L'interfaccia e il registro della conversazione conoscono solo questi eventi. `ClaudeCodeRunner` li ricava dal flusso `stream-json` di Claude Code con `claude-stream-parser.ts` (righe non valide diventano `parse_error`, mai eccezioni).

## ClaudeCodeRunner (`claude-code-runner.ts`)
Avvia `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode acceptEdits` nella cartella del progetto, con il prompt su stdin e gli argomenti costruiti da `buildClaudeArgs` (`--resume`/`--fork-session`, `--add-dir`, `--model`, `--settings`, `--strict-mcp-config --mcp-config`, `--permission-prompt-tool`, `--disallowedTools`, `--allowedTools`). Su POSIX il processo ha un proprio gruppo, e `cancel()` manda SIGTERM poi SIGKILL a tutto il gruppo. Il comando è `claude` o quello in `MOTION_STUDIO_CLAUDE_COMMAND` (array JSON, usato dai test per il finto `claude`).

## AgentLauncher (`launcher.ts`) e policy (`policy.ts`)
L'`AgentLauncher` è l'unico punto in cui parte un agente. Per ogni lavoro (`creative`, `console`, `brand-analysis`, `describe`):
1. legge le impostazioni e decide se usare la sandbox (`sandboxMode === 'auto'` e `detectSandbox()` disponibile: macOS `sandbox-exec`, Linux `bubblewrap` + `socat`);
2. carica le regole "Sempre per questo progetto" da `.studio/permissions.json`, accettando solo i formati che l'interfaccia può produrre (`isAllowedRule`);
3. calcola con `buildAgentPolicy` le impostazioni di sandbox (cartelle sensibili non leggibili, codebase collegate e file di configurazione non scrivibili, domini di rete ammessi solo per creatività e console), le regole consentite e negate;
4. registra il lavoro nel bridge, scrive in `<configDir>/run/` (0700) un file di token e la configurazione MCP (0600; il token non passa mai da argv o ambiente);
5. avvia il runner con `unsetEnv` = chiavi dei provider e token del bridge, e al termine o su annullamento revoca il token, annulla le approvazioni pendenti e cancella i file.

Gli strumenti MCP disponibili per tipo di lavoro sono in `MCP_TOOLS`. I permessi che escono dal perimetro arrivano all'interfaccia tramite lo strumento `approve` (`--permission-prompt-tool`).

## Cosa servirebbe per un CodexRunner
Il principio è che nulla fuori da `agent/` sappia quale agente c'è dietro. Un `CodexRunner` dovrebbe:
- implementare `AgentRunner` traducendo gli eventi dell'altro agente negli `AgentEvent` sopra (incluso `result` con la sessione da riprendere) e restituendo `AgentRunResult` con le stesse regole (un `result` ok vince su un annullamento successivo);
- tradurre `AgentTurnRequest` negli strumenti dell'altro agente: sessioni riprendibili e fork, cartelle aggiuntive, collegamento del server MCP `studio` (stessa configurazione e stessi strumenti), regole di permesso allow/deny e un modo per delegare le richieste di approvazione a `approve`;
- offrire un isolamento equivalente: la policy oggi produce impostazioni specifiche di Claude Code (`settings.sandbox`, regole `Edit(...)`/`Read(...)`); un altro backend o riusa un livello di sandbox del sistema operativo o va dichiarato senza sandbox (il Doctor e le Impostazioni lo segnalano);
- passare dal launcher (token, file privati, `unsetEnv`) e non avviare mai il processo direttamente;
- aggiungere un test con un finto eseguibile, come `packages/core/test/fixtures/fake-claude.mjs`, e un controllo nel Doctor (`doctor.ts`).

Non esiste ancora una scelta del backend nelle Impostazioni: `startServer` crea `ClaudeCodeRunner` direttamente, quindi un secondo backend richiede anche quel collegamento.
