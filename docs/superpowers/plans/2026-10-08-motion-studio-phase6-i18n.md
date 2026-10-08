# Motion Studio — Fase 6: Lingue (inglese + italiano) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Motion Studio diventa un progetto open-source con **inglese come lingua primaria** e **italiano come seconda lingua**. Al primo avvio usa la lingua del sistema (italiano se il sistema è in italiano, altrimenti inglese). L'utente può cambiarla nelle Impostazioni (Sistema / English / Italiano). L'agente risponde e scrive i testi destinati all'utente (linee guida del brand, descrizioni degli asset, messaggi nella conversazione) nella lingua impostata. Aggiungere una lingua deve richiedere solo un nuovo file di traduzioni.

**Architecture:** Un catalogo di messaggi tipizzato in `packages/shared/src/i18n/`. `en.ts` è la fonte di verità; `it.ts` ha il tipo `Messages` derivato da `en`, quindi una chiave mancante fa fallire il typecheck. Le interpolazioni sono funzioni (`(p: { n: number }) => string`); i plurali usano `Intl.PluralRules`. Nessuna dipendenza esterna. Il core salva l'impostazione in `config.json` (`language: 'system' | 'en' | 'it'`), calcola la lingua effettiva (impostazione, altrimenti lingua di sistema) e localizza i propri messaggi con `t()`: è un'app locale per un solo utente, quindi una lingua corrente a livello di processo è sufficiente. La UI riceve la lingua effettiva nello snapshot e la usa con un `I18nProvider`. Nel desktop, Electron passa al core le lingue preferite del sistema.

**Tech Stack:** come Fase 5. Nessuna nuova dipendenza.

**Spec:** `docs/superpowers/specs/2026-10-07-motion-studio-design.md`. Revisione delle decisioni con l'utente (2026-10-08): la voce 17 cambia, la lingua primaria è l'inglese e la lingua dell'app è selezionabile; la voce 10 resta invariata. Base: `main` dopo `260df62`.

## Global Constraints

- Tutti i vincoli delle fasi 1–5 restano validi (sandbox, approvazioni, token UI, chiavi solo nel core, `.git`/`.claude`/`CLAUDE.md`/`.studio` protetti, una sola istanza, smoke test solo con cartelle temporanee).
- Lingue supportate: `en` (predefinita e di riserva) e `it`. Tipo: `export type Locale = 'en' | 'it'`.
- Risoluzione della lingua di sistema: la prima lingua preferita che inizia con `it` → `it`; altrimenti `en`.
- Copy inglese: frasi brevi e dirette, voce attiva, nomi che l'utente riconosce. Gli errori dicono cosa è successo e come rimediare, senza scuse. Stesso registro dell'italiano attuale. I testi italiani esistenti diventano il catalogo `it` **senza cambiarli**.
- Nessuna stringa visibile all'utente scritta direttamente nel codice di `packages/web/src`, `packages/core/src` (messaggi restituiti alla UI), `apps/desktop/src`, `apps/cli/src`: sempre `t('chiave')` o la funzione del catalogo. I commenti nel codice restano in inglese, come oggi.
- I dati già salvati restano come sono: testi scritti in passato (problemi di validazione in `versions.json`, messaggi della conversazione, linee guida) non vengono tradotti. Solo i nuovi testi usano la lingua corrente.
- Niente logica basata sul testo di un'etichetta (es. `job.label === 'Descrizione asset'`): usare campi strutturati.
- Prompt dell'agente in inglese (istruzioni) con la richiesta esplicita di rispondere e scrivere i testi per l'utente nella lingua impostata (`English` / `Italian`).
- Test esistenti: un file di setup Vitest imposta la lingua `it` per i test di `core`, `web`, `desktop` e `cli`, così le asserzioni attuali sui testi italiani restano valide. I nuovi test coprono anche `en`.
- Niente push, PR, tag, release o pubblicazioni da parte dell'esecutore.

## Review Focus

