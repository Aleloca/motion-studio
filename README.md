# Motion Studio

App locale e open-source per creare video in motion graphics e immagini usando il tuo agente di coding (inizialmente **Claude Code**). Tutto resta sul tuo computer: i progetti sono cartelle con file JSON/Markdown versionate con git.

> Stato: fase 3 (brand, asset e codebase collegate). Vedi `docs/superpowers/specs/` per il design completo.

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

## Come funziona una creatività
1. In un progetto apri **Creatività → + Nuova creatività**, descrivi cosa vuoi, scegli canali e formati e premi **Genera**.
2. L'agente lavora in `creatives/<data-titolo>/work/` e consegna in `outputs/vN/` un file per formato più `manifest.json`.
3. Motion Studio controlla gli output (presenza, risoluzione, durata; con ffmpeg/ffprobe installati li verifica davvero): se qualcosa non torna chiede all'agente di correggere, fino a 3 tentativi; poi salva la versione, anche se incompleta.
4. Ogni versione è un commit git del progetto. Dalla pagina della creatività puoi aprire un formato, aggiungere commenti su un punto/istante, chiedere modifiche, confrontare versioni e ripartire da una versione precedente.

Limiti attuali: brand kit, asset e codebase collegate arrivano nella fase 3; approvazioni dalla UI, tool MCP e rigenerazione automatica col comando del manifest nella fase 4; app desktop ed export in cartella scelta nella fase 5.

## Sicurezza nella fase 2
- **Turni delle creatività:** l'agente può eseguire senza chiedere conferma `node`, `python3`, `npm`/`npx`/`pnpm`, `pip`/`pip3`, `ffmpeg`/`ffprobe` e `mkdir`/`cp`/`mv`, oltre a modificare i file del progetto. Queste regole non lo confinano nella cartella del progetto: i comandi ammessi possono leggere e scrivere ovunque l'utente possa farlo. Tutti gli altri comandi vengono rifiutati.
- **Approvazioni:** le richieste di permesso dall'interfaccia arrivano nella fase 4; fino ad allora usa Motion Studio solo con progetti e brief di cui ti fidi.
- **Output non verificati:** senza ffmpeg/ffprobe installati Motion Studio non può controllare davvero risoluzione e durata, e mostra gli output come "non verificati".

## Brand, asset e codebase collegate
- **Brand**: palette, font, loghi, tono, cose da fare e da evitare, stile fotografico; ogni voce mostra da dove arriva (manuale, sito, immagine). Le linee guida discorsive sono in `brand/guidelines.md`.
- **Analisi brand**: aggiungi uno o più siti (e le immagini di riferimento con "Usa per l'analisi brand") e premi **Analizza brand**. L'agente visita i siti, scarica gli asset utili in `assets/` e propone modifiche: le applichi voce per voce, le voci inserite a mano non vengono mai rimosse.
- **Asset e riferimenti**: carica file trascinandoli, filtra per tipo e origine, aggiungi descrizioni e tag (anche con **Descrivi con l'agente**).
- **Codebase collegate** (Impostazioni del progetto o della singola creatività): cartelle del tuo computer che l'agente può leggere ma non modificare (regole di sola lettura su ogni turno; se una cartella è un repository git e risulta modificata dopo un turno, la conversazione lo segnala).

Limite attuale: le regole bloccano gli strumenti di modifica dell'agente, ma gli interpreti che l'agente può usare (per esempio node o python) potrebbero comunque scrivere nella cartella. Motion Studio rileva e segnala le modifiche solo nelle cartelle che sono repository git; per le altre le modifiche non verrebbero rilevate. Collega preferibilmente repository git con le modifiche già committate.

Sicurezza: durante l'analisi brand l'agente può anche usare `WebFetch` e `curl` per scaricare i file dai siti indicati.

## Limiti attuali dell'agente
- **Console del progetto:** i turni girano con `--permission-mode acceptEdits`, quindi l'agente può modificare i file nella cartella del progetto senza chiedere conferma (le richieste che richiederebbero un'approvazione vengono rifiutate). Le approvazioni dall'interfaccia arrivano nella fase 4.

## Sviluppo
```bash
pnpm dev                  # core (tsx watch, porta 4317) + web (Vite, porta 5173 con proxy /api)
pnpm test                 # tutti i test (usano un finto `claude`, nessun consumo di quota)
npx vitest run packages/core/test/server.test.ts   # un singolo file (dalla radice del repository)
pnpm typecheck
```

Variabili utili:
- `MOTION_STUDIO_CONFIG_DIR` — dove salvare la config dell'app (percorso del workspace).
- `MOTION_STUDIO_CLAUDE_COMMAND` — comando dell'agente come array JSON, es. `["node","/percorso/fake-claude.mjs"]`.

## Licenza
MIT
