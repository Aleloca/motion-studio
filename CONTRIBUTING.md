# Contribuire a Motion Studio

Grazie dell'interesse! Questa guida spiega come preparare l'ambiente e cosa ci aspettiamo da una modifica.

## Setup
Servono Node.js 22+ (la CI usa 24), pnpm, Git e FFmpeg (alcuni test lo usano). Non serve Claude Code per i test.

```bash
pnpm install
pnpm test        # tutti i test
pnpm typecheck
pnpm dev         # core (porta 4317) + web (Vite, 5173)
```

Un singolo file: `npx vitest run packages/core/test/export.test.ts`. I test che usano ffmpeg hanno `{ timeout: 20_000 }`.

## Mappa del monorepo
- `packages/shared` — tipi e schemi zod condivisi (manifest, eventi, impostazioni, catalogo formati).
- `packages/core` — il server Fastify e tutta la logica: progetti e creatività, agente (runner, launcher, policy, sandbox), approvazioni, bridge MCP, provider, esportazione.
- `packages/web` — l'interfaccia (React + Vite).
- `packages/mcp-studio` — il server MCP `studio` (stdio) che l'agente usa per parlare con il core.
- `apps/cli` — il pacchetto npm `motion-studio-app` (bundle con tsup che include la web app).
- `apps/desktop` — l'app Electron, che esegue il core nello stesso processo.

Altre guide: [contratto di output](docs/output-contract.md), [provider](docs/providers.md), [backend dell'agente](docs/agent-backends.md); il design è in `docs/superpowers/specs/`.

## Come lavoriamo
- **TDD**: scrivi prima il test che fallisce, poi il codice che lo fa passare. Una correzione di bug parte da un test che riproduce il bug. Esegui il test mirato mentre sviluppi e l'intera suite (`pnpm test && pnpm typecheck`) prima di aprire la pull request.
- **Mai il vero `claude` nei test**: usa il finto agente `packages/core/test/fixtures/fake-claude.mjs` (scenario con `FAKE_CLAUDE_SCENARIO`, comando con `MOTION_STUDIO_CLAUDE_COMMAND`). Non toccare il vero portachiavi: usa `MemoryVault`. Nessuna chiamata di rete reale: i provider si testano con un `fetch` iniettato.
- **Nessun segreto nei test** né nei commit: usa chiavi finte, mai chiavi vere.
- **Convenzioni**: testi dell'interfaccia e dell'agente in italiano; nell'interfaccia solo token CSS (nessun colore fisso); i file JSON hanno `schemaVersion: 1` e un JSON corrotto non viene mai riscritto; il server accetta solo Host e Origin di loopback.
- **Commit**: messaggi in inglese nello stile Conventional Commits (`feat(core): …`, `fix(web): …`, `docs: …`, `build(desktop): …`, `ci: …`), un cambiamento coerente per commit. Non committare `dist/`, `release/`, `resources/` né i `.tgz`.
- **Sicurezza**: una modifica a sandbox, policy, bridge o provider va accompagnata da un test e, se cambia cosa è consentito, dall'aggiornamento della sezione Sicurezza del README.

## Rilasci
Vedi la sezione *Rilascio* del README (tag `vX.Y.Z`, segreti del workflow).

Per creare il pacchetto npm serve Node ≥ 22.18 (prepack in TypeScript).
