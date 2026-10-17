# Motion Studio — Pagina GitHub (GitHub Pages) — Design

> **Fonti:**
> - brief dell'orchestratore (claude-motion-graphics-77): `branding/github-page-brief.md` nel checkout principale (non tracciato, non va toccato);
> - riferimento di stile: `branding/DESIGN.md` (sito di GSAP), solo animazione e composizione;
> - brainstorming con l'utente del 2026-10-16: le scelte marcate **(utente)** sono sue; quelle marcate **(mia scelta)** sono mie e l'utente le può rivedere.

## 1. Perché e per chi

- **Per chi:** sviluppatori e maker che arrivano dal repo pubblico `Aleloca/motion-studio`.
- **Un solo compito:** in 10 secondi far capire che Motion Studio è un'app locale sopra Claude Code che trasforma un brief in video e immagini animate per ogni canale, e portare il visitatore a installarlo (o a mettere la stella al repo).
- **Perché animata:** Motion Studio fa video e animazione, quindi la pagina stessa deve muoversi. Le animazioni dimostrative sono **composizioni vere di Motion Studio**, riprodotte dal runtime del prodotto (dogfooding) **(utente)**.

## 2. Obiettivi, non obiettivi, anti-obiettivi

**Obiettivi**
- Una pagina singola, in **inglese** **(utente)**: l'italiano si aggiungerà dopo, senza rifare la struttura.
- Hero "brief che diventa video" **(utente)**.
- Nove blocchi funzionalità **(utente)**, la vetrina, l'installazione e il footer (§4).
- Sito statico in `site/`, pubblicato da `.github/workflows/pages.yml` con `actions/deploy-pages` **(utente)**.

**Non obiettivi**
- Niente versione italiana in questa consegna.
- Niente documentazione completa: la pagina rimanda al README e a `docs/`.
- Niente modifiche al codice prodotto in `packages/` o `apps/`.

**Anti-obiettivi** (la consegna fallisce anche se "funziona"):
- funzioni o numeri inventati;
- colori o font di GSAP, il font Mori, testi o nomi di GSAP;
- analytics, tracker o embed di terze parti;
- una pagina illeggibile con il movimento ridotto;
- scroll orizzontale a 360px;
- un primo caricamento lento per colpa dei media.

## 3. Identità visiva

### 3.1 Palette (campionata da `logo.svg`)

| Ruolo | Valore | Note |
|---|---|---|
| Stage (sfondo di tutta la pagina) | `#0F0F0F` | lo stesso fondo dell'app icon |
| Superfici, card | `#171717` | |
| Hairline | `#262626` (mia scelta) | linee da 1px tra i blocchi |
| Grigio tratteggio del logo | `#6B6B6B` | solo decorazione, non testo |
| Testo | `#F5F1EC` (mia scelta, off-white caldo) | |
| Testo smorzato | `#A3A3A3` (mia scelta) | circa 8:1 sul nero, AA |
| Arancio play (accento primario) | `#FF5A1F` | circa 6,2:1 sul nero: ok anche per il testo piccolo |
| Arancio "Studio" | `#C2410C` | circa 3,7:1: solo testo grande (≥24px) o decorazioni |

**Colori di categoria (utente)**, usati solo come etichette e accenti, mai come fondo di grandi superfici:
- Formati e canali: teal `#2DD4BF`;
- Brand: arancio `#FF5A1F`;
- Store e identity: viola `#A78BFA`;
- Lingue: azzurro `#60A5FA`;
- Agente: giallo `#FACC15`.

L'assegnazione di blocchi 7, 8 e 9 (§4.2) a una categoria spetta al builder. Proposta: git e locale → Agente; servizi → Brand; varianti → Formati.

Profondità con gradienti, **mai ombre**.

### 3.2 Tipografia (utente)

