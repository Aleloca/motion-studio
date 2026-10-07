# Motion Studio — Design Spec

- **Data:** 2026-10-07
- **Stato:** bozza da revisionare
- **Licenza proposta:** MIT

## 1. Obiettivo

Motion Studio è un'applicazione open-source, interamente locale, che fa da interfaccia (UX/UI) verso un agente di coding installato sulla macchina dell'utente — inizialmente **Claude Code** — per produrre **video in motion graphics e immagini** per la comunicazione e la promozione.

L'utente organizza il lavoro in **Progetti**; in ogni progetto raccoglie asset, immagini di riferimento, linee guida di brand (anche estratte automaticamente da siti web e immagini) e cartelle codebase collegate; poi crea **Creatività** descrivendo cosa vuole ottenere, per quali canali e in quali formati. L'agente lavora in background, produce gli output e l'utente itera in conversazione, con versioni navigabili.

### Pubblico

Misto: interfaccia semplice di default per creativi/marketer non tecnici, con una **modalità esperto** che mostra codice, comandi, log e sessione dell'agente.

### Principi

1. **Tutto locale, nessun database.** Lo stato vive su file nel workspace dell'utente (JSON/Markdown + git).
2. **Libertà nel come, contratto sul cosa.** L'agente sceglie liberamente strumenti e tecniche (Remotion, Motion Canvas, MoviePy, ffmpeg, HTML+Playwright, Blender…). L'app impone solo un contratto sugli output consegnati.
3. **Nessuna limitazione sui tipi di creatività.** Spot social, explainer, animazioni di dati/UI, immagini statiche: il brief è libero.
4. **Agente intercambiabile.** Claude Code è il primo backend; l'architettura permette di aggiungerne altri (es. Codex) in futuro.
5. **Le chiavi API non escono mai dal core.**

### Non-obiettivi

- Nessun servizio cloud proprio, account o sincronizzazione.
- Nessun editor video timeline-based manuale: le modifiche passano dall'agente.
- Nessuna esecuzione delle codebase collegate (solo lettura).
- Nessuna gestione del login/abbonamento dell'agente: l'utente deve avere l'agente installato e autenticato.

## 2. Architettura

