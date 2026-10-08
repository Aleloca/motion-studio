# Motion Studio

App locale e open-source per creare video in motion graphics e immagini usando il tuo agente di coding (inizialmente **Claude Code**). Descrivi cosa vuoi, scegli canali e formati: l'agente produce una ricomposizione dedicata per ogni formato. Tutto resta sul tuo computer: i progetti sono cartelle con file JSON/Markdown versionate con git.

<!-- screenshot: aggiungere -->

> Il design completo è in `docs/superpowers/specs/`. Guide per chi sviluppa: [CONTRIBUTING.md](CONTRIBUTING.md), [contratto di output](docs/output-contract.md), [provider](docs/providers.md), [backend dell'agente](docs/agent-backends.md).

## Installazione

**App desktop (Electron).** Scarica l'installer dalla pagina *Releases* di GitHub del progetto, quando sarà pubblicato. Le build non firmate (quelle senza i certificati dei maintainer) richiedono un passaggio in più la prima volta:
- macOS: clic destro sull'app, poi **Apri** (e conferma); un doppio clic normale viene bloccato da Gatekeeper.
- Gli aggiornamenti automatici dell'app (controllo all'avvio, installazione al riavvio) richiedono build **firmate** su macOS; con una build non firmata aggiorna scaricando a mano la nuova versione.

**Da npm.** `npx motion-studio-app` (il comando installato si chiama `motion-studio`), quando sarà pubblicato. Finché non lo è, usa i sorgenti.

**Dai sorgenti.**
```bash
pnpm install
pnpm motion-studio        # build + avvio su http://127.0.0.1:4317 e apertura del browser
```

Opzioni del launcher (dopo il nome dello script, es. `pnpm motion-studio --port 5000 --no-open`):
- `--port <n>` — porta del server locale (1–65535, predefinita 4317).
- `--no-open` — non aprire il browser (se l'apertura non riesce, il launcher stampa l'indirizzo da aprire a mano).
- `--print-url` — stampa l'indirizzo del Motion Studio già avviato, senza avviarne un altro (utile se hai chiuso la scheda).

L'indirizzo stampato all'avvio contiene un codice di accesso (`#t=…`): apri Motion Studio da quel link. Il browser lo ricorda; se l'interfaccia chiede di riaprirla dal link del terminale, usa `--print-url`. L'app desktop apre da sola la propria finestra.

## Requisiti
- [Claude Code](https://docs.claude.com/claude-code) installato e autenticato (`claude auth login`)
- Git
- FFmpeg (consigliato: senza, gli output risultano "non verificati")
- Node.js 22+ per `npx` e per i sorgenti (non serve per l'app desktop)

## Come funziona
1. In un progetto apri **Creatività → + Nuova creatività**, descrivi cosa vuoi, scegli canali e formati e premi **Genera**.
2. L'agente lavora in `creatives/<data-titolo>/work/` e consegna in `outputs/vN/` un file per formato più `manifest.json` ([contratto completo](docs/output-contract.md)).
3. Motion Studio controlla gli output (presenza, risoluzione, durata; con ffmpeg/ffprobe installati li verifica davvero): se qualcosa non torna chiede all'agente di correggere, fino a 3 tentativi in totale; poi salva la versione, anche se incompleta.
4. Ogni versione è un commit git del progetto. Dalla pagina della creatività puoi aprire un formato, aggiungere commenti su un punto/istante, chiedere modifiche, confrontare versioni e ripartire da una versione precedente.

### Esporta
Dalla pagina della creatività, **Esporta…** copia gli output di una versione in una cartella a tua scelta (nell'app desktop c'è anche **Scegli cartella…**). I file si chiamano `<slug>-<formato>-vN.<estensione>` (es. `lancio-instagram-reel-9x16-v2.mp4`); non sovrascrive mai nulla (se il nome esiste aggiunge `-2`, `-3`…) e rifiuta destinazioni dentro il workspace di Motion Studio. Gli output non esportabili (file mancante o non regolare) vengono saltati e l'interfaccia li elenca.

### Aggiungere formati
Se in una creatività già generata aggiungi formati al brief e premi di nuovo **Genera**, Motion Studio chiede all'agente di aggiungere solo i formati mancanti riusando i sorgenti già presenti in `work/` e lo stesso stile della versione precedente; nella richiesta include il comando di render registrato nel manifest (`renderCommand`), se c'è. È l'agente a eseguirlo e ad adattarlo: Motion Studio non lancia il comando da solo, e ogni formato nuovo è comunque una ricomposizione.

Limiti attuali: la rigenerazione dei soli formati è quindi guidata dall'agente, non un render automatico del comando del manifest; le build desktop firmate dipendono dai certificati dei maintainer (vedi Rilascio).

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
- **Provider di immagini, voce e stock:** sono descritti in [docs/providers.md](docs/providers.md) ma non sono stati verificati dal vivo con chiavi reali (i test usano risposte simulate).

## Sviluppo
```bash
pnpm install
pnpm dev                  # core (tsx watch, porta 4317) + web (Vite, porta 5173 con proxy /api); il core stampa il link con il codice di accesso
pnpm test                 # tutti i test (usano un finto `claude`, nessun consumo di quota)
npx vitest run packages/core/test/server.test.ts   # un singolo file (dalla radice del repository)
pnpm typecheck
pnpm build                # web + bundle del pacchetto npm (apps/cli/dist)
pnpm motion-studio        # build + avvio del pacchetto locale

pnpm --filter motion-studio-desktop dev        # app Electron in sviluppo (prima: `pnpm --filter @motion-studio/web build && pnpm --filter motion-studio-desktop build`)
pnpm --filter motion-studio-desktop smoke      # avvio di prova dell'app con una configurazione temporanea
pnpm --filter motion-studio-desktop dist:mac   # installer locale (dist:win, dist:linux; senza argomento: la piattaforma corrente)
```

Variabili utili:
- `MOTION_STUDIO_CONFIG_DIR` — dove salvare la config dell'app (percorso del workspace).
- `MOTION_STUDIO_CLAUDE_COMMAND` — comando dell'agente come array JSON, es. `["node","/percorso/fake-claude.mjs"]`.

Per contribuire vedi [CONTRIBUTING.md](CONTRIBUTING.md).

## Rilascio
Per i maintainer. Crea e pubblica un tag `vX.Y.Z` (allinea prima le versioni nei `package.json`): il workflow `.github/workflows/release.yml` costruisce l'app desktop su macOS, Windows e Linux e crea una **bozza** di release su GitHub con gli installer (da pubblicare a mano); poi, se `NPM_TOKEN` è presente, pubblica `motion-studio-app` su npm. La CI (`ci.yml`) esegue i test a ogni push su `main` e sulle pull request.

Segreti del repository usati dal workflow (tutti facoltativi: senza, la build è non firmata o l'npm viene saltato):
- macOS (firma e notarizzazione): `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Senza `MAC_CERT_P12_BASE64` la firma è disattivata.
- Windows: `WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD`.
- npm: `NPM_TOKEN`.
- `GITHUB_TOKEN` è fornito da GitHub Actions.

## Licenza
MIT
