# Motion Studio — Fase 7: Nuova interfaccia — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire l'intera interfaccia web/desktop con il redesign approvato, cioè la direzione B del prototipo navigabile:
- design system con token neutri e un solo accento arancione, Schibsted Grotesk, componenti propri al posto dei controlli nativi, loghi dei canali;
- sistema di animazioni con le 17 transizioni della specifica;
- nuova struttura: barre, navigazione, palette `⌘K`, centro attività, toast, notifiche desktop;
- tutte le schermate ridisegnate sulle funzioni che esistono oggi.

Le funzioni delle fasi 8–11 non compaiono, oppure compaiono in sola lettura, mai con dati finti.

**Architecture:** si aggiungono a `packages/web/src`:
- `ui/` (componenti con test);
- `motion/` (WAAPI, `PageHost`, FLIP);
- `shell/` (barre, centro attività, toast, palette, notifiche);
- `screens/` (riscritte).

Restano `api.ts`, `useServerEvents`/`eventsReducer`, `useProjectData`/`useCreative`, `i18n.tsx` e `routes.ts` (esteso). Il prototipo in `docs/design/redesign-prototype/` è il riferimento di markup, testi e movimento: ogni schermata si **porta** dal prototipo in TSX, sostituendo i dati simulati con l'API reale. Nel core cambiano solo tre cose piccole: creatività recenti, export di formati scelti, nomi dei file dal titolo.

**Tech Stack:** React 19, Vite 7, Vitest + Testing Library (jsdom), TypeScript.

Nuove dipendenze:
- `@fontsource/schibsted-grotesk`;
- `simple-icons` (SVG dei canali, licenza CC0).

Da rimuovere: `@fontsource/manrope`.

**Spec:** `docs/superpowers/specs/2026-10-08-motion-studio-redesign-design.md` (§4 design system, §5 movimento, §6 schermate, §7 architettura, §8 verifica). Riferimenti visivi: `docs/design/README.md`.

## Global Constraints

- Token e valori **esatti** della specifica §4.1. Struttura dei temi:
  - chiaro su `:root`;
  - scuro in `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` e in `:root[data-theme="dark"]`.
- Grigi neutri, nessun viola. Accento `#FF5A1F` solo per: selezione, azioni importanti, stati che richiedono l'utente, avanzamento, Generate e Send.
- **Nessun controllo nativo visibile**: niente `<select>`, checkbox o radio native, niente maniglia di ridimensionamento delle textarea. Si usano i componenti di `ui/`.
- **Nessun colore letterale** (`#xxx`, `rgb(`, `hsl(`) nei TSX di `screens/` e `shell/`. Fanno eccezione i colori che sono dati (palette del brand, loghi dei canali) e le costanti di colore che `ui/` esporta. Lo verifica un test nel Task 16.
- Tutti i testi da cataloghi `en`/`it`. `pnpm check:i18n` verde a ogni task.
- Animazioni solo da `motion/`. Con `prefers-reduced-motion` si arriva subito allo stato finale. Un'entrata annulla le animazioni precedenti sullo stesso elemento.
- Accessibilità:
  - controlli veri con nomi accessibili;
  - Esc chiude popover e modali;
  - il focus torna all'origine;
  - contrasto AA.
- Nessuna funzione delle fasi 8–11 visibile con dati inventati. Tra queste: token, approvazione automatica, ★ per formato, timeline modificabile, ricerca Google Fonts.
- Si mantengono intatti: sicurezza (token UI, sandbox, approvazioni), API esistenti, `desktop.ts`.
- Nel core niente di diverso dai Task 7 e 8.
- Niente push, PR, release o pubblicazioni da parte dell'esecutore.
- Ogni commit con i trailer del progetto. A ogni task devono passare `pnpm test`, `pnpm typecheck` e `pnpm check:i18n`.

## Review Focus

1. **Modali e popover sovrapposti**: popover aperto dentro un modale, Esc che chiude solo il livello più alto, clic fuori che non attraversa il velo. → test nel Task 4.
2. **Navigazione rapida**: clic ripetuti su schede o pagine durante una transizione; mai due pagine "attive", mai una pagina invisibile (bug trovato nel prototipo). → test di `PageHost` nel Task 2.
3. **Eventi WebSocket durante le animazioni**: una nuova versione arriva mentre si apre l'editor, un'approvazione arriva a pagina che cambia. Lo stato resta coerente e il contatore della campanella è giusto. → test nei Task 5 e 6.
4. **Testi lunghi e lingue**: titoli di creatività lunghi, italiano più lungo dell'inglese, percorsi lunghi nei comandi delle approvazioni. A capo o ellissi, mai fuoriuscite orizzontali (punto 22 del test). → test di layout con `scrollWidth` nei Task 6 e 11.
5. **Assenza di dati**: progetto senza brand, creatività senza versioni, asset senza descrizione, nessuna approvazione. Ogni schermata ha uno stato vuoto disegnato con un'azione. → test per schermata.