- **Display:** Bricolage Grotesque, peso 700–800. Nell'hero va a 160–224px su desktop (con `clamp()` verso i telefoni), tracking circa −0,04em, interlinea circa 0,9; il titolo esce dai bordi del viewport.
- **Testo:** Instrument Sans 400/500.
- **Eyebrow `{ … }`, codice, etichette:** JetBrains Mono.
- **Caricamento:** da Google Fonts (l'unico CSS esterno ammesso) con `display=swap` e i soli pesi usati. In alternativa i file possono essere self-hosted in `site/assets/fonts/`: decide il builder. Self-hosting è preferibile per la privacy, perché la pagina non contatterebbe Google.

### 3.3 Logo e motivo

- File da copiare in `site/assets/` (senza `.DS_Store`), dalla cartella `branding/` del checkout principale:
  - `logo.svg` e `logo.png`;
  - il set favicon con `head-snippet.html` e `site.webmanifest`, adattando i percorsi assoluti `/…` al sottopercorso di Pages `/motion-studio/`;
  - `AppIcon-1024.png` per l'immagine Open Graph, se serve.
- Sul fondo scuro la scritta "Motion" va in bianco. Il logo SVG ha "Motion" in `#171717`, quindi serve una variante chiara: una copia con il solo `fill` cambiato in `site/assets/`.
- **Motivo:** i tre riquadri del logo (tratteggiato → contorno → pieno con play) significano "bozza → composizione → video" e ricorrono in tutta la pagina: transizioni, indicatori di progresso, bullet.

## 4. Struttura della pagina

Riferimento di composizione: `branding/DESIGN.md`. Tutta la pagina è uno stage scuro. Ogni sezione si apre con un eyebrow `{ … }` in mono. I pulsanti sono pill a contorno; **un solo** pulsante primario arancio, **Get started** **(utente)**.

### 4.1 Hero, "brief che diventa video" (utente)

Sequenza (i tempi sono una mia proposta):
1. In un campo stile "New creative" si scrive a macchina un brief realistico, per esempio "Launch teaser for a coffee app, bold and warm". Accanto compaiono come chip i formati scelti: Instagram Reel 9:16, Post 1:1, YouTube 16:9.
2. Transizione con il motivo del logo: il riquadro tratteggiato (bozza) diventa a contorno (composizione) e poi pieno con il play (video).
3. Entrano uno dopo l'altro **tre composizioni live**, una per formato, con la stessa creatività ricomposta per ciascuno. È il punto chiave del prodotto: una ricomposizione dedicata per ogni formato.
4. Sotto c'è il titolo display enorme, che esce dai bordi. La frase la sceglie il builder, coerente con il README. Poi un sottotitolo di una riga ("A local app on top of Claude Code…"), **Get started** (primario, va alla sezione Install) e **Star on GitHub** (contorno).

Il loop riparte lentamente o resta fermo sull'ultimo stato: decide il builder, purché non distragga dalla lettura.

### 4.2 Blocchi funzionalità (utente)

Blocchi a due colonne, alternati sinistra/destra, separati da hairline. Da una parte una **composizione live** che dimostra la funzione. Dall'altra l'eyebrow col colore della categoria, il titolo, un corpo breve e una pill a contorno che porta alla sezione giusta del README.

1. **Every format, every channel**: formati per canale, formati collegati ("TikTok follows the Reel").
2. **Live preview and direct editing**: anteprima senza render, editor (testi, posizione, timing, preset), salvataggio di una nuova versione senza agente e senza token.
3. **Your brand, from a site or a codebase**: analisi del brand da siti web e da codebase in sola lettura (palette, font, logo, tono).
4. **Identity and store packs**: logo, favicon, app icon e social preview come set di file; store pack con gli screenshot per App Store e Google Play.
5. **Languages**: traduzione in fino a 10 lingue, il testo che deve stare nel suo box, voice-over tradotto, render ed export per lingua.
6. **Talk to the agent while it works**: coda, Stop, Stop and redirect, messaggi live.
7. **Local and versioned with git**: tutto sul tuo computer, ogni versione è un commit, export con nomi file a pattern.
8. **Paid services, only when you say so**: immagini (OpenAI), voce (OpenAI, ElevenLabs), musica ed effetti (ElevenLabs), stock (Pexels, Unsplash). Conferma prima di ogni chiamata a pagamento; chiavi nel portachiavi, mai visibili all'agente.
9. **Creative variants**: fino a 5 direzioni creative (A–E) per ogni creatività, ognuna coerente su tutti i formati. La scelta finale si fa per formato, anche mescolando varianti diverse; le varianti scartate escono dalla scelta ("Discard") e tornano con "Restore".
   - L'utente aveva chiesto di presentarle come già disponibili; la fase 15 è su main da 385f898 (vedi §8).
   - Fonte: README "Creative variants".

Tutti i testi vengono dal README, da `README.it.md`, da `docs/` e dalle spec. Niente funzioni o numeri che lì non ci sono.

### 4.3 Vetrina

Griglia di card 16:9 e 1:1, ciascuna con una composizione live (o la sua immagine ferma finché non entra nel viewport). L'arte esce leggermente dalla card per suggerire il movimento. Ogni card mostra l'etichetta del formato e del canale. 4–6 card (mia scelta).

### 4.4 Install / Get started

Riporta **esattamente** lo stato del README di oggi:
- **da sorgente**, l'unico percorso disponibile adesso: `pnpm install` e `pnpm motion-studio`, con il blocco codice copiabile;
- **app desktop** dalle GitHub Releases e **npm** (`npx @motion-studio/cli`), entrambi indicati come "once published", come nel README;
- requisiti: Claude Code con login, Git, FFmpeg, Node.js 22+ (Chrome solo per il CLI).

### 4.5 Footer

Repository, README, `docs/`, licenza MIT, il logo. Nessun tracker.

## 5. Movimento

- **Il movimento è il contenuto:**
  - reveal guidati dallo scroll;
  - testo diviso in parole o lettere;
  - SVG del motivo del logo che si disegna;
  - forme che si sovrappongono al testo display.
- **Libreria:** GSAP con ScrollTrigger e SplitText, versione esatta da cdnjs o jsDelivr (oppure vendorizzata in `site/vendor/`). Vanno bene anche solo CSS e Web Animations. Decide il builder (mia preferenza: GSAP vendorizzato, così non c'è nessuna terza parte a runtime).
- **`prefers-reduced-motion`:** ogni animazione ha uno stato fermo e leggibile.
  - Le composizioni live mostrano un fotogramma rappresentativo (seek a un tempo scelto) e non vanno in play.
  - Il brief dell'hero appare già scritto.
- **Fuori viewport:** le composizioni non visibili sono in pausa (IntersectionObserver) e quelle lontane non sono ancora montate.

## 6. Composizioni live (utente: "scritte da me nel formato vero")

- **Le composizioni:**
  - Le scrive a mano il builder come `composition.json` conformi al contratto (`docs/output-contract.md`), con i loro `assets/`: font self-hosted, SVG, immagini piccole.
  - **Vanno validate con lo schema reale del progetto**, quello dello stesso codice usato dal core, tramite uno script nel sito o un test, senza lanciare l'app né spendere token dell'agente.
  - Niente video sorgente pesanti: testi, forme, SVG e animazioni JSON.
- **Riproduzione:**
  - Usa il runtime vero, `packages/composition-runtime`. È un IIFE (`runtime.js` circa 40 KB; `preview.js` circa 460 KB, con zod, solo in preview mode). Va scelta la modalità meno pesante che consenta la riproduzione in loop, per esempio la render mode pilotata con `__ms.seek` su un clock, oppure la preview mode con il suo bridge.
  - Ogni composizione gira in un iframe con la pagina runtime, la composizione inline (`renderRuntimePage`) e il `base` relativo alla sua cartella.
  - I file del runtime vengono dal pacchetto, costruiti nel workflow Pages o vendorizzati con uno script di copia ripetibile.
- **Vincolo:** se l'incorporamento statico richiede una **modifica in `packages/`** (per esempio un'origine o un clock diversi), il builder **chiede prima all'orchestratore**. Nel frattempo usa il ripiego: video brevi in loop (mp4/webm muti, piccoli, lazy) con poster, renderizzati dalle stesse composizioni.
- **Posizione:** `site/compositions/<nome>/`.
- **Quante:** 3 per l'hero (la stessa idea in 9:16, 1:1 e 16:9), una per blocco funzionalità (anche riusate) e 4–6 per la vetrina, con riuso ammesso.

- **Cosa mostrano le composizioni dei blocchi (utente):** **pezzi motion stilizzati** che raccontano l'idea della funzione, non mock dell'interfaccia dell'app. Esempi:
  - un riquadro che si ricompone in 9:16, 1:1 e 16:9;
  - un titolo che cambia lingua restando nel suo box;
  - i tre riquadri del logo che diventano le varianti A–E.

  Il riuso tra hero, blocchi e vetrina è ammesso.
- **Il ripiego video (mia scelta):**
  - Si attiva solo se l'orchestratore non approva la modifica in `packages/` che serve all'incorporamento.
  - In quel caso il builder può renderizzare in locale i loop con lo stesso runtime, con Chrome headless (profilo temporaneo, `--use-mock-keychain`, `--password-store=basic`) e ffmpeg.
  - Senza lanciare l'app pacchettizzata e senza l'agente.
- **Da dove vengono i file del runtime (mia scelta):**
  - Il workflow Pages costruisce `@motion-studio/composition-runtime` con pnpm (`pnpm install --frozen-lockfile` e `pnpm --filter @motion-studio/composition-runtime build`), poi uno script del sito copia i `dist/` e genera le pagine runtime.
  - Il filtro dei path del workflow include anche `packages/composition-runtime/**`.
  - Niente binari del runtime committati in `site/`.

## 7. Vincoli tecnici

- **Progressive enhancement (mia scelta):**
  - Tutti i testi (hero, blocchi, install, footer) sono HTML vero e leggibile senza JS.
  - Il JS aggiunge solo animazioni e composizioni.
  - Senza JS, al posto delle composizioni si vede il loro poster statico.
- **Asset e font (mia scelta):**
  - I file del logo si copiano **una volta** da `branding/` del checkout principale in `site/assets/` e si committano. Nessuno script contiene percorsi assoluti.
  - I font (OFL) si scaricano una volta da Google Fonts in `site/assets/fonts/`, self-hosted, con le licenze accanto. A runtime la pagina non contatta Google.
- **Link (mia scelta):** puntano a `https://github.com/Aleloca/motion-studio` (ref `main`) e alle ancore del README; il builder verifica che ogni ancora esista.
- **Varianti (mia scelta):** i testi del blocco 9 vengono dalla sezione "Creative variants" del README di main dopo il merge della fase 15 (385f898).

- **Struttura:**
  - `site/` con HTML, CSS e JS semplici;
  - Vite solo se l'incorporamento del runtime lo richiede davvero;
  - `.github/workflows/pages.yml` costruisce (se serve) e pubblica con `actions/upload-pages-artifact` e `actions/deploy-pages`, su push a `main` limitato ai path `site/**` e al workflow stesso, più `workflow_dispatch`.
- **Percorsi:** il sito vive sotto `/motion-studio/`, quindi tutti i percorsi sono relativi.
- **Prestazioni:**
  - primo paint veloce: il CSS critico inline e l'hero leggibile prima che arrivi il JS;
  - media e composizioni lazy;
  - nessuna risorsa bloccante oltre i font.
- **Responsive:** da 360px a 1440px e oltre, senza scroll orizzontale; il titolo che "esce dai bordi" è tagliato da un `overflow: clip` sul contenitore.
- **Accessibilità:**
  - heading veri, in ordine;
  - testo alternativo o `aria-label` per ogni composizione;
  - focus visibile (anello arancio);
  - contrasto AA;
  - le composizioni decorative hanno `aria-hidden` e una descrizione testuale accanto.
- **Meta:** title, description, Open Graph e Twitter card con un'immagine 1200×630 statica in `site/assets/`, favicon dal set del logo.
- **Privacy:** niente analytics né tracker; solo il CDN pinnato, se si usa.

## 8. Regole di lavoro e note

- **Dove si lavora:**
  - worktree `../claude-motion-graphics-site`, branch `feat/github-page`;
  - mai push, PR, abilitazione di Pages o modifiche alle impostazioni del repo;
  - niente riscritture della storia, niente `stash`, `reset`, `restore` o `clean`;
  - kill solo dei PID propri.
- **Browser:** solo con profilo temporaneo, `--use-mock-keychain` e `--password-store=basic`.
- **Test:** niente suite pesanti, perché la fase 15 è in corso in parallelo. Solo la validazione delle composizioni e controlli mirati.
- **Fine lavoro:**
  - trailer dei commit come nel brief;
  - prima della consegna, grep del diff per il percorso della home locale e l'e-mail dell'utente: nessun risultato ammesso.
- **Nota per l'orchestratore:** la fase 15 è su main (385f898) ed è stata unita in questo branch; il blocco 9 è allineato al README.

## 9. Lasciato al builder

- frase del titolo hero e testi, sempre fedeli alle fonti;
- tempi, easing e coreografia;
- la modalità del runtime;
- GSAP o CSS/WAAPI, font da Google Fonts o self-hosted;
- il soggetto delle composizioni dimostrative;
- il numero esatto di card in vetrina;
- la categoria dei blocchi 7–9.
