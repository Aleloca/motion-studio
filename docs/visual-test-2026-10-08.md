# Prova visiva — annotazioni (2026-10-08)

## Stato dopo la Fase 7 (redesign, branch `feat/phase7-redesign-ui`)
Legenda: **✅ Fase 7** risolto, con una nota su come; **◐** parziale, resta aperto; **⏳ Fase N** rimandato alla fase indicata. Le differenze rimaste rispetto alle tavole sono in `.superpowers/sdd/2026-10-08-motion-studio-phase7-redesign-ui/visual-diff.md` (non versionato).
- Redesign UX/UI: **✅ Fase 7**. Nuovo design system (`ui/`), animazioni (`motion/`), barre e centro attività (`shell/`) e tutte le schermate riscritte; le vecchie schermate e i vecchi componenti sono stati rimossi.
- Loghi dei canali: **✅ Fase 7** (Simple Icons in `ChannelMark`, nella tavola dei formati, nelle schede, nel canvas e nell'export).
- Controlli nativi: **✅ Fase 7**. Niente `<select>`, checkbox, radio o maniglie delle textarea; un test impedisce anche i colori letterali in `screens/` e `shell/`.
- Tema: **✅ Fase 7**, spostato in Impostazioni → General con anteprime.
- Progetto nuovo: **✅ Fase 7**, stato vuoto con "Set up the brand" e "New creative"; i filtri mostrano i conteggi.
- Pagina Brand: **✅ Fase 7**, sezioni con navigazione, gerarchia e controlli propri.
- Nuove funzioni: consumo di token e costi **⏳ Fase 8**; traduttore dei comandi **⏳ Fase 8**; vista editor dei video **⏳ Fase 10**.

## Da fare DOPO i test: redesign UX/UI (richiesta esplicita dell'utente)
- Giudizio dell'utente: "UX generale super AI-slop". Problemi: niente icone, elenchi confusionari. Va ripensata l'esperienza nel suo complesso, non con ritocchi.
- **Mancano i loghi dei canali** (Instagram, TikTok, YouTube, Facebook, LinkedIn, X, Pinterest, App Store, Play Store) nella tavola dei formati, nelle anteprime e nell'export. → Icone dei marchi (es. Simple Icons, licenza CC0; rispettare le linee guida d'uso dei marchi), più icone generiche per Web e per video/immagine.
- Controlli nativi del browser ovunque: checkbox, select, radio, textarea con la maniglia di ridimensionamento. → Servono componenti propri e coerenti, con stati di focus, hover e disabilitato.
- Sui bottoni del tema: "Sistema / Chiaro / Scuro" sono sempre visibili nella barra in alto e si possono confondere con "Sistema" della lingua.

- Un progetto nuovo si apre su Creatività vuote, con 7 filtri di stato mostrati anche quando non c'è nessuna creatività. Manca una guida al primo passo (per esempio "imposta il brand, poi crea la prima creatività").
- Pagina Brand: select nativi del browser e nessuna gerarchia visiva.

## Bug e lacune funzionali
1. Il Doctor completo compare solo nell'onboarding. Nelle Impostazioni c'è solo lo stato della sandbox, quindi non c'è un posto per ricontrollare l'ambiente dopo la configurazione. → Aggiungere "Stato del sistema" nelle Impostazioni, con un pulsante "Ricontrolla".
    → **✅ Fase 7:** Impostazioni → System check con il Doctor completo e "Check again".
2. Durante l'analisi del brand la pagina mostra solo "Analyzing…", senza fasi né avanzamento, e non c'è modo di vedere cosa sta facendo l'agente. Gli eventi esistono già (`report_progress`, eventi dello stream), ma la pagina Brand non li mostra. → Mostrare le fasi (lettura del sito, download dei loghi, font, proposta) e un riquadro con l'attività dell'agente, come nella creatività.
    → **✅ Fase 7:** (presentazione) la pagina Brand mostra passi e avanzamento dell'analisi dal vivo, dagli eventi del job.