---

## File Structure

```
packages/web/src/
  theme.css                    # rewritten: tokens (spec §4.1) + base reset
  ui/ui.css                    # component classes
  ui/index.ts                  # exports
  ui/Button.tsx Icon.tsx icons.ts ChannelMark.tsx Field.tsx Input.tsx Toggle.tsx Check.tsx Segmented.tsx
  ui/Chip.tsx Tag.tsx Pill.tsx VersionBadge.tsx Spinner.tsx Typing.tsx ProgressBar.tsx CountdownRing.tsx
  ui/Avatar.tsx Empty.tsx Card.tsx NavItem.tsx Tabs.tsx Select.tsx Popover.tsx Modal.tsx Toasts.tsx toast.ts Markdown.tsx
  motion/motion.ts PageHost.tsx useEnter.ts
  shell/TopBars.tsx ProjectSwitcher.tsx ActivityCenter.tsx CommandPalette.tsx notify.ts useAttention.ts
  screens/Welcome.tsx Pairing.tsx Projects.tsx ProjectCreatives.tsx NewCreative.tsx CreativeCanvas.tsx FormatView.tsx
  screens/Brand.tsx BrandReview.tsx Assets.tsx References.tsx ProjectSettings.tsx AppSettings.tsx ExportDialog.tsx CompareDialog.tsx
  components/ApprovalCard.tsx  (rewritten)  Conversation.tsx (rewritten)
apps/desktop/src/preload.ts main.ts   # notify + setBadge
packages/core/src/server/...          # recent creatives; export formats + title-based names
```