1. **Chiave mancante o segnaposto sbagliato**: una traduzione `it` senza una chiave, o con parametri diversi da `en`, deve far fallire il typecheck o un test, mai mostrare `undefined` o la chiave grezza. → Task 1.
2. **Cambio lingua a metà sessione**: dopo il cambio nelle Impostazioni, UI ed errori del core passano alla nuova lingua senza ricaricare; le richieste dell'agente già in corso non si interrompono. → Task 2 e Task 5.
3. **Lingua di sistema non supportata o assente** (`de-DE`, `LANG=C`, `navigator.languages` vuoto): l'app parte in inglese senza errori. → Task 1 e Task 2.
4. **Stringhe dimenticate**: un testo italiano rimasto nel codice compare in inglese mischiato. Uno script di controllo in CI segnala le stringhe sospette fuori dai cataloghi. → Task 7.
5. **Etichette usate come chiavi** (job "Descrizione asset", nomi dei formati, titoli delle approvazioni): con l'inglese, la UI non deve perdere la distinzione tra analisi e descrizione degli asset né rompere il riconoscimento delle approvazioni. → Task 3.

---

## File Structure

```
packages/shared/src/i18n/
  index.ts        # Locale, Messages, createT(), resolveLocale(), languageName()
  en.ts           # source of truth
  it.ts           # typed as Messages
packages/shared/test/i18n.test.ts
packages/core/src/i18n.ts            # currentLocale(), setLocale(), t()
packages/core/test/setup-locale.ts   # sets 'it' for existing tests
packages/web/src/i18n.tsx            # I18nProvider, useT(), useLocale()
packages/web/test/setup-locale.ts
scripts/check-i18n.mjs               # heuristic: Italian-looking literals outside catalogs
README.md (English)  README.it.md (Italian)  CONTRIBUTING.md (+ "Adding a language")
```

---

### Task 1: Catalogo tipizzato e risoluzione della lingua (`packages/shared`)

**Files:**
- Create: `packages/shared/src/i18n/index.ts`, `packages/shared/src/i18n/en.ts`, `packages/shared/src/i18n/it.ts`, `packages/shared/test/i18n.test.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/schemas.ts` (`appConfigSchema.language`)

**Interfaces:**
```ts
export type Locale = 'en' | 'it';
export const LOCALES: readonly Locale[];                 // ['en', 'it']
export type LanguageSetting = 'system' | Locale;
export type Messages = typeof en;                        // en.ts: `export const en = { … } as const satisfies Catalog`
export function resolveLocale(setting: LanguageSetting | undefined, systemLocales: readonly string[]): Locale;
  // setting en/it → that; otherwise first system locale starting with 'it' (case-insensitive) → 'it'; else 'en'
export function messages(locale: Locale): Messages;
export function languageName(locale: Locale): string;    // 'English' | 'Italian' (used in agent prompts)
export function plural(locale: Locale, n: number, forms: { one: string; other: string }): string;  // Intl.PluralRules
```
- The catalog is a nested object grouped by area (`common`, `errors`, `doctor`, `approvals`, `onboarding`, `projects`, `brand`, `assets`, `creatives`, `export`, `settings`, `desktop`, `cli`, `formats`, …). Leaves are either `string` or `(p: {...}) => string`.
- `it.ts`: `export const it: Messages = { … }`. TypeScript enforces the same keys and the same parameter shapes.
- `appConfigSchema` gains `language: z.enum(['system', 'en', 'it']).default('system')`.

- [ ] **Step 1: Test che falliscono**