3. Scheda di approvazione dei comandi: mostra il comando shell grezzo senza spiegare a parole cosa fa e perché. → Titolo in linguaggio comune generato dall'agente (passato a `approve` come motivo) oppure ricavato dal comando; il comando completo resta visibile in un "Dettagli".
    → **⏳ Fase 8** (spiegazione deterministica dei comandi). In Fase 7 la scheda ha già titolo, frase descrittiva, chip di contesto e il comando completo in "Show command".
4. Durante l'analisi accanto al sito resta scritto "Never analyzed". → Mostrare "Analysis in progress".
    → **✅ Fase 7:** durante l'analisi la fonte mostra "Analysis in progress".
5. L'analisi del brand chiede approvazioni frequenti per comandi innocui sui file del progetto (`ls`, `file`, `sips` verso `$TMPDIR`), perché nei lavori brand `autoAllowBash` è false e i comandi composti non possono avere "Sempre". → Valutare se approvare in automatico nei lavori brand i comandi in sandbox senza rete, come per le creatività.
    → **⏳ Fase 8** (approvazione automatica).
6. 🔴 **Il comando nella scheda di approvazione sembra tagliato**: il riquadro ha `max-height: 7.5em` con scorrimento, ma su macOS la barra di scorrimento è nascosta, quindi l'utente crede di aver visto tutto. → Indicatore esplicito "Mostra tutto (N righe)" o sfumatura in fondo, numero di righe visibile; mai approvare senza capire che c'è altro testo. È un problema di trasparenza, da correggere per primo.
    → **✅ Fase 7:** "Show command" mostra il comando completo con a capo, numero di righe e invito a scorrere; dice quando il core lo ha accorciato.
7. Per lo stesso motivo del punto 5: nell'analisi brand ogni elaborazione di immagini (colori dominanti) richiede un'approvazione.
    → **⏳ Fase 8.**
8. Un'analisi brand ha chiesto 4 approvazioni, tutte per comandi innocui: conversione webp in png, colori dominanti (due volte) e validazione JSON della proposta. → Uno strumento MCP `validate_brand_proposal` per la verifica, e l'approvazione automatica dei comandi in sandbox nei lavori brand (vedi il punto 5).
    → **⏳ Fase 8.**
9. A fine analisi la proposta compare in cima alla pagina mentre l'utente guarda in fondo, vicino alle approvazioni: nessun segnale, nessuno scorrimento, nessuna notifica. → Al termine, scorrere fino alla proposta o mostrare un avviso "Proposta pronta – Rivedi" vicino al pulsante; notifica di sistema se la finestra non è in primo piano.
    → **✅ Fase 7:** a fine analisi la revisione si apre da sola; se l'utente sta facendo altro compare il toast "Suggestions ready · Review" (più la notifica).
10. **Font non identificati** ("could not be identified from the page content"). `WebFetch` converte l'HTML in testo e perde CSS e `@font-face`, quindi l'agente non vede i font del sito. → Uno strumento del core, `inspect_site_fonts(url)`, che scarichi i fogli di stile con `safeFetch` ed estragga `font-family`, `@font-face` e i link a Google Fonts; poi `fonts_fetch` sul risultato.
    → **⏳ Fase 11.**
11. Revisione della proposta:
    - **i loghi sono mostrati solo come percorso**, senza miniatura, quindi non si può verificare cosa si sta approvando;
    - "— →" ripetuto su ogni riga (attuale vuoto → proposto) è rumore;
    - il testo è duplicato a sinistra (etichetta della checkbox) e a destra (valore proposto);
    - nelle sezioni Do/Avoid la checkbox sta da sola su una riga;
    - le linee guida sono Markdown grezzo in monospace invece che renderizzato;
    - non ci sono "Seleziona tutto/nessuno" per sezione.
    → **✅ Fase 7:** foglio di revisione con anteprime vere (colori, specimen, loghi), selezione per elemento e per gruppo, Markdown renderizzato, "Apply N of M" con Undo.
