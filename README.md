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
pnpm motion-studio        # build + avvio su http://127.0.0.1:4317 e apertura del browser
```

Opzioni del launcher (dopo il nome dello script, es. `pnpm motion-studio --port 5000 --no-open`):
- `--port <n>` — porta del server locale (1–65535, predefinita 4317).
- `--no-open` — non aprire il browser (se l'apertura non riesce, il launcher stampa l'indirizzo da aprire a mano).

> Il pacchetto non è ancora pubblicato su npm: `npx motion-studio` non funziona ancora, usa `pnpm motion-studio` dal repository.

## Limiti della fase 1
- **Permessi dell'agente:** i turni girano con `--permission-mode acceptEdits`, quindi l'agente può modificare i file nella cartella del progetto senza chiedere conferma (le richieste che richiederebbero un'approvazione vengono rifiutate). Le approvazioni dall'interfaccia arrivano nella fase 4.
- **Codebase collegate:** le `linkedCodebases` di `project.json` vengono ignorate; la fase 3 le renderà disponibili all'agente in sola lettura.

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