```ts
import { describe, expect, it } from 'vitest';
import { LOCALES, messages, plural, resolveLocale } from '../src/i18n/index.ts';

const leaves = (o: unknown, path = ''): Array<[string, unknown]> =>
  typeof o === 'object' && o !== null ? Object.entries(o).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k)) : [[path, o]];

describe('resolveLocale', () => {
  it('honours an explicit choice', () => { expect(resolveLocale('it', ['en-US'])).toBe('it'); expect(resolveLocale('en', ['it-IT'])).toBe('en'); });
  it('follows the system for Italian, English otherwise', () => {
    expect(resolveLocale('system', ['it-IT', 'en'])).toBe('it');
    expect(resolveLocale('system', ['de-DE', 'it'])).toBe('it');
    expect(resolveLocale('system', ['de-DE'])).toBe('en');
    expect(resolveLocale(undefined, [])).toBe('en');
    expect(resolveLocale('system', ['C', 'POSIX'])).toBe('en');
  });
});

describe('catalogs', () => {
  it('have the same keys and no empty strings', () => {
    const en = leaves(messages('en')); const itl = leaves(messages('it'));
    expect(itl.map(([k]) => k).sort()).toEqual(en.map(([k]) => k).sort());
    for (const l of LOCALES) for (const [k, v] of leaves(messages(l))) {
      if (typeof v === 'string') expect(v.trim(), `${l}:${k}`).not.toBe('');
      else expect(typeof v, `${l}:${k}`).toBe('function');
    }
  });
  it('pluralises', () => {
    expect(plural('en', 1, { one: '1 file', other: 'files' })).toBe('1 file');
    expect(plural('it', 2, { one: 'file', other: '2 file' })).toBe('2 file');
  });
});
```

- [ ] **Step 2: Implementa** `index.ts`, `en.ts` e `it.ts`, all'inizio con il gruppo `common` e le chiavi usate dai test. I task successivi aggiungono le chiavi della propria area **in entrambi i file nello stesso commit**.
- [ ] **Step 3:** `pnpm vitest run packages/shared && pnpm typecheck`.
- [ ] **Step 4: Commit** `feat(shared): typed message catalogs for English and Italian with locale resolution`.

---

### Task 2: Lingua nel core, impostazione e API

**Files:**
- Create: `packages/core/src/i18n.ts`, `packages/core/test/i18n.test.ts`, `packages/core/test/setup-locale.ts`
- Modify: `packages/core/src/app-config.ts`, `packages/core/src/server/main.ts` (option `systemLocales?: string[]`), the settings/snapshot routes in `packages/core/src/server/app.ts`, the core and apps vitest config (`setupFiles`), `apps/desktop/src/main.ts` (passes `app.getPreferredSystemLanguages()`), `apps/cli/src/main.ts` (passes `Intl.DateTimeFormat().resolvedOptions().locale` plus `LC_ALL`/`LC_MESSAGES`/`LANG` when set, normalised from `it_IT.UTF-8` to `it-IT`)

**Interfaces:**
```ts
// packages/core/src/i18n.ts
export function setLocale(l: Locale): void;
export function currentLocale(): Locale;
export function t(): Messages;                           // messages(currentLocale())
```
- `AppConfigStore.setLanguage(setting: LanguageSetting): Promise<AppConfig>`.
- At startup `startServer` computes `resolveLocale(config.language, opts.systemLocales ?? detectSystemLocales())` and calls `setLocale`.
- `PUT /api/settings/language { language: 'system' | 'en' | 'it' }` → 400 on other values; saves, recomputes, calls `setLocale`, broadcasts on the WebSocket `{ type: 'locale', locale, setting }`. It requires the UI token like every other mutating route.
- The WebSocket snapshot and `GET /api/settings` include `{ locale, languageSetting }`.
- `setup-locale.ts`: `setLocale('it')` before each test file, so existing assertions keep their Italian texts.

- [ ] **Step 1: Test che falliscono.** Persistenza e default `system`, cambio tramite API con broadcast, 400 su `'de'`, `systemLocales: ['de-DE']` → `en`, `['it-IT']` → `it`, `LANG=it_IT.UTF-8` normalizzato dal CLI.
- [ ] **Step 2: Implementa, verifica** (`pnpm vitest run packages/core apps && pnpm typecheck`).
- [ ] **Step 3: Commit** `feat(core): language setting with system detection and live switching`.

---

### Task 3: Messaggi del core

Copre tutto ciò che il core restituisce o salva per l'utente.

**Files:** `packages/core/src/**` (WorkspaceError messages, Doctor checks and fixes, approval card titles/descriptions, cost confirmations, validation problems, export results, job labels, commit messages shown in the history, 401 pairing page, provider errors), `packages/shared/src/formats.ts` (format names and channel labels), the catalogs.

