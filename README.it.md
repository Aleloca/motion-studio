# Motion Studio

🇬🇧 [English](README.md)

App locale e open-source per creare video in motion graphics e immagini usando il tuo agente di coding (inizialmente **Claude Code**). Descrivi cosa vuoi, scegli canali e formati: l'agente produce una ricomposizione dedicata per ogni formato. Tutto resta sul tuo computer: i progetti sono cartelle con file JSON/Markdown versionate con git.

<!-- screenshot: aggiungere -->

> Il design completo è in `docs/superpowers/specs/`. Guide per chi sviluppa (in inglese): [CONTRIBUTING.md](CONTRIBUTING.md), [contratto di output](docs/output-contract.md), [provider](docs/providers.md), [backend dell'agente](docs/agent-backends.md).

## Lingua
Motion Studio è disponibile in inglese e in italiano. Al primo avvio usa la lingua del sistema: la prima delle tue lingue preferite supportata da Motion Studio, altrimenti l'inglese. Si cambia in **Impostazioni → Lingua** (Sistema / English / Italiano): l'interfaccia, i menu dell'app desktop e i messaggi del launcher da terminale cambiano lingua, e l'agente risponde e scrive i testi destinati a te nella lingua scelta. Quando l'app desktop si collega a un Motion Studio già in esecuzione, il suo menu nativo resta nella lingua con cui è partito; l'interfaccia segue il cambio subito. Per aggiungere un'altra lingua vedi [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-language) (in inglese).

I testi salvati in passato (problemi di validazione di una versione, messaggi della conversazione, linee guida del brand) non vengono tradotti; solo i testi nuovi usano la lingua corrente.

## Installazione

**App desktop (Electron).** Scarica l'installer dalla pagina *Releases* di GitHub del progetto, quando sarà pubblicato (macOS: Apple Silicon `arm64` e Intel `x64`). Le build non firmate (quelle senza i certificati dei maintainer) richiedono un passaggio in più la prima volta:
- macOS: clic destro sull'app, poi **Apri** (e conferma); un doppio clic normale viene bloccato da Gatekeeper.
- Gli aggiornamenti automatici dell'app (controllo all'avvio, installazione al riavvio) richiedono build **firmate** su macOS; con una build non firmata aggiorna scaricando a mano la nuova versione.

**Da npm.** `npx @motion-studio/cli` (il comando installato si chiama `motion-studio`), quando sarà pubblicato. Per pubblicarlo serve l'organizzazione npm `motion-studio`. Finché non lo è, usa i sorgenti.

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

