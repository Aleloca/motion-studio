# Motion Studio — Fase 14: Brand da codebase, pacchetto store tra i formati, formati di identità — Specifica

> **Fonti:**
> - richieste dell'utente del 2026-10-14, dopo il giro nell'app di sviluppo:
>   1. estrarre le linee guida del brand anche da una codebase, non solo da un sito;
>   2. il pacchetto screenshot/app preview per gli store sta nell'elenco dei formati ed è gestito da lì, non in una scheda a parte;
>   3. formati per generare loghi, favicon e simili per siti e app;
> - risposte dell'utente del 2026-10-15:
>   - (a) l'agente può leggere tutta la codebase, solo in lettura;
>   - (b) loghi sia partendo dal brand esistente sia da zero;
> - seguiti aperti del giro UX 1 (decisioni 700–714);
> - percorso attuale:
>   - analisi del brand: `brand-analysis.ts`, `brand-prompt.ts`, `download_file`, `inspect_site_fonts`;
>   - codebase collegate: `normalizeCodebasePath`, `codebaseOverlaps`, `readOnlyRules`, `codebaseSnapshot`;
>   - pacchetto store: `store-pack.ts`, `StorePackWizard.tsx`, `store-pack-routes.ts`;
>   - formati immagine: `formats.ts`, `renderer.ts` (still con `duration: 0`).
>
> **Decisioni prese in autonomia** dall'orchestratore: voci 720–735 del registro. Chi implementa numera da 740. L'utente le rivede alla fine.

## 1. Perché

- Molti progetti dell'utente sono app e siti di cui ha il codice ma non un sito pubblico, o il sito non racconta tutto. I colori, i font e il logo veri stanno nei token, nel tema, nella cartella `public/`, nelle icone dell'app.
- Il pacchetto store oggi si crea da un riquadro separato della schermata "Nuova creatività" e diventa sempre una creatività nuova. Per l'utente è "solo un formato": deve stare con gli altri formati e potersi aggiungere anche a una creatività esistente.
- Loghi, favicon, icone app e immagini di anteprima social sono un bisogno ricorrente. Oggi Motion Studio produce solo PNG/JPEG singoli a misura fissa: niente vettoriale, niente set di dimensioni, niente `.ico`.

## 2. Brand da una codebase

### 2.1 Fonte

- **Nuovo tipo di fonte del brand: `codebase`**, con `{path, note?}`, accanto a `website` e `image`. Una stessa analisi può avere più fonti di tipi diversi, per esempio sito + codebase.
- **Scelta della cartella**, nella schermata Brand (vuota o "Aggiungi fonte"):
  - nell'app desktop c'è il selettore di cartelle;
  - si può anche scrivere il percorso a mano;
  - le codebase già collegate al progetto compaiono come suggerimenti da un clic.
- **Validazione lato server**, uguale a quella delle codebase delle creatività:
  - `normalizeCodebasePath`: percorso assoluto o con `~`, mai la radice del disco o la home;
  - `codebaseOverlaps`: mai dentro o attorno al progetto o al workspace;
  - la cartella deve esistere;
  - al massimo 5 fonti codebase per brand (voce 720).

### 2.2 Cosa può fare l'agente