**Interfaces:**
- `JobSummary` gains `kind: 'creative' | 'brand-analysis' | 'asset-description' | …` (shared schema). `labels.ts` replaces `isDescribeJob` text comparison with `job.kind === 'asset-description'`. `label` stays as display text, localized when the job is created.
- `FormatPreset.name` and the channel names become catalog keys: `formats.<id>` and `channels.<channel>`. The shared catalog resolves them; the format id stays the stable key.
- The approval cards carry a stable `kind` (already present or added) for logic, and a localized `title`/`description` for display.

- [ ] **Step 1:** Estrai per area: un commit per gruppo (`errors`, `doctor`, `approvals`, `validation`, `export`, `jobs`, `formats`, `pairing`). Ogni gruppo aggiunge le chiavi in `en.ts` e `it.ts`. Il testo `it` è identico a quello attuale.
- [ ] **Step 2:** Test nuovi in `en`. Almeno: un errore 404 di progetto, un check del Doctor, una scheda di approvazione "file fuori dal progetto", un problema di validazione, la pagina 401 di abbinamento, il nome di un formato. Ognuno usa `setLocale('en')` nel test.
- [ ] **Step 3:** Test: la UI distingue l'analisi dalla descrizione degli asset anche con l'etichetta in inglese (`kind`).
- [ ] **Step 4:** `pnpm test && pnpm typecheck`. Commit per gruppo con `refactor(core): localize <area> messages`.

---

### Task 4: Prompt dell'agente e server MCP

**Files:** `packages/core/src/creatives/prompt.ts`, `packages/core/src/brand/brand-prompt.ts`, `packages/mcp-studio/src/server.mjs`, tests in `packages/core/test/prompt.test.ts` and the brand prompt tests.

**Interfaces:**
- The builders take `locale: Locale` (from `currentLocale()` at job start; a running job keeps its language).
- The instructions are in English. They end with: `Always reply to the user in ${languageName(locale)}. Write every text meant for the user (conversation messages, brand guidelines, asset descriptions, problem reports) in ${languageName(locale)}.`
- Remove `Rispondi sempre in italiano` and `in italiano` from the descriptions and guidelines instructions.
- The tool descriptions and messages of the MCP server, read by the agent, move to English. Tool results whose text reaches the UI (e.g. confirmations, cost denials) come from the core, which localizes them.

- [ ] **Step 1: Test.** Prompt con `it` contiene `Always reply to the user in Italian.`, con `en` `in English.`; nessuna occorrenza di `italiano` nei prompt; il job già avviato mantiene la lingua anche se la si cambia durante il turno.
- [ ] **Step 2: Implementa, verifica, commit** `feat(core): agent prompts in English answering in the user's language`.

---

### Task 5: Interfaccia web

**Files:** `packages/web/src/i18n.tsx`, `packages/web/test/setup-locale.ts`, every screen and component in `packages/web/src/screens/*` and `packages/web/src/components/*`, `labels.ts`, `useServerEvents.ts`/`eventsReducer.ts` (event `locale`), `index.html` (`lang` updated at runtime), `SettingsPage.tsx` (language selector), the catalogs.

**Interfaces:**
```tsx
export function I18nProvider(props: { locale: Locale; children: ReactNode }): JSX.Element;
export function useT(): Messages;
export function useLocale(): Locale;
export function formatDate(locale: Locale, iso: string, opts?: Intl.DateTimeFormatOptions): string;
```
- The locale comes from the snapshot and the `locale` event. Before the first snapshot (pairing page, Onboarding loading) the UI uses `resolveLocale('system', navigator.languages)`.
- `document.documentElement.lang = locale` on every change.
- Settings → **Language** (it: **Lingua**): radio buttons `System (English)` / `English` / `Italiano`, with the System option showing the detected language. A change calls `PUT /api/settings/language` and applies immediately. Each language is always written in its own language.
- Every date and number in the UI uses `Intl` with the current locale.