Per ogni cartella di configurazione gira un solo Motion Studio: se è già avviato (dal terminale o come app desktop), `motion-studio` stampa `Motion Studio è già avviato: <indirizzo>`, lo apre nel browser (salvo `--no-open`) e termina, e l'app desktop apre quell'indirizzo invece di avviarne un altro (se quel Motion Studio si chiude, l'app propone di riavviarsi).

## Requisiti
- [Claude Code](https://docs.claude.com/claude-code) installato e autenticato (`claude auth login`)
- Git
- FFmpeg (serve per renderizzare le composizioni in video; le immagini fisse non ne hanno bisogno; senza, le creatività vecchie risultano "non verificate")
- Solo per la CLI (`npx`): Google Chrome o Chromium, che renderizza le composizioni. Se manca, **Impostazioni → System check** propone di scaricare Chrome for Testing nella cartella dati di Motion Studio, solo dopo averne mostrato la dimensione e con il tuo consenso. L'app desktop renderizza con il proprio Chromium.
- Node.js 22+ per `npx` e per i sorgenti (non serve per l'app desktop)

## Come funziona
1. In un progetto apri **Creatività → + Nuova creatività**, descrivi cosa vuoi, scegli canali e formati e premi **Genera**.
2. L'agente lavora in `creatives/<data-titolo>/work/` e consegna in `outputs/vN/compositions/<formato>/` una **composizione** per formato: un `composition.json` (scene, tracce, testi, forme, immagini, video, audio, animazioni, livelli HTML facoltativi) e gli `assets/` che usa ([contratto completo](docs/output-contract.md)). L'agente non renderizza mai i media finali e non installa renderer.
3. Motion Studio controlla ogni composizione (schema, file, durata rispetto al brief): se qualcosa non torna chiede all'agente di correggere, fino a 3 tentativi in totale; poi salva la versione, anche se incompleta. Poi crea una storyboard (un piccolo fotogramma per scena) per ogni formato.
4. Le tavole mostrano le storyboard e riproducono un'**anteprima dal vivo** della composizione: non serve aspettare un render. Una versione nasce "Not rendered".
5. **Render ★** (o un export che ne ha bisogno) renderizza le versioni ★ sul tuo computer, fuori dalla sandbox dell'agente: un mp4 (H.264, BT.709) per i video, un file immagine per le fisse (un png se il formato lo prevede, altrimenti un jpg o webp tra quelli ammessi), con i target di codifica di ogni formato. Un render non blocca mai l'agente: i render aspettano in una coda propria, uno alla volta. Una modifica successiva crea una nuova versione, e il render di un'altra versione non viene mai toccato; rifare il render della stessa versione ne sostituisce il file.
6. Ogni versione è un commit git del progetto. Dalla pagina della creatività puoi aprire un formato, aggiungere commenti su un punto/istante, chiedere modifiche, confrontare versioni e ripartire da una versione precedente. Una creatività fatta prima delle composizioni tiene i suoi video; alla modifica successiva l'agente la converte in composizione (la chat avvisa che quel turno costa più token).

### Consumi e token
Ogni lavoro dell'agente (turno di una creatività, tentativo di correzione, analisi del brand, descrizione degli asset) aggiunge una riga a `<progetto>/.studio/usage.jsonl` con i token riportati da Claude Code per quel turno e, quando è noto, il costo ai prezzi di listino delle API. Il file si scrive solo in coda ed è protetto dall'agente.
- **Prima i token, poi il costo.** La cifra mostrata è token di input + output + scrittura in cache; le letture dalla cache stanno solo nei dettagli. Con un abbonamento Claude il costo compare come "ai prezzi API sarebbe circa …", perché il consumo conta sul piano.
- **Dove si vede:** contatore dal vivo sul lavoro in corso, totale di oggi nella barra in alto (apre **Impostazioni → Usage**), centro attività (per lavoro, più "Today · N tokens"), scheda di ogni versione nella conversazione, ogni analisi del brand, il brief della creatività e **Impostazioni → Usage** (ultimi 7 giorni, per progetto e per tipo di lavoro). Il modulo della nuova creatività stima un intervallo dalle tue prime generazioni passate.
- **Sessioni riprese:** per una sessione ripresa Claude Code riporta il costo cumulativo, quindi ogni riga salva la differenza dal turno precedente della stessa sessione; se non si può calcolare, il costo resta vuoto e marcato come stimato.
- **Niente numeri inventati:** i lavori precedenti a questa funzione non hanno cifre ("Tracked since …") e i valori mancanti mostrano "—" o vengono nascosti.
- **File pesanti:** un video con bitrate oltre 1,5 volte un obiettivo ragionevole per la sua misura (per esempio circa 4 Mbps per un reel 1080×1920 a 30 fps) riceve il chip "large" con peso, bitrate e obiettivo. È solo un avviso: non fa mai fallire l'output.

### Esporta
Dalla pagina della creatività, **Esporta** copia la versione ★ di ogni formato in una cartella a tua scelta (nell'app desktop c'è anche **Scegli…**). Ogni riga mostra il nome finale del file, "★ vN" (e "vM più recente" se esiste una versione più nuova) e "segue …" per un formato che ne segue un altro: si esporta come file proprio dalla versione ★ del suo principale. I nomi vengono da uno schema con le variabili `{title} {channel} {format} {ratio} {v} {date}` (predefinito `{title}-{format}-v{v}`, es. `lancio-instagram-reel-9x16-v2.mp4`); ogni valore diventa uno slug, gli altri caratteri diventano `-`, il nome è limitato a 120 caratteri prima dell'estensione, `{date}` è il giorno mostrato nella finestra (`AAAA-MM-GG`), i nomi riservati di Windows come `CON` o `NUL` ricevono un `_` e le variabili sconosciute vengono omesse (la finestra le segnala). La finestra mostra l'anteprima dei nomi mentre scrivi e **Salva come predefinito** salva lo schema per il workspace. Se due formati avrebbero lo stesso nome (senza distinguere maiuscole e minuscole) l'export viene rifiutato: aggiungi `{format}`. Non sovrascrive mai nulla (se il nome esiste aggiunge `-2`, `-3`…) e rifiuta le destinazioni dentro il workspace di Motion Studio. Una ★ il cui file manca, è un link simbolico o un hard link non si può esportare: la finestra la disattiva e l'export la rifiuta prima di copiare qualsiasi file. Una ★ in forma di composizione non ancora renderizzata (o con un render non aggiornato) viene prima renderizzata, mostrando l'avanzamento, e poi copiata.

### Aggiungere formati
Se in una creatività già generata aggiungi formati al brief e premi di nuovo **Genera**, Motion Studio chiede all'agente di aggiungere solo le composizioni mancanti, riusando i sorgenti già presenti in `work/` e lo stesso stile della versione precedente. Un formato collegato a un altro (per esempio TikTok che segue il Reel) non richiede l'agente: condivide la composizione e il render del suo principale. In una creatività fatta prima delle composizioni, aggiungere solo formati collegati continua a non richiedere l'agente: sono copie del video del loro principale, come prima. Aggiungere un altro formato, o rigenerare, converte ogni formato in composizione con l'agente; l'editor del brief lo dice prima di **Salva e rigenera**, perché quel turno costa più token.

### Modificare una composizione direttamente
Nella vista di un formato, **Modifica** (o **Apri l’editor** su una tavola) apre l'editor sulla versione mostrata. Un formato che ne segue un altro apre la composizione del suo principale, e l'intestazione dice quali formati la condividono. L'editor ha le scene (o, per un'immagine fissa, i livelli) a sinistra, il palco con l'anteprima dal vivo al centro, la timeline sotto un video, e **Ispettore** e **Chat** a destra.

- **Cosa puoi cambiare:**
  - di un testo, contenuto, carattere (uno della composizione, o un carattere del brand kit che ha un file: il file viene aggiunto alla composizione), peso (solo quelli dichiarati per il carattere), dimensione, colore e allineamento;
  - posizione, dimensione, rotazione e opacità: con le maniglie sul palco (con aggancio a guide, area sicura e quadro), con i numeri dell'ispettore, o spostando con Alt+frecce;
  - i tempi: accorciare e spostare le clip sulla timeline (con aggancio, che Alt disattiva), con **Ripple** per spingere le scene successive quando una clip si allunga; l'ordine delle scene, quando ogni clip sta in una sola scena;
  - le animazioni predefinite di entrata e di uscita;
  - un file di immagine, immagine vettoriale, video o audio, sostituito dalla libreria del progetto o caricato lì (un video più corto della clip lo segnala e propone "Adatta la clip al video"); inizio del taglio e volume di un video; volume e dissolvenze di una clip audio;
  - i parametri di un livello HTML;
  - nascondere e bloccare clip e tracce, e silenziare le tracce audio.

  Nuove clip, livelli, animazioni personalizzate, effetti e nuove scene restano all'agente: chiedili in chat.
- **Annulla e ripristina:** ⌘Z e ⇧⌘Z (Ctrl su Windows e Linux), mai mentre scrivi in un campo. Un trascinamento, o una raffica di battute, è un passo solo.
- **Salva:** la pillola "Bozza · N modifiche" offre **Salva come vN** e **Scarta**.
  - Il salvataggio crea una nuova versione normale (`origin: editor`) la cui richiesta è il riepilogo delle modifiche, per esempio "Direct edits: Title text, font Schibsted Grotesk".
  - Non parte nessun agente e non si usano token: il registro dei consumi non riceve righe.
  - Gli altri formati vengono portati; i formati che seguono quello modificato vengono ricontrollati (uno che non può più seguirlo, per esempio perché supera la sua durata massima, viene scollegato e la chat lo dice).
  - I render vengono portati solo per le composizioni invariate, e le storyboard si rifanno.
- **La bozza non si perde per sorpresa:**
  - uscire dall'editor con modifiche non salvate (indietro, un altro formato o versione, un link, un messaggio in chat) chiede "Salva · Scarta · Continua a modificare";
  - ricaricare o chiudere la pagina chiede la conferma del browser (o dell'app, anche per ⌘R e Vista → Ricarica), e un ricaricamento confermato la bozza la perde davvero.
- **Mentre altri lavorano:**
  - mentre gira un turno dell'agente o un render della creatività, il salvataggio non è disponibile (anche il core lo rifiuta);
  - se nel frattempo un turno o un altro salvataggio ha cambiato lo stesso formato, il salvataggio viene rifiutato e la bozza resta; **Riapri sull'ultima versione** la scarta dopo una conferma;
  - un turno su un altro formato non blocca il salvataggio.
- **Commenti per l'agente:** oltre che su un punto del quadro, un commento può riguardare una clip (**Commenta la clip**, o `C` con una clip selezionata) o un intervallo di tempo (**Commenta un intervallo**, o `R`, o Maiusc+trascinamento sul righello), nell'editor e nella vista formato. Il chip nella chat nomina la clip o l'intervallo, e il prompt dell'agente riporta id e nome della clip o l'intervallo, con un fotogramma (due per un intervallo).

Una durata cambiata nell'editor è una tua scelta: la versione resta completa anche se è molto diversa da quella del brief, e la vista formato mostra accanto la durata del brief ("7 s · brief 6 s (modifica diretta)"). Al turno successivo l'agente riceve l'indicazione di mantenere la durata attuale, a meno che tu non ne chieda un'altra; se vuoi che coincidano, aggiorna tu la durata del brief.

Limiti attuali: le build desktop firmate dipendono dai certificati dei maintainer (vedi Rilascio). Su Ubuntu 24.04 e successive l'AppImage può non avviarsi perché il sistema limita i namespace utente non privilegiati (AppArmor, `kernel.apparmor_restrict_unprivileged_userns`), che servono alla sandbox di Chromium: serve un profilo AppArmor per l'app (o, a tuo rischio, disattivare quella restrizione); evita `--no-sandbox`, che toglie l'isolamento della finestra.

## Sicurezza
- **Sandbox dell'agente** (macOS; Linux con `bubblewrap` e `socat`): ogni lavoro dell'agente gira isolato. Può scrivere solo nella cartella del progetto, non può leggere cartelle sensibili (`~/.ssh`, credenziali cloud, portachiavi, configurazione di Motion Studio). La rete dipende dal lavoro: creatività e console usano solo registri di pacchetti, CDN e i domini che aggiungi in **Impostazioni → Rete**; l'analisi brand non ha rete nella sandbox: legge le pagine con `WebFetch` e scarica loghi e font solo con lo strumento `download_file` di Motion Studio, che blocca gli indirizzi privati o locali (controllati sull'IP risolto, a ogni redirect); la descrizione degli asset non ha rete. La sandbox non ripiega sull'esecuzione libera: se non riesce ad avviarsi i comandi non partono, e l'agente non può chiedere di eseguire un comando fuori da essa.
- **File che configurano Motion Studio e l'agente**: in ogni lavoro, con o senza sandbox, l'agente non può modificare `.git/`, `.claude/`, `.studio/`, `CLAUDE.md`, `CLAUDE.local.md` e `.mcp.json` del progetto; Motion Studio esegue git senza hook del progetto.
- **Codebase collegate**: leggibili, mai scrivibili (anche dagli interpreti, grazie alla sandbox); Motion Studio segnala comunque se una codebase git cambia durante un turno.
- **Approvazioni**: tutto ciò che esce dal perimetro (es. installare un programma, scrivere fuori dal progetto) compare come richiesta nella pagina del lavoro e in alto a destra: *Consenti una volta*, *Sempre per questo progetto* (revocabile in Impostazioni del progetto) o *Nega*. "Sempre per questo progetto" è offerto solo per una breve lista di comandi sicuri (`ls`, `mkdir`, `ffprobe`, ottimizzatori di immagini), per cartelle fuori dalle posizioni sensibili e dal workspace, per domini web e per i provider a pagamento; gli altri comandi si approvano una volta per volta. Le regole stanno in `<progetto>/.studio/permissions.json`, protetto dall'agente. Senza risposta entro 10 minuti la richiesta viene negata.
- **Approvazione automatica dei comandi in sandbox** (**Project settings → Agent and approvals**, attiva di default, condivisa da tutti i progetti): un comando shell parte senza chiedere solo se valgono tutte queste condizioni: è un comando `Bash`, il lavoro gira nella sandbox, l'impostazione era attiva all'avvio del lavoro ed è ancora attiva, e l'agente non ha chiesto di eseguirlo fuori dalla sandbox (`dangerouslyDisableSandbox`). Vale per creatività, analisi del brand e descrizione degli asset. È sicura perché un comando approvato resta comunque nella sandbox (verificato dal vivo: anche approvato non scrive fuori dalle cartelle consentite e non raggiunge altri siti). Alle stesse condizioni è approvata anche la lettura di un file nella cartella temporanea per utente di Claude Code (`/tmp/claude-<uid>`, dove possono finire i fotogrammi di controllo dell'agente), mai il resto della cartella temporanea; all'agente si chiede di tenere i fotogrammi in `creatives/<slug>/work/tmp/` dentro il progetto, che non viene mai versionata. Tutto il resto chiede ancora: altri file fuori dal progetto, provider a pagamento, siti nuovi. Ogni comando o lettura approvati così compaiono nella conversazione ("N commands ran automatically in the sandbox · Details", con spiegazione a parole e indicatori di rischio) e, per l'analisi del brand, sulla scheda dell'analisi e nell'elenco Analyses della pagina Brand (dal `log.jsonl` della proposta). L'impostazione **vale per i nuovi lavori**: accenderla non cambia i lavori già in corso; spegnerla vale dalla loro richiesta successiva.
- **Spiegazione dei comandi**: le schede di approvazione e le approvazioni automatiche descrivono il comando a parole con indicatori di rischio (per esempio "Complex command", "Deletes files"), calcolati da Motion Studio sul comando stesso; quando non è sicuro lo dice e valuta il comando almeno medio invece di indovinare. Il motivo scritto dall'agente compare solo come citazione ("The agent says: …") e non sostituisce mai la spiegazione. Il comando completo resta sempre in **Show command**.
- **Chiavi API**: nel portachiavi del sistema (o nelle variabili d'ambiente `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`); l'agente non le vede mai: le variabili delle chiavi vengono tolte dall'ambiente dell'agente (e del suo server MCP) e gli strumenti MCP chiedono a Motion Studio di chiamare i provider.
- **Costi**: generazioni di immagini, voci fuori campo, effetti sonori e musica chiedono conferma prima di ogni chiamata, sia dall'agente sia da **Genera** negli Asset (disattivabile in Impostazioni con **Chiedi conferma prima di usare provider a pagamento**).
- **Codice di accesso dell'interfaccia**: le API di Motion Studio rispondono solo all'interfaccia aperta dal link del terminale (il codice sta in `ui-token` nella cartella di configurazione). È una difesa contro richieste locali estranee, per esempio pagine web aperte nel browser o programmi che non conoscono il codice; non è una barriera contro un processo dello stesso utente che può leggere la cartella di configurazione.
- **Senza sandbox** (Windows, Linux senza bubblewrap, o isolamento disattivato): Motion Studio usa l'elenco ristretto di comandi della fase precedente e lo segnala nel Doctor e nelle Impostazioni. Senza sandbox i comandi consentiti (node, python, npm/npx, pip, ffmpeg) possono leggere e scrivere ovunque e contattare Motion Studio stesso: usa la sandbox. Possono anche leggere la cartella di configurazione di Motion Studio, compresi il token dell'interfaccia (`ui-token`) e i token del bridge dei lavori in corso in quel momento (`run/*.token`): con il primo un programma può usare tutta l'interfaccia di Motion Studio, approvazioni comprese; con un token del bridge può agire come quel lavoro in corso, nel suo progetto e con i suoi strumenti (una chiamata a pagamento chiede comunque conferma, salvo una regola "Sempre"). Gli strumenti Read, Grep e Glob dell'agente sono negati su quella cartella in ogni modalità, e una richiesta di permesso che nomina un percorso al suo interno viene rifiutata senza chiederti nulla; i comandi non passano da questo controllo. In particolare un interprete avviato dall'agente potrebbe modificare `.studio/permissions.json`: Motion Studio accetta solo regole nei formati che "Sempre per questo progetto" può produrre (comandi sicuri, cartelle fuori dalle posizioni sensibili e dal workspace, domini web, conferme dei provider), quindi l'agente potrebbe concedersi quei permessi o saltare la conferma di costo di un provider, ma non andare oltre quei limiti.
- **Composizioni (codice scritto dall'agente che gira fuori dalla sandbox).** Una composizione può contenere livelli HTML scritti dall'agente, e Motion Studio la renderizza fuori dalla sandbox, per questo è isolata su quattro livelli:
  - un server locale suo (il composition server), su un'origine diversa dall'interfaccia, raggiungibile solo con un token breve, in sola lettura e limitato a una composizione, che serve solo il runtime e gli `assets/` e i `layers/` di quella composizione (niente link, niente percorsi fuori, controllo contro il DNS rebinding);
  - intestazioni rigide su ogni file: una Content-Security-Policy senza rete (`connect-src 'none'`), ogni livello HTML nel suo frame isolato;
  - nel render, una pagina Chromium con ogni richiesta fuori dal composition server bloccata (intercettazione delle richieste più un proxy "morto"), WebRTC e worker senza uscita, un controllo di tempo e memoria, e l'intero gruppo di processi chiuso in caso di annullamento, timeout o crash. L'app desktop usa finestre Electron nascoste e isolate, ognuna con una sessione in memoria propria; la CLI usa Chrome con un profilo usa e getta nella cartella temporanea;
  - nell'interfaccia, l'anteprima dal vivo è un iframe con solo `sandbox="allow-scripts"` (senza `allow-same-origin`), sull'origine del composition server, e i messaggi che invia vengono controllati. L'app desktop annulla anche ogni richiesta o navigazione di un frame dell'anteprima che esce dal composition server.

  Una composizione non riceve mai il codice di accesso dell'interfaccia, le chiavi API o la rete. Le immagini delle storyboard passano da URL firmati che scadono dopo pochi minuti. Ogni API di Motion Studio richiede comunque il codice di accesso dell'interfaccia.
- **Output non verificati:** senza ffmpeg/ffprobe installati Motion Studio non può controllare davvero risoluzione e durata, e mostra gli output come "non verificati".

## Provider
| Strumento | Provider | Chiave |
|---|---|---|
| Immagini | OpenAI gpt-image-2 | `OPENAI_API_KEY` |
| Voce fuori campo | OpenAI TTS, ElevenLabs | `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` |
| Effetti sonori, musica, elenco voci | ElevenLabs | `ELEVENLABS_API_KEY` |
| Foto e video stock | Pexels, Unsplash | `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` |
| Font | Google Fonts | nessuna |

Gli asset di stock conservano l'attribuzione richiesta da Pexels e Unsplash (campo `attribution` in `assets/assets.json`). Dettagli (in inglese) in [docs/providers.md](docs/providers.md).

- **Verifica delle chiavi**: in **Impostazioni → Servizi a pagamento**, salvare una chiave (e il pulsante **Prova** di ogni riga) la prova con richieste gratuite e di sola lettura e mostra cosa può fare, per capacità: funziona, manca (con il permesso da attivare sul sito del fornitore), non verificata (solo una generazione a pagamento può dirlo) o errore (rete, tempo scaduto, 5xx, limite di richieste). Una chiave che il fornitore non conosce mostra "Il servizio non accetta questa chiave". I risultati restano nella memoria di Motion Studio: mai su disco, mai con la chiave.
- **Servizi per creatività**: il brief (in **Nuova creatività → Altre opzioni**, nell'editor del brief e dietro il chip **Servizi** nel compositore della chat) dice quali servizi esterni l'agente può usare, per tipo: immagini (Auto, OpenAI, Solo stock, Spento), voce (Auto, OpenAI, ElevenLabs, Spento), musica ed effetti sonori (Auto, ElevenLabs, Spento). Auto è il comportamento di prima. Motion Studio applica la scelta in ogni strumento dell'agente, prima di qualunque conferma o richiesta: un tipo spento viene rifiutato, un fornitore scelto non viene mai sostituito con un altro e uno senza chiave viene rifiutato. L'agente conosce la scelta e, se chiedi qualcosa di spento, ti indica il pulsante Servizi. Un fornitore senza chiave non si può scegliere. Una modifica vale dal messaggio successivo. **Genera** negli Asset non cambia (è un'azione tua).

## Brand, asset e codebase collegate
- **Brand**: palette, font, loghi, tono, cose da fare e da evitare, stile fotografico; ogni voce mostra da dove arriva (manuale, sito, immagine). Le linee guida discorsive sono in `brand/guidelines.md`.
- **Font**: **Tipografia → + Aggiungi da Google Fonts** cerca nel catalogo di Google Fonts, mostra l'anteprima di ogni famiglia nel suo carattere (servita da Motion Studio: la pagina non carica mai Google) e aggiunge i pesi che spunti (e il corsivo) in `assets/fonts/` con origine `google-fonts`; il font del brand viene collegato al suo file. Aggiungere una famiglia già presente nel brand le aggiunge i pesi nuovi. **+ Aggiungi a mano** collega ancora i tuoi file.
- **Suono**: la sezione **Suono** della pagina Brand contiene genere, energia, strumenti da usare e da evitare e la voce del brand, che si sceglie con la chiave del fornitore impostata: le voci ElevenLabs dell'account, con anteprima, o l'elenco fisso di OpenAI (senza anteprima: ascoltarla sarebbe una chiamata a pagamento). L'agente la segue quando sceglie musica, effetti sonori e voci.
- **Analisi brand**: aggiungi uno o più siti (e le immagini di riferimento con "Usa per l'analisi brand") e premi **Analizza brand**. L'analisi mostra le sue fasi (lettura, font, colori, loghi, tono, scrittura). I font vengono per primi: lo strumento `inspect_site_fonts` legge l'HTML e i fogli di stile del sito e dice quali font usa e da dove arrivano; poi i font Google vengono scaricati in `assets/fonts/`, quelli ospitati dal sito scaricati (con "licenza sconosciuta" nel riepilogo), quelli Adobe e di sistema solo nominati. L'agente visita i siti, scarica gli asset utili in `assets/` e propone modifiche: le applichi voce per voce, le voci inserite a mano non vengono mai rimosse. L'agente lavora su copie: brand kit, linee guida, sorgenti e metadati di asset e riferimenti non possono essere modificati dagli strumenti di modifica e, se l'agente li cambia comunque, Motion Studio annulla la modifica e lo segnala.
- **Asset e riferimenti**: carica file trascinandoli, filtra per tipo e origine, aggiungi descrizioni e tag (anche con **Descrivi con l'agente**). Audio e video si riproducono nei dettagli dell'asset (l'audio con la sua forma d'onda); durata, dimensione e misure vengono lette dai file. **Rinomina il file** rinomina un asset e aggiorna il brand kit e i brief che lo usano. Ordina per data, nome, tipo o durata ("Più lunghi").
- **Genera** (Asset): crea un'immagine (OpenAI), una voce fuori campo (OpenAI o ElevenLabs), un effetto sonoro o una musica (ElevenLabs) direttamente nella libreria, dopo la solita conferma a pagamento. Una scheda è disponibile solo con la chiave del suo fornitore.
- **Codebase collegate** (Impostazioni del progetto o della singola creatività): cartelle del tuo computer che l'agente può leggere; gli strumenti di modifica sono bloccati su ogni turno e, se una cartella è un repository git e risulta modificata dopo un turno, la conversazione lo segnala. Non puoi collegare la cartella del progetto o del workspace, una cartella che le contiene né una cartella al loro interno.

Con la sandbox attiva gli interpreti non possono scrivere nelle codebase collegate. Senza sandbox le regole bloccano solo gli strumenti di modifica dell'agente: gli interpreti (per esempio node o python) potrebbero comunque scrivere nella cartella. Motion Studio rileva e segnala le modifiche solo nelle cartelle che sono repository git; per le altre le modifiche non verrebbero rilevate. Collega preferibilmente repository git con le modifiche già committate.

Consiglio generale: analizza solo siti di cui ti fidi.

## Limiti attuali dell'agente
- **Console del progetto:** con la sandbox attiva i comandi girano isolati; fuori dalla sandbox l'agente può modificare i file del progetto, ma le richieste che richiedono un'approvazione compaiono nell'interfaccia (vedi Sicurezza).
- **Provider di immagini, voce, suoni, musica e stock:** sono descritti in [docs/providers.md](docs/providers.md) ma non sono stati verificati dal vivo con chiavi reali (i test usano risposte simulate). La verifica delle chiavi è stata provata dal vivo solo contro un servizio simulato; Google Fonts e la lettura dei font del sito nell'analisi del brand sono stati provati dal vivo (vedi `docs/superpowers/notes/2026-10-13-phase11-live-checks.md`).

## Sviluppo
```bash
pnpm install
pnpm dev                  # core (tsx watch, porta 4317) + web (Vite, porta 5173 con proxy /api); il core stampa il link con il codice di accesso
pnpm test                 # tutti i test (usano un finto `claude`, nessun consumo di quota)
npx vitest run packages/core/test/server.test.ts   # un singolo file (dalla radice del repository)
pnpm typecheck
pnpm check:i18n           # segnala testo italiano rimasto nel codice fuori dai cataloghi delle lingue
pnpm build                # web + bundle del pacchetto npm (apps/cli/dist)
pnpm motion-studio        # build + avvio del pacchetto locale

pnpm --filter motion-studio-desktop dev        # app Electron in sviluppo (prima: `pnpm --filter @motion-studio/web build && pnpm --filter motion-studio-desktop build`)
pnpm --filter motion-studio-desktop smoke      # avvio di prova dell'app con una configurazione temporanea
pnpm --filter motion-studio-desktop dist:dir   # app non impacchettata in apps/desktop/release (solo l'architettura di questo computer)
pnpm --filter motion-studio-desktop dist:mac   # installer locale (dist:win, dist:linux; senza argomento: la piattaforma corrente)
```

Variabili utili:
- `MOTION_STUDIO_CONFIG_DIR` — dove salvare la config dell'app (percorso del workspace).
- `MOTION_STUDIO_CLAUDE_COMMAND` — comando dell'agente come array JSON, es. `["node","/percorso/fake-claude.mjs"]`.

Per contribuire vedi [CONTRIBUTING.md](CONTRIBUTING.md).

## Rilascio
Per i maintainer. Allinea la versione in `apps/desktop/package.json` e `apps/cli/package.json`, poi crea e pubblica il tag `vX.Y.Z` corrispondente: ogni job del workflow `.github/workflows/release.yml` si ferma subito se il tag non coincide con entrambe le versioni. Il workflow costruisce l'app desktop su macOS (`arm64` e `x64`), Windows e Linux e crea una **bozza** di release su GitHub con gli installer (da pubblicare a mano); in parallelo, se `NPM_TOKEN` è presente, pubblica `@motion-studio/cli` su npm (un errore in una build desktop non lo blocca). La CI (`ci.yml`) esegue il controllo dei tipi, il controllo delle lingue (`pnpm check:i18n`) e i test a ogni push su `main` e sulle pull request.

Segreti del repository usati dal workflow (tutti facoltativi: senza, la build è non firmata o l'npm viene saltato):
- macOS (firma e notarizzazione): `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Senza `MAC_CERT_P12_BASE64` la firma è disattivata; la notarizzazione parte solo se ci sono il certificato (`MAC_CERT_P12_BASE64`) e tutti e tre i segreti `APPLE_*`, altrimenti è disattivata esplicitamente.
- Windows: `WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD`.
- npm: `NPM_TOKEN`.
- `GITHUB_TOKEN` è fornito da GitHub Actions.

## Licenza
MIT
