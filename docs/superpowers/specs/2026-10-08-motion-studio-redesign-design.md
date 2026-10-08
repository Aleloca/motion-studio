# Motion Studio — Redesign (programma fasi 7–11) e specifica della Fase 7

**Data:** 2026-10-08 · **Stato:** in revisione · **Sorgenti di verità visive:**
- Prototipo navigabile (layout, interazioni, animazioni): https://claude.ai/artifact/9fLFkK5iBx77pWWGbrxDJv
- Canvas delle schermate, chiaro e scuro: https://claude.ai/artifact/DJacCEhN7XU9nHCEKkGS2B
- Prototipo delle animazioni: https://claude.ai/artifact/GjUAVjJdN7WBtRb5zzHmRP
- Annotazioni del test visivo: `docs/visual-test-2026-10-08.md`

Il prototipo è il riferimento per aspetto, struttura e movimento. Dove questa specifica e il prototipo divergono, vale la specifica.

## 1. Perché

Nel test visivo del 2026-10-08 l'utente ha giudicato l'interfaccia "AI-slop": niente icone, controlli nativi del browser, nessuna gerarchia, testi tecnici, nessun riscontro sulle azioni. Il redesign è stato definito insieme all'utente:
- tre direzioni messe a confronto;
- direzione B scelta e rifinita sui suoi commenti;
- prototipo navigabile approvato ("veramente un ottimo lavoro, siamo pronti per l'integrazione").

Requisito esplicito dell'utente: l'app deve sembrare uno **strumento professionale a pagamento**, con **animazioni curate e funzionali** in ogni cambio di pagina, apertura e caricamento.

## 2. Programma