- [ ] **Step 1:** `i18n.tsx` con i test: provider, cambio lingua dall'evento, `lang` sul documento, selettore nelle Impostazioni.
- [ ] **Step 2:** Estrai le stringhe schermata per schermata, con un commit per gruppo: `onboarding+projects`, `brand+assets+references`, `creatives`, `approvals+settings+export`, `components condivisi`.
- [ ] **Step 3:** Per ogni gruppo, almeno un test di render in `en` con un testo chiave in inglese.
- [ ] **Step 4:** `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`.

---

### Task 6: App desktop e CLI

**Files:** `apps/desktop/src/main.ts` (menu, dialog titles, notifications, the "already running" and restart prompts), `apps/cli/src/main.ts` (help, startup lines, `--print-url`, "already running"), the catalogs.

- Desktop: the menu is rebuilt when the `locale` event arrives (the main process listens to the core in-process; expose an `onLocaleChange(cb)` from `startServer`'s result).
- CLI: messages in the locale resolved at startup (`config.language` and the system language).

- [ ] **Step 1: Test.** Menu `en` (`Edit`, `View`, `Window`, `Help`) e `it` (`Modifica`, `Vista`, `Finestra`, `Aiuto`); help del CLI in `en` con `LANG=en_US.UTF-8` e in `it` con `LANG=it_IT.UTF-8`.
- [ ] **Step 2: Implementa, verifica** (`pnpm vitest run apps && pnpm --filter motion-studio-desktop smoke`), **commit**.

---

### Task 7: Controllo automatico e documentazione

**Files:** `scripts/check-i18n.mjs`, `package.json` (script `check:i18n`), `.github/workflows/ci.yml` (step after typecheck), `README.md` (English), `README.it.md` (Italian, the current README updated), `CONTRIBUTING.md` (English, with "Adding a language"), `docs/output-contract.md`, `docs/providers.md`, `docs/agent-backends.md` (English).

- `check-i18n.mjs` scans string literals and JSX text in `packages/*/src`, `apps/*/src`, `packages/mcp-studio/src` (excluding `i18n/` catalogs and test files). It fails when one contains Italian accented letters (`àèéìòù`) or one of a short list of frequent Italian words as whole words (`il`, `della`, `non`, `per`, `una`, `nella`, `sono`, `errore`, `cartella`, `progetto`, …). It accepts `// i18n-ignore` on the same line for real exceptions (e.g. the `Italiano` label).
- README in English with a link `🇮🇹 Italiano` → `README.it.md`, and vice versa.
- "Adding a language" in CONTRIBUTING: copy `en.ts` to `<code>.ts`, translate it, add it to `LOCALES`, `resolveLocale`, `languageName` and the Settings selector; the typecheck lists any missing key.

- [ ] **Step 1:** Script con un test su un file d'esempio, che deve segnalare `'Cartella non trovata'` e ignorare `'Not found'`.
- [ ] **Step 2:** `pnpm check:i18n` deve passare su tutto il repository. Ogni stringa segnalata va spostata nel catalogo, oppure marcata con `i18n-ignore` e una motivazione.
- [ ] **Step 3:** Documentazione. **Commit** `docs: English documentation with Italian README; i18n check in CI`.

---

### Task 8: Verifica finale

- [ ] **Step 1:** `pnpm test && pnpm typecheck && pnpm build && pnpm check:i18n` → tutto verde.
- [ ] **Step 2:** Core dal CLI con config temporanea e `LANG=en_US.UTF-8`: snapshot `locale: 'en'`. Un errore (progetto inesistente) arriva in inglese, e la pagina 401 è in inglese. `PUT /api/settings/language {"language":"it"}` → lo stesso errore in italiano, senza riavviare.
- [ ] **Step 3:** Con `LANG=it_IT.UTF-8` e config nuova si parte in italiano.
- [ ] **Step 4:** Smoke del desktop (cartelle temporanee) e del Doctor in entrambe le lingue.
- [ ] **Step 5:** Prompt reale: con il finto claude in modalità che registra il prompt, una creatività in `en` contiene `Always reply to the user in English.`.
- [ ] **Step 6: Rapporto.** Numero di chiavi del catalogo, stringhe marcate `i18n-ignore` con il motivo, cosa resta da verificare a occhio: lunghezza dei testi inglesi nei bottoni e nella tavola dei formati, a 1024 px di larghezza.