12. Qualità dell'analisi (half-story.com): contenuto accurato e specifico (palette campionata dalle immagini, tono, regole do/avoid). Non ha trovato i font (vedi il punto 10).
    → **⏳ Fase 11** (font dai CSS del sito).
13. **Aggiungere un font a mano è scomodo**: si scrive il nome della famiglia a mano, e il file si può solo scegliere tra i font già caricati negli asset. Dalla UI non si può cercare e scaricare un Google Font (lo fa solo l'agente con `fonts_fetch`), e l'anteprima "Aa Bb" funziona solo se il font è installato nel sistema. → Campo di ricerca Google Fonts con anteprima, che scarica il font negli asset e lo collega al brand.
    → **⏳ Fase 11** (ricerca Google Fonts dall'interfaccia).
14. **Salvataggio del brand senza feedback**: dopo "Save" non compare nessuno stato in corso né conferma (salvato/errore). → Stato del pulsante (Saving…/Saved ✓), modifiche non salvate evidenziate, avviso se si esce con modifiche pendenti.
    → **✅ Fase 7:** salvataggio con stato "Saving…" / "All changes saved" ed errori spiegati.
15. **Campo della famiglia del font**: accetta un intero stack CSS (`Newsreader, "Newsreader Fallback", Georgia, serif`) come nome della famiglia. → Normalizzare alla prima famiglia oppure avvisare. L'anteprima "Aa Bb Cc" usa il font di sistema se il font non è installato, quindi è fuorviante: va caricato il file del font (dagli asset o da Google Fonts) o indicato "anteprima non disponibile".
    → **✅ Fase 7:** all'inserimento la famiglia si normalizza alla prima dello stack; lo specimen usa il file del font del progetto, altrimenti dice "Preview unavailable".
16. **Pagina Assets**:
    - riga dei filtri con select nativi piccoli accanto a una ricerca enorme;
    - le schede mostrano il percorso `brand/…` in monospace come titolo;
    - nessuna descrizione o tag visibile finché non si lancia "Describe with the agent";
    - il primo logo (SVG bianco) è su sfondo scuro, ok, ma la scheda non dice che è un logo;
    - griglia con molto spazio vuoto.
    L'utente giudica il design "brutto": rientra nel redesign.
    → **✅ Fase 7:** pagina ridisegnata: filtri per tipo, origine e tag; nome leggibile; descrizione, tag e origine nelle schede.
17. **Descrizioni e tag degli asset invisibili nelle schede**: l'analisi del brand li aveva già scritti, ma si vedono solo aprendo il dettaglio. "Describe with the agent" risponde "No assets to describe" senza spiegare che tutti sono già descritti. → Descrizione breve e tag nelle schede; il pulsante mostra quanti asset sono senza descrizione ("Describe 0 assets" disabilitato con tooltip) e c'è un'opzione "Rigenera le descrizioni" per selezione.
    → **✅ Fase 7:** descrizione e tag nelle schede; riga "N assets without a description · Describe them".
18. **"Describe with the agent" non dice quali asset descriverà** (né quanti), e durante il lavoro le schede coinvolte non sono segnalate. → Selezione esplicita (checkbox sulle schede; default "senza descrizione: N") e stato "Describing…" su ogni scheda interessata.
    → **✅ Fase 7:** selezione multipla con "Describe again"; stato "Describing…" sulle schede coinvolte.
19. **Dettaglio dell'asset**: textarea della descrizione bassa (3 righe, testo tagliato); tag in un campo di testo unico e tagliato invece che come chip; il pannello laterale restringe la griglia.
    → **✅ Fase 7:** pannello di dettaglio con descrizione ampia e tag come chip.
20. **Tavola dei formati**: "Post 1:1" (video) e "Image 1:1" (statico) sono indistinguibili; mancano le icone video/immagine e la durata o tipo nella pillola. La tavola dei 40 formati è un muro di pillole senza gerarchia; le righe App Store e Play Store vanno a capo male (pillole orfane sotto l'etichetta del canale). L'anteprima "What you'll get" è valida come idea, ma ha solo riquadri tratteggiati con le dimensioni.
    → **✅ Fase 7:** tavola per canale con loghi, icona video/immagine, proporzione disegnata, durata massima, filtro Video/Image, ricerca e "More channels".
21. **"Assets to use" è un campo testo con percorsi separati da virgole**. → Selettore visuale con miniature dalla libreria, con i loghi del brand già proposti.
    → **✅ Fase 7:** selettore di asset a miniature dalla libreria.
22. 🔴 **Il pannello della conversazione rompe la larghezza della finestra**: un percorso lungo in un comando senza spazi spinge la pagina oltre lo schermo (scroll orizzontale). → `min-width: 0` sulle colonne, `overflow-wrap: anywhere` sul `<pre>` dei comandi.
    → **✅ Fase 7:** colonne con `min-width: 0` e comandi a capo. Verifica visiva: nessuno scorrimento orizzontale a 1440 e 1024 px, in chiaro e scuro.
23. 🔴 **Ambiente di render assente**: nella prima creatività l'agente ha provato Playwright via npm (la cache di npm non è scrivibile nella sandbox), poi è passato a Python creando un `.venv` in `work/` e installando con pip Pillow, numpy e cairosvg. Ogni creatività rischia di ripartire da zero, con minuti persi, approvazioni e fallimenti. → (a) cache di npm e pip in una cartella scrivibile per la sandbox (es. `<configDir>/cache/{npm,pip}` passata come variabile d'ambiente e in `--add-dir`); (b) un "render kit" preinstallato e condiviso tra le creatività (ambiente Python con Pillow, numpy, cairosvg e/o Remotion), preparato dal Doctor o al primo uso con il consenso dell'utente; (c) indicare nel prompt cosa è già disponibile.
    → **⏳ Fase 10.**
24. 🔴 **Nelle creatività arrivano approvazioni nonostante `autoAllowBashIfSandboxed: true`** (verificato sugli argomenti del processo `claude` in esecuzione: sandbox attiva, `failIfUnavailable`, `acceptEdits`). Hanno chiesto conferma `pkill …; cd … && rm -rf .venv && pip install …` e `time PYTHONPATH=pydeps python3 render.py ../outputs/v1 2>&1 | tail -5`, cioè anche il render stesso. Ipotesi: Claude Code chiede sempre conferma per comandi con assegnazioni di variabili d'ambiente, `time`, pipe, `;`, `pkill` o `rm -rf`, anche in sandbox. → Riprodurre con Haiku, capire le regole effettive di Claude Code 2.1.29x e decidere: (a) regole `allow` mirate per i comandi in `work/` (es. `Bash(python3:*)` non basta per `PYTHONPATH=… python3`); (b) indicazioni nel prompt ("don't prefix commands with env vars or time; use separate commands"); (c) auto-approvazione dal nostro `approve` per i comandi che girano nella sandbox delle creatività, se Claude Code passa comunque dal permission-prompt-tool.
    → **⏳ Fase 8.**

25. **Conversazione**: tutto l'avanzamento del turno sta in un'unica bubble che si aggiorna continuamente, ed è difficile da seguire. → Ogni messaggio o passaggio dell'agente in una bubble separata con timestamp; approvazioni come elementi a sé nel flusso, nel punto in cui sono arrivate; il riepilogo finale del turno distinto dai passaggi intermedi, che si possono comprimere a turno concluso.
    → **✅ Fase 7:** un messaggio per bubble con orario, passi compatti, approvazioni nel punto in cui arrivano, risultato distinto.

26. **Vista esperto (tab Expert)**: il contenuto è lunghissimo e lo scroll muove tutta la pagina. → Pannello con altezza fissa e scroll interno, con aggancio all'ultimo evento ("segui"), filtri per tipo di evento e possibilità di comprimere gli output lunghi dei tool.
    → **✅ Fase 7:** la vista Expert non c'è più: i dettagli tecnici stanno in "Activity details", richiudibile e con scorrimento interno. Anche la scheda "Agent console" del progetto è stata tolta (i vecchi link `#/p/<progetto>/console` aprono le creatività).
27. 🔴 **Output enormi**: `instagram-reel-9x16.mp4` di 6 s pesa 78 MB, mentre per la pubblicazione sarebbero ragionevoli 3–8 MB. Il contratto degli output non verifica peso e bitrate. → Limiti per canale nel catalogo dei formati (es. bitrate massimo, peso massimo; Instagram e TikTok hanno limiti reali), validazione con un messaggio chiaro, indicazioni nel prompt di codifica (H.264, CRF 18–23, `yuv420p`, `+faststart`, AAC).
    → **⏳ Fase 8 o 10** (peso dei video, legato al render kit).

28. 🔴 **Nessun segnale quando serve un'approvazione.** Oggi `App.tsx` crea una `Notification` solo se `document.visibilityState === 'hidden'` e il permesso è stato concesso dal pulsante "Enable notifications". Con la finestra visibile ma l'utente in un'altra parte della pagina non arriva nulla, e l'approvazione rischia di scadere. → In-app: banner o toast fisso con "Vai alla richiesta", conteggio nel titolo della finestra, suono opzionale. Desktop: `app.dock.setBadge(n)`, `app.dock.bounce('informational')`, notifica nativa dal main process senza passaggio di permesso. Conto alla rovescia visibile nella scheda e avviso a 1 minuto dalla scadenza.
    → **✅ Fase 7:** toast con Review, contatore sulla campanella, "(N)" nel titolo, badge e rimbalzo del Dock, notifica nativa dal main anche a finestra visibile (si spegne in Settings → Notifications), conto alla rovescia nella scheda.

29. ~~Approvazione ripetuta~~: falso allarme, l'utente non aveva cliccato. Però dimostra quanto sia facile perdere di vista una richiesta (vedi il punto 28).
30. 🔴🔴 **PRIORITÀ MASSIMA — troppe approvazioni**: una creatività ha chiesto 5 o più conferme (pip install, render, render più ffprobe, manifest) e un'analisi brand 4. L'utente: "dovrò approvarli OGNI volta?". → Impostazione di progetto, **attiva di default**, "Approva automaticamente i comandi in sandbox": il nostro strumento `approve` risponde `allow` a ogni Bash nei lavori con sandbox attiva (creatività e brand), e chiede all'utente solo ciò che esce dalla sandbox (Edit/Write fuori dal progetto, provider a pagamento, domini non consentiti, WebFetch fuori whitelist). Prima va verificato che i comandi passati da `approve` restino comunque nella sandbox (`allowUnsandboxedCommands: false`): se è così, auto-approvarli non riduce la sicurezza. Questo assorbe i punti 5, 7, 8 e 24.
    → **⏳ Fase 8.**

31. **Miniatura del reel nera**: usa il primo fotogramma, che è nero per la dissolvenza in apertura. → Poster da un fotogramma rappresentativo (es. 40% della durata, oppure scelto dall'agente nel manifest) e riproduzione al passaggio del mouse.
    → **◐ Fase 7, aperto:** le copertine usano l'anteprima del core (fotogramma a 0,5 s); manca la riproduzione al passaggio del mouse (fix wave della Fase 7).
32. **Markdown non renderizzato nella conversazione** (`**grassetto**`, backtick, elenchi). → Render Markdown sicuro (senza HTML).
    → **✅ Fase 7:** Markdown sicuro, senza HTML.
33. 🔴🔴 **Chromium non gira nella sandbox** ("mach-port permission denied"): Playwright, Puppeteer e Remotion (cioè il render basato su browser, il più adatto alla motion graphics) sono impossibili nelle creatività. L'agente ripiega su Python/Pillow più ffmpeg, che è limitato. → Opzioni: (a) capire quali permessi Seatbelt servono a Chromium (mach-lookup verso alcuni servizi) e se le impostazioni sandbox di Claude Code permettono di concederli in modo mirato; (b) uno strumento MCP `render_web(composition, formats)` eseguito dal core fuori dalla sandbox, in un processo Chromium isolato e senza rete, che renderizza HTML/CSS/JS dalla cartella `work/` in fotogrammi o mp4; (c) Remotion lanciato dal core come renderer controllato. Va valutato insieme al punto 23 (render kit). Impatta direttamente la qualità del prodotto.
    → **⏳ Fase 10.**
34. La conversazione mostra dettagli tecnici di basso livello ("mach-port permission denied", "venv's old pip is stalling"). → Separare messaggi per l'utente (cosa sta facendo, a che punto è) da quelli tecnici (vista esperto); istruire l'agente a usare `report_progress` per l'utente.
    → **✅ Fase 7:** (presentazione) in primo piano solo i messaggi per l'utente; i dettagli tecnici in "Activity details".
35. Pagina della creatività: grande area vuota a destra delle anteprime; titolo della creatività = obiettivo del brief in minuscolo ("promuovere il caso della settimana"), meglio un titolo generato o modificabile.
    → **✅ Fase 7:** titolo breve modificabile, generato dal brief; canvas con le tavole in proporzione e pannello laterale.

36. **Le finestre modali non si chiudono cliccando fuori** (lo fa solo Escape o "Close"). → Clic sullo sfondo per chiudere, salvo quando ci sono modifiche non salvate.
    → **✅ Fase 7:** clic sul velo ed Esc chiudono i modali e i popover (solo il livello più alto).
37. **Safe zone incomprensibile**: le bande viola compaiono solo sulle miniature, senza legenda, e non nella vista grande dove servono. → Overlay anche nel focus, con etichette ("Coperto dall'interfaccia di Instagram: nome account / didascalia e pulsanti") e una legenda accanto all'interruttore.
    → **✅ Fase 7:** safe zone anche nella vista del formato, con legenda.
38. **Commenti sui video poco chiari**: "Add comment" su un video chiede di cliccare un punto; la spiegazione ("The comment uses the video's current time") è una riga minuscola in fondo. → Flusso esplicito: pausa automatica, mirino, tooltip "Clicca il punto del fotogramma a 0:05"; possibilità di un commento senza punto (sull'intero video o su un intervallo di tempo); marcatori dei commenti sulla timeline.
    → **✅ Fase 7:** pausa, invito "Click the spot of the frame at 00:02.50", marcatori sulla barra. Il commento senza punto o su un intervallo arriva con le fasi 9–10.
39. Il player usa i controlli nativi del browser. → Player proprio con timeline, avanzamento fotogramma per fotogramma, loop e velocità.
    → **◐ Fase 7, aperto:** player proprio con play/pausa, scorrimento e fotogramma per fotogramma; mancano loop e velocità (fix wave della Fase 7).

40. 🔴 **Commenti puntuali senza testo**: sul media si lasciano solo segnaposti numerati; il testo va scritto a parte in "Request a change", dove i segnaposti diventano chip. L'utente si aspettava di scrivere accanto al punto. Inoltre:
    - i segnaposti non si possono spostare né cancellare sul media (solo la × sulla chip);
    - i segnaposti di altri istanti (3.0 s) restano visibili sul fotogramma a 5 s;
    - è facile crearne per sbaglio (3 segnaposti per una sola modifica).
    → Commenti in stile Figma: clic, fumetto con campo di testo, invio; ogni commento ha il proprio testo, si può modificare, spostare e cancellare; i segnaposti sono **legati al fotogramma**: compaiono solo vicino al loro istante (±0,5 s) e spariscono durante la riproduzione o lo scorrimento della timeline (confermato dall'utente: "il commento rimaneva lì mentre il video andava avanti e indietro"); restano segnati sulla timeline; "Applica i commenti" crea la nuova versione con tutti i commenti aperti.
    → **✅ Fase 7:** commenti in stile Figma con il loro testo, modificabili e cancellabili, legati al fotogramma.

41. **Versioni**: passare tra v1 e v2 e "Restart from v1" funzionano, ma l'utente giudica la UX e la UI "veramente brutte". → Nel redesign: cronologia delle versioni visuale (miniature, data, richiesta che l'ha generata, chi o cosa è cambiato), confronto affiancato tra due versioni, azioni chiare ("Riparti da qui" con spiegazione di cosa succede alle versioni successive).
    → **✅ Fase 7:** menu delle versioni con miniatura, ora e nota, "Restart from here" con la spiegazione, "Compare" con slider.

42. **Aggiunta di formati con specifiche identiche**: la v3 (TikTok e Shorts aggiunti a una creatività con Reel 9:16) è stata completata in circa 3 min e l'agente ha copiato lo stesso file (stesso MD5) per i tre formati, quindi nessun nuovo render. L'utente però percepiva "sta rigenerando tutto". → (a) Riuso automatico nel core, senza agente, quando dimensioni, safe zone e durata sono compatibili con un output esistente: zero token, pochi secondi. (b) Stato chiaro ("Aggiungo 2 formati riusando la v2"). (c) Un solo file su disco per più formati (hard link o riferimento nel manifest; attenzione ai controlli `nlink > 1` delle letture confinate, che vanno rivisti per gli output). (d) Safe zone di TikTok distinta da quella dei Reels (pulsanti laterali e didascalia più alti).
    → **⏳ Fase 9.**
43. Il `renderCommand` registrato per la v2 inizia con `python3 -m pip install --target pydeps …`, cioè l'installazione delle dipendenze dentro il comando di render. → Il contratto dovrebbe separare il setup dal render (`setupCommand` / `renderCommand`), oppure il render kit del punto 23 lo rende superfluo.
    → **⏳ Fase 10.**

44. **Nomi dei file esportati lunghissimi**: `2026-10-08-promuovere-il-caso-della-settimana-instagram-reel-9x16-v3.mp4`, perché lo slug della creatività contiene data e obiettivo del brief. → Titolo breve della creatività (vedi il punto 35) e schema di nome configurabile (es. `{progetto}-{canale}-{formato}-v{n}`).
    → **✅ Fase 7:** i nomi seguono il titolo breve (`<titolo>-<formato>-v<n>.<ext>`). Lo schema configurabile arriva con la Fase 9.
45. **Finestra di export**: l'etichetta "Destination folder (absolute path)" è tecnica; dopo il successo il pulsante "Export" resta attivo (rischio di doppio export con suffisso -2); manca la scelta dei formati da esportare; manca il ricordo dell'ultima cartella usata.
    → **✅ Fase 7:** modale con etichette chiare, scelta dei formati, ultima cartella ricordata, avanzamento e schermata di successo con "Show in Finder".

## Nuove funzioni richieste
- **Consumo di token e costi visibili all'utente.** Oggi `claude-stream-parser` legge solo `total_cost_usd` dall'evento `result`, mostrato soltanto nella console o vista esperto, per turno e senza somme; `usage` (input, output, cache read e cache creation tokens) e `modelUsage` vengono ignorati. → Leggere `usage` e `modelUsage`; salvare token e costo per lavoro (versione di creatività, analisi brand, descrizione asset) in `versions.json` e nei metadati dei job; mostrarli nella scheda della versione o dell'analisi, con totali per creatività e per progetto; contatore in tempo reale durante il lavoro; indicare "stima a tariffa API" quando Claude Code usa un abbonamento (il costo è teorico).

- **Traduttore dei comandi nelle approvazioni** (richiesta dell'utente, estende il punto 3). La scheda dice in linguaggio chiaro cosa si sta approvando; il comando completo resta visibile espandendo "Dettagli". Proposta in tre livelli, dal più affidabile:
  1. **Indicatori ricavati dal core analizzando il comando** (deterministici, non falsificabili dall'agente): "Cancella file in work/", "Installa pacchetti da internet", "Termina processi", "Scrive fuori dal progetto", "Usa la rete". Ogni indicatore ha un colore di rischio.
  2. **Frase per i comandi noti**, presa da un dizionario del core (ls, cp, rm, mkdir, pip/npm install, ffmpeg, sips, python -c…). Per esempio: "Ricrea l'ambiente Python della creatività e installa Pillow, numpy e cairosvg".
  3. **Motivo dichiarato dall'agente**, mostrato come citazione ("L'agente dice: …"). È utile ma non garantito, perché un agente compromesso potrebbe descrivere male il comando: non deve mai sostituire i livelli 1 e 2.
  In alternativa, per i comandi non riconosciuti, un riassunto fatto da un modello piccolo e indipendente dall'agente (es. Haiku), con un piccolo costo per richiesta.
- **Vista "editor" dei video in stile iMovie** (richiesta dell'utente). Oltre al render finale, mostrare la composizione del video: scene/shot su una timeline, tracce (illustrazioni/asset, testi, logo, transizioni, audio), con inizio e fine di ogni elemento; commenti su un clip o su un intervallo specifico; in prospettiva modifiche dirette. Proposta a fasi:
  1. **Timeline in sola lettura**: il contratto degli output si estende con una sezione `timeline` nel manifest (tracce → clip {id, tipo, start, end, asset/testo, note}) che l'agente compila; la UI la disegna sotto il player sincronizzata con la riproduzione; si commenta un clip o un intervallo, e il commento arriva all'agente con l'id del clip.
  2. **Modifiche dirette dei parametri**: l'agente rende il render parametrico (`work/composition.json` con testi, durate, ordine, asset); dalla timeline l'utente cambia testo, durata o ordine, e il core rilancia `renderCommand` senza agente (veloce e senza costo di token), creando una nuova versione.
  3. **Editor completo** (taglio, spostamento, sostituzione di asset), da valutare dopo le prime due.
  Dipende dalla scelta del motore di render (punti 23 e 33): con un render basato su web o Remotion la composizione è già strutturata ed esportabile come timeline.

## OK
- Tema chiaro leggibile (stessi problemi di UX della versione scura); finestra a 1024 px senza fuoriuscite; elenco dei permessi "Always" del progetto vuoto con messaggio esplicativo.
- Export della v3 in una cartella scelta con il selettore nativo del Finder: 4 file con nomi per canale e versione, "Show in folder" funzionante.
- Aggiunta di formati (TikTok e YouTube Shorts): v3 completata in circa 3 min riusando il video della v2.
- Cambio di versione v1/v2 e "Restart from v1" presenti e funzionanti.
- v2 generata correttamente con le modifiche richieste tramite commenti (logo più piccolo, fotogramma finale più lungo).
- Reel 9:16 giudicato "carino" dall'utente, testo leggibile, 6 s.
- Prima creatività completata: v1 Ready, validazione superata. Immagine 1:1 di buona qualità e coerente con il brand (palette, Newsreader, logo, accento arancione unico). L'agente ha guardato i propri fotogrammi di prova e corretto un difetto (lo stacco sull'illustrazione della città) prima di consegnare.
- L'agente ha usato il font Newsreader aggiunto a mano nel brand, scaricandolo da solo (`assets/fonts/Newsreader-400.ttf`).
- Caricamento di un asset (abdul_wahab.png) e descrizione automatica in inglese, accurata e coerente con lo stile del brand. Il dettaglio con descrizione e tag modificabili funziona.
- Analisi del brand completata e applicata: colori, loghi, tono e regole visibili nella pagina Brand.
- Creazione del progetto "Half Story"; interfaccia in inglese dopo il cambio lingua.
- Avvio dell'app desktop, scelta del workspace, cambio lingua, impostazioni.