- **Lettura di tutta la codebase, in sola lettura** (risposta (a) dell'utente):
  - la cartella entra con `--add-dir`;
  - le regole `Edit(//path/**)` sono negate;
  - con la sandbox attiva la cartella è in `denyWrite`.
- **Strumenti:** l'analisi con almeno una fonte codebase aggiunge `Read`, `Glob` e `Grep` agli strumenti consentiti. Senza fonti codebase gli strumenti restano quelli di oggi.
- **File segreti esclusi dalla lettura** (voce 721):
  - quali sono: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.keystore`, `*.jks`, `id_rsa*`, `.npmrc`, `.netrc`, `.pypirc`, `credentials*`, `secrets*`, `*.mobileprovision`, `google-services.json`, `GoogleService-Info.plist`, `.git/`;
  - come sono esclusi: regole `Read(//path/**/<pattern>)` negate e, con la sandbox, anche `denyRead`;
  - se la sandbox non c'è, il turno si avvia lo stesso, ma la UI dice che l'esclusione vale solo come regola dello strumento e non come barriera del sistema operativo;
  - il prompt dice di non aprire quei file e di saltare `node_modules`, `dist`, `build`, `Pods`, `.next` e le cartelle generate.
- **Controllo che la codebase non cambi:** `codebaseSnapshot` prima e dopo il turno, come per le creatività. Se cambia qualcosa:
  - la proposta viene scartata;
  - la UI mostra un errore che nomina la cartella;
  - il registro tiene l'elenco dei file cambiati (voce 722).
- **Copiare file dalla codebase al progetto:** nuovo strumento MCP `import_codebase_file {source, dest}`, solo per `brand-analysis` (voce 723).
  - `source` è un percorso dentro una delle codebase fonte dell'analisi, verificato dopo `realpath`: niente link simbolici che escono.
  - Deve essere un file regolare, al massimo 50 MB, con le stesse estensioni di `download_file`, compreso `ico`.
  - `source` non può corrispondere a uno dei pattern segreti.
  - `dest` segue le regole di `download_file`: `assets/brand/<nome>` o `assets/fonts/<nome>`.
  - Al massimo 40 chiamate per analisi.
  - Il file entra nella libreria con origine `codebase` (nuova) e tag `brand`.
- **Rete:** invariata. Con la sandbox l'analisi del brand non ha rete. `WebFetch` resta per le fonti sito.

### 2.3 Cosa cerca

Il prompt guida l'agente, in quest'ordine:
- **token e tema:** `tailwind.config.*`, variabili CSS (`:root`), file di design token (JSON/YAML, Style Dictionary), temi di MUI/Chakra/styled-components, `colors.xml` / `themes.xml` Android, `Assets.xcassets` iOS (color set);
- **font:** `@font-face` con file locali (copiati con `import_codebase_file`), `next/font`, import di Google Fonts. Se il font è su Google Fonts si usa `fonts_fetch` come oggi;
- **loghi e icone:**
  - SVG e PNG in `public/`, `static/`, `assets/`;
  - `favicon.*`, `apple-touch-icon*`;
  - `AppIcon.appiconset` iOS e `mipmap-*` / `ic_launcher*` Android;
  - `manifest.json` / `site.webmanifest` (`theme_color`, `background_color`, nome);
- **tono:** README, testi di marketing, stringhe di i18n delle pagine principali, metadati dello store (`fastlane/metadata`, se c'è).

Le fasi mostrate restano quelle di oggi (`reading` copre anche la lettura della codebase). Ogni elemento del kit ha `source: {kind: 'codebase', ref: <percorso relativo alla codebase>}`. La UI lo mostra come "da codebase · `src/theme.ts`".

## 3. Il pacchetto store sta tra i formati

- **Nella "Nuova creatività"** il riquadro separato "App Store / Google Play" sparisce. Nella bacheca dei formati, gruppo "Store", c'è una voce **"Pacchetto store"** che apre lo stesso assistente di oggi in una finestra (voce 724).
  - Alla conferma il pacchetto si aggiunge ai formati scelti, con le sue istanze, etichette e collegamenti (`storePackFormats`).
  - Una creatività può mescolare pacchetto e altri formati.
- **Nel brief di una creatività esistente** (scheda Brief, scelta dei formati) c'è la stessa voce.
  - Una creatività ha al massimo un pacchetto.
  - Se c'è già, la voce diventa "Pacchetto store · N screenshot" con **Modifica** (riapre l'assistente con i valori attuali) e **Rimuovi**.
- **Modifica e rimozione:**
  - il core ricalcola le istanze del pacchetto dal nuovo `storePack`;
  - toglie quelle che non servono più;
  - aggiunge le nuove;
  - non tocca le istanze che non sono del pacchetto.
  - Le istanze tolte non cancellano versioni già fatte: restano nella cronologia come oggi per un formato tolto dal brief.
  - Le schermate (`screen`) passano dalla stessa `verifyScreens` di oggi.
- **Formati scelti a mano:** gli screenshot store scelti uno a uno restano possibili come formati normali, senza pacchetto e senza export del pacchetto.
- **Colonna dei formati della creatività:**
  - le istanze del pacchetto stanno in un unico gruppo "Pacchetto store", con App Store e Google Play come sottogruppi;
  - "Esporta pacchetto" sta nell'intestazione del gruppo, non più nella barra in alto.
- **Compatibilità:**
  - la rotta `POST …/creatives/store-pack` resta, per le creatività già create così e per l'API;
  - la UI non la usa più.

## 4. Formati di identità: logo, favicon, icona app, anteprima social

### 4.1 Nuovi formati

Un nuovo gruppo del catalogo, **"Identità"** (voce 725):

| Formato | Cosa produce |
|---|---|
| `identity-logo` — Logo | `logo.svg` (vettoriale) e `logo.png` 1024 px di lato lungo, trasparente |
| `identity-favicon` — Favicon per siti | `favicon.ico` (16, 32, 48), `favicon.svg`, `apple-touch-icon.png` 180 opaco, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `site.webmanifest`, `head-snippet.html` |
| `identity-app-icon` — Icona app | iOS: `AppIcon-1024.png` opaco senza alfa e `Contents.json` (formato a dimensione singola). Android: `ic_launcher-playstore.png` 512, `ic_launcher_foreground.png` 432 (alfa), `ic_launcher_background.png` 432 o colore, `ic_launcher.xml` adattiva, `mipmap-*/ic_launcher.png` da 48 a 192 |
| `og-image-1200x630` — Anteprima social (Open Graph) | PNG o JPEG 1200×630, al massimo 5 MB. È un formato immagine normale e usa il rendering di oggi |

I preset `appstore-icon` e `playstore-icon` restano, come singole immagini.

### 4.2 Logo, favicon e icona app sono vettoriali

- **Una composizione "vettoriale"** (voce 726): ferma (`duration: 0`), quadrata (1024×1024 per favicon e icona app; per il logo il lato lungo è 1024) e fatta da un solo clip `svg` a tutto quadro, senza altri layer.
  - Il core controlla questa forma.
  - Se non torna, parte il normale turno di riparazione con il motivo.
- **L'SVG deve passare un controllo severo** prima di diventare un'uscita (voce 727). Non sono ammessi:
  - `<script>`, `<foreignObject>`;
  - attributi `on*`;
  - riferimenti esterni (`href` / `xlink:href` che non siano `#id`);
  - `<image>`, `@import`;
  - URL in `style`.
  - Massimo 512 KB.
  - I testi vanno convertiti in tracciati. Un `<text>` è ammesso solo con un avviso, perché la resa dipende dai font installati.
- **Variante piccola, facoltativa:** per favicon e icona app l'agente può aggiungere una seconda composizione, `small`, usata per le dimensioni fino a 48 px. Serve per un segno semplificato che resti leggibile a 16 px (voce 728).
- **Rasterizzazione:** ogni PNG nasce dall'SVG reso in Chrome alla dimensione esatta, con lo stesso isolamento e gli stessi `BASE_FLAGS` del render. Non si ridimensiona un PNG grande.
- **`.ico`:** scritto dal core in TypeScript (contenitore ICO con voci PNG), senza dipendenze nuove.
- **Opaco dove serve** (voce 729):
  - `apple-touch-icon`, iOS 1024 e Play 512 sono senza alfa;
  - lo sfondo è il `background` della composizione se opaco, altrimenti il colore primario del brand, altrimenti il bianco con un avviso;
  - si riusa `flattenPng` del pacchetto store.
- **Zona sicura:** per `icon-512-maskable` e per il primo piano adattivo Android il core misura dove cade il contenuto non trasparente. Se esce dal cerchio sicuro (80% per maskable, 66/108 per l'adattiva), un avviso lo dice. Non blocca.
- **Il colore del tema** del `site.webmanifest` viene dal brand (colore con ruolo primario), altrimenti dallo sfondo.

### 4.3 Dal brand o da zero

Risposta (b) dell'utente: entrambi. Nella scelta dei formati di identità c'è un campo **"Partenza"** (voce 730):
- **"Dal logo del brand"**, la scelta predefinita se il brand ha almeno un logo:
  - l'agente parte dal logo esistente, preferendo la variante `icon` per favicon e icona app;
  - lo adatta (margini, versione semplificata per le dimensioni piccole) senza ridisegnarlo.
  - Se il logo del brand è raster, l'agente lo ridisegna come SVG fedele e la UI lo dice nella conversazione.
- **"Da zero":**
  - campi: nome o sigla, parole chiave di stile (facoltative), colori dal brand o liberi;
  - per `identity-logo` da zero il brief crea **3 proposte** come istanze (`identity-logo`, `@2`, `@3`), modificabile da 1 a 5 (voce 731);
  - l'agente disegna SVG, non usa servizi di generazione di immagini a pagamento (voce 732).

**"Usa come logo del brand"** (voce 733): un'azione su una versione di `identity-logo` (o di un'icona) che:
- copia l'SVG in `assets/brand/`;
- aggiunge al kit un logo (`variant` primario o icona, `source: {kind: 'manual', ref: 'creative:<slug>/<versione>'}`);
- chiede prima conferma. Non serve una proposta da approvare: l'utente lo ha scelto esplicitamente.

### 4.4 Vedere e scaricare

- **Vista formato per favicon e icona app:** l'immagine principale più una griglia **"Dimensioni"**:
  - ogni uscita a 1:1 e ingrandita;
  - le maschere di contesto: scheda del browser (16/32), icona iOS (angoli arrotondati), cerchio Android e zona sicura.
- **Vista formato per il logo:** su chiaro e su scuro, affiancati.
- **Etichetta di stato e "Render"** anche per i formati immagine (seguito 7 del giro UX 1):
  - "Anteprima dal vivo" / "Rendering…" / "Immagine pronta";
  - per i set: "Set pronto · N file".
- **Esportazione:** una cartella per formato con i file della tabella di §4.1. L'export della creatività li include come oggi gli altri file resi.

## 5. Seguiti del giro UX 1 inclusi

- **Seguito 3:** un layer html del tutto fuori quadro non riceve frame rAF in Chrome senza finestra, e il seek fallisce dopo 30 s. Una composizione con un layer parcheggiato fuori campo deve rendersi (voce 734).
- **Seguito 2:** codice e testo propri per lo stallo del layer (`layerStalled`), non più `layerTimeout`.
- **Seguito 4:** mezza frase alla voce 709 sul ciclo `await new Promise(requestAnimationFrame)`.
- **Seguito 10:** togliere la chiave orfana `web.render.storyboardNone`.

Gli altri seguiti restano per un giro UX successivo (voce 735):
- miniature dall'anteprima dal vivo e limiti della corsia;
- pulsante "Apri" nell'app desktop;
- suggerimenti nel kit;
- banda unica per gli intervalli;
- controllo in Chrome dell'intera vista formato.

## 6. Fuori perimetro

- Brand da Figma o da file di design.
- Logo animato come formato a sé: resta un normale video con il logo.
- Ricerche di marchio o di somiglianza.
- `.icns` per macOS, tile Windows (`browserconfig.xml`), icone di notifica Android.
- Generazione raster di loghi con servizi a pagamento.
- Più pacchetti store nella stessa creatività.

## 7. Verifica

- **Test automatici con i dati finti di sempre** (cartella di configurazione temporanea, `MemoryVault`, nessuna chiamata ai servizi a pagamento):
  - fonti codebase, con validazione e sovrapposizioni;
  - regole di lettura e scrittura passate al runner (con e senza sandbox);
  - esclusione dei segreti;
  - `import_codebase_file`: fuori dalla codebase, link simbolico che esce, file segreto, estensione, limite di chiamate;
  - codebase cambiata, quindi proposta scartata;
  - pacchetto nel brief: aggiunta, modifica, rimozione, creatività mista;
  - forma vettoriale e controllo SVG, con un caso ostile per ogni regola;
  - scrittore ICO, riletto e verificato;
  - appiattimento, zona sicura, manifest e snippet;
  - "Usa come logo del brand".
- **Chrome**, sempre con l'harness e i `BASE_FLAGS`: rasterizzazione delle dimensioni (16 px fedele al rendering di Chrome), layer fuori quadro.
- **Prova dal vivo** con il vero Claude Code, nell'app di sviluppo con `MOTION_STUDIO_USER_DATA_DIR` e un workspace temporaneo:
  1. brand da una piccola codebase di prova creata nella cartella temporanea (token Tailwind, un SVG, un `manifest.json`, un `.env` finto che non deve essere letto né copiato);
  2. un favicon dal logo del brand e un logo da zero con 3 proposte.
  - Prima e dopo si controllano le date di modifica delle cartelle vere.
  - Se il classificatore di sicurezza ferma una prova, ci si ferma e si riporta, senza aggirarlo.
