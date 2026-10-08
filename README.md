# Motion Studio

App locale e open-source per creare video in motion graphics e immagini usando il tuo agente di coding (inizialmente **Claude Code**). Tutto resta sul tuo computer: i progetti sono cartelle con file JSON/Markdown versionate con git.

> Stato: fase 4 (sandbox, strumenti MCP, provider e approvazioni). Vedi `docs/superpowers/specs/` per il design completo.

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
- `--print-url` — stampa l'indirizzo del Motion Studio già avviato, senza avviarne un altro (utile se hai chiuso la scheda).

L'indirizzo stampato all'avvio contiene un codice di accesso (`#t=…`): apri Motion Studio da quel link. Il browser lo ricorda; se l'interfaccia chiede di riaprirla dal link del terminale, usa `--print-url`.

> Dal pacchetto npm: `npx motion-studio-app` (il comando installato si chiama `motion-studio`). Finché il pacchetto non è pubblicato su npm, usa `pnpm motion-studio` dal repository.

## Come funziona una creatività
1. In un progetto apri **Creatività → + Nuova creatività**, descrivi cosa vuoi, scegli canali e formati e premi **Genera**.
2. L'agente lavora in `creatives/<data-titolo>/work/` e consegna in `outputs/vN/` un file per formato più `manifest.json`.
3. Motion Studio controlla gli output (presenza, risoluzione, durata; con ffmpeg/ffprobe installati li verifica davvero): se qualcosa non torna chiede all'agente di correggere, fino a 3 tentativi; poi salva la versione, anche se incompleta.
4. Ogni versione è un commit git del progetto. Dalla pagina della creatività puoi aprire un formato, aggiungere commenti su un punto/istante, chiedere modifiche, confrontare versioni e ripartire da una versione precedente.

Limiti attuali: la rigenerazione col comando del manifest (quando cambiano solo i formati) non è ancora disponibile, quindi Motion Studio chiede sempre all'agente; app desktop, export in cartella scelta e pacchetti firmati arrivano nella fase 5.