```
┌────────────── Electron (distribuzione principale) / browser via npx ──────────────┐
│  Frontend web (React)                                                            │
│  Progetti · Brand · Asset · Riferimenti · Creatività · Impostazioni              │
└───────────────▲──────────────────────────────────────────────────────────────────┘
                │ HTTP + WebSocket (eventi in streaming)
┌───────────────┴────────────────────── Core (Node/TypeScript) ────────────────────┐
│ WorkspaceStore   → lettura/scrittura progetti su file + git + file watcher       │
│ AgentRunner      → interfaccia astratta; ClaudeCodeRunner come primo backend     │
│ ApprovalBroker   → richieste di permesso inoltrate alla UI                       │
│ JobQueue         → concorrenza limitata, stato, cancellazione                    │
│ OutputContract   → validazione manifest + outputs, generazione anteprime         │
│ SecretsVault     → chiavi API nel portachiavi del sistema operativo              │
│ Doctor           → verifica dipendenze e guida all'installazione                 │
└───────────────▲──────────────────────────────────────────────────────────────────┘
                │ stdio (MCP)
┌───────────────┴─────────── MCP server "studio" (avviato per sessione) ───────────┐
│ generate_image · tts · stock_search · stock_download · fonts_fetch               │
│ screenshot_url · request_approval · report_progress · validate_output            │
│ read_brand_kit                                                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Monorepo

| Package | Ruolo |
|---|---|
| `packages/core` | Server locale: API HTTP/WS, store, runner, coda, contratto, segreti, doctor |
| `packages/web` | Frontend React, ignaro di come è stato avviato |
| `packages/mcp-studio` | Server MCP con provider e strumenti di coordinamento |
| `packages/shared` | Schemi (zod), tipi, catalogo formati di default |
| `apps/electron` | Avvia il core in-process e apre la finestra; notifiche e dialoghi nativi |
| `apps/cli` | `npx motion-studio`: avvia il core e apre il browser |

### Comunicazione con l'agente (ClaudeCodeRunner)

- Ogni turno di lavoro avvia `claude -p --output-format stream-json --input-format stream-json` con `cwd` nella cartella del progetto.
- Le codebase collegate sono passate con `--add-dir`; le regole di permesso generate per sessione le rendono in sola lettura.
- Il server MCP `studio` è configurato per sessione tramite `--mcp-config`.
- La conversazione continua con `--resume <session-id>`; ripartire da una versione precedente usa `--resume` + `--fork-session`.
- Le richieste di permesso fuori perimetro passano da un permission-prompt tool / hook che le inoltra all'ApprovalBroker.
- Il parsing dello stream-json è isolato in un adapter dedicato e coperto da test con stream registrati, per assorbire cambiamenti di formato della CLI.

`AgentRunner` espone un'interfaccia neutra (avvia turno, invia messaggio, riprendi/forka sessione, annulla, stream di eventi normalizzati), così un futuro `CodexRunner` può essere aggiunto senza toccare UI e store.

> Nota: il Claude Agent SDK è stato scartato come backend primario perché pensato per prodotti con propria API key; l'obiettivo è usare il Claude Code già installato e autenticato dall'utente. Potrà essere aggiunto come backend alternativo per chi usa una API key.

## 3. Struttura su disco

```
~/MotionStudio/                         ← workspace (scelto al primo avvio)
├── .studio/
│   ├── settings.json                   (parallelismo, provider attivi, modalità esperto, modello)
│   └── presets/formats.json            (catalogo canali/formati, modificabile)
└── <progetto>/                         ← un progetto = una cartella = un repo git
    ├── project.json                    (nome, descrizione, codebase collegate, date, schemaVersion)
    ├── brand/
    │   ├── brand-kit.json              (palette, font, loghi, tono, do/don't — ogni campo con "source")
    │   ├── guidelines.md               (linee guida libere)
    │   └── sources.json                (siti/immagini analizzati, data dell'analisi)
    ├── assets/
    │   ├── …file…
    │   └── assets.json                 (origine, tag, descrizione generata)
    ├── references/
    │   ├── …immagini…
    │   └── references.json             (note per immagine)
    ├── creatives/
    │   └── <yyyy-mm-dd-slug>/
    │       ├── creative.json           (brief, formati, codebase collegate, stato)
    │       ├── conversation.jsonl      (messaggi ed eventi normalizzati per la UI)
    │       ├── versions.json           (vN → commit git, session id, note, stato)
    │       ├── work/                   ← spazio di lavoro libero dell'agente
    │       └── outputs/                ← escluso da git
    │           └── vN/ manifest.json + file finali
    ├── .studio/context.md              (contesto agente-neutro: struttura, contratto, brand)
    ├── CLAUDE.md                       (generato; importa .studio/context.md)
    ├── .claude/                        (skill del contratto, generata dall'app)
    └── .gitignore                      (outputs/, node_modules/, .venv/, cache)
```

- Ogni file JSON ha `schemaVersion`; il core contiene migrazioni versionate.
- Il filesystem è l'unica fonte di verità; il core tiene una cache in memoria invalidata da un file watcher, così modifiche manuali o dell'agente compaiono subito in UI.
- Le codebase collegate sono riferimenti a percorsi (con nota opzionale), mai copie. Possono essere collegate a livello di progetto e/o di singola creatività.

## 4. Contratto di output

L'agente è libero su strumenti e tecniche, ma al termine di ogni turno produttivo deve consegnare in `creatives/<slug>/outputs/vN/`:

1. **Un file per ogni formato richiesto**, con nome derivato dal preset (es. `instagram-reel-9x16.mp4`).
2. **`manifest.json`** con: elenco file, preset di riferimento, risoluzione, durata (per i video), formato file, strumenti usati, e un **comando di re-render** riproducibile da eseguire in `work/`.
3. Una chiamata a `validate_output`, con cui il core verifica che tutti i formati siano presenti e che risoluzione, durata e peso rispettino i vincoli del preset.

Se la validazione fallisce, l'errore torna all'agente che corregge (default 3 tentativi, configurabile). Superati i tentativi, la versione viene salvata come **incompleta** con l'elenco delle mancanze.

Il contratto è descritto in una skill/istruzione generata nel progetto. Possono esserci **suggerimenti** di strumenti (es. "per video brevi Remotion funziona bene"), mai vincoli.

Ogni formato è una **ricomposizione** dedicata (layout adattato, elementi riposizionati), non un ritaglio di un master.

## 5. Catalogo formati

Catalogo di default in `formats.json`, modificabile ed estendibile con formati personalizzati. Ogni preset include id, canale, nome, dimensioni, tipo (video/immagine), estensioni ammesse e vincoli (durata max, safe zone, peso max).

| Canale | Formati |
|---|---|
| Instagram | Post 1:1 (1080×1080), Post 4:5 (1080×1350), Story/Reel 9:16 (1080×1920) |
| TikTok | 9:16 (1080×1920) |
| YouTube | Video 16:9 (1920×1080, 4K opz.), Shorts 9:16, Thumbnail (1280×720) |
| Facebook | Feed 1:1 / 4:5, Story 9:16, Cover |
| LinkedIn | 1:1, 4:5, 16:9, banner |
| X | 16:9 (1600×900), 1:1 |
| Pinterest | 2:3 (1000×1500) |
| Web | Hero 16:9, banner display (300×250, 728×90, 160×600, …) |
| App Store | Screenshot iPhone 6.9"/6.5", iPad 13", App Preview video, icona 1024×1024 |
| Play Store | Feature graphic 1024×500, screenshot telefono/tablet, icona 512×512, video promo 16:9 |

Formati file: MP4 (H.264), WebM, GIF, MOV ProRes 4444 con alpha; PNG, JPG.

Le specifiche esatte (in particolare degli store) vanno verificate sulle documentazioni ufficiali in fase di implementazione.

## 6. Flussi

### 6.1 Analisi brand

1. L'utente inserisce URL e/o carica immagini nella sezione Brand.
2. Il core avvia una sessione "analisi": l'agente visita i siti (fetch + `screenshot_url` via Playwright), estrae palette, font, loghi, immagini e tono; scarica gli asset in `assets/` con metadati di origine; recupera i font tramite il provider Google Fonts.
3. L'agente propone modifiche a `brand-kit.json` e `guidelines.md`; la UI mostra un **diff approvabile campo per campo**, così le modifiche manuali non vengono sovrascritte.

### 6.2 Ciclo di vita di una creatività

1. **Brief strutturato:** obiettivo, messaggio chiave, canali/formati, durata, asset preferiti, codebase collegate, note libere.
2. **Generazione v1:** il job entra in coda; il runner avvia la sessione; la UI mostra i passi da `report_progress` (modalità semplice) o lo stream completo (modalità esperto).
3. **Chiusura turno:** `validate_output` → commit git → nuova versione in `versions.json` → anteprime (poster frame, thumbnail).
4. **Iterazione:** messaggi in chat o commenti ancorati a frame/timestamp (con fotogramma allegato); il runner riprende la sessione e produce v(N+1).
5. **Ripartire da una versione:** ripristina `work/` dal commit di vN e forka la sessione dell'agente.
6. **Re-render / nuovo formato:** se cambiano solo i formati, si prova prima il comando di re-render del manifest; altrimenti si chiede all'agente.
7. **Esporta:** apre la cartella degli output o copia i file in una destinazione scelta con nomi per canale.

### 6.3 Permessi e approvazioni

Regole generate per sessione:

- **Consentito:** lettura/scrittura in `work/` e `outputs/` della creatività; lettura di `brand/`, `assets/`, `references/` e delle codebase collegate; package manager e interpreti in locale nella cartella di lavoro; fetch di rete.
- **Negato:** scrittura nelle codebase collegate.
- **Su approvazione:** tutto il resto (installazioni di sistema, file fuori dal workspace, comandi insoliti). Il job va in pausa e la UI mostra **Consenti una volta / Sempre per questo progetto / Nega**.

In modalità esperto l'utente può modificare le regole per progetto.

### 6.4 Parallelismo

- Coda globale con limite configurabile (default 2).
- Ogni job è un processo separato annullabile.
- Un solo job attivo per creatività; creatività diverse (anche dello stesso progetto) possono procedere in parallelo.
- Le operazioni git sono serializzate per progetto.

## 7. Provider esterni (MCP `studio`)

Provider opzionali, attivati inserendo la chiave nelle impostazioni (salvata nel portachiavi del sistema operativo). L'agente vede solo gli strumenti dei provider attivi.

| Strumento | Provider iniziale |
|---|---|
| `generate_image` | OpenAI gpt-image-2 |
| `tts` | OpenAI TTS e/o ElevenLabs |
| `stock_search` / `stock_download` | Pexels, Unsplash |
| `fonts_fetch` | Google Fonts |

Strumenti di coordinamento sempre disponibili: `report_progress`, `request_approval`, `validate_output`, `read_brand_kit`, `screenshot_url`.

I provider sono moduli indipendenti con un'interfaccia comune, così aggiungerne altri (musica generata, video AI) non richiede modifiche al core.

## 8. Interfaccia

### 8.1 Direzione scelta: ibrido "Tavola + Conversazione"

Scelta dopo il confronto di tre varianti (A · Studio, B · Conversazione al centro, C · Tavola dei formati):

- **Base C, tavola dei formati.** Nella creatività tutti i formati richiesti sono affiancati nelle proporzioni reali, su una superficie con zoom, "adatta alla finestra" e raggruppamento per canale. I commenti sono pin ancorati al formato e al timestamp. Le safe zone dei preset sono visualizzabili. Il selettore di versione e la funzione "Confronta" stanno nella barra superiore.
- **Vista focus.** Con un doppio clic su un formato lo si apre grande con il player completo (scrubbing, marcatori dei commenti, "+ Commento al frame"). È l'impostazione della variante A, usata come modalità di C.
- **Brief guidato, da B.** Un campo grande "Cosa vuoi realizzare?" e blocchi per formati, asset, codebase e durata. Selezionando i formati compaiono a lato i riquadri vuoti nelle proporzioni reali.
- **Conversazione in un pannello laterale apribile, con il registro di B.** Ogni versione appare come card con le miniature dei formati e le azioni (anteprima, riparti da qui, mostra nel Finder). Il lavoro in corso mostra i passi e il progresso, e le approvazioni compaiono inline nella conversazione.
- **Modalità esperto, con la densità di A.** Il pannello laterale aggiunge una scheda con stream completo, tool call, comandi e diff, in carattere monospace.
- **Temi.** Chiaro e scuro, entrambi di prima classe, con un'opzione "segui il sistema". Tutti i colori sono definiti come token di tema; nessuna schermata ha colori fissi.

### 8.2 Contenuti

- **Primo avvio / Doctor:** scelta workspace; verifica Claude Code (installato e autenticato), git, ffmpeg, Node; configurazione opzionale dei provider.
- **Home:** card dei progetti (anteprima, colori del brand, n. creatività), ricerca, "Nuovo progetto", indicatore globale dei job.
- **Progetto:** Panoramica · Brand (kit visuale, `guidelines.md`, sorgenti, "Analizza") · Asset · Riferimenti · Creatività (con stato: bozza, in lavorazione, in attesa di approvazione, pronta, incompleta, errore, interrotta) · Impostazioni (codebase collegate, permessi).
- **Creatività:** tavola dei formati con commenti a pin e vista focus; pannello conversazione (card versione, passi, approvazioni; scheda esperto); selettore versioni (confronta, riparti da, esporta); brief consultabile e modificabile (una modifica genera una nuova versione).
- **Impostazioni globali:** provider e chiavi, parallelismo, modalità esperto, tema (chiaro / scuro / sistema), editor catalogo formati, modello dell'agente.
- **Notifiche:** toast in-app e notifiche di sistema (Electron) per job completati e approvazioni richieste.

## 9. Gestione errori

| Situazione | Comportamento |
|---|---|
| Agente non installato / non autenticato | Il Doctor blocca la generazione e mostra il comando da eseguire |
| Processo dell'agente terminato | Job in errore, log salvato, "Riprova" riprende la sessione |
| Limite di utilizzo raggiunto | Messaggio chiaro, job in pausa, nessun retry automatico |
| Output non valido dopo N tentativi | Versione "incompleta" con elenco mancanze |
| Errore di un provider | Errore leggibile restituito all'agente; visibile nei passi |
| Codebase collegata mancante | Avviso; sessione avviata senza, segnalato nel prompt |
| JSON non valido / modificato a mano | Validazione zod con messaggio puntuale; nessuna sovrascrittura senza conferma |
| Chiusura app con job attivi | Avviso; al riavvio i job diventano "interrotti" e riprendibili |

## 10. Test

- **Unit:** schemi e migrazioni, WorkspaceStore, OutputContract, JobQueue, adapter stream-json.
- **Integrazione:** AgentRunner contro un **finto `claude`** che riproduce stream-json registrati (deterministico, senza consumo di quota); server MCP con provider mock.
- **E2E (Playwright):** nuovo progetto → analisi brand → creatività → iterazione → ripartenza da versione, con l'agente finto.
- **Smoke manuale** con Claude Code reale prima di ogni release, su 3–4 brief di riferimento.

## 11. Distribuzione

- Release Electron per macOS (arm64/x64, firmata e notarizzata), Windows e Linux tramite GitHub Actions; aggiornamenti automatici.
- Pacchetto npm per `npx motion-studio`.
- Documentazione: README, guida al contratto di output, guida ai provider, guida per aggiungere un backend agente.

## 12. Fasi di sviluppo

Il prodotto è definito per intero; l'implementazione procede in quest'ordine:

1. Monorepo, core, WorkspaceStore, Doctor, AgentRunner (Claude Code) con streaming verso una UI minima.
2. Creatività completa: brief, chat, versioni git, contratto di output, anteprime.
3. Brand kit, analisi siti/immagini con estrazione asset, gestione asset e riferimenti, codebase collegate.
4. Server MCP con provider, approvazioni, parallelismo.
5. Electron, packaging e release, UI rifinita secondo la variante scelta.

La direzione visiva è fissata in §8.1. I mockup di riferimento sono sulla tavola di design del progetto.
