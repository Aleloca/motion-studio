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