| Fase | Obiettivo | Dipende da |
|---|---|---|
| **7 · Nuova interfaccia** | Design system, sistema di animazioni, nuova struttura e tutte le schermate ridisegnate sulle funzioni esistenti; centro attività, avvisi, notifiche desktop | — |
| **8 · Approvazioni e consumi** | Approvazione automatica dei comandi in sandbox; spiegazione dei comandi in linguaggio chiaro (indicatori deterministici, frasi per i comandi noti, motivo dell'agente); token e costo per lavoro, progetto e settimana | 7 |
| **9 · Versioni per formato** | Cronologia per formato; ★ "usata per l'export" per formato; formati collegati (stesso file); confronto; export delle versioni ★ con schema dei nomi | 7 |
| **10 · Composizioni modificabili** | Render dedicato fuori dalla sandbox (Chromium/Remotion controllato dal core); timeline dei video e livelli delle immagini nel manifest; modifiche dirette che rifanno il render senza agente e senza token | 7, 9 |
| **11 · Brand e asset** | Ricerca e download di Google Fonts dall'interfaccia; font ricavati dai CSS del sito; avanzamento dell'analisi; miglioramenti degli asset | 7 |

Ogni fase ha la sua specifica e il suo piano. Questo documento specifica in dettaglio solo la **Fase 7**. Le fasi 8–11 sono descritte quanto basta perché la 7 prepari gli spazi giusti senza simulare funzioni che non esistono.

**Regola per le funzioni future dentro la Fase 7.** Un elemento del prototipo che dipende da una fase successiva:
- non compare, oppure compare in forma **sola lettura** e senza numeri inventati;
- non mostra mai dati finti;
- si accende quando arriva la fase corrispondente.

I casi sono elencati nella §6.

## 3. Principi

1. **Il contenuto è protagonista.** Fotogrammi, tavole e immagini grandi; l'interfaccia arretra (grigi neutri, un solo accento).
2. **Due livelli senza interruttore.** Il default è semplice per chi non è tecnico. Gli strumenti da designer (inspector, dettagli tecnici, comando completo) sono sempre a un clic, ma mai in primo piano. La vecchia "modalità esperto" sparisce: i dettagli tecnici vivono in "Show command", nei pannelli Details e nella vista Activity.
3. **Ogni azione ha un riscontro.** Stato in corso, conferma ("Saved", "Exported 4 files"), errore spiegato con il rimedio, "Undo" dove l'azione si può annullare.
4. **Il movimento spiega.** Le transizioni dicono da dove viene e dove va un elemento (shared element dalla tavola all'editor, popover che nascono dal pulsante). Niente animazioni decorative.
5. **Linguaggio dell'utente.** Testi in inglese e italiano dai cataloghi; nessun termine interno (`stream-json`, `mach-port`, percorsi assoluti) in primo piano.

## 4. Design system

### 4.1 Token (sostituiscono `packages/web/src/theme.css`)

| Token | Chiaro | Scuro |
|---|---|---|
| `--bg` | `#F5F5F4` | `#0F0F0F` |
| `--panel` | `#FFFFFF` | `#171717` |
| `--line` / `--line2` | `#E5E5E3` / `#EFEFED` | `#2A2A2A` / `#212121` |
| `--text` / `--muted` / `--faint` | `#171717` / `#6B6B6B` / `#A3A3A3` | `#EDEDED` / `#9C9C9C` / `#6B6B6B` |
| `--field` | `#F2F2F1` | `#222222` |
| `--dot` (griglia del canvas) | `#DEDEDB` | `#262626` |
| `--ink` / `--inkText` (azione primaria) | `#171717` / `#FFFFFF` | `#EDEDED` / `#0F0F0F` |
| `--accent` | `#FF5A1F` | `#FF5A1F` |
| `--accentText` | `#E8501A` | `#FF8A5C` |
| `--sel` (selezione tenue) | `#FFF1EA` | `#2A1A12` |
| `--ok` / `--okBg` | `#2E7A4C` / `#E4F3EA` | `#6FCF97` / `#132A1D` |
| `--warn` / `--warnBg` / `--warnLine` | `#D9480F` / `#FFF5EF` / `#FFD3C0` | `#FF8A5C` / `#231711` / `#55301E` |
| `--scrim` | `rgba(23,23,23,.32)` | `rgba(0,0,0,.6)` |

I grigi sono **neutri** (richiesta esplicita dell'utente: niente dominanti blu o viola). L'accento arancione si usa per selezione, azioni importanti, stati che richiedono l'utente e indicatori di avanzamento. L'azione primaria standard è `--ink` (nero o bianco); l'arancione pieno è riservato a **Generate** e **Send**.

Struttura obbligatoria dei temi: valori chiari su `:root`; scuri in `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` e in `:root[data-theme="dark"]`. Il tema si sceglie in **Impostazioni → General**, con System come default, e non più nella barra in alto.

### 4.2 Tipografia
- Interfaccia: **Schibsted Grotesk** 400/500/600/700, da `@fontsource/schibsted-grotesk` (font inclusi nell'app, voce 10 del registro).
- Dati, codici, dimensioni: **JetBrains Mono** 400/500.
- Scala: 11 (etichette maiuscole, letter-spacing .06em) · 12 · 13 (testo base) · 15 · 18 · 20/22 (titoli di pagina) · 26–30 (titoli del setup). `text-wrap: balance` sui titoli. Numeri allineati con `tabular-nums`.
- Si rimuovono `@fontsource/manrope` e il viola.

### 4.3 Componenti (nuova cartella `packages/web/src/ui/`)
Ogni componente ha il suo test e niente stili inline per colori o spaziature: classi da `ui.css` e token.

| Componente | Note |
|---|---|
| `Button` | Varianti `default`, `ink`, `accent`, `ghost`, `outline`, `danger`; misure `sm` 28 / `md` 32 / `lg` 38; `icon`; stato `loading` con Spinner; pressione `scale(.97)` |
| `Icon` | Set SVG a tratto 1.4 (≈45 icone del prototipo); `aria-hidden` |
| `ChannelMark` | Loghi dei canali: Instagram, TikTok, YouTube, Facebook, LinkedIn, X, Pinterest, App Store, Google Play, più icona Web. **SVG ufficiali da Simple Icons (CC0)**, monocromi su riquadro colorato; nel prototipo erano sigle |
| `Field` | Campo da 28 px con etichetta interna (`X`, `IN`, `DUR`…), per gli inspector |
| `Input`, `Textarea` | 36 px, sfondo `--field`, focus con anello arancione; niente `resize` nativo visibile |
| `Toggle`, `Check`, `Segmented`, `Chip`, `Tag`, `Pill`, `VersionBadge` | Sostituiscono **tutti** i controlli nativi (checkbox, radio, select) |
| `Select` | Menu a tendina in popover, accessibile da tastiera (frecce, Invio, Esc), al posto di `<select>` |
| `Popover` | Ancorato al pulsante d'origine; si chiude con clic fuori ed Esc; focus trap leggero |
| `Modal` / `Sheet` | Velo e dialogo; si chiude con **clic sul velo** ed Esc (punto 36 del test); il focus torna al pulsante d'origine |
| `Toast` | Pila in alto al centro; `tone` ok/neutral; azione opzionale (Undo, Review, Open) |
| `Tabs`, `NavItem`, `Card`, `Empty`, `Spinner`, `Typing`, `ProgressBar`, `CountdownRing`, `Avatar` | Come nel prototipo |

Accessibilità:
- controlli veri (`button`, `input`) con `aria-label` sui pulsanti a sola icona;
- focus visibile;
- contrasto AA;
- tutto raggiungibile da tastiera.

## 5. Sistema di animazioni (`packages/web/src/motion/`)

Si usa la Web Animations API, senza dipendenze, come nel prototipo.

| Nome | Valore |
|---|---|
| Durate | `xs` 120 ms · `s` 200 ms · `m` 320 ms · `l` 480 ms |
| Curve | `std` `cubic-bezier(.2,0,0,1)` · `out` `cubic-bezier(.16,1,.3,1)` (entrate) · `in` `cubic-bezier(.4,0,1,1)` (uscite) · `spring` `cubic-bezier(.34,1.56,.64,1)` (popover, badge, toggle) |

Regole:
- **uscire è più veloce che entrare**, circa il 20% in meno;
- le cascate distanziano gli elementi di 20–40 ms;
- un'entrata **annulla sempre** le animazioni precedenti sullo stesso elemento (bug trovato nel prototipo);
- con `prefers-reduced-motion` si arriva direttamente allo stato finale.

API:
- `enter`, `exit`, `stagger`, `pop`, `pulse`, `flash`, `flip`;
- hook `useEnter`;
- componente `PageHost`, che tiene la pagina uscente durante la sua uscita e applica la direzione calcolata dalla profondità della rotta.

Catalogo delle transizioni, ognuna con il suo test di presenza:

| # | Momento | Movimento |
|---|---|---|
| T1 | Cambio pagina (più profonda / meno profonda) | La pagina uscente scorre di 16 px e sfuma (`s`, in); l'entrante arriva da 24 px nella direzione del movimento (`m`, out) |
| T2 | Cambio scheda dentro il progetto | Dissolvenza con 6 px verticali (`m`) |
| T3 | Tavola → editor | La tavola diventa il player (FLIP `l`, out); il canvas arretra; pannelli laterali da ±16 px e timeline da +24 px, con 160 ms di ritardo |
| T4 | Editor → tavola | Percorso inverso, più rapido |
| T5 | Popover | `scale(.96)` e −4 px → 1 (`s`, spring); righe in cascata di 20 ms; chiusura con dissolvenza `xs` |
| T6 | Modale / foglio | Velo in dissolvenza (`s`); dialogo `scale(.97)` → 1 (`m`, out); chiusura `xs` |
| T7 | Avviso (toast) | Discesa da −16 px (`m`); uscita −8 px (`s`) |
| T8 | Arrivo di un'approvazione | Toast, scheda in chat con 2 pulsazioni dell'alone, badge della campanella che rimbalza, anello del conto alla rovescia in tempo reale |
| T9 | Messaggi dell'agente | Ognuno entra da +8 px; prima di ogni passo compaiono i puntini di scrittura |
| T10 | Generazione in corso | Riflesso che scorre sulla tavola, barra sottile di avanzamento, passi come messaggi |
| T11 | Nuova versione pronta | Nuovo fotogramma da sfocato a nitido (`l`); il badge di versione fa un piccolo scatto (spring); toast "vN is ready" |
| T12 | Bozza / salvataggio | La pillola Draft scende; Save la trasforma in "✓ Saved", poi sparisce |
| T13 | Selezione | Riquadro di selezione e righe selezionate con transizioni `m` |
| T14 | Liste e griglie | Ingresso in cascata alla prima apparizione; i nuovi elementi entrano con `scale(.96)` |
| T15 | Rimozione | Altezza e opacità vanno a zero (`m`, in), poi toast con Undo |
| T16 | Toggle e Check | Pallino con spring; riempimento `s` |
| T17 | Passi del setup | Il pannello esce verso −16 px ed entra da +16 px |

## 6. Struttura, navigazione e schermate (Fase 7)

### 6.1 Barre
- **Globale** (Progetti, Impostazioni): logo, ricerca centrale (`⌘K` apre una palette di comandi di sola navigazione verso progetti, creatività e pagine), indicatore "N running", campanella, avatar.
- **Progetto**: logo, selettore di progetto (popover con elenco e "New project"), schede Creatives · Brand · Assets · References · Settings, indicatore, campanella, avatar.
- **Creatività / editor**: "← Creatives" o "← All formats", breadcrumb, stato, campanella, menu della versione, Export.

Rotte: le attuali di `routes.ts`, più `welcome`, `settings/:section`, `creative/:c/:format` (vista del formato). La profondità della rotta guida la direzione di T1.

### 6.2 Schermate

Per ogni schermata: l'API già esistente su cui si appoggia (nel piano: verifica degli endpoint), cosa cambia e cosa resta per dopo.

1. **Welcome (setup)**:
   - 3 passi: controllo di sistema con i check che compaiono uno a uno, workspace con selettore nativo (desktop) o campo testo (web) e anteprima delle cartelle, primo progetto (nome e sito facoltativo; con il sito parte l'analisi);
   - stepper a sinistra;
   - API: `/api/doctor`, workspace, creazione del progetto, avvio dell'analisi.
2. **Pairing**: pagina 401 ridisegnata, con il comando `--print-url` copiabile.
3. **Projects**:
   - "Jump back in" con le ultime 3 creatività di tutti i progetti, ciascuna con il suo stato (in attesa, in render con %, pronta);
   - griglia di progetti con copertina (ultime tavole) e striscia della palette;
   - "New project" in linea;
   - se manca un endpoint aggregato, il piano ne aggiunge uno di sola lettura (`GET /api/recent-creatives`).
4. **Project · Creatives**:
   - filtri a segmenti (All, Needs you, In progress, Ready, Drafts) e ricerca;
   - schede con anteprime dei formati in proporzione e stato in chiaro: approvazione in linea con Review, avanzamento con il passo, errore spiegato con Try again, bozza con Generate.
5. **New creative**:
   - brief grande con suggerimenti;
   - messaggio chiave;
   - durata a segmenti (disattivata senza formati video);
   - **selettore di asset a miniature** dalla libreria, che sostituisce il campo con i percorsi (punto 21);
   - interruttore del brand;
   - tavola dei formati con loghi dei canali, icona video/immagine, proporzione disegnata, nota sulla durata massima, filtro Video/Image e ricerca, "More channels" espandibili, icona di collegamento sui 9:16;
   - barra di riepilogo con il numero di render e la stima del **tempo**, senza token fino alla Fase 8;
   - Generate (arancione, `⌘↵`) porta al canvas, che mostra la generazione in corso (T10).
6. **Creative · canvas**:
   - colonna dei formati raggruppati per canale;
   - canvas con le tavole in proporzione, griglia a puntini, zoom e safe zone con legenda (punto 37);
   - **"Open editor"** al passaggio del mouse e doppio clic, con T3;
   - barra strumenti fluttuante: Select (V), Comment (C), Hand (H), zoom, Safe zones;
   - **commenti in stile Figma**: clic, fumetto con il campo di testo e invio; segnaposto **legati al fotogramma** per i video; modificabili e cancellabili (punti 38 e 40);
   - pannello Chat · Comments · Brief;
   - **conversazione a messaggi separati con orario** (punto 25), passi dell'agente compatti con ✓, risultato formattato in **Markdown sicuro** (punto 32), approvazioni nel flusso;
   - composer con le chip dei commenti e `⌘↵`;
   - menu della versione con la cronologia **per creatività** (Fase 9 la porterà per formato): miniatura, ora, autore, nota, "Restart from here"; **Compare** con slider tra due versioni (anche in Fase 7, sulle versioni di creatività);
   - Export.
7. **Vista del formato (anteprima dell'editor)**:
   - video: player grande con play/pausa, scorrimento sulla barra, fotogramma per fotogramma, commenti legati all'istante, colonna "Scenes" con l'**indicazione che la timeline arriva con la Fase 10**, chat a destra;
   - immagine: zoom e commenti;
   - **inspector, timeline, livelli e modifiche dirette sono esclusi dalla Fase 7**;
   - la transizione T3/T4 c'è già.
8. **Brand**:
   - navigazione per sezioni con evidenziazione allo scorrimento;
   - panoramica;
   - colori modificabili (popover con nome, hex, ruolo, rimozione con Undo);
   - tipografia con specimen (la ricerca su Google Fonts arriva in Fase 11);
   - loghi con le varianti e il riquadro "Missing: …" quando manca un logo per sfondi chiari o scuri;
   - Voice con Do e Avoid espandibili e aggiungibili;
   - stile delle immagini e linee guida renderizzate;
   - colonna con le fonti (aggiunta, Analyze again);
   - **avanzamento dell'analisi dal vivo**: passi e percentuale, alimentati dagli eventi del job (punto 2);
   - Brand health e cronologia.
9. **Brand proposal review**: foglio a schermo quasi pieno, gruppi a sinistra con i contatori, **anteprime visive vere** a destra (colori, specimen, loghi; punto 11), selezione per elemento e per gruppo, "Apply N of M", toast con Undo.
10. **Assets**:
    - filtri (tipo, origine, tag) e ricerca;
    - schede con **descrizione e tag visibili** (punto 17) e stato "Describing…" sulle schede coinvolte (punto 18);
    - **selezione multipla** con barra azioni (Describe again, Add tags, Use in a creative, Delete con Undo);
    - pannello di dettaglio con nome, descrizione e tag modificabili (tag come chip, punto 19) e metadati;
    - trascinamento su tutta la pagina, caricamento con la scheda che compare subito.
11. **References**: moodboard a colonne, link (anteprima), immagini, note, interruttore "Brand analysis" per scheda, "Analyze brand with these", rimozione con Undo.
12. **Project · Settings**:
    - sezioni General, Agent and approvals, Internet access, Linked code, Delete;
    - "Always allowed" in linguaggio chiaro con la regola tecnica sotto, revoca con T15 e Undo;
    - domini e codice collegato;
    - lavori in parallelo;
    - **l'interruttore "Approve sandboxed commands automatically" arriva con la Fase 8**.
13. **App settings**:
    - General (lingua, tema con anteprime), Paid services (chiavi nel Portachiavi con stato e test), Notifications, Updates;
    - **System check**, cioè il Doctor completo con "Check again" (punto 1);
    - **Usage arriva con la Fase 8**.
14. **Export** (modale):
    - righe per formato con miniatura, nome del file risultante e peso; selezione dei formati (piccola estensione del core: `formats?: string[]` nella richiesta di export); destinazione ricordata e selettore nativo; avanzamento e schermata di successo con "Show in Finder" (punto 45);
    - versioni ★ per formato e schema dei nomi configurabile arrivano con la Fase 9;
    - in Fase 7 i nomi seguono un titolo breve della creatività (punto 44: la creatività ottiene un **titolo modificabile**, generato dal brief alla creazione).
15. **Activity center**: popover dalla campanella con le schede Needs you (schede di approvazione complete), Running (lavori con passo e %) e Done (ultimi esiti).

### 6.3 Approvazioni, avvisi e notifiche (Fase 7)

- **Scheda di approvazione**:
  - titolo, frase descrittiva e chip di contesto, presi da quanto il core fornisce già;
  - **comando completo in "Show command"**, con a capo e scorrimento visibile: mai troncato senza segnalarlo (punto 6);
  - conto alla rovescia;
  - Allow, "Always here" se esiste una regola proponibile, Deny.
- **Segnali** (punto 28):
  - toast con Review;
  - campanella con il contatore;
  - titolo della finestra con "(N)";
  - **desktop**: badge sull'icona del Dock, un rimbalzo, notifica nativa dal processo principale anche a finestra visibile (si spegne in Settings → Notifications);
  - **web**: Notification API se concessa.

  Si aggiungono al preload `motionStudio.notify({title, body})` e `motionStudio.setBadge(n)`, con fallback web.
- La **spiegazione deterministica dei comandi** (indicatori di rischio, dizionario) e l'**approvazione automatica** sono della Fase 8.

### 6.4 Correzioni del test visivo incluse nella Fase 7

Punti 1, 2 (presentazione), 4, 6, 9, 11, 14, 15 (normalizzazione della famiglia del font all'inserimento), 16–22, 25, 26, 28, 31, 32, 34 (presentazione), 35, 36–41, 44, 45. Più i punti di redesign: controlli nativi, icone, loghi dei canali, gerarchia, tema spostato nelle Impostazioni.

Punti rimandati:
- Fase 8: 3, 5, 7, 8, 24, 30;
- Fase 9: 42 e i nomi configurabili;
- Fase 10: 23, 33, 43, la timeline e l'editor;
- Fase 11: 10, 12, 13;
- Fase 8 o 10: 27 (peso dei video, legato al render kit).

## 7. Architettura del frontend

- Cartelle nuove: `src/ui/` (componenti), `src/motion/` (animazioni), `src/shell/` (barre, `PageHost`, palette dei comandi, centro attività, toast), `src/screens/*` riscritte.
- **Stato**: si mantengono `useServerEvents`/`eventsReducer`, gli hook `useProjectData`/`useCreative` e `api.ts`. Si aggiunge un piccolo store per i toast e per gli avvisi locali.
- **Testi**: tutti dai cataloghi `en`/`it` (`packages/shared/src/i18n`); `pnpm check:i18n` deve passare.
- **Stili**: `ui.css` (componenti) più CSS per schermata con classi; obiettivo **zero colori letterali** nei TSX, verificato da un test che cerca `#[0-9a-f]{3,6}` e `rgb(` in `src/screens` e `src/shell`. Fanno eccezione le anteprime dei colori del brand, che sono dati.
- **Desktop**: il preload aggiunge `notify` e `setBadge`; il main li implementa con `Notification` e `app.dock.setBadge` / `app.dock.bounce('informational')`.
- **Core**, solo estensioni piccole e retrocompatibili:
  - `formats?: string[]` nell'export;
  - un titolo modificabile della creatività (`title` nello store, generato dal brief);
  - eventuale `GET /api/recent-creatives`;
  - nessuna modifica a sandbox, approvazioni o versioni.

## 8. Test e verifica

- Test unitari per ogni componente di `ui/` e per i helper di `motion/`: `enter` annulla l'uscita; reduced motion salta l'animazione.
- Test delle schermate (testing-library) sui comportamenti chiave: filtri, selezione multipla, commento con testo legato al tempo, revisione della proposta con conteggio, export con selezione dei formati, centro attività, chiusura dei modali con clic sul velo ed Esc.
- `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm check:i18n` verdi.
- **Verifica visiva**: avvio dell'app reale con un workspace temporaneo e il finto claude, screenshot di ogni schermata in chiaro e scuro, a 1440 e 1024 px, confrontati con il prototipo; elenco delle differenze accettate.
- Le transizioni T1–T17 sono presenti: un test controlla che il componente invochi l'helper giusto; il resto è verifica manuale.

## 9. Fuori perimetro della Fase 7

- **Fase 8**: approvazione automatica; spiegazione deterministica dei comandi; consumi e token.
- **Fase 9**: versioni per formato, ★ ed export per versione.
- **Fase 10**: timeline, livelli, inspector, modifiche dirette, render dedicato.
- **Fase 11**: Google Fonts dall'interfaccia, font dai CSS.

Restano escluse anche nuove lingue oltre a inglese e italiano.
