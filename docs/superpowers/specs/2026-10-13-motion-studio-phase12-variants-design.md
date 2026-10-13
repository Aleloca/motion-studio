# Motion Studio — Fase 12: Varianti — Specifica

> **Fonti:**
> - programma `docs/superpowers/specs/2026-10-08-motion-studio-redesign-design.md`, §2, riga della Fase 12: duplicare un formato nella stessa creatività; versioni localizzate in cui cambiano solo testi e voce; pacchetto promozionale per App Store e Google Play (N screenshot più video di anteprima);
> - modello attuale: brief (`packages/shared/src/creative.ts`), preset dei formati (`packages/shared/src/formats.ts`), composizione `motion-studio/composition@1`, `planTurn`, render su richiesta, export, editor diretto (Fase 10b).
>
> **Decisioni prese in autonomia** dall'orchestratore (l'utente dorme e ha chiesto di procedere): voci 420–429 del registro. L'utente le rivede alla fine.

## 1. Perché

Oggi:
- un formato compare una sola volta in una creatività, perché l'id del preset è anche il nome della cartella della composizione. Non si possono avere due Story diverse, né dieci screenshot per lo stesso iPhone;
- non esiste la lingua dei contenuti: per una versione in tedesco bisogna rifare la creatività, e il layout può cambiare;
- i preset di App Store e Google Play esistono, ma non c'è un percorso per un pacchetto completo (serie di screenshot coerenti, video di anteprima, cartelle pronte per il caricamento).

## 2. Istanze di formato (duplicare un formato)

- **Id di istanza.** `brief.formats` accetta, oltre all'id del preset, un id di istanza `<presetId>@<k>` con `k` da 2 a 20. La prima istanza resta l'id nudo del preset, quindi le creatività esistenti non cambiano. La cartella della composizione è `compositions/<instanceId>`. Il preset si ricava togliendo il suffisso.
- **Etichette.** `brief.formatLabels?: Record<instanceId, string>` (massimo 60 caratteri), per esempio "Story · promo estiva" o "Screenshot 3 · Ricerca". La UI mostra l'etichetta, altrimenti nome del preset più "#k".
- **Duplica.** Nella vista formato, "Duplicate format" crea l'istanza successiva libera, copia la composizione della versione aperta e salva una nuova versione (origine `editor`, richiesta "Duplicated <etichetta>"). Le altre istanze vengono riportate come oggi. Da lì l'istanza si itera da sola, in chat (turno con `formats: [instanceId]`) o nell'editor.
- **Rimuovi.** Togliere un'istanza dal brief la esclude dai turni successivi. Le versioni salvate non cambiano.
- **Ordine.** L'ordine di `brief.formats` è l'ordine di visualizzazione e di export; la UI permette di riordinare.
- **Ovunque si usa un formato** (turni, `planTurn`, follower, editor, render, export, scelte di export, nomi dei file) si usa l'id di istanza. I nomi di export aggiungono l'indice quando ci sono più istanze dello stesso preset (`{format}` diventa `instagram-story-2`), così due file non collidono mai.

## 3. Versioni localizzate

### 3.1 Modello

- **Lingue della creatività.** Il brief guadagna `locales?: { primary: string; extra: string[] }` (tag BCP-47 da un elenco curato, massimo 10 lingue extra). Assente vuol dire nessuna localizzazione.
- **Sovrapposizione, non copia.** Una localizzazione non è una seconda composizione: è un file per formato e lingua, `outputs/vN/locales/<locale>/<instanceId>.json` (`motion-studio/localization@1`), che contiene solo:
  - `texts`: testo per id di clip di testo, con il testo di origine;
  - `params`: testo per `clipId.chiave` dei parametri di testo dei layer html, con il testo di origine;
  - `voices`: per id di clip voce, il nuovo `src` (un file in `assets/`), lo script tradotto e quello di origine;
  - `fit`: fattore di scala del corpo del testo per clip, da 0,7 a 1,0, per le lingue più lunghe;
  - `fonts`: font di ripiego aggiunti per la scrittura della lingua (§3.4).