## Sicurezza
- **Sandbox dell'agente** (macOS; Linux con `bubblewrap` e `socat`): ogni lavoro dell'agente gira isolato. Può scrivere solo nella cartella del progetto, non può leggere cartelle sensibili (`~/.ssh`, credenziali cloud, portachiavi, configurazione di Motion Studio). La rete dipende dal lavoro: creatività e console usano solo registri di pacchetti, CDN e i domini che aggiungi in **Impostazioni → Rete**; l'analisi brand non ha rete nella sandbox: legge le pagine con `WebFetch` e scarica loghi e font solo con lo strumento `download_file` di Motion Studio, che blocca gli indirizzi privati o locali (controllati sull'IP risolto, a ogni redirect); la descrizione degli asset non ha rete. La sandbox non ripiega sull'esecuzione libera: se non riesce ad avviarsi i comandi non partono, e l'agente non può chiedere di eseguire un comando fuori da essa.
- **File che configurano Motion Studio e l'agente**: in ogni lavoro, con o senza sandbox, l'agente non può modificare `.git/`, `.claude/`, `.studio/`, `CLAUDE.md`, `CLAUDE.local.md` e `.mcp.json` del progetto; Motion Studio esegue git senza hook del progetto.
- **Codebase collegate**: leggibili, mai scrivibili (anche dagli interpreti, grazie alla sandbox); Motion Studio segnala comunque se una codebase git cambia durante un turno.
- **Approvazioni**: tutto ciò che esce dal perimetro (es. installare un programma, scrivere fuori dal progetto) compare come richiesta nella pagina del lavoro e in alto a destra: *Consenti una volta*, *Sempre per questo progetto* (revocabile in Impostazioni del progetto) o *Nega*. "Sempre per questo progetto" è offerto solo per una breve lista di comandi sicuri (`ls`, `mkdir`, `ffprobe`, ottimizzatori di immagini), per cartelle fuori dalle posizioni sensibili e dal workspace, per domini web e per i provider a pagamento; gli altri comandi si approvano una volta per volta. Le regole stanno in `<progetto>/.studio/permissions.json`, protetto dall'agente. Senza risposta entro 10 minuti la richiesta viene negata.
- **Chiavi API**: nel portachiavi del sistema (o nelle variabili d'ambiente `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`); l'agente non le vede mai: le variabili delle chiavi vengono tolte dall'ambiente dell'agente (e del suo server MCP) e gli strumenti MCP chiedono a Motion Studio di chiamare i provider.
- **Costi**: generazioni di immagini e voci chiedono conferma prima di ogni chiamata (disattivabile in Impostazioni).
- **Codice di accesso dell'interfaccia**: le API di Motion Studio rispondono solo all'interfaccia aperta dal link del terminale (il codice sta in `ui-token` nella cartella di configurazione). È una difesa contro richieste locali estranee, per esempio pagine web aperte nel browser o programmi che non conoscono il codice; non è una barriera contro un processo dello stesso utente che può leggere la cartella di configurazione.
- **Senza sandbox** (Windows, Linux senza bubblewrap, o isolamento disattivato): Motion Studio usa l'elenco ristretto di comandi della fase precedente e lo segnala nel Doctor e nelle Impostazioni. Senza sandbox i comandi consentiti (node, python, npm/npx, pip, ffmpeg) possono leggere e scrivere ovunque e contattare Motion Studio stesso: usa la sandbox. In particolare un interprete avviato dall'agente potrebbe modificare `.studio/permissions.json`: Motion Studio accetta solo regole nei formati che "Sempre per questo progetto" può produrre (comandi sicuri, cartelle fuori dalle posizioni sensibili e dal workspace, domini web, conferme dei provider), quindi l'agente potrebbe concedersi quei permessi o saltare la conferma di costo di un provider, ma non andare oltre quei limiti.
- **Output non verificati:** senza ffmpeg/ffprobe installati Motion Studio non può controllare davvero risoluzione e durata, e mostra gli output come "non verificati".

## Provider
| Strumento | Provider | Chiave |
|---|---|---|
| Immagini | OpenAI gpt-image-2 | `OPENAI_API_KEY` |
| Voce fuori campo | OpenAI TTS, ElevenLabs | `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` |
| Foto e video stock | Pexels, Unsplash | `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` |
| Font | Google Fonts | nessuna |

Gli asset di stock conservano l'attribuzione richiesta da Pexels e Unsplash (campo `attribution` in `assets/assets.json`).

## Brand, asset e codebase collegate
- **Brand**: palette, font, loghi, tono, cose da fare e da evitare, stile fotografico; ogni voce mostra da dove arriva (manuale, sito, immagine). Le linee guida discorsive sono in `brand/guidelines.md`.
- **Analisi brand**: aggiungi uno o più siti (e le immagini di riferimento con "Usa per l'analisi brand") e premi **Analizza brand**. L'agente visita i siti, scarica gli asset utili in `assets/` e propone modifiche: le applichi voce per voce, le voci inserite a mano non vengono mai rimosse. L'agente lavora su copie: brand kit, linee guida, sorgenti e metadati di asset e riferimenti non possono essere modificati dagli strumenti di modifica e, se l'agente li cambia comunque, Motion Studio annulla la modifica e lo segnala.
- **Asset e riferimenti**: carica file trascinandoli, filtra per tipo e origine, aggiungi descrizioni e tag (anche con **Descrivi con l'agente**).
- **Codebase collegate** (Impostazioni del progetto o della singola creatività): cartelle del tuo computer che l'agente può leggere; gli strumenti di modifica sono bloccati su ogni turno e, se una cartella è un repository git e risulta modificata dopo un turno, la conversazione lo segnala. Non puoi collegare la cartella del progetto o del workspace, una cartella che le contiene né una cartella al loro interno.

Con la sandbox attiva gli interpreti non possono scrivere nelle codebase collegate. Senza sandbox le regole bloccano solo gli strumenti di modifica dell'agente: gli interpreti (per esempio node o python) potrebbero comunque scrivere nella cartella. Motion Studio rileva e segnala le modifiche solo nelle cartelle che sono repository git; per le altre le modifiche non verrebbero rilevate. Collega preferibilmente repository git con le modifiche già committate.

Consiglio generale: analizza solo siti di cui ti fidi.

## Limiti attuali dell'agente
- **Console del progetto:** con la sandbox attiva i comandi girano isolati; fuori dalla sandbox l'agente può modificare i file del progetto, ma le richieste che richiedono un'approvazione compaiono nell'interfaccia (vedi Sicurezza).

## Sviluppo
```bash
pnpm dev                  # core (tsx watch, porta 4317) + web (Vite, porta 5173 con proxy /api); il core stampa il link con il codice di accesso
pnpm test                 # tutti i test (usano un finto `claude`, nessun consumo di quota)
npx vitest run packages/core/test/server.test.ts   # un singolo file (dalla radice del repository)
pnpm typecheck
```

Variabili utili:
- `MOTION_STUDIO_CONFIG_DIR` — dove salvare la config dell'app (percorso del workspace).
- `MOTION_STUDIO_CLAUDE_COMMAND` — comando dell'agente come array JSON, es. `["node","/percorso/fake-claude.mjs"]`.

## Licenza
MIT