Old screens and components are deleted once each replacement lands, together with their now-obsolete tests (Task 16 removes what's left).

---

### Task 1: Fondamenta visive (token, font, riferimenti)

**Files:** `packages/web/src/theme.css` (riscritto), `packages/web/src/ui/ui.css` (nuovo, vuoto con solo l'header), `packages/web/src/main.tsx`, `packages/web/package.json`, `packages/web/test/theme.test.ts`.

- [ ] **Step 1: Test che fallisce**, `test/theme.test.ts`: legge `src/theme.css` e verifica:
  - che ogni token della specifica §4.1 sia definito su `:root`;
  - che sia ridefinito nei due blocchi scuri;
  - che non compaiano `#6D28D9` né `Manrope`.

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
const TOKENS = ['--bg', '--panel', '--line', '--line2', '--text', '--muted', '--faint', '--field', '--dot', '--ink', '--inkText', '--accent', '--accentText', '--sel', '--ok', '--okBg', '--warn', '--warnBg', '--warnLine', '--scrim'];
const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
describe('theme tokens', () => {
  it('defines every token in light and both dark blocks', () => {
    const root = block(':root {');
    for (const t of TOKENS) expect(root, t).toContain(t + ':');
    for (const sel of [':root:not([data-theme="light"])', ':root[data-theme="dark"]']) for (const t of TOKENS.filter((x) => x !== '--accent')) expect(block(sel), sel + t).toContain(t + ':');
  });
  it('drops the old palette and font', () => { expect(css).not.toMatch(/6D28D9|Manrope/i); });
});
```
- [ ] **Step 2:** `pnpm vitest run packages/web/test/theme.test.ts`, che deve FALLIRE.
- [ ] **Step 3: Implementazione.**
  - `theme.css`: token esatti della §4.1, reset di base (`body` con `--bg`/`--text`, 13px/1.45 Schibsted Grotesk, `-webkit-font-smoothing`), focus visibile arancione, `@media (prefers-reduced-motion: reduce)` che azzera animazioni e transizioni.
  - Si mantengono, mappati sui nuovi token, solo gli alias ancora usati dalle schermate vecchie (`--surface` → `--panel`, `--border` → `--line`, `--accent-soft` → `--sel`…), così l'app resta usabile finché ogni schermata viene sostituita. Il Task 16 li rimuove.
  - `main.tsx`: importa `@fontsource/schibsted-grotesk/{400,500,600,700}.css` al posto di Manrope.
  - `package.json`: aggiunge `@fontsource/schibsted-grotesk` e `simple-icons`, rimuove `@fontsource/manrope`.
- [ ] **Step 4:** test verdi; `pnpm --filter @motion-studio/web build`.
- [ ] **Step 5: Commit** `feat(web): redesign tokens, Schibsted Grotesk, neutral palette`.

---

### Task 2: Sistema di animazioni (`motion/`)

**Files:** `src/motion/motion.ts`, `src/motion/PageHost.tsx`, `src/motion/useEnter.ts`, `test/motion.test.tsx`.

**Interfaces** (porting di `docs/design/redesign-prototype/lib.js` → `motion` e `app.js` → `PageHost`):
```ts
export const D: { xs: 120; s: 200; m: 320; l: 480 };
export const E: { std: string; out: string; in: string; spring: string };
export function anim(el: Element | null, frames: Keyframe[], ms?: number, ease?: string, delay?: number): Promise<void>;
export function enter(el: Element | null, o?: { x?: number; y?: number; scale?: number; delay?: number; ms?: number }): Promise<void>; // cancels el.getAnimations() first
export function exit(el: Element | null, o?: { x?: number; y?: number; ms?: number }): Promise<void>;  // fill: forwards
export function stagger(els: Iterable<Element>, o?: Parameters<typeof enter>[1], step?: number): Promise<void>;
export function pop(el: Element | null): Promise<void>; export function pulse(el: Element | null): Promise<void>; export function flash(el: Element | null): Promise<void>;
export function flip(el: Element | null, from: DOMRect | null, ms?: number): Promise<void>;
export function reducedMotion(): boolean;   // matchMedia; all helpers resolve immediately when true
export function useEnter<T extends HTMLElement>(deps?: unknown[]): React.RefObject<T>; // animates [data-enter] children in cascade
export function PageHost<R>(p: { route: R; keyOf(r: R): string; depthOf?(r: R): number; soft?: boolean; render(r: R): React.ReactNode }): JSX.Element;
```
`PageHost` mantiene al massimo **una** pagina uscente e una entrante. Una nuova navigazione durante una transizione rimuove subito la pagina uscente precedente.

- [ ] **Step 1: Test che falliscono.** In jsdom si sostituiscono `Element.prototype.animate` e `getAnimations` con dei finti che registrano le chiamate.
  - `enter` cancella le animazioni esistenti prima di animare (regressione del prototipo).
  - Con reduced motion: nessuna chiamata ad `animate`, promesse risolte.
  - `PageHost`: dopo `route` A → B → C in rapida successione, nel DOM ci sono al massimo 2 pagine. L'ultima ha `pointer-events: auto` e l'attributo `data-page-active`.
  - `PageHost`: la direzione è `+1` quando la profondità aumenta e `-1` quando diminuisce, verificata dal valore `x` passato all'animazione d'ingresso.
- [ ] **Step 2:** FAIL. **Step 3:** porting dal prototipo con i tipi. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(web): motion system with page host, flip and reduced-motion support`.

---

### Task 3: Componenti di base (`ui/`, parte 1)

**Files:**
- `src/ui/{Button,Icon,icons,ChannelMark,Field,Input,Toggle,Check,Segmented,Chip,Tag,Pill,VersionBadge,Spinner,Typing,ProgressBar,CountdownRing,Avatar,Empty,Card,NavItem,Tabs,Markdown}.tsx`;
- `src/ui/ui.css`;
- `test/ui-basic.test.tsx`.

**Interfaces** (classi e misure dal prototipo, `styles.css`):
- `Button({ variant?: 'default'|'ink'|'accent'|'ghost'|'outline'|'danger'; size?: 'sm'|'md'|'lg'; icon?: boolean; loading?: boolean; ...button props })`;
- `Icon({ name: IconName; size?: number })`, con `IconName` come unione dei nomi di `icons.ts` (portati da `P` nel prototipo);
- `ChannelMark({ channel: 'instagram'|'tiktok'|'youtube'|'facebook'|'linkedin'|'x'|'pinterest'|'appstore'|'googleplay'|'web'; size?: 16|20 })`: SVG da `simple-icons` (`siInstagram.path`…) in bianco su riquadro con il colore del marchio, `web` con l'icona globo;
- `Toggle({ on, onChange, label, size? })` (role switch), `Check({ on, onChange, label })` (role checkbox), `Segmented({ options: {value,label,icon?,count?}[]; value; onChange; label })` (role radiogroup, frecce da tastiera);
- `Field({ prefix?: string; children })` (28 px), `Input`/`Textarea` (senza resize visibile, `rows` controllato);
- `CountdownRing({ createdAt: number; ttlSec: number })`, `ProgressBar({ value })`;
- `Markdown({ text })`: **render sicuro** di grassetto, corsivo, codice in linea, elenchi puntati e link `https?:` aperti esternamente; tutto il resto è testo; nessun `dangerouslySetInnerHTML` (punto 32).

- [ ] **Step 1: Test che falliscono** (un `describe` per componente). Almeno:
  - Button `loading` è disabilitato e mostra lo spinner;
  - Toggle e Check emettono il valore invertito e hanno il ruolo ARIA giusto;
  - Segmented si sposta con ArrowRight;
  - ChannelMark rende un `svg` con un `path` non vuoto per ogni canale;
  - Markdown rende `**a**` come `<strong>`, non esegue `<img onerror>` (resta testo) e non rende link `javascript:`.
- [ ] **Step 2–4:** FAIL → implementazione → PASS.
- [ ] **Step 5: Commit** `feat(web): base UI components replacing native controls`.

---

### Task 4: Componenti sovrapposti (`ui/`, parte 2)

**Files:** `src/ui/{Popover,Select,Modal,Toasts,toast}.tsx`, `test/ui-overlay.test.tsx`.

**Interfaces:**
```ts
export function Popover(p: { open: boolean; onClose(): void; anchor: React.RefObject<HTMLElement>; placement?: 'bottom-start'|'bottom-end'|'top-start'; width?: number; children: React.ReactNode }): JSX.Element | null; // T5 enter/exit
export function Select<T extends string>(p: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string }): JSX.Element; // popover list, arrows/Enter/Esc
export function Modal(p: { open: boolean; onClose(): void; label: string; width?: number; children: React.ReactNode }): JSX.Element | null; // T6, closes on scrim click and Esc, returns focus
export const toast: { show(text: string, o?: { tone?: 'ok'|'neutral'; action?: { label: string; run(): void }; ms?: number }): number; dismiss(id: number): void };
export function Toasts(): JSX.Element; // T7, top centre stack
```
Un **gestore dei livelli** (pila in un modulo) fa in modo che Esc chiuda solo il livello più alto e che il clic sul velo di un modale non chiuda i popover sottostanti.

- [ ] **Step 1: Test che falliscono.**
  - Popover dentro Modal: il primo Esc chiude solo il popover, il secondo il modale.
  - Clic sul velo: chiude il modale.
  - Clic dentro il dialogo: non lo chiude.
  - Il focus torna al pulsante d'origine.
  - Select: con frecce e Invio sceglie un valore.
  - Toast: compare con `role="status"`, l'azione chiama `run` e chiude.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): popover, select, modal and toasts with layered escape handling`.

---

### Task 5: Struttura, barre, centro attività, notifiche

**Files:**
- `src/routes.ts` (esteso), `src/App.tsx` (riscritto attorno a `PageHost`);
- `src/shell/{TopBars,ProjectSwitcher,ActivityCenter,CommandPalette,notify,useAttention}.ts(x)`;
- `src/desktop.ts` (nuovi metodi facoltativi);
- `apps/desktop/src/preload.ts`, `apps/desktop/src/main.ts`;
- test: `test/shell.test.tsx`, `test/routes.test.ts` (esteso), `apps/desktop/test/notify.test.ts`.

**Interfaces:**
- Rotte nuove: `{ name: 'welcome'; step?: 1|2|3 }`, `{ name: 'settings'; section: 'general'|'system'|'paid'|'notifications'|'updates' }` (`#/settings/system`…), `{ name: 'format'; slug; creative; format }` (`#/p/:s/c/:c/f/:format`). Si mantengono tutte le rotte attuali.
- `depthOf`: welcome 0 · projects 1 · settings/project 2 · new-creative/creative 3 · format 4.
- Barre (porting di `GlobalTop`, `ProjectTop`, `CreativeTop` del prototipo):
  - campanella con il contatore delle approvazioni pendenti (da `eventsReducer`);
  - "N running" dai job attivi;
  - avatar con menu (Settings, System check, Replay setup);
  - **niente** contatore di token (Fase 8);
  - il tema esce dalla barra.
- `ActivityCenter`: popover con le schede Needs you / Running / Done, alimentate da approvazioni, job attivi e ultimi esiti dei job (dallo stato degli eventi; ultimi 20 nella sessione).
- `CommandPalette` (`⌘K` o `Ctrl+K`): cerca progetti, creatività e pagine (fonti: `listProjects` e `listCreatives` dei progetti visitati) e naviga. Nessuna azione distruttiva.
- `useAttention(pendingCount)`:
  - aggiorna `document.title` con il prefisso `(N) `;
  - chiama `desktop()?.setBadge(n)`;
  - all'**arrivo** di una nuova approvazione chiama `desktop()?.notify({ title, body })` o, sul web, `Notification` se concessa;
  - mostra un toast con "Review";
  - rispetta l'impostazione `notifyApprovals` (Task 15, `localStorage`, default `true`).
- Desktop:
  - preload: `notify({title, body}) => ipcRenderer.invoke('ms:notify', …)` e `setBadge(n) => ipcRenderer.invoke('ms:badge', n)`;
  - main: `new Notification({ title, body }).show()`, `app.dock?.setBadge(n ? String(n) : '')`, `app.dock?.bounce('informational')` quando `n` cresce;
  - argomenti validati (stringhe di lunghezza massima 200, intero da 0 a 99), con la stessa protezione sull'origine degli IPC esistenti.

- [ ] **Step 1: Test che falliscono.**
  - `parseRoute`/`href` per le nuove rotte.
  - La campanella mostra 2 con due approvazioni nello stato, poi 1 dopo una decisione.
  - Il centro attività mostra le schede.
  - `useAttention`: con un'approvazione in più, il titolo diventa `(1) Motion Studio`, il badge vale 1 e `notify` viene chiamata una sola volta; un evento ripetuto con lo stesso id non notifica di nuovo.
  - `⌘K` apre la palette e l'Invio naviga.
  - Desktop: il preload espone `notify` e `setBadge`; il main rifiuta argomenti non validi.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web,desktop): new shell with activity center, command palette and attention signals`.

---

### Task 6: Scheda di approvazione e conversazione

**Files:** `src/components/ApprovalCard.tsx` (riscritto), `src/components/Conversation.tsx` (sostituisce `ConversationPanel`), test `test/approval-card.test.tsx`, `test/conversation.test.tsx`.

**Interfaces** (porting di `ApprovalCard`, `ChatList`, `Msg`, `Composer` del prototipo):
- `ApprovalCard({ approval: ApprovalRequest; context?: string })`:
  - titolo e descrizione da `approval` (campi esistenti);
  - chip di contesto se presenti;
  - `CountdownRing` sulla scadenza;
  - "Show command" che apre il comando **intero** in un `<pre>` con `white-space: pre-wrap; overflow-wrap: anywhere`, un'indicazione "N lines" e lo scorrimento interno visibile (punto 6);
  - Allow, "Always here" (solo se esiste una regola proposta), Deny tramite `api.decideApproval`;
  - animazione T8;
  - uscita T15 quando viene decisa.
- `Conversation({ slug, creative, entries, approvals, job })`:
  - un **messaggio per elemento** con l'orario (punto 25);
  - le voci dell'agente di tipo passo come righe compatte con ✓, il risultato con `Markdown`;
  - i dettagli tecnici, come gli eventi di tool e i comandi, solo in un pannello "Activity details" richiudibile;
  - i puntini di scrittura quando il job è in corso e non ci sono ancora eventi nuovi;
  - le approvazioni del job nel flusso;
  - composer con le chip dei commenti in attesa e `⌘↵` che chiama `api.sendCreativeTurn` (`{ text, pins }`).

- [ ] **Step 1: Test che falliscono.**
  - Un comando di 30 righe con un percorso di 300 caratteri senza spazi: il `pre` non supera la larghezza della scheda (`scrollWidth <= clientWidth` del contenitore, con un layout stimato), e "Show command" mostra "30 lines".
  - Allow chiama `decideApproval(id, 'allow')`.
  - "Always here" non c'è senza regola.
  - La conversazione rende N bolle per N voci, ciascuna con l'orario.
  - Il Markdown del risultato ha `<strong>`.
  - `⌘↵` invia testo e pin.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): approval card with full command, conversation as separate timed messages`.

---

### Task 7: Core: creatività recenti

**Files:** `packages/core/src/server/creative-routes.ts` (o il file delle rotte dei progetti), `packages/core/test/recent-creatives.test.ts`, `packages/web/src/api.ts`, `packages/shared` (tipo).

**Interfaces:** `GET /api/recent-creatives?limit=3` restituisce `Array<CreativeSummary & { project: { slug: string; name: string } }>`, ordinato per `updatedAt` decrescente, `limit` tra 1 e 12 (default 3). Usa le API dello store già esistenti, ignora i progetti illeggibili e richiede il token UI come le altre rotte.

- [ ] **Step 1: Test.** Tre progetti con creatività a date diverse: restituisce le 3 più recenti nell'ordine giusto; `limit=99` viene ridotto a 12; senza token risponde 401.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(core): recent creatives across projects`.

---

### Task 8: Core: export di formati scelti e nomi dal titolo

**Files:** `packages/core/src/creatives/export.ts`, rotta di export, `packages/core/test/export.test.ts` (esteso), `packages/web/src/api.ts`.

**Interfaces:**
- il body dell'export accetta `{ destination: string; formats?: string[] }`; i formati sconosciuti o assenti nella versione rispondono 400 con un messaggio tradotto;
- la base dei nomi diventa lo **slug del titolo della creatività** (`slugify(title)`, al massimo 40 caratteri, ripiego sullo slug della cartella) al posto dello slug con data e obiettivo (punto 44);
- lo schema resta `<base>-<format>-v<n>.<ext>` e le regole esistenti non cambiano (niente sovrascritture, confinamento, `skipped`);
- `api.exportVersion(slug, c, n, destination, formats?)`.

- [ ] **Step 1: Test.**
  - `formats: ['ig-square']` esporta solo quel file.
  - Un formato sconosciuto risponde 400.
  - Il titolo "A crime a week" produce `a-crime-a-week-instagram-reel-9x16-v3.mp4`.
  - Un titolo vuoto ricade sullo slug.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(core): export selected formats, file names from the creative title`.

---

### Task 9: Welcome e Pairing

**Files:** `src/screens/Welcome.tsx` (sostituisce `Onboarding.tsx`), `src/screens/Pairing.tsx` (estratto da `App.tsx`), test.

Porting di `WelcomePage`/`SystemChecks` e `PairingPage` del prototipo:
- 3 passi con T17;
- passo 1: i check di `/api/doctor` compaiono uno a uno, e i check falliti mostrano il rimedio con "Check again";
- passo 2: workspace con `desktop().pickFolder` o campo di testo, anteprima delle cartelle e messaggio di stato dal server;
- passo 3: nome del progetto e sito facoltativo; con il sito chiama `createProject`, `addBrandSource` e `analyzeBrand` e apre la scheda Brand;
- il setup appare quando manca il workspace o un check obbligatorio fallisce (stessa logica di oggi).

Pairing: comando copiabile e, se l'API lo indica, il collegamento al desktop.

- [ ] **Test.**
  - Un check fallito blocca "Continue" e mostra il rimedio.
  - Il passo 2 su desktop finto usa `pickFolder`.
  - Il passo 3 con il sito chiama le tre API in ordine.
  - Pairing mostra il comando e "Copy" lo copia, con un ripiego quando gli appunti non sono disponibili.
- [ ] **Commit** `feat(web): three-step setup and pairing page`.

---

### Task 10: Projects e creatività del progetto

**Files:** `src/screens/Projects.tsx`, `src/screens/ProjectCreatives.tsx` (sostituiscono `ProjectList.tsx`, `ProjectPage.tsx` e `CreativeList.tsx`), test.

Porting di `Projects`/`ProjectCard` e `Creatives`/`CreativeCard`:
- "Jump back in" da `GET /api/recent-creatives`;
- copertina del progetto: ultime cover delle creatività e striscia della palette del brand (`getBrand`), con ripiego sul nome;
- creazione del progetto in linea;
- filtri a segmenti con i conteggi e ricerca;
- schede con anteprime in proporzione (da `CatalogState`) e lo stato:
  - approvazione con Review;
  - job con passo e %;
  - stato `failed` con il messaggio d'errore e "Try again", che rimanda la richiesta tramite `sendCreativeTurn` con il testo di ripetizione già usato dal core;
  - bozza con Generate;
- stato vuoto disegnato (progetto senza creatività: "Set up the brand" / "New creative").

- [ ] **Test.**
  - Filtri e conteggi.
  - Una scheda con approvazione pendente ha il bordo e il pulsante Review.
  - Un progetto senza creatività mostra lo stato vuoto con le due azioni.
  - Il nome di progetto creato in linea compare con T14.
- [ ] **Commit** `feat(web): projects home and project creatives redesign`.

---

### Task 11: New creative

**Files:** `src/screens/NewCreative.tsx` (riscritto), `src/components/FormatBoard.tsx` (sostituito dalla tavola nuova dentro la schermata), test.

Porting di `NewCreativePage`/`Tile`:
- brief con suggerimenti (testi nei cataloghi);
- messaggio chiave;
- durata a segmenti, disattivata senza formati video;
- **selettore di asset a miniature** (`listAssets`), che salva i percorsi nel brief come fa oggi il campo di testo;
- interruttore del brand (campo esistente del brief, se c'è; altrimenti solo presentazione e annotato);
- tavola dei formati dal catalogo reale (`getFormats`), raggruppata per canale con `ChannelMark`, icona del tipo, proporzione disegnata, nota sulla durata massima, filtro Video/Image, ricerca, "More channels";
- icona di collegamento sui 9:16 video successivi al primo, solo come indicazione: il collegamento vero arriva in Fase 9;
- riepilogo con il numero di render e la **stima del tempo** (nessun token);
- Generate con `⌘↵` chiama `createCreative(..., generate: true)` e naviga al canvas;
- titolo della creatività generato dal brief (prima frase, al massimo 60 caratteri) e modificabile in seguito.

- [ ] **Test.**
  - Senza brief, Generate evidenzia il campo e non chiama l'API.
  - La selezione di 2 formati ne invia 2.
  - Il filtro Video nasconde le immagini.
  - Il selettore aggiunge gli asset al brief.
  - Con un titolo di 200 caratteri, nessuna fuoriuscita orizzontale.
- [ ] **Commit** `feat(web): new creative with format board and asset picker`.

---

### Task 12: Canvas della creatività

**Files:** `src/screens/CreativeCanvas.tsx` (sostituisce `CreativePage.tsx`), `src/screens/ExportDialog.tsx`, `src/screens/CompareDialog.tsx`, test (sostituiscono `CreativePage*.test.tsx` ed `ExportDialog.test.tsx`).

Porting di `CanvasView`, `VersionsPopover`, `PinComposer`, `ExportDialog`, `CompareDialog`:
- **colonna dei formati** per canale;
- **canvas**:
  - tavole in proporzione con le immagini degli output della versione selezionata (`fileUrl`);
  - stato di generazione T10 sulle tavole in lavorazione;
  - "Open editor" al passaggio del mouse e doppio clic che naviga alla rotta `format` salvando `getBoundingClientRect()` per T3;
  - zoom; safe zones dal catalogo con la legenda (punto 37);
- **barra strumenti**: V/C/H, zoom, Safe zones;
- **commenti**:
  - in modalità C, il clic sulla tavola apre il fumetto con il testo e crea un `Pin` (`note` = testo, `timeSec` per i video = 0 sul canvas);
  - i pin in attesa diventano chip nel composer;
  - si possono **modificare e cancellare** prima dell'invio (punto 40);
  - l'invio passa da `sendCreativeTurn({ text, pins })`;
- **pannello** Chat (componente del Task 6) · Comments (pin inviati per versione) · Brief (testo con "Edit the brief");
- **menu della versione** (cronologia per creatività):
  - miniatura dalla cover;
  - `n`, ora, nota dalla `request`;
  - "Restart from here" chiama `restoreVersion`;
  - "Show in Finder" chiama `revealVersion`;
  - **Compare** con slider tra due versioni;
- **Export** (modale):
  - righe per formato con miniatura, nome finale (Task 8) e checkbox;
  - destinazione con `pickFolder` o campo testo, ricordata in `localStorage`;
  - avanzamento e successo con "Show in Finder" (`revealPath`), errori in linea;
- **titolo modificabile** nella barra, con clic o F2 e `updateCreative`.

- [ ] **Test.**
  - Un clic in modalità commento crea un pin con il testo; la chip si può modificare e cancellare.
  - L'invio chiama l'API con il pin.
  - La versione 2 cambia le immagini delle tavole.
  - Compare apre lo slider.
  - Export con 1 formato deselezionato chiama l'API con i soli formati scelti; in successo appare "Show in Finder".
  - Approvazione in arrivo durante l'apertura dell'editor: nessun errore e contatore corretto (Review Focus 3).
- [ ] **Commit** `feat(web): creative canvas with comments, version menu, compare and export`.

---

### Task 13: Vista del formato (anteprima dell'editor)

**Files:** `src/screens/FormatView.tsx`, test. Sostituisce `FocusView`.

Porting della parte di `VideoEditor`/`ImageEditor` che **non** dipende dalla Fase 10:
- barra con "← All formats" (T4), nome del formato e proporzioni, menu della versione, Export;
- **video**:
  - player grande con play/pausa (Spazio), barra di scorrimento a trascinamento, fotogramma per fotogramma (←/→, 1/30 s);
  - commenti con il clic sul player in pausa: pin con `timeSec` corrente e testo;
  - i pin visibili **solo entro ±0,5 s** del loro istante (punto 38) e marcati sulla barra;
  - colonna "Scenes" con un riquadro "Edit scenes, text and timing directly — coming with the timeline" senza controlli finti;
- **immagine**: zoom (Fit, ±, 100%) e commenti con pin;
- pannello Chat;
- T3 all'apertura (FLIP dal rettangolo salvato) e T4 alla chiusura.

- [ ] **Test.**
  - Spazio alterna la riproduzione (`HTMLMediaElement.play` finto).
  - Un pin a 5 s è visibile a 5,3 s e non a 6 s.
  - L'apertura con il rettangolo salvato chiama `flip`.
  - "← All formats" torna alla rotta della creatività.
- [ ] **Commit** `feat(web): format view with frame-accurate comments and shared-element transition`.

---

### Task 14: Brand e revisione della proposta

**Files:** `src/screens/Brand.tsx`, `src/screens/BrandReview.tsx` (sostituiscono `BrandPage.tsx` e `ProposalReview.tsx`), test.

Porting di `BrandPage`, `Colors`/`Swatch`, `Typography`/`FontCard` (**senza** ricerca Google Fonts), `Logos`, `Voice`, `Sources`, `AnalysisCard`, `BrandReview`:
- tutte le modifiche passano da `saveBrandKit`/`saveGuidelines` con riscontro (Saving… → Saved) e Undo dove si rimuove;
- il campo della famiglia del font normalizza uno stack CSS alla prima famiglia (punto 15);
- **avanzamento dell'analisi** dagli eventi del job brand (`report_progress` ed eventi di stato), con passi e percentuale (punto 2);
- proposta pronta: toast e foglio di revisione con **anteprime visive vere** dei colori, specimen dei font e immagini dei loghi (`projectFileUrl`), selezione per elemento e per gruppo, "Apply N of M" con `applyProposal`, "Discard all" con `discardProposal`;
- "Missing: logo for light backgrounds" quando nessun logo è per sfondi chiari, con "Ask the agent" che avvia una richiesta al job brand se l'API lo permette, altrimenti apre il caricamento.

- [ ] **Test.**
  - La modifica di un colore salva il kit.
  - La rimozione mostra Undo, che ripristina.
  - Lo stack `Newsreader, "Newsreader Fallback", Georgia` diventa `Newsreader`.
  - Gli eventi di avanzamento aggiornano la percentuale.
  - Il foglio di revisione deseleziona un gruppo e chiama `applyProposal` con gli id restanti.
  - Un progetto senza brand mostra lo stato vuoto con il campo del sito.
- [ ] **Commit** `feat(web): brand page with live analysis and visual proposal review`.

---

### Task 15: Assets, References, Project settings, App settings

**Files:** `src/screens/{Assets,References,ProjectSettings,AppSettings}.tsx` (sostituiscono le attuali `AssetsPage`, `ReferencesPage`, `ProjectSettings`, `SettingsPage`, insieme a `PermissionsList`, `CodebaseList` e `UploadZone`), test.

- **Assets** (porting di `AssetsPage`, `AssetCard`, `AssetDetail`, `SelBar`):
  - filtri per tipo, origine e tag; ricerca;
  - schede con descrizione e tag; stato "Describing…" per gli asset coinvolti nel job di descrizione;
  - selezione multipla: Describe again tramite `describeAssets(files)`, Delete con Undo (eliminazione differita di 5 s, poi `deleteAsset`);
  - dettaglio con nome, descrizione e tag in chip (`updateAsset`);
  - trascinamento su tutta la pagina con `uploadFiles`.
- **References** (porting di `ReferencesPage`/`RefCard`):
  - colonne e note;
  - interruttore "Brand analysis" con `updateReference(useForBrand)`;
  - "Analyze brand with these" porta al Brand e avvia l'analisi;
  - aggiunta di immagini con il caricamento; aggiunta di link solo se l'API la supporta, altrimenti il campo link non c'è.
- **Project settings** (porting di `ProjectSettingsPage`):
  - sezioni;
  - "Always allowed" con l'etichetta in chiaro e la regola sotto; revoca con T15 e Undo (revoca differita come sopra);
  - domini extra, codice collegato, lavori in parallelo (impostazioni esistenti);
  - **niente** interruttore di approvazione automatica (Fase 8).
- **App settings** (porting di `AppSettingsPage`):
  - General: lingua (`setLanguage`) e tema (System/Light/Dark con anteprime, salvato come oggi);
  - **System check** con `/api/doctor` e "Check again";
  - Paid services: `getSecrets`/`setSecret`/`deleteSecret` con "Save and test", come oggi;
  - Notifications: `notifyApprovals` e `notifyReady` in `localStorage`;
  - Updates: stato dell'updater se il desktop lo espone, altrimenti versione e "You're up to date" senza pulsanti finti;
  - **niente Usage** (Fase 8).

- [ ] **Test.**
  - Filtri e selezione multipla.
  - Delete e Undo entro 5 s non chiamano `deleteAsset`.
  - Il pannello di dettaglio salva i tag.
  - L'interruttore di References chiama l'API.
  - La revoca con Undo non chiama `deletePermission`.
  - System check mostra un check fallito con il rimedio.
  - Il tema cambia `data-theme`.
- [ ] **Commit** `feat(web): assets, references and settings redesign`.

---

### Task 16: Pulizia, controlli automatici, verifica visiva

**Files:** rimozione dei componenti, schermate, test e alias CSS obsoleti; `test/no-literal-colors.test.ts`; `docs/visual-test-2026-10-08.md` (stato dei punti).

- [ ] **Step 1: test dei colori letterali.** Scansiona `src/screens/**` e `src/shell/**` cercando `#[0-9a-fA-F]{3,8}\b`, `rgb\(` e `hsl\(`. Un'eccezione è permessa solo con il commento `// color-data` sulla stessa riga, per le anteprime dei colori del brand e i colori dei canali. Deve passare.
- [ ] **Step 2: rimozione.**
  - Componenti vecchi non più importati: `ThemeToggle`, `ApprovalsIndicator`, `FocusView`, `FormatPicker`, `FormatPreview`, `MediaThumb` se sostituito, `ConversationPanel`, `AgentConsole`.
  - La scheda "Agent console" del progetto diventa "Activity details" nella conversazione: annotarlo.
  - Alias CSS del Task 1.
  - `pnpm --filter @motion-studio/web build` senza avvisi.
- [ ] **Step 3: verifica automatica.** `pnpm test && pnpm typecheck && pnpm build && pnpm check:i18n` verdi.
- [ ] **Step 4: verifica visiva.**
  - Avviare il core dal CLI con config e workspace temporanei e il finto claude (`FAKE_CLAUDE_SCENARIO=render`).
  - Creare un progetto e una creatività con 2 formati.
  - Catturare screenshot (Chrome dell'esecutore o Playwright, se disponibile senza installazioni globali) di ogni schermata in chiaro e scuro, a 1440×900 e 1024×700.
  - Confrontarli con le tavole in `docs/design/redesign-boards/` e annotare le differenze accettate.
  - Le cartelle reali dell'utente restano intatte.
- [ ] **Step 5:** aggiornare `docs/visual-test-2026-10-08.md` segnando i punti risolti in Fase 7.
- [ ] **Step 6: Commit** `chore(web): remove the old UI, literal-color guard, phase 7 verification notes`.
