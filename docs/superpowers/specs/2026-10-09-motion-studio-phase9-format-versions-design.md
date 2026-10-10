# Motion Studio — Fase 9: Versioni per formato — Specifica

> Programma: `docs/superpowers/specs/2026-10-08-motion-studio-redesign-design.md` §2.
>
> Fonti:
> - punto 42 del test visivo e "nomi configurabili" (`docs/visual-test-2026-10-08.md`);
> - segnalazione dell'utente del 2026-10-09 sul confronto dei video;
> - prototipo, `docs/design/redesign-prototype/` (`creative.js` `VersionsPopover`, `modals.js` `ExportDialog` e `CompareDialog`, `data.js` `linkable`/`follows`/`star`).

## 1. Perché

Oggi una versione appartiene a tutta la creatività: `outputs/vN/` contiene un file per ogni formato. L'utente invece ragiona **per formato**:
- "il Reel mi piace nella v5, il post quadrato nella v2";
- "esporto le versioni buone".

Ci sono altri tre problemi:
- se una modifica riguarda solo il Reel, il menu delle versioni non lo dice;
- aggiungere formati identici, come TikTok e Shorts accanto a un Reel 9:16, fa lavorare l'agente per minuti e lascia l'impressione che "rigeneri tutto" (punto 42);
- il confronto con lo slider va bene per le immagini, ma non per i video (segnalazione dell'utente).

## 2. Modello

### 2.1 Cronologia per formato (derivata, nessuna migrazione)

- Le versioni della creatività restano come sono: `outputs/vN/`, `versions.json`, un commit per versione.
- Per ogni file di output il core calcola uno **hash del contenuto** (sha256, in streaming), salvato in `OutputFileInfo.sha256`. È un campo facoltativo: per le versioni vecchie si calcola al primo accesso e si mette in cache, senza riscrivere i file.
- La **cronologia del formato F** contiene le versioni della creatività in cui il file di F è nuovo o diverso dal precedente. Una versione in cui F è identico alla versione prima non compare nella cronologia di F.
  - Ogni voce indica il numero di versione della creatività `vN`, che resta l'identificatore unico in tutta l'app, insieme all'ora, alla richiesta e ai token (Fase 8).
  - Nessuna rinumerazione: se il Reel cambia nelle v1, v3 e v5, la sua cronologia è v1, v3, v5.

### 2.2 Versione da esportare (★) per formato

- Il file `creative.json` riceve un campo facoltativo `exportPicks: Record<formatId, number>`.
- **Regola predefinita**: senza scelta, la ★ di un formato è la **versione più recente**, nella cronologia di F, in cui F non ha problemi. Se tutte ne hanno, è la più recente.
- **Scelta manuale**: l'utente mette la ★ su una versione. Da quel momento la ★ resta lì anche quando arrivano versioni nuove, e l'interfaccia segnala "v7 newer". La scelta manuale si cancella solo quando coincide con la versione che darebbe la regola predefinita. Così si può mettere la ★ anche su una versione recente che ha problemi.
- La ★ non cambia mai da sola su una versione scelta dall'utente.

### 2.3 Formati collegati

- Due formati sono **collegabili** quando hanno:
  - lo stesso tipo (video o immagine);
  - la stessa risoluzione;
  - estensioni compatibili;
  - una durata del file principale che rientra nel limite del formato collegato;
  - safe zone compatibili: l'area sicura del formato collegato **contiene** quella del principale, cioè i margini del collegato sono minori o uguali. Così ciò che è al sicuro sul principale lo è anche sul collegato.

  Il catalogo calcola la compatibilità, con il campo `linkGroup` o una funzione `canFollow(a, b)`.
- Il brief riceve `links: Record<formatId, formatId>` (seguace → principale). Alla creazione è **attivo di default** per le coppie collegabili: il primo formato di ogni gruppo è il principale. Si attiva o disattiva dalla tavola dei formati di New creative e dal canvas con "Unlink — make a dedicated version" o "Link to …".
- **Effetto sul lavoro:**
  - l'agente riceve solo i formati principali;
  - dopo la validazione, il core **materializza** ogni formato seguace copiando il file del principale in `outputs/vN/<seguace>.<ext>`;
  - l'operazione costa zero token;
  - nel manifest, il formato seguace ha la voce `followsFormat`.
  
  Il file è una copia e non un hard link, perché i controlli `nlink > 1` delle letture confinate restano invariati.
- La ★ di un formato seguace è sempre quella del principale: ha la scritta "follows Reel ★ v5" e non ha una ★ propria.
- **Scollegare** un formato fa sì che la richiesta successiva lo dia all'agente come formato proprio: "Make a dedicated TikTok version…".

### 2.4 Formati aggiunti senza agente (punto 42)

Quando l'utente aggiunge al brief formati che sono **tutti** collegabili a formati già presenti nell'ultima versione:
- il core crea `v(N+1)` senza avviare l'agente:
  - copia gli output dell'ultima versione;
  - materializza i nuovi formati come seguaci;
  - aggiorna il manifest;
  - fa la validazione e il commit;
- costa zero token e richiede pochi secondi;
- in chat compare "Added TikTok and Shorts using the Reel (v5) · no agent needed";
- se anche un solo formato aggiunto non è collegabile, il flusso resta quello attuale, con l'agente, ma i formati collegabili vengono comunque materializzati dal core.

### 2.5 Modifiche mirate

Una cronologia per formato ha senso solo se i formati non toccati restano **identici**. Per questo la richiesta di modifica dice a quali formati si applica.

- **Composer:** selettore "Applies to", con queste opzioni:
  - "All formats";
  - un formato o più formati (multiselezione con le chip dei formati principali).

  Il valore predefinito sono i formati dei commenti allegati, se ce ne sono; altrimenti "All formats" nel canvas e il formato stesso nella vista del formato. Il turno dell'API riceve `formats?: string[]`.
- **Core:**
  - l'agente riceve solo i formati indicati (più la consegna in `outputs/vN/`);
  - dopo la validazione, il core **copia senza modifiche** dalla versione di partenza (`resumeFrom` oppure l'ultima) gli output degli altri formati, poi materializza i seguaci;
  - la validazione controlla solo i formati consegnati dall'agente, mentre per quelli copiati vale il controllo esistente sulla presenza;
  - i token si spendono solo per ciò che cambia.
- **Formato seguace:** se un formato seguace è tra quelli indicati, la richiesta si applica al suo principale, e l'interfaccia lo dice: "TikTok follows the Reel: the change applies to both".

## 3. Interfaccia

### 3.1 Canvas

Da `creative.js`, `CanvasView` e `VersionsPopover`.

- **Colonna dei formati:** ogni riga mostra "★ v5" oppure "follows Reel".
- **Tavole:**
  - ogni tavola ha un **badge di versione** proprio, "★ v5 ▾", che apre il `VersionsPopover` del formato con:
    - le voci della cronologia di F, con miniatura, `vN`, ora e nota;
    - la ★ cliccabile, con il toast "v3 will be exported for Reel";
    - l'etichetta "Auto" sulla voce scelta dalla regola predefinita, con tooltip "Starred automatically: the newest version without problems"; con una scelta manuale, l'azione "Reset to Auto" in fondo al popover cancella la scelta;
    - in fondo, Compare e "Restart from here";
  - la tavola mostra la ★ come impostazione predefinita;
  - si può *guardare* un'altra versione senza cambiare la ★, con la scritta "viewing v3";
  - le tavole dei formati seguaci mostrano il file del principale, con la chip "Linked to Reel" e il menu Unlink.
- **Selettore di versione nella barra in alto:** non serve più per scegliere cosa vedere. Diventa "Versions" e apre la cronologia della creatività (tutte le vN con le richieste), da cui si raggiungono "Restart from here" e "Show in Finder".
- **Vista del formato:** stesso badge e stesso popover.

### 3.2 Confronto

- Il confronto si apre per un formato e propone due versioni, scelte tra la cronologia del formato con le chip.
- **Immagini:** slider sovrapposto come oggi (default), con l'alternativa "Side by side".
- **Video:**
  - **due player affiancati e sincronizzati** (default), ciascuno con l'etichetta della versione;
  - **un solo controllo condiviso**: play e pausa, barra, fotogramma ←/→, loop e velocità;
  - si sincronizzano sul tempo del player di sinistra e correggono la deriva oltre 1 fotogramma;
  - con durate diverse, la barra arriva alla durata più lunga e il video più corto resta fermo sull'ultimo fotogramma;
  - alternativa "Overlay", cioè lo slider su un fotogramma in pausa.
- Azioni: "★ Use vA for export" e "★ Use vB for export".

### 3.3 Export

Da `modals.js` `ExportDialog`.

- Il titolo è "Export the starred versions": una riga per formato con miniatura, nome del file finale, "★ v5", la nota "v7 newer" se c'è, la checkbox, e per i seguaci la scritta "follows Reel".
- **Schema dei nomi:**
  - campo con variabili `{title} {channel} {format} {ratio} {v} {date}`;
  - anteprima dal vivo del primo nome;
  - si salva come predefinito del workspace (`exportNamePattern`, default `{title}-{format}-v{v}`);
  - si validano i caratteri, la lunghezza massima e l'unicità dei nomi nell'export. Se due formati darebbero lo stesso nome, compare un errore in linea con il suggerimento di aggiungere `{format}`.
- **Core:** l'export accetta `picks: Record<formatId, number>` al posto di una sola versione. Le regole di sicurezza restano invariate: niente sovrascritture, confinamento, cartelle del workspace rifiutate.

## 4. Fuori perimetro

- Hard link o deduplicazione su disco: si usano copie. Gli output non sono in git; i file copiati occupano spazio su disco, accettabile con i pesi della Fase 8.
- Rinumerazione delle versioni per formato.
- Confronto tra formati diversi.
- "Restart from here" per singolo formato: il ripristino resta per creatività.

## 5. Verifica

- **Test del core:**
  - hash e cronologia per formato, comprese le versioni vecchie senza hash;
  - regola predefinita della ★ e scelta manuale;
  - materializzazione dei seguaci e manifest;
  - aggiunta di formati senza agente (zero lanci di `claude`) e aggiunta mista;
  - modifica mirata: un turno con `formats: ['reel']` consegna solo il Reel; il post viene copiato identico (stesso sha256) e la sua cronologia non cresce;
  - export con le scelte e lo schema dei nomi;
  - formato seguace con una durata oltre il limite: in quel caso non è collegabile.
- **Test del web:**
  - badge e popover per tavola;
  - ★ e "viewing";
  - Unlink e Link;
  - confronto video sincronizzato con media finti, durate diverse e deriva;
  - anteprima dei nomi ed errore di collisione.
- **Verifica dal vivo con Haiku:**
  - una creatività con Reel e post 1:1;
  - una modifica solo al Reel, dopo la quale la cronologia del post non cresce;
  - aggiunta di TikTok e Shorts: zero token e pochi secondi;
  - export delle ★ con uno schema personalizzato.
- **Screenshot**, in chiaro e scuro.