- **Applicazione.** Una funzione pura condivisa `applyLocalization(composition, overlay)` produce la composizione localizzata. Tocca solo quei campi. È **il modo strutturale** per garantire che cambino solo testi e voce: posizioni, tempi, animazioni, colori e immagini restano quelli della composizione di base, e la validazione dell'overlay rifiuta qualunque altro campo.
- **Clip voce.** Le clip audio con `role: 'voice'` guadagnano un campo facoltativo `script` (il testo parlato). Quando manca, il core usa la descrizione dell'asset generato da `tts`. Una clip voce senza script noto non si può tradurre: la UI la segnala.
- **Registro nella versione.** `VersionEntry.localizations?: { locale, instanceId, hash, origin: 'agent'|'editor', stale: string[], problems? }[]`.

### 3.2 Tradurre

- **"Translate"** (pannello "Languages" della creatività) avvia un turno di tipo `localize` sulla versione aperta, per le lingue e i formati scelti.
- Il prompt (in inglese) dà all'agente i testi di origine con il contesto (nome della clip, scena, dimensione del riquadro, numero massimo di righe stimato), lo stile e il tono del brand, e le note del brief. L'agente risponde **solo** con il nuovo strumento MCP `submit_localization(locale, instanceId, texts, params, voiceScripts, fit)`. Non scrive file né tocca composizioni.
- Il core valida (solo id esistenti, solo campi ammessi, lunghezze massime), applica l'overlay e lancia i controlli esistenti sulla composizione risultante. Il testo che esce dal riquadro anche con `fit` a 0,7 è un problema. Il ciclo di riparazione esistente (3 tentativi) chiede all'agente un testo più corto, e il tentativo di riparazione porta la richiesta originale dell'utente (Fase 11, F4).
- **Voce.** Dopo che le traduzioni sono valide, è il core (non l'agente) a generare le voci tradotte, con il servizio scelto nel brief (`brief.services.voice`, regole della Fase 11) e la voce del brand. Prima di generare chiede **una sola conferma** per tutto il turno: elenca le chiamate, il servizio, i caratteri e la stima del costo quando è nota. Una regola "Always" del progetto per `tts` vale anche qui.
- Se la voce è `none` o il servizio non è disponibile, per ogni lingua si sceglie tra "Keep original voice" e "Mute voice". La UI lo mostra nella riga della lingua.
- Una voce tradotta più lunga della clip è un problema riportato, mai tagliata in silenzio. La riparazione chiede uno script più corto.

### 3.3 Rivedere, modificare, aggiornare

- **Tabella di revisione.** Nel pannello Languages, per formato e lingua: origine | traduzione | stato (ok, testo fuori riquadro, superata). La traduzione si modifica a mano. Il salvataggio scrive l'overlay della stessa versione (origine `editor`) sotto il blocco della creatività, rilancia i controlli e non crea una nuova versione delle composizioni.
- **Anteprima.** Il player e l'editor hanno un selettore di lingua. L'anteprima applica l'overlay con il comando di runtime `setComposition` già esistente.
- **Versioni successive.** Quando un turno crea la versione N+1, il core riporta gli overlay della base: le voci la cui clip esiste ancora con lo stesso testo di origine restano valide, le altre finiscono in `stale`. "Translate" rifà solo ciò che manca o è superato. Un testo superato non si mostra mai come se fosse aggiornato: anteprima ed export usano il testo di origine per quella clip e la segnalano.

### 3.4 Lingue e scritture

- **Elenco curato** di lingue da sinistra a destra: le principali europee, più cinese semplificato e tradizionale, giapponese, coreano, hindi, thai, vietnamita, indonesiano, turco, russo e ucraino.
- **Lingue da destra a sinistra** (arabo, ebraico, persiano, urdu): **non supportate** in questa fase. La UI le mostra disattivate con il motivo.
- **Font di ripiego.** Per le scritture non latine, cirilliche o greche, il core aggiunge un Noto Sans della scrittura (per esempio Noto Sans JP), scaricato con il flusso Google Fonts della Fase 11, in coda alla catena dei font delle clip di testo. Il browser fa il ripiego per carattere: nessun controllo sui glifi.

### 3.5 Render ed export

- Render su richiesta e scelte di export accettano `locales?: string[]`. File: `outputs/vN/<instanceId>.<locale>.<ext>`. Senza lingua resta il file di oggi, nella lingua primaria.
- Il nuovo token di export `{locale}` è aggiunto al modello predefinito solo quando una creatività ha lingue extra.
- Un render localizzato con voci superate o problemi aperti chiede conferma ("render anyway") e lo segna nel manifest.

## 4. Pacchetto App Store e Google Play

### 4.1 Creare il pacchetto

- Nuovo tipo di creatività dalla schermata "New creative": **"App store pack"**. Una procedura guidata chiede:
  - app (nome, una riga di descrizione);
  - store (App Store, Google Play o entrambi);
  - dispositivi:
    - App Store: iPhone 6.9″ obbligatorio, iPad 13″ facoltativo;
    - Google Play: telefono obbligatorio, tablet facoltativo, feature graphic;
  - numero di screenshot (App Store da 1 a 10, Google Play da 2 a 8) con una didascalia ciascuno;
  - video di anteprima sì/no;
  - le schermate reali dell'app, caricate dalla libreria (immagini in `assets/`), una per screenshot.
- Il risultato è un brief normale: `brief.storePack` con le scelte, e `brief.formats` con un'istanza per screenshot e dispositivo (per esempio `appstore-iphone-69`, `appstore-iphone-69@2` …), con le etichette "Screenshot N · <didascalia>".
- Il prompt dice all'agente che si tratta di una **serie**: stessa griglia, stesso stile, didascalia in alto, schermata dell'app dentro una cornice di dispositivo generica disegnata in HTML/CSS, una storia che procede da uno screenshot al successivo.
- **Nessuna immagine ufficiale dei dispositivi** Apple o Google: le cornici sono generiche, per non usare marchi e artwork protetti.
- Le istanze dello stesso screenshot su dispositivi diversi possono seguire lo stesso primario (meccanismo `links` esistente), adattato per dispositivo.

### 4.2 Requisiti degli store

- Il core verifica, prima dell'export del pacchetto:
  - dimensioni esatte del preset;
  - PNG o JPEG;
  - per App Store, screenshot senza canale alfa: il render li appiattisce sullo sfondo;
  - video di anteprima App Store da 15 a 30 s, 30 fps, H.264, con traccia audio (silenziosa se la composizione non ha audio);
  - feature graphic di Google Play senza trasparenza.
- **Stato dei requisiti.** I limiti stanno nei preset e vanno ricontrollati sulla documentazione pubblica di Apple e Google all'inizio della fase (solo lettura delle pagine, data annotata nel commento dei preset).
- Google Play non accetta un file video: vuole un link YouTube. Il pacchetto include il video 16:9 con una nota nel README.

### 4.3 Export del pacchetto

- "Export store pack" scrive, con il meccanismo di export esistente:

  ```
  <titolo>-store-pack/
    AppStore/<locale>/<dispositivo>/01-<didascalia>.png …
    AppStore/<locale>/preview.mp4
    GooglePlay/<locale>/<dispositivo>/01-….png …
    GooglePlay/<locale>/feature-graphic.png
    README.txt
  ```

  Il README contiene i limiti verificati, l'ordine di caricamento e la nota sul video di Google Play.
- Con le lingue extra (§3) c'è una cartella per lingua.
- Un controllo fallito blocca l'export di quel file con il motivo tradotto. Il resto del pacchetto si esporta.

## 5. Fuori perimetro

- Lingue da destra a sinistra (§3.4).
- Caricamento diretto su App Store Connect o Google Play Console.
- Testi dei metadati degli store (descrizione, parole chiave).
- Traduzione automatica senza agente (servizi di traduzione esterni).
- Cambiare layout o tempi per lingua: si cambiano solo testi, voce, scala del testo e font di ripiego.

## 6. Verifica

- Test unitari e di route:
  - istanze, duplicazione, nomi di export;
  - `applyLocalization` con overlay ostili (campi non ammessi, id inesistenti, `fit` fuori intervallo, percorsi voce fuori da `assets/`);
  - riporto e testi superati;
  - conferma unica della voce;
  - requisiti dello store e layout dell'export.
- I servizi a pagamento usano solo `fetch` finto; resta attiva la guardia di rete dei test della Fase 11.
- Verifica dal vivo con un core usa e getta e haiku, senza chiavi reali:
  - duplicare un formato e iterare solo l'istanza;
  - tradurre in tedesco e giapponese due formati, con la voce in "Keep original";
  - modificare a mano una traduzione;
  - un nuovo turno che rende superato un testo;
  - un pacchetto App Store con 3 screenshot e anteprima, esportato e controllato con ffprobe e con la lettura dell'header PNG (niente alfa).
