# Motion Studio — Fase 2: Creatività — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dentro un progetto l'utente crea una creatività da un brief guidato (obiettivo, messaggio, formati dal catalogo, durata, note), l'agente produce gli output nel contratto stabilito, il core li valida (con correzione automatica fino a 3 tentativi), salva una versione (commit git + `outputs/vN/` + anteprime), e l'utente itera dalla tavola dei formati con commenti ancorati a formato/tempo/punto, può ripartire da una versione precedente, confrontare versioni e aprire la cartella degli output.

**Architecture:** Si estende la Fase 1. `packages/shared` aggiunge catalogo formati e schemi della creatività. `packages/core` aggiunge `FormatCatalog`, `CreativeStore` (file della creatività), `MediaTools` (ffprobe/ffmpeg), `validateOutputs` (contratto), `buildCreativePrompt` e `CreativeTurnService`, che esegue un turno come job della `JobQueue` esistente e scrive conversazione, versioni e commit. La validazione avviene **dopo** il turno nel core (il tool MCP `validate_output` arriverà in Fase 4): se fallisce, il core rilancia l'agente sulla stessa sessione con l'elenco dei problemi. `packages/web` aggiunge le schermate creatività secondo la direzione UI §8.1 (tavola dei formati, vista focus, pannello conversazione con schede Conversazione/Brief/Esperto).

**Tech Stack:** come Fase 1 (Node ≥ 22, pnpm 10, TypeScript 5.9 ESM, zod 4, Fastify 5, React 19 + Vite 7, Vitest 3). Nuovi: `open` nel core (rivela cartella), ffmpeg/ffprobe di sistema (opzionali, rilevati dal Doctor).

**Spec:** `docs/superpowers/specs/2026-10-07-motion-studio-design.md` (§3 struttura, §4 contratto, §5 catalogo, §6.2 ciclo di vita, §8 UI, §9 errori). Base di codice: branch `feat/phase1-foundation` (Fase 1 completata).

## Global Constraints

- Tutti i vincoli globali della Fase 1 restano validi (tutto locale, `schemaVersion: 1` in ogni JSON, mai sovrascrivere JSON non validi, git serializzato per progetto, loopback-only, colori solo da token CSS, copy in italiano, `AgentRunner` neutro).
- Struttura creatività (spec §3): `creatives/<yyyy-mm-dd-slug>/` con `creative.json`, `conversation.jsonl`, `versions.json`, `work/` (spazio libero dell'agente), `outputs/vN/` (escluso da git) con `manifest.json`.
- Contratto (spec §4): per ogni formato richiesto un file nominato dal preset (`<presetId>.<ext>`), `manifest.json` con file, preset, risoluzione, durata (video), formato file, strumenti usati e comando di re-render; validazione di presenza, risoluzione e durata; **default 3 tentativi**, poi versione **incompleta** con elenco mancanze.
- Ogni formato è una **ricomposizione** dedicata (scritto nelle istruzioni all'agente).
- Versione = commit git del progetto + voce in `versions.json`; ripartire da una versione = ripristino di `work/` da quel commit + `--resume <sessione di vN> --fork-session`.
- Catalogo formati in `<workspace>/.studio/presets/formats.json`, modificabile; creato con i default se manca; un file non valido non viene sovrascritto (si usano i default e si segnala l'errore).
- `.studio/context.md` è di proprietà dell'app: viene riscritto prima di ogni turno.
- Stati creatività: `draft`, `working`, `ready`, `incomplete`, `error`, `interrupted` (spec §8: bozza, in lavorazione, pronta, incompleta, errore, interrotta; "in attesa di approvazione" arriva in Fase 4).
- All'avvio del server le creatività in `working` diventano `interrupted` (spec §9).
- ffmpeg/ffprobe opzionali: senza, la validazione si fida del manifest (output marcati "non verificati") e non ci sono anteprime estratte.
- Fuori scope (fasi successive, scritto nel README): esecuzione automatica del comando di re-render (Fase 4, richiede approvazioni), tool MCP `validate_output`/`report_progress` (Fase 4), brand kit/asset/codebase collegate (Fase 3), dialog nativi ed export in cartella scelta (Fase 5).

## Review Focus

1. **Output parziali o sbagliati dall'agente** (manca un formato, risoluzione diversa, manifest assente o JSON rotto, file che punta fuori da `outputs/vN/`): il core non va in crash, elenca i problemi in italiano, rilancia l'agente fino a 3 volte, poi salva una versione "incompleta" visibile in UI. → test in Task 5 e Task 8.
2. **Turno fallito o annullato a metà** (claude crasha, limite di utilizzo, Annulla): nessuna versione viene creata, lo stato della creatività diventa `error` (con messaggio) o torna allo stato precedente se annullato, la conversazione registra l'evento; il server riavviato durante un turno mostra la creatività come `interrupted`. → test in Task 3 e Task 8.
3. **Path traversal sui file serviti** (`../`, percorsi assoluti, symlink in `outputs/`): l'endpoint dei file serve solo dentro la cartella della creatività. → test in Task 9.
4. **ffmpeg/ffprobe assenti**: creazione, turni e versioni funzionano; gli output sono "non verificati" e la UI mostra i file senza anteprima estratta; i commenti su timestamp passano come testo. → test in Task 4, Task 5 e Task 8.
5. **`formats.json` modificato a mano e non valido / preset rimosso usato da una creatività esistente**: il catalogo ripiega sui default con un errore visibile; una creatività che richiede un preset sconosciuto mostra il formato come "preset sconosciuto" senza rompere la pagina e la validazione lo segnala come problema. → test in Task 2, Task 5 e Task 12.

---

## File Structure

```
packages/shared/src/
  formats.ts                 # FormatPreset, DEFAULT_FORMATS, formatPresetSchema, formatsFileSchema
  creative.ts                # creativeFileSchema, versionsFileSchema, manifestSchema, Pin, ConversationEntry, DTO
  events.ts                  # (modify) ServerMessage + 'creative'
  index.ts                   # (modify) re-export
packages/core/src/
  formats/format-catalog.ts  # load/save formats.json nel workspace
  creatives/creative-store.ts# file della creatività: create/list/get/update, versions, conversation, recovery
  media/media-tools.ts       # MediaTools: probe (ffprobe), poster/frame (ffmpeg); NoMediaTools
  creatives/output-contract.ts # validateOutputs()
  creatives/prompt.ts        # buildCreativePrompt(), CONTRACT_MD
  creatives/creative-turns.ts# CreativeTurnService
  project-template.ts        # (modify) CONTEXT_MD con sezione contratto
  agent/runner.ts            # (modify) forkSession
  agent/claude-code-runner.ts# (modify) --fork-session
  git.ts                     # (modify) restorePath()
  server/app.ts              # (modify) route creatività, formati, file, reveal
  server/creative-routes.ts  # route creatività (registrate da app.ts)
  server/main.ts             # (modify) MediaTools reali, opener reale
packages/core/test/
  fixtures/fake-claude.mjs   # (modify) scenari render / render_missing_once / render_never
  format-catalog.test.ts  creative-store.test.ts  media-tools.test.ts
  output-contract.test.ts  prompt.test.ts  creative-turns.test.ts  creative-routes.test.ts
packages/web/src/
  api.ts                     # (modify) API creatività
  routes.ts                  # parseRoute()
  App.tsx                    # (modify) routing
  screens/ProjectPage.tsx    # (modify) schede Creatività / Console
  screens/CreativeList.tsx
  screens/NewCreative.tsx
  screens/CreativePage.tsx
  components/FormatBoard.tsx # tavola dei formati
  components/FormatFrame.tsx # riquadro con output/placeholder e pin
  components/FocusView.tsx   # vista focus con player e aggiunta pin
  components/ConversationPanel.tsx
  components/StatusBadge.tsx
  frameSize.ts               # dimensioni riquadri in proporzioni reali
  useCreative.ts             # carica creatività + ricarica su messaggi 'creative'
packages/web/test/
  routes.test.ts frameSize.test.ts NewCreative.test.tsx FormatBoard.test.tsx ConversationPanel.test.tsx CreativePage.test.tsx
```

---

### Task 1: Catalogo formati e schemi della creatività (shared)

**Files:**
- Create: `packages/shared/src/formats.ts`, `packages/shared/src/creative.ts`, `packages/shared/test/formats.test.ts`, `packages/shared/test/creative.test.ts`
- Modify: `packages/shared/src/events.ts`, `packages/shared/src/index.ts`

**Interfaces:**
- Produces (`formats.ts`):
  ```ts
  export type FormatKind = 'video' | 'image';
  export interface FormatPreset {
    id: string;            // /^[a-z0-9][a-z0-9-]{0,62}$/, also the output file stem
    channel: string;       // e.g. 'Instagram'
    name: string;          // e.g. 'Story/Reel 9:16'
    width: number; height: number;
    kind: FormatKind;
    extensions: string[];  // allowed, lowercase without dot, first = preferred
    maxDurationSec?: number;
    safeZone?: { top: number; bottom: number; left: number; right: number }; // px of the preset size
    maxFileMB?: number;
  }
  export const formatPresetSchema; export const formatsFileSchema; // { schemaVersion: 1, presets: FormatPreset[] } with unique ids
  export const DEFAULT_FORMATS: FormatPreset[];
  ```
- Produces (`creative.ts`):
  ```ts
  export type CreativeStatus = 'draft' | 'working' | 'ready' | 'incomplete' | 'error' | 'interrupted';
  export interface Brief { goal: string; message: string; formats: string[]; durationSec: number | null; assets: string[]; notes: string }
  export interface CreativeFile { schemaVersion: 1; title: string; brief: Brief; status: CreativeStatus; error: string | null;
    createdAt: string; updatedAt: string; resumeFrom: { version: number; sessionId: string } | null }
  export interface OutputFileInfo { format: string; file: string; width: number; height: number; durationSec: number | null; verified: boolean; preview: string | null }
  export interface VersionEntry { n: number; commit: string | null; sessionId: string | null; status: 'complete' | 'incomplete';
    createdAt: string; request: string; outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: string | null; basedOn: number | null }
  export interface VersionsFile { schemaVersion: 1; versions: VersionEntry[] }
  export interface ManifestFile { schemaVersion: 1; files: Array<{ format: string; file: string; width: number; height: number; durationSec?: number }>; tools: string[]; renderCommand?: string }
  export interface Pin { format: string; x: number; y: number; timeSec: number | null; note?: string } // x,y in 0..1
  export type ConversationEntry =
    | { type: 'user'; at: string; text: string; pins: Pin[]; attachments: string[] }
    | { type: 'agent'; at: string; jobId: string; event: AgentEvent }
    | { type: 'version'; at: string; n: number; status: 'complete' | 'incomplete' }
    | { type: 'system'; at: string; level: 'info' | 'error'; text: string };
  export interface CreativeSummary { slug: string; title: string; status: CreativeStatus; formats: string[]; versions: number; updatedAt: string; cover: string | null }
  export type CreativeListItem = ({ ok: true } & CreativeSummary) | { ok: false; slug: string; error: string };
  export interface CreativeDetail { slug: string; creative: CreativeFile; versions: VersionEntry[]; jobKey: string }
  // zod: briefSchema, creativeFileSchema, versionsFileSchema, manifestSchema, pinSchema
  ```
- Produces (`events.ts`): `ServerMessage` gains `| { type: 'creative'; project: string; creative: string }` (a creative's files changed: clients refetch).

- [ ] **Step 1: Test che falliscono**

`packages/shared/test/formats.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMATS, formatsFileSchema } from '../src/index.ts';

describe('DEFAULT_FORMATS', () => {
  it('has unique ids that are valid file stems', () => {
    const ids = DEFAULT_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
  it('covers every channel of spec §5', () => {
    const channels = new Set(DEFAULT_FORMATS.map((f) => f.channel));
    for (const c of ['Instagram', 'TikTok', 'YouTube', 'Facebook', 'LinkedIn', 'X', 'Pinterest', 'Web', 'App Store', 'Play Store']) {
      expect(channels.has(c)).toBe(true);
    }
  });
  it('validates as a formats file', () => {
    expect(formatsFileSchema.safeParse({ schemaVersion: 1, presets: DEFAULT_FORMATS }).success).toBe(true);
  });
  it('rejects duplicate ids', () => {
    const p = DEFAULT_FORMATS[0]!;
    expect(formatsFileSchema.safeParse({ schemaVersion: 1, presets: [p, p] }).success).toBe(false);
  });
  it('video presets accept mp4 first; image presets accept png first', () => {
    for (const f of DEFAULT_FORMATS) expect(f.extensions[0]).toBe(f.kind === 'video' ? 'mp4' : 'png');
  });
});
```

`packages/shared/test/creative.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { creativeFileSchema, manifestSchema, pinSchema, versionsFileSchema } from '../src/index.ts';

const now = '2026-10-07T10:00:00.000Z';
const creative = {
  schemaVersion: 1, title: 'Lancio app', status: 'draft', error: null, createdAt: now, updatedAt: now, resumeFrom: null,
  brief: { goal: 'Far capire che prenotare è immediato', message: '', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' },
};

describe('creativeFileSchema', () => {
  it('accepts a valid creative', () => { expect(creativeFileSchema.parse(creative)).toEqual(creative); });
  it('requires at least one format and a non-empty goal', () => {
    expect(creativeFileSchema.safeParse({ ...creative, brief: { ...creative.brief, formats: [] } }).success).toBe(false);
    expect(creativeFileSchema.safeParse({ ...creative, brief: { ...creative.brief, goal: ' ' } }).success).toBe(false);
  });
  it('rejects a duration outside 1..600', () => {
    expect(creativeFileSchema.safeParse({ ...creative, brief: { ...creative.brief, durationSec: 0 } }).success).toBe(false);
  });
});

describe('manifestSchema', () => {
  it('accepts a manifest and rejects file names with path separators', () => {
    const m = { schemaVersion: 1, files: [{ format: 'instagram-post-1x1', file: 'instagram-post-1x1.png', width: 1080, height: 1080 }], tools: ['remotion'] };
    expect(manifestSchema.parse(m)).toEqual(m);
    expect(manifestSchema.safeParse({ ...m, files: [{ ...m.files[0], file: '../x.png' }] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...m, files: [{ ...m.files[0], file: 'a/b.png' }] }).success).toBe(false);
  });
});

describe('pinSchema', () => {
  it('keeps coordinates in 0..1', () => {
    expect(pinSchema.safeParse({ format: 'a', x: 0.5, y: 1, timeSec: null }).success).toBe(true);
    expect(pinSchema.safeParse({ format: 'a', x: 1.2, y: 0, timeSec: null }).success).toBe(false);
  });
});

describe('versionsFileSchema', () => {
  it('defaults to an empty list', () => {
    expect(versionsFileSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1, versions: [] });
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/shared`
Expected: FAIL (export mancanti).

- [ ] **Step 3: Implementa `formats.ts`**

```ts
import { z } from 'zod';

export type FormatKind = 'video' | 'image';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const formatPresetSchema = z.object({
  id: z.string().regex(ID_RE),
  channel: z.string().min(1),
  name: z.string().min(1),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  kind: z.enum(['video', 'image']),
  extensions: z.array(z.string().regex(/^[a-z0-9]{2,5}$/)).min(1),
  maxDurationSec: z.number().positive().optional(),
  safeZone: z.object({ top: z.number().min(0), bottom: z.number().min(0), left: z.number().min(0), right: z.number().min(0) }).optional(),
  maxFileMB: z.number().positive().optional(),
});
export type FormatPreset = z.infer<typeof formatPresetSchema>;

export const formatsFileSchema = z.object({
  schemaVersion: z.literal(1),
  presets: z.array(formatPresetSchema).min(1),
}).refine((f) => new Set(f.presets.map((p) => p.id)).size === f.presets.length, { message: 'id dei preset duplicati', path: ['presets'] });
export type FormatsFile = z.infer<typeof formatsFileSchema>;

const VIDEO = ['mp4', 'webm', 'mov', 'gif'];
const IMAGE = ['png', 'jpg', 'jpeg', 'webp'];
const v = (id: string, channel: string, name: string, width: number, height: number, extra: Partial<FormatPreset> = {}): FormatPreset =>
  ({ id, channel, name, width, height, kind: 'video', extensions: VIDEO, ...extra });
const i = (id: string, channel: string, name: string, width: number, height: number, extra: Partial<FormatPreset> = {}): FormatPreset =>
  ({ id, channel, name, width, height, kind: 'image', extensions: IMAGE, ...extra });

// Store specs change often: values to re-check against official docs before each release.
const REELS_SAFE = { top: 220, bottom: 420, left: 60, right: 120 };

export const DEFAULT_FORMATS: FormatPreset[] = [
  v('instagram-post-1x1', 'Instagram', 'Post 1:1', 1080, 1080, { maxDurationSec: 60 }),
  v('instagram-post-4x5', 'Instagram', 'Post 4:5', 1080, 1350, { maxDurationSec: 60 }),
  v('instagram-reel-9x16', 'Instagram', 'Story/Reel 9:16', 1080, 1920, { maxDurationSec: 90, safeZone: REELS_SAFE }),
  i('instagram-image-1x1', 'Instagram', 'Immagine 1:1', 1080, 1080),
  i('instagram-image-4x5', 'Instagram', 'Immagine 4:5', 1080, 1350),
  v('tiktok-9x16', 'TikTok', 'Video 9:16', 1080, 1920, { maxDurationSec: 180, safeZone: REELS_SAFE }),
  v('youtube-16x9', 'YouTube', 'Video 16:9', 1920, 1080),
  v('youtube-4k-16x9', 'YouTube', 'Video 4K 16:9', 3840, 2160),
  v('youtube-shorts-9x16', 'YouTube', 'Shorts 9:16', 1080, 1920, { maxDurationSec: 60, safeZone: REELS_SAFE }),
  i('youtube-thumbnail', 'YouTube', 'Thumbnail', 1280, 720, { maxFileMB: 2 }),
  v('facebook-feed-1x1', 'Facebook', 'Feed 1:1', 1080, 1080),
  v('facebook-feed-4x5', 'Facebook', 'Feed 4:5', 1080, 1350),
  v('facebook-story-9x16', 'Facebook', 'Story 9:16', 1080, 1920, { maxDurationSec: 60, safeZone: REELS_SAFE }),
  i('facebook-cover', 'Facebook', 'Cover', 1640, 624),
  v('linkedin-1x1', 'LinkedIn', 'Post 1:1', 1080, 1080),
  v('linkedin-4x5', 'LinkedIn', 'Post 4:5', 1080, 1350),
  v('linkedin-16x9', 'LinkedIn', 'Video 16:9', 1920, 1080),
  i('linkedin-banner', 'LinkedIn', 'Banner', 1584, 396),
  v('x-16x9', 'X', 'Video 16:9', 1600, 900),
  v('x-1x1', 'X', 'Post 1:1', 1080, 1080),
  i('pinterest-2x3', 'Pinterest', 'Pin 2:3', 1000, 1500),
  i('web-hero-16x9', 'Web', 'Hero 16:9', 1920, 1080),
  i('web-banner-300x250', 'Web', 'Banner 300×250', 300, 250),
  i('web-banner-728x90', 'Web', 'Banner 728×90', 728, 90),
  i('web-banner-160x600', 'Web', 'Banner 160×600', 160, 600),
  i('appstore-iphone-69', 'App Store', 'Screenshot iPhone 6.9"', 1320, 2868),
  i('appstore-iphone-65', 'App Store', 'Screenshot iPhone 6.5"', 1284, 2778),
  i('appstore-ipad-13', 'App Store', 'Screenshot iPad 13"', 2064, 2752),
  v('appstore-preview', 'App Store', 'App Preview', 886, 1920, { maxDurationSec: 30, extensions: ['mp4', 'mov'] }),
  i('appstore-icon', 'App Store', 'Icona', 1024, 1024),
  i('playstore-feature', 'Play Store', 'Feature graphic', 1024, 500),
  i('playstore-phone-9x16', 'Play Store', 'Screenshot telefono 9:16', 1080, 1920),
  i('playstore-tablet', 'Play Store', 'Screenshot tablet', 1600, 2560),
  i('playstore-icon', 'Play Store', 'Icona', 512, 512),
  v('playstore-promo-16x9', 'Play Store', 'Video promo 16:9', 1920, 1080),
];
```

- [ ] **Step 4: Implementa `creative.ts`**

```ts
import { z } from 'zod';
import type { AgentEvent } from './events.ts';

export const creativeStatusSchema = z.enum(['draft', 'working', 'ready', 'incomplete', 'error', 'interrupted']);
export type CreativeStatus = z.infer<typeof creativeStatusSchema>;

export const briefSchema = z.object({
  goal: z.string().trim().min(1),
  message: z.string(),
  formats: z.array(z.string().min(1)).min(1),
  durationSec: z.number().int().min(1).max(600).nullable(),
  assets: z.array(z.string()),
  notes: z.string(),
});
export type Brief = z.infer<typeof briefSchema>;

export const creativeFileSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1),
  brief: briefSchema,
  status: creativeStatusSchema,
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resumeFrom: z.object({ version: z.number().int().min(1), sessionId: z.string().min(1) }).nullable(),
});
export type CreativeFile = z.infer<typeof creativeFileSchema>;

export const outputFileInfoSchema = z.object({
  format: z.string(), file: z.string(), width: z.number(), height: z.number(),
  durationSec: z.number().nullable(), verified: z.boolean(), preview: z.string().nullable(),
});
export type OutputFileInfo = z.infer<typeof outputFileInfoSchema>;

export const versionEntrySchema = z.object({
  n: z.number().int().min(1),
  commit: z.string().nullable(),
  sessionId: z.string().nullable(),
  status: z.enum(['complete', 'incomplete']),
  createdAt: z.iso.datetime(),
  request: z.string(),
  outputs: z.array(outputFileInfoSchema),
  problems: z.array(z.string()),
  tools: z.array(z.string()),
  renderCommand: z.string().nullable(),
  basedOn: z.number().int().nullable(),
});
export type VersionEntry = z.infer<typeof versionEntrySchema>;

export const versionsFileSchema = z.object({ schemaVersion: z.literal(1), versions: z.array(versionEntrySchema).default([]) });
export type VersionsFile = z.infer<typeof versionsFileSchema>;

const FILE_NAME = /^[^/\\]+$/;
export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.array(z.object({
    format: z.string().min(1),
    file: z.string().regex(FILE_NAME).refine((f) => f !== '.' && f !== '..', 'nome file non valido'),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSec: z.number().positive().optional(),
  })),
  tools: z.array(z.string()).default([]),
  renderCommand: z.string().optional(),
});
export type ManifestFile = z.infer<typeof manifestSchema>;

export const pinSchema = z.object({
  format: z.string().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  timeSec: z.number().min(0).nullable(),
  note: z.string().optional(),
});
export type Pin = z.infer<typeof pinSchema>;

export type ConversationEntry =
  | { type: 'user'; at: string; text: string; pins: Pin[]; attachments: string[] }
  | { type: 'agent'; at: string; jobId: string; event: AgentEvent }
  | { type: 'version'; at: string; n: number; status: 'complete' | 'incomplete' }
  | { type: 'system'; at: string; level: 'info' | 'error'; text: string };

export interface CreativeSummary { slug: string; title: string; status: CreativeStatus; formats: string[]; versions: number; updatedAt: string; cover: string | null }
export type CreativeListItem = ({ ok: true } & CreativeSummary) | { ok: false; slug: string; error: string };
export interface CreativeDetail { slug: string; creative: CreativeFile; versions: VersionEntry[]; jobKey: string }
```

Note: `manifestSchema` with `tools.default([])` means `parse` adds `tools: []` when missing; the test passes `tools` explicitly so equality holds.

- [ ] **Step 5: Aggiorna `events.ts` e `index.ts`**

In `packages/shared/src/events.ts` replace the `ServerMessage` type with:
```ts
export type ServerMessage =
  | { type: 'snapshot'; jobs: JobSummary[] }
  | { type: 'job'; job: JobSummary }
  | { type: 'agent'; jobId: string; event: AgentEvent }
  /** A creative's files changed (status, versions, conversation): clients refetch it. */
  | { type: 'creative'; project: string; creative: string };
```

Append to `packages/shared/src/index.ts`:
```ts
export * from './formats.ts';
export * from './creative.ts';
```

- [ ] **Step 6: Adegua il reducer web al nuovo messaggio**

`packages/web/src/eventsReducer.ts`: in `eventsReducer` add before the closing of the switch:
```ts
    case 'creative':
      return state; // handled by useCreative (Task 10)
```

- [ ] **Step 7: Verifica**

Run: `pnpm vitest run packages/shared packages/web && pnpm typecheck`
Expected: tutti PASS, nessun errore di tipo.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(shared): format catalog and creative schemas"
```

---

### Task 2: FormatCatalog nel workspace

**Files:**
- Create: `packages/core/src/formats/format-catalog.ts`, `packages/core/test/format-catalog.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `readJsonFile`, `writeJsonFileAtomic`, `JsonFileError` (Fase 1); `DEFAULT_FORMATS`, `formatsFileSchema`, `FormatPreset` (Task 1).
- Produces:
  ```ts
  export interface CatalogState { presets: FormatPreset[]; error: string | null; path: string }
  export class FormatCatalog {
    constructor(workspaceRoot: string)
    load(): Promise<CatalogState>          // creates the file with defaults if missing; invalid file → defaults + error, file untouched
    save(presets: FormatPreset[]): Promise<CatalogState> // validates (WorkspaceError 400 on invalid), writes atomically
    resetToDefaults(): Promise<CatalogState>
  }
  export function findPreset(presets: FormatPreset[], id: string): FormatPreset | undefined
  ```

- [ ] **Step 1: Test che falliscono**

`packages/core/test/format-catalog.test.ts`:
```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { findPreset, FormatCatalog } from '../src/formats/format-catalog.ts';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ms-fmt-')); });
const file = () => join(root, '.studio', 'presets', 'formats.json');

describe('FormatCatalog', () => {
  it('creates the file with the defaults when missing', async () => {
    const s = await new FormatCatalog(root).load();
    expect(s.error).toBeNull();
    expect(s.presets).toEqual(DEFAULT_FORMATS);
    expect(JSON.parse(await readFile(file(), 'utf8')).presets).toHaveLength(DEFAULT_FORMATS.length);
  });
  it('falls back to defaults on an invalid file without rewriting it', async () => {
    await mkdir(join(root, '.studio', 'presets'), { recursive: true });
    await writeFile(file(), '{"schemaVersion":1,"presets":[]}');
    const s = await new FormatCatalog(root).load();
    expect(s.presets).toEqual(DEFAULT_FORMATS);
    expect(s.error).toContain('formats.json');
    expect(await readFile(file(), 'utf8')).toBe('{"schemaVersion":1,"presets":[]}');
  });
  it('saves a valid custom catalog and rejects an invalid one with 400', async () => {
    const c = new FormatCatalog(root);
    const custom = [{ ...DEFAULT_FORMATS[0]!, id: 'custom-1x1', name: 'Custom' }];
    expect((await c.save(custom)).presets).toEqual(custom);
    expect((await c.load()).presets).toEqual(custom);
    const err = await c.save([]).catch((e) => e);
    expect(err.status).toBe(400);
  });
  it('resets to defaults', async () => {
    const c = new FormatCatalog(root);
    await c.save([DEFAULT_FORMATS[0]!]);
    expect((await c.resetToDefaults()).presets).toEqual(DEFAULT_FORMATS);
  });
});

describe('findPreset', () => {
  it('finds by id', () => {
    expect(findPreset(DEFAULT_FORMATS, 'youtube-16x9')?.width).toBe(1920);
    expect(findPreset(DEFAULT_FORMATS, 'nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/format-catalog.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementa**

`packages/core/src/formats/format-catalog.ts`:
```ts
import { join } from 'node:path';
import { DEFAULT_FORMATS, formatsFileSchema, type FormatPreset } from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { WorkspaceError } from '../workspace-store.ts';

export interface CatalogState { presets: FormatPreset[]; error: string | null; path: string }

export const findPreset = (presets: FormatPreset[], id: string) => presets.find((p) => p.id === id);

export class FormatCatalog {
  private readonly path: string;
  constructor(workspaceRoot: string) { this.path = join(workspaceRoot, '.studio', 'presets', 'formats.json'); }

  async load(): Promise<CatalogState> {
    try {
      const file = await readJsonFile(this.path, formatsFileSchema);
      return { presets: file.presets, error: null, path: this.path };
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') return this.write(DEFAULT_FORMATS);
      if (err instanceof JsonFileError) {
        return { presets: DEFAULT_FORMATS, error: `${err.message}. Uso il catalogo predefinito.`, path: this.path };
      }
      throw err;
    }
  }

  async save(presets: FormatPreset[]): Promise<CatalogState> {
    const parsed = formatsFileSchema.safeParse({ schemaVersion: 1, presets });
    if (!parsed.success) {
      throw new WorkspaceError(400, `Catalogo formati non valido: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return this.write(parsed.data.presets);
  }

  resetToDefaults(): Promise<CatalogState> { return this.write(DEFAULT_FORMATS); }

  private async write(presets: FormatPreset[]): Promise<CatalogState> {
    await writeJsonFileAtomic(this.path, { schemaVersion: 1, presets });
    return { presets, error: null, path: this.path };
  }
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './formats/format-catalog.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core/test/format-catalog.test.ts && pnpm typecheck`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): editable format catalog stored in the workspace"
```

### Task 3: CreativeStore (file della creatività)

**Files:**
- Create: `packages/core/src/creatives/creative-store.ts`, `packages/core/test/creative-store.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `readJsonFile`, `writeJsonFileAtomic`, `JsonFileError` (Fase 1); `KeyedMutex` (Fase 1); `slugify`, `WorkspaceError` (Fase 1); schemi del Task 1.
- Produces:
  ```ts
  export const CREATIVE_SLUG_RE: RegExp; // /^[a-z0-9][a-z0-9-]{0,79}$/
  export class CreativeStore {
    constructor(projectDir: string)
    dir(slug: string): string            // throws WorkspaceError 400 on invalid slug
    workDir(slug: string): string        // <dir>/work
    outputsDir(slug: string, n: number): string // <dir>/outputs/v<n>
    create(input: { title: string; brief: Brief }, now?: Date): Promise<{ slug: string; creative: CreativeFile }> // slug = yyyy-mm-dd-<slugify(title)>, unique (-2, -3…)
    list(): Promise<CreativeListItem[]>  // updatedAt desc; broken creative.json → { ok: false }
    get(slug: string): Promise<CreativeFile>  // 404 if missing
    update(slug: string, patch: Partial<Pick<CreativeFile, 'title' | 'brief' | 'status' | 'error' | 'resumeFrom'>>): Promise<CreativeFile> // serialized per slug, bumps updatedAt, validates (400)
    readVersions(slug: string): Promise<VersionEntry[]>
    nextVersionNumber(slug: string): Promise<number>
    appendVersion(slug: string, entry: VersionEntry): Promise<void> // serialized per slug
    appendConversation(slug: string, entry: ConversationEntry): Promise<void> // one JSON line, serialized per slug
    readConversation(slug: string): Promise<ConversationEntry[]> // skips corrupt lines
    recoverInterrupted(): Promise<string[]> // every 'working' creative → 'interrupted' + system entry; returns slugs
  }
  ```

- [ ] **Step 1: Test che falliscono**

`packages/core/test/creative-store.test.ts`:
```ts
import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Brief, VersionEntry } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { CreativeStore } from '../src/creatives/creative-store.ts';

const brief: Brief = { goal: 'Lancio app', message: 'Prenota in 3 tap', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' };
const day = new Date('2026-10-07T10:00:00.000Z');
let projectDir: string;
let store: CreativeStore;
beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ms-cr è '));
  store = new CreativeStore(projectDir);
});

const version = (n: number, extra: Partial<VersionEntry> = {}): VersionEntry => ({
  n, commit: 'abc', sessionId: 's1', status: 'complete', createdAt: day.toISOString(), request: 'r',
  outputs: [{ format: 'instagram-post-1x1', file: 'instagram-post-1x1.mp4', width: 1080, height: 1080, durationSec: 15, verified: true, preview: '.previews/instagram-post-1x1.jpg' }],
  problems: [], tools: [], renderCommand: null, basedOn: null, ...extra,
});

describe('create / get / list', () => {
  it('creates the folder layout with a dated slug', async () => {
    const { slug, creative } = await store.create({ title: 'Lancio App Primavera!', brief }, day);
    expect(slug).toBe('2026-10-07-lancio-app-primavera');
    expect(creative).toMatchObject({ schemaVersion: 1, title: 'Lancio App Primavera!', status: 'draft', error: null, resumeFrom: null });
    for (const rel of ['creative.json', 'versions.json', 'conversation.jsonl', 'work']) {
      await expect(stat(join(store.dir(slug), rel))).resolves.toBeTruthy();
    }
    expect(await store.get(slug)).toEqual(creative);
  });
  it('makes slugs unique on the same day', async () => {
    const a = await store.create({ title: 'Teaser', brief }, day);
    const b = await store.create({ title: 'Teaser', brief }, day);
    expect([a.slug, b.slug]).toEqual(['2026-10-07-teaser', '2026-10-07-teaser-2']);
  });
  it('rejects an invalid brief with 400', async () => {
    const err = await store.create({ title: 'X', brief: { ...brief, formats: [] } }, day).catch((e) => e);
    expect(err.status).toBe(400);
  });
  it('lists newest first with cover and version count, and reports broken ones', async () => {
    const a = await store.create({ title: 'Prima', brief }, new Date('2026-10-01T10:00:00.000Z'));
    const b = await store.create({ title: 'Seconda', brief }, day);
    await store.appendVersion(a.slug, version(1));
    await store.update(a.slug, { status: 'ready' });
    const c = await store.create({ title: 'Rotta', brief }, day);
    await writeFile(join(store.dir(c.slug), 'creative.json'), '{');
    const items = await store.list();
    expect(items[0]).toMatchObject({ ok: true, slug: a.slug, status: 'ready', versions: 1, cover: 'outputs/v1/.previews/instagram-post-1x1.jpg' });
    expect(items.find((i) => i.slug === b.slug)).toMatchObject({ ok: true, versions: 0, cover: null });
    expect(items.find((i) => i.slug === c.slug)).toMatchObject({ ok: false });
  });
  it('404 for unknown, 400 for traversal', async () => {
    expect((await store.get('nope').catch((e) => e)).status).toBe(404);
    expect((await store.get('../x').catch((e) => e)).status).toBe(400);
  });
});

describe('update', () => {
  it('serializes concurrent updates and bumps updatedAt', async () => {
    const { slug, creative } = await store.create({ title: 'A', brief }, day);
    await Promise.all([store.update(slug, { status: 'working' }), store.update(slug, { error: 'x' })]);
    const after = await store.get(slug);
    expect(after.status).toBe('working');
    expect(after.error).toBe('x');
    expect(after.updatedAt > creative.updatedAt).toBe(true);
  });
});

describe('versions and conversation', () => {
  it('numbers versions and appends them', async () => {
    const { slug } = await store.create({ title: 'A', brief }, day);
    expect(await store.nextVersionNumber(slug)).toBe(1);
    await store.appendVersion(slug, version(1));
    expect(await store.nextVersionNumber(slug)).toBe(2);
    expect((await store.readVersions(slug)).map((v) => v.n)).toEqual([1]);
  });
  it('appends conversation lines and skips corrupt ones', async () => {
    const { slug } = await store.create({ title: 'A', brief }, day);
    await store.appendConversation(slug, { type: 'user', at: day.toISOString(), text: 'ciao', pins: [], attachments: [] });
    await appendFile(join(store.dir(slug), 'conversation.jsonl'), 'not json\n');
    await store.appendConversation(slug, { type: 'system', at: day.toISOString(), level: 'info', text: 'ok' });
    expect((await store.readConversation(slug)).map((e) => e.type)).toEqual(['user', 'system']);
  });
});

describe('recoverInterrupted', () => {
  it('marks working creatives as interrupted and logs it', async () => {
    const { slug } = await store.create({ title: 'A', brief }, day);
    await store.update(slug, { status: 'working' });
    expect(await store.recoverInterrupted()).toEqual([slug]);
    expect((await store.get(slug)).status).toBe('interrupted');
    const conv = await store.readConversation(slug);
    expect(conv.at(-1)).toMatchObject({ type: 'system', level: 'error' });
    expect(await readFile(join(store.dir(slug), 'creative.json'), 'utf8')).toContain('interrupted');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/creative-store.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementa**

`packages/core/src/creatives/creative-store.ts`:
```ts
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  creativeFileSchema, versionsFileSchema,
  type Brief, type ConversationEntry, type CreativeFile, type CreativeListItem, type VersionEntry,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { slugify, WorkspaceError } from '../workspace-store.ts';

export const CREATIVE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const issues = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  e.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');

export class CreativeStore {
  private readonly root: string;
  private readonly lock = new KeyedMutex();

  constructor(projectDir: string) { this.root = join(projectDir, 'creatives'); }

  dir(slug: string): string {
    if (!CREATIVE_SLUG_RE.test(slug)) throw new WorkspaceError(400, `Identificativo creatività non valido: ${slug}`);
    return join(this.root, slug);
  }
  workDir(slug: string) { return join(this.dir(slug), 'work'); }
  outputsDir(slug: string, n: number) { return join(this.dir(slug), 'outputs', `v${n}`); }
  private file(slug: string, name: string) { return join(this.dir(slug), name); }

  async create(input: { title: string; brief: Brief }, now = new Date()): Promise<{ slug: string; creative: CreativeFile }> {
    const at = now.toISOString();
    const parsed = creativeFileSchema.safeParse({
      schemaVersion: 1, title: input.title, brief: input.brief, status: 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null,
    });
    if (!parsed.success) throw new WorkspaceError(400, `Brief non valido: ${issues(parsed.error)}`);
    const creative = parsed.data;
    await mkdir(this.root, { recursive: true });
    const slug = await this.lock.run('create', async () => {
      const base = `${at.slice(0, 10)}-${slugify(creative.title)}`.slice(0, 70).replace(/-+$/, '');
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        try {
          await mkdir(join(this.root, candidate));
          return candidate;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
    });
    await mkdir(this.workDir(slug), { recursive: true });
    await writeFile(join(this.workDir(slug), '.gitkeep'), '');
    await writeJsonFileAtomic(this.file(slug, 'creative.json'), creative);
    await writeJsonFileAtomic(this.file(slug, 'versions.json'), { schemaVersion: 1, versions: [] });
    await writeFile(this.file(slug, 'conversation.jsonl'), '');
    return { slug, creative };
  }

  async list(): Promise<CreativeListItem[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const items: CreativeListItem[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !CREATIVE_SLUG_RE.test(e.name)) continue;
      try {
        const c = await readJsonFile(this.file(e.name, 'creative.json'), creativeFileSchema);
        const versions = await this.readVersions(e.name);
        const last = versions.at(-1);
        const first = last?.outputs[0];
        const cover = last && first ? `outputs/v${last.n}/${first.preview ?? first.file}` : null;
        items.push({ ok: true, slug: e.name, title: c.title, status: c.status, formats: c.brief.formats, versions: versions.length, updatedAt: c.updatedAt, cover });
      } catch (err) {
        if (err instanceof JsonFileError && err.reason === 'missing') continue;
        items.push({ ok: false, slug: e.name, error: (err as Error).message });
      }
    }
    const key = (i: CreativeListItem) => (i.ok ? i.updatedAt : '');
    return items.sort((a, b) => key(b).localeCompare(key(a)));
  }

  async get(slug: string): Promise<CreativeFile> {
    try {
      return await readJsonFile(this.file(slug, 'creative.json'), creativeFileSchema);
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') throw new WorkspaceError(404, `Creatività ${slug} non trovata`);
      throw err;
    }
  }

  update(slug: string, patch: Partial<Pick<CreativeFile, 'title' | 'brief' | 'status' | 'error' | 'resumeFrom'>>): Promise<CreativeFile> {
    return this.lock.run(`c:${slug}`, async () => {
      const current = await this.get(slug);
      const nowIso = new Date().toISOString();
      const updatedAt = nowIso > current.updatedAt ? nowIso : new Date(Date.parse(current.updatedAt) + 1).toISOString();
      const parsed = creativeFileSchema.safeParse({ ...current, ...patch, updatedAt });
      if (!parsed.success) throw new WorkspaceError(400, `Creatività non valida: ${issues(parsed.error)}`);
      await writeJsonFileAtomic(this.file(slug, 'creative.json'), parsed.data);
      return parsed.data;
    });
  }

  async readVersions(slug: string): Promise<VersionEntry[]> {
    try {
      return (await readJsonFile(this.file(slug, 'versions.json'), versionsFileSchema)).versions;
    } catch (err) {
      if (err instanceof JsonFileError && err.reason === 'missing') return [];
      throw err;
    }
  }

  async nextVersionNumber(slug: string): Promise<number> {
    const versions = await this.readVersions(slug);
    return (versions.at(-1)?.n ?? 0) + 1;
  }

  appendVersion(slug: string, entry: VersionEntry): Promise<void> {
    return this.lock.run(`v:${slug}`, async () => {
      const versions = await this.readVersions(slug);
      await writeJsonFileAtomic(this.file(slug, 'versions.json'), { schemaVersion: 1, versions: [...versions, entry] });
    });
  }

  appendConversation(slug: string, entry: ConversationEntry): Promise<void> {
    return this.lock.run(`l:${slug}`, () => appendFile(this.file(slug, 'conversation.jsonl'), `${JSON.stringify(entry)}\n`));
  }

  async readConversation(slug: string): Promise<ConversationEntry[]> {
    const raw = await readFile(this.file(slug, 'conversation.jsonl'), 'utf8').catch(() => '');
    const out: ConversationEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ConversationEntry;
        if (e && typeof e === 'object' && typeof e.type === 'string') out.push(e);
      } catch { /* a hand-edited or truncated line: skip it */ }
    }
    return out;
  }

  async recoverInterrupted(): Promise<string[]> {
    const recovered: string[] = [];
    for (const item of await this.list()) {
      if (!item.ok || item.status !== 'working') continue;
      await this.update(item.slug, { status: 'interrupted', error: 'Il lavoro è stato interrotto (app chiusa durante la generazione).' });
      await this.appendConversation(item.slug, {
        type: 'system', at: new Date().toISOString(), level: 'error',
        text: 'Lavoro interrotto: Motion Studio è stato chiuso durante la generazione. Invia un messaggio per riprendere.',
      });
      recovered.push(item.slug);
    }
    return recovered;
  }
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './creatives/creative-store.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core/test/creative-store.test.ts && pnpm typecheck`
Expected: 10 PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): file-based creative store with versions and conversation log"
```

---

### Task 4: MediaTools (ffprobe / ffmpeg)

**Files:**
- Create: `packages/core/src/media/media-tools.ts`, `packages/core/test/media-tools.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `CommandExec`, `execCommand` (Fase 1).
- Produces:
  ```ts
  export interface MediaInfo { width: number; height: number; durationSec: number | null }
  export interface MediaTools {
    readonly available: boolean;
    probe(file: string): Promise<MediaInfo | null>;                         // null = unreadable / not media
    poster(video: string, out: string, atSec?: number): Promise<boolean>;    // writes a JPEG frame
    frame(video: string, out: string, atSec: number): Promise<boolean>;      // same, at an exact time
  }
  export function createFfmpegTools(exec?: CommandExec): Promise<MediaTools>; // probes `ffprobe -version`; unavailable → NoMediaTools
  export const NoMediaTools: MediaTools; // available false, probe → null, poster/frame → false
  ```

- [ ] **Step 1: Test che falliscono**

`packages/core/test/media-tools.test.ts`:
```ts
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execCommand, type CommandExec } from '../src/exec.ts';
import { createFfmpegTools, NoMediaTools } from '../src/media/media-tools.ts';

const hasFfmpeg = (await execCommand('ffmpeg', ['-version'])).code === 0;

describe('createFfmpegTools', () => {
  it('returns NoMediaTools when ffprobe is missing', async () => {
    const exec: CommandExec = async () => ({ code: -1, stdout: '', stderr: '', notFound: true });
    expect(await createFfmpegTools(exec)).toBe(NoMediaTools);
  });
  it('parses ffprobe JSON', async () => {
    const exec: CommandExec = async (cmd, args) => {
      if (args.includes('-version')) return { code: 0, stdout: 'ffprobe version 8', stderr: '', notFound: false };
      return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920 }], format: { duration: '15.04' } }), stderr: '', notFound: false };
    };
    const tools = await createFfmpegTools(exec);
    expect(await tools.probe('/x.mp4')).toEqual({ width: 1080, height: 1920, durationSec: 15.04 });
  });
  it('treats still images as having no duration', async () => {
    const exec: CommandExec = async (_c, args) => args.includes('-version')
      ? { code: 0, stdout: '', stderr: '', notFound: false }
      : { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'png', width: 300, height: 250 }], format: { duration: '0.04' } }), stderr: '', notFound: false };
    expect(await (await createFfmpegTools(exec)).probe('/x.png')).toEqual({ width: 300, height: 250, durationSec: null });
  });
  it('returns null for unreadable files', async () => {
    const exec: CommandExec = async (_c, args) => args.includes('-version')
      ? { code: 0, stdout: '', stderr: '', notFound: false }
      : { code: 1, stdout: '', stderr: 'Invalid data', notFound: false };
    expect(await (await createFfmpegTools(exec)).probe('/x.mp4')).toBeNull();
  });
});

describe.skipIf(!hasFfmpeg)('with real ffmpeg', () => {
  it('probes a generated video and extracts a poster', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-media è '));
    const video = join(dir, 'clip.mp4');
    await execCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-pix_fmt', 'yuv420p', video]);
    const tools = await createFfmpegTools();
    const info = await tools.probe(video);
    expect(info).toMatchObject({ width: 320, height: 240 });
    expect(info!.durationSec).toBeGreaterThan(1.5);
    const poster = join(dir, '.previews', 'clip.jpg');
    expect(await tools.poster(video, poster)).toBe(true);
    expect((await stat(poster)).size).toBeGreaterThan(0);
  });
});

describe('NoMediaTools', () => {
  it('is inert', async () => {
    expect(NoMediaTools.available).toBe(false);
    expect(await NoMediaTools.probe('/x')).toBeNull();
    expect(await NoMediaTools.poster('/x', '/y')).toBe(false);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/media-tools.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementa**

`packages/core/src/media/media-tools.ts`:
```ts
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execCommand, type CommandExec } from '../exec.ts';

export interface MediaInfo { width: number; height: number; durationSec: number | null }
export interface MediaTools {
  readonly available: boolean;
  probe(file: string): Promise<MediaInfo | null>;
  poster(video: string, out: string, atSec?: number): Promise<boolean>;
  frame(video: string, out: string, atSec: number): Promise<boolean>;
}

export const NoMediaTools: MediaTools = {
  available: false,
  probe: async () => null,
  poster: async () => false,
  frame: async () => false,
};

const STILL_CODECS = new Set(['png', 'mjpeg', 'webp', 'bmp', 'tiff']);

export async function createFfmpegTools(exec: CommandExec = execCommand): Promise<MediaTools> {
  const check = await exec('ffprobe', ['-version'], { timeoutMs: 10_000 });
  if (check.code !== 0) return NoMediaTools;

  const grab = async (video: string, out: string, atSec: number) => {
    await mkdir(dirname(out), { recursive: true });
    const r = await exec('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(atSec), '-i', video, '-frames:v', '1', '-q:v', '3', out], { timeoutMs: 60_000 });
    if (r.code === 0) return true;
    if (atSec === 0) return false;
    // Clips shorter than atSec: fall back to the first frame.
    return (await exec('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-frames:v', '1', '-q:v', '3', out], { timeoutMs: 60_000 })).code === 0;
  };

  return {
    available: true,
    async probe(file) {
      const r = await exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeoutMs: 30_000 });
      if (r.code !== 0) return null;
      try {
        const data = JSON.parse(r.stdout) as { streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>; format?: { duration?: string } };
        const s = data.streams?.find((x) => x.codec_type === 'video' && x.width && x.height);
        if (!s?.width || !s.height) return null;
        const still = s.codec_name !== undefined && STILL_CODECS.has(s.codec_name);
        const d = Number(data.format?.duration);
        return { width: s.width, height: s.height, durationSec: !still && Number.isFinite(d) && d > 0 ? d : null };
      } catch {
        return null;
      }
    },
    poster: (video, out, atSec = 0.5) => grab(video, out, atSec),
    frame: (video, out, atSec) => grab(video, out, atSec),
  };
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './media/media-tools.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core/test/media-tools.test.ts`
Expected: tutti PASS (il blocco "with real ffmpeg" gira se ffmpeg è installato).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): ffprobe/ffmpeg media tools with graceful absence"
```

---

### Task 5: Contratto di output (`validateOutputs`)

**Files:**
- Create: `packages/core/src/creatives/output-contract.ts`, `packages/core/test/output-contract.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `manifestSchema`, `FormatPreset`, `OutputFileInfo` (Task 1); `findPreset` (Task 2); `MediaTools`, `NoMediaTools` (Task 4).
- Produces:
  ```ts
  export interface ValidationResult { outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: string | null }
  export function validateOutputs(opts: {
    dir: string;              // absolute outputs/vN folder
    requested: string[];      // preset ids from the brief
    presets: FormatPreset[];
    durationSec: number | null;
    media: MediaTools;
  }): Promise<ValidationResult>
  ```
  `outputs` lists only files that exist inside `dir`; `preview` is relative to `dir` (`.previews/<stem>.jpg`) for videos when a poster was extracted, else `null`; `verified` is true when the media tools probed the file. Problems are Italian, one per line item.

  Rules, in order, per requested format:
  1. unknown preset → `Preset sconosciuto: <id> (non è nel catalogo formati)`
  2. no manifest entry → `Manca il formato <channel> · <name> (<id>)`
  3. file missing, not a regular file (symlinks refused), or outside `dir` → `File non trovato per <id>: <file>`
  4. extension not in `preset.extensions` → `<file>: estensione .<ext> non ammessa per <id> (ammesse: …)`
  5. size over `maxFileMB` → `<file>: <size> MB, massimo <max> MB`
  6. resolution (probe, or manifest values when tools unavailable) ≠ preset → `<file>: risoluzione <w>×<h>, attesa <W>×<H>`
  7. video: no duration when probed → `<file>: non sembra un video`; over `maxDurationSec` → `<file>: durata <d>s oltre il massimo di <max>s`; brief duration set and |d − target| > max(1, 10% target) → `<file>: durata <d>s, richiesta circa <target>s`
  Manifest missing → single problem `manifest.json mancante in <dir name>`; invalid → `manifest.json non valido: <issues>`.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/output-contract.test.ts`:
```ts
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FormatPreset } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateOutputs } from '../src/creatives/output-contract.ts';
import { NoMediaTools, type MediaInfo, type MediaTools } from '../src/media/media-tools.ts';

const presets: FormatPreset[] = [
  { id: 'sq', channel: 'Instagram', name: 'Post 1:1', width: 1080, height: 1080, kind: 'video', extensions: ['mp4'], maxDurationSec: 60 },
  { id: 'banner', channel: 'Web', name: 'Banner', width: 300, height: 250, kind: 'image', extensions: ['png', 'jpg'], maxFileMB: 1 },
];
const fakeMedia = (info: Record<string, MediaInfo | null>): MediaTools => ({
  available: true,
  probe: async (f) => info[f.split('/').pop()!] ?? null,
  poster: async (_v, out) => { await mkdir(join(out, '..'), { recursive: true }); await writeFile(out, 'jpg'); return true; },
  frame: async () => true,
});

let dir: string;
beforeEach(async () => { dir = join(await mkdtemp(join(tmpdir(), 'ms-out-')), 'v1'); await mkdir(dir); });
const manifest = (files: unknown[], extra = {}) => writeFile(join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files, tools: ['remotion'], renderCommand: 'npm run render', ...extra }));
const sq = { format: 'sq', file: 'sq.mp4', width: 1080, height: 1080, durationSec: 15 };
const banner = { format: 'banner', file: 'banner.png', width: 300, height: 250 };

describe('validateOutputs', () => {
  it('accepts complete, correct outputs and extracts video posters', async () => {
    await manifest([sq, banner]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    await writeFile(join(dir, 'banner.png'), 'i');
    const r = await validateOutputs({ dir, requested: ['sq', 'banner'], presets, durationSec: 15,
      media: fakeMedia({ 'sq.mp4': { width: 1080, height: 1080, durationSec: 15.2 }, 'banner.png': { width: 300, height: 250, durationSec: null } }) });
    expect(r.problems).toEqual([]);
    expect(r.tools).toEqual(['remotion']);
    expect(r.renderCommand).toBe('npm run render');
    expect(r.outputs).toEqual([
      { format: 'sq', file: 'sq.mp4', width: 1080, height: 1080, durationSec: 15.2, verified: true, preview: '.previews/sq.jpg' },
      { format: 'banner', file: 'banner.png', width: 300, height: 250, durationSec: null, verified: true, preview: null },
    ]);
  });
  it('reports a missing manifest', async () => {
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['manifest.json mancante in v1']);
  });
  it('reports an invalid manifest', async () => {
    await writeFile(join(dir, 'manifest.json'), '{"schemaVersion":1,"files":[{"format":"sq","file":"../x"}]}');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems[0]).toMatch(/^manifest.json non valido: /);
  });
  it('lists every kind of problem', async () => {
    await manifest([{ ...sq, file: 'sq.mov' }, { ...banner, file: 'banner.gif' }, { format: 'ghost', file: 'g.png', width: 1, height: 1 }]);
    await writeFile(join(dir, 'banner.gif'), 'x'.repeat(2 * 1024 * 1024));
    const r = await validateOutputs({ dir, requested: ['sq', 'banner', 'ghost', 'missing'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual([
      'File non trovato per sq: sq.mov',
      'banner.gif: estensione .gif non ammessa per banner (ammesse: png, jpg)',
      'banner.gif: 2.0 MB, massimo 1 MB',
      'Preset sconosciuto: ghost (non è nel catalogo formati)',
      'Preset sconosciuto: missing (non è nel catalogo formati)',
    ]);
  });
  it('checks resolution and duration from the probe', async () => {
    await manifest([sq]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: 15,
      media: fakeMedia({ 'sq.mp4': { width: 1080, height: 1350, durationSec: 70 } }) });
    expect(r.problems).toEqual([
      'sq.mp4: risoluzione 1080×1350, attesa 1080×1080',
      'sq.mp4: durata 70.0s oltre il massimo di 60s',
      'sq.mp4: durata 70.0s, richiesta circa 15s',
    ]);
  });
  it('flags a "video" that has no duration', async () => {
    await manifest([sq]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: fakeMedia({ 'sq.mp4': { width: 1080, height: 1080, durationSec: null } }) });
    expect(r.problems).toEqual(['sq.mp4: non sembra un video']);
  });
  it('falls back to manifest values without media tools and marks outputs unverified', async () => {
    await manifest([{ ...sq, width: 1000 }]);
    await writeFile(join(dir, 'sq.mp4'), 'v');
    const r = await validateOutputs({ dir, requested: ['sq'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['sq.mp4: risoluzione 1000×1080, attesa 1080×1080']);
    expect(r.outputs[0]).toMatchObject({ verified: false, preview: null });
  });
  it.skipIf(process.platform === 'win32')('refuses symlinks', async () => {
    await manifest([banner]);
    await symlink('/etc/hosts', join(dir, 'banner.png'));
    const r = await validateOutputs({ dir, requested: ['banner'], presets, durationSec: null, media: NoMediaTools });
    expect(r.problems).toEqual(['File non trovato per banner: banner.png']);
    expect(r.outputs).toEqual([]);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/output-contract.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Implementa**

`packages/core/src/creatives/output-contract.ts`:
```ts
import { lstat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { manifestSchema, type FormatPreset, type OutputFileInfo } from '@motion-studio/shared';
import { findPreset } from '../formats/format-catalog.ts';
import { JsonFileError, readJsonFile } from '../json-file.ts';
import type { MediaTools } from '../media/media-tools.ts';

export interface ValidationResult { outputs: OutputFileInfo[]; problems: string[]; tools: string[]; renderCommand: string | null }

export async function validateOutputs(opts: {
  dir: string; requested: string[]; presets: FormatPreset[]; durationSec: number | null; media: MediaTools;
}): Promise<ValidationResult> {
  const { dir, media } = opts;
  let manifest;
  try {
    manifest = await readJsonFile(join(dir, 'manifest.json'), manifestSchema);
  } catch (err) {
    if (err instanceof JsonFileError && err.reason === 'missing') return empty([`manifest.json mancante in ${basename(dir)}`]);
    if (err instanceof JsonFileError) return empty([`manifest.json non valido: ${err.message.replace(/^.*?: /, '')}`]);
    throw err;
  }

  const problems: string[] = [];
  const outputs: OutputFileInfo[] = [];
  for (const id of opts.requested) {
    const preset = findPreset(opts.presets, id);
    if (!preset) { problems.push(`Preset sconosciuto: ${id} (non è nel catalogo formati)`); continue; }
    const entry = manifest.files.find((f) => f.format === id);
    if (!entry) { problems.push(`Manca il formato ${preset.channel} · ${preset.name} (${id})`); continue; }
    const path = join(dir, entry.file);
    const info = await lstat(path).catch(() => null);
    if (!info || !info.isFile()) { problems.push(`File non trovato per ${id}: ${entry.file}`); continue; }

    const ext = extname(entry.file).slice(1).toLowerCase();
    if (!preset.extensions.includes(ext)) {
      problems.push(`${entry.file}: estensione .${ext} non ammessa per ${id} (ammesse: ${preset.extensions.join(', ')})`);
    }
    const sizeMB = info.size / (1024 * 1024);
    if (preset.maxFileMB !== undefined && sizeMB > preset.maxFileMB) {
      problems.push(`${entry.file}: ${sizeMB.toFixed(1)} MB, massimo ${preset.maxFileMB} MB`);
    }

    const probed = media.available ? await media.probe(path) : null;
    const width = probed?.width ?? entry.width;
    const height = probed?.height ?? entry.height;
    const durationSec = probed ? probed.durationSec : entry.durationSec ?? null;
    if (width !== preset.width || height !== preset.height) {
      problems.push(`${entry.file}: risoluzione ${width}×${height}, attesa ${preset.width}×${preset.height}`);
    }
    if (preset.kind === 'video') {
      if (probed && durationSec === null) problems.push(`${entry.file}: non sembra un video`);
      if (durationSec !== null) {
        if (preset.maxDurationSec !== undefined && durationSec > preset.maxDurationSec) {
          problems.push(`${entry.file}: durata ${durationSec.toFixed(1)}s oltre il massimo di ${preset.maxDurationSec}s`);
        }
        const target = opts.durationSec;
        if (target !== null && Math.abs(durationSec - target) > Math.max(1, target * 0.1)) {
          problems.push(`${entry.file}: durata ${durationSec.toFixed(1)}s, richiesta circa ${target}s`);
        }
      }
    }

    let preview: string | null = null;
    if (preset.kind === 'video' && media.available) {
      const rel = `.previews/${basename(entry.file, extname(entry.file))}.jpg`;
      if (await media.poster(path, join(dir, rel))) preview = rel;
    }
    outputs.push({ format: id, file: entry.file, width, height, durationSec, verified: probed !== null, preview });
  }
  return { outputs, problems, tools: manifest.tools, renderCommand: manifest.renderCommand ?? null };
}

const empty = (problems: string[]): ValidationResult => ({ outputs: [], problems, tools: [], renderCommand: null });
```

Note: `entry.file` can't contain separators (schema), so `join(dir, entry.file)` stays inside `dir`; `lstat` + `isFile()` refuses symlinks.

Append to `packages/core/src/index.ts`:
```ts
export * from './creatives/output-contract.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core/test/output-contract.test.ts && pnpm typecheck`
Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): output contract validation with Italian problem reports"
```

---

### Task 6: Prompt della creatività e contesto con il contratto

**Files:**
- Create: `packages/core/src/creatives/prompt.ts`, `packages/core/test/prompt.test.ts`
- Modify: `packages/core/src/project-template.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `CreativeFile`, `Pin`, `FormatPreset` (Task 1); `findPreset` (Task 2).
- Produces:
  ```ts
  export type PromptKind = 'first' | 'iteration' | 'fix';
  export interface PromptInput {
    slug: string; creative: CreativeFile; presets: FormatPreset[]; version: number; kind: PromptKind;
    userText?: string; pins?: Pin[]; attachments?: string[]; // attachments: paths relative to the project root
    problems?: string[];                                     // for 'fix'
  }
  export function buildCreativePrompt(i: PromptInput): string
  export function parseStudioBlock(prompt: string): StudioBlock | null // used by tests and the fake agent
  export interface StudioBlock { outputDir: string; workDir: string; durationSec: number | null;
    formats: Array<{ id: string; width: number; height: number; kind: 'video' | 'image'; extensions: string[] }> }
  ```
  Every prompt ends with a fenced block ` ```motion-studio ` containing `StudioBlock` as JSON (paths relative to the project root, which is the agent cwd).
- Modifies: `CONTEXT_MD` gains a `## Contratto di output` section (text below).

- [ ] **Step 1: Test che falliscono**

`packages/core/test/prompt.test.ts`:
```ts
import { DEFAULT_FORMATS, type CreativeFile } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { buildCreativePrompt, parseStudioBlock } from '../src/creatives/prompt.ts';
import { CONTEXT_MD } from '../src/project-template.ts';

const creative: CreativeFile = {
  schemaVersion: 1, title: 'Lancio app', status: 'draft', error: null, resumeFrom: null,
  createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T10:00:00.000Z',
  brief: { goal: 'Far capire che prenotare è immediato', message: 'Prenota in 3 tap', formats: ['instagram-post-1x1', 'web-banner-300x250', 'ghost'],
    durationSec: 15, assets: ['assets/logo.svg'], notes: 'Chiudi sempre con il logo' },
};
const base = { slug: '2026-10-07-lancio-app', creative, presets: DEFAULT_FORMATS, version: 2 };

describe('buildCreativePrompt', () => {
  it('first turn: brief, formats, paths and the machine block', () => {
    const p = buildCreativePrompt({ ...base, kind: 'first' });
    expect(p).toContain('Far capire che prenotare è immediato');
    expect(p).toContain('Prenota in 3 tap');
    expect(p).toContain('Chiudi sempre con il logo');
    expect(p).toContain('assets/logo.svg');
    expect(p).toContain('Instagram · Post 1:1 — 1080×1080, video');
    expect(p).toContain('creatives/2026-10-07-lancio-app/outputs/v2/');
    expect(p).toContain('ricomposizione');
    expect(p).toContain('ghost: preset sconosciuto');
    expect(parseStudioBlock(p)).toEqual({
      outputDir: 'creatives/2026-10-07-lancio-app/outputs/v2',
      workDir: 'creatives/2026-10-07-lancio-app/work',
      durationSec: 15,
      formats: [
        { id: 'instagram-post-1x1', width: 1080, height: 1080, kind: 'video', extensions: ['mp4', 'webm', 'mov', 'gif'] },
        { id: 'web-banner-300x250', width: 300, height: 250, kind: 'image', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
    });
  });
  it('iteration: user text and pins with time and position', () => {
    const p = buildCreativePrompt({ ...base, kind: 'iteration', userText: 'Logo più grande',
      pins: [{ format: 'instagram-post-1x1', x: 0.25, y: 0.5, timeSec: 4.2, note: 'qui' }], attachments: ['creatives/2026-10-07-lancio-app/work/.feedback/p1.jpg'] });
    expect(p).toContain('Logo più grande');
    expect(p).toContain('instagram-post-1x1 @ 4.2s, punto (25%, 50%): qui');
    expect(p).toContain('work/.feedback/p1.jpg');
    expect(p).toContain('outputs/v2/');
  });
  it('fix: lists the problems', () => {
    const p = buildCreativePrompt({ ...base, kind: 'fix', problems: ['Manca il formato Web · Banner 300×250 (web-banner-300x250)'] });
    expect(p).toContain('- Manca il formato Web · Banner 300×250 (web-banner-300x250)');
    expect(p).toContain('stessa cartella');
  });
});

describe('parseStudioBlock', () => {
  it('returns null without a block', () => { expect(parseStudioBlock('ciao')).toBeNull(); });
});

describe('CONTEXT_MD', () => {
  it('documents the output contract', () => {
    expect(CONTEXT_MD).toContain('## Contratto di output');
    expect(CONTEXT_MD).toContain('manifest.json');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/prompt.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 3: Aggiorna `CONTEXT_MD`**

In `packages/core/src/project-template.ts` append to the `CONTEXT_MD` template literal (before the closing backtick), keeping the existing sections:
```md

## Contratto di output
Sei libero di scegliere strumenti e tecniche (Remotion, Motion Canvas, HTML + Playwright, ffmpeg, Python…). Al termine di ogni turno consegna in \`creatives/<slug>/outputs/vN/\` (la cartella esatta è indicata nella richiesta):
1. un file per ogni formato richiesto, chiamato \`<id-preset>.<estensione>\` (es. \`instagram-reel-9x16.mp4\`), con la risoluzione esatta del preset;
2. \`manifest.json\`:
   \`\`\`json
   { "schemaVersion": 1,
     "files": [{ "format": "<id-preset>", "file": "<nome file>", "width": 1080, "height": 1920, "durationSec": 15 }],
     "tools": ["remotion"],
     "renderCommand": "comando da eseguire in work/ per rigenerare gli output" }
   \`\`\`
Ogni formato è una **ricomposizione** dedicata (layout adattato, testi ridimensionati, safe zone rispettate), mai un ritaglio di un master.
Motion Studio controlla gli output dopo il turno: se mancano formati o le risoluzioni non tornano, riceverai l'elenco dei problemi da correggere.
Suggerimenti (non vincoli): per video brevi Remotion funziona bene; per immagini statiche HTML/CSS renderizzato con Playwright.
```

- [ ] **Step 4: Implementa `prompt.ts`**

`packages/core/src/creatives/prompt.ts`:
```ts
import type { CreativeFile, FormatPreset, Pin } from '@motion-studio/shared';
import { findPreset } from '../formats/format-catalog.ts';

export type PromptKind = 'first' | 'iteration' | 'fix';
export interface PromptInput {
  slug: string; creative: CreativeFile; presets: FormatPreset[]; version: number; kind: PromptKind;
  userText?: string; pins?: Pin[]; attachments?: string[]; problems?: string[];
}
export interface StudioBlock {
  outputDir: string; workDir: string; durationSec: number | null;
  formats: Array<{ id: string; width: number; height: number; kind: 'video' | 'image'; extensions: string[] }>;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function buildCreativePrompt(i: PromptInput): string {
  const { brief } = i.creative;
  const base = `creatives/${i.slug}`;
  const outputDir = `${base}/outputs/v${i.version}`;
  const known = brief.formats.map((id) => [id, findPreset(i.presets, id)] as const);
  const block: StudioBlock = {
    outputDir, workDir: `${base}/work`, durationSec: brief.durationSec,
    formats: known.flatMap(([, p]) => (p ? [{ id: p.id, width: p.width, height: p.height, kind: p.kind, extensions: p.extensions }] : [])),
  };
  const formatLines = known.map(([id, p]) => p
    ? `- ${p.id}: ${p.channel} · ${p.name} — ${p.width}×${p.height}, ${p.kind}${p.maxDurationSec ? `, max ${p.maxDurationSec}s` : ''}${p.safeZone ? `, safe zone px (alto ${p.safeZone.top}, basso ${p.safeZone.bottom}, sx ${p.safeZone.left}, dx ${p.safeZone.right})` : ''} — estensioni: ${p.extensions.join(', ')}`
    : `- ${id}: preset sconosciuto, ignoralo e segnalalo nella risposta`);

  const parts: string[] = [];
  if (i.kind === 'first') {
    const briefLines = [
      `- Obiettivo: ${brief.goal}`,
      brief.message && `- Messaggio chiave: ${brief.message}`,
      brief.durationSec && `- Durata dei video: circa ${brief.durationSec} secondi`,
      brief.assets.length > 0 && `- Asset da usare (percorsi nel progetto): ${brief.assets.join(', ')}`,
      brief.notes && `- Note: ${brief.notes}`,
    ].filter((l): l is string => typeof l === 'string' && l !== '');
    parts.push(`Realizza la creatività "${i.creative.title}" (versione ${i.version}).`, '', '## Brief', ...briefLines);
    if (i.userText) parts.push('', '## Indicazioni aggiuntive', i.userText);
  } else if (i.kind === 'iteration') {
    parts.push(`Nuova richiesta sulla creatività "${i.creative.title}": produci la versione ${i.version}.`, '', '## Richiesta', i.userText ?? '');
    if (i.pins?.length) {
      parts.push('', '## Commenti puntuali');
      for (const p of i.pins) parts.push(`- ${p.format}${p.timeSec !== null ? ` @ ${p.timeSec.toFixed(1)}s` : ''}, punto (${pct(p.x)}, ${pct(p.y)})${p.note ? `: ${p.note}` : ''}`);
    }
    if (i.attachments?.length) parts.push('', '## Fotogrammi allegati (leggili)', ...i.attachments.map((a) => `- ${a}`));
  } else {
    parts.push(
      `Gli output della versione ${i.version} non rispettano il contratto. Correggi questi problemi e riconsegna nella stessa cartella (${outputDir}/), aggiornando manifest.json:`,
      ...(i.problems ?? []).map((p) => `- ${p}`),
    );
  }
  parts.push(
    '', '## Formati richiesti', ...formatLines,
    '', '## Dove lavorare',
    `- Spazio di lavoro: ${base}/work/ (sorgenti, script, dipendenze locali)`,
    `- Consegna: ${outputDir}/ con un file per formato (\`<id>.<estensione>\`) e manifest.json, come da contratto in .studio/context.md`,
    '- Ogni formato è una ricomposizione dedicata, non un ritaglio.',
    '', '```motion-studio', JSON.stringify(block), '```',
  );
  return parts.filter((l, idx, arr) => !(l === '' && arr[idx - 1] === '')).join('\n');
}

export function parseStudioBlock(prompt: string): StudioBlock | null {
  const m = prompt.match(/```motion-studio\n([\s\S]*?)\n```/);
  if (!m?.[1]) return null;
  try { return JSON.parse(m[1]) as StudioBlock; } catch { return null; }
}
```

Note: the final `filter` only collapses consecutive blank lines; `userText` on a `first` prompt (e.g. "Rigenera" before any version exists) becomes "Indicazioni aggiuntive".

Append to `packages/core/src/index.ts`:
```ts
export * from './creatives/prompt.ts';
```

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS (anche i test esistenti di workspace-store, che controllano solo l'esistenza di context.md).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): creative prompts with machine-readable block and output contract context"
```

---

### Task 7: `--fork-session` e ripristino di `work/` da un commit

**Files:**
- Modify: `packages/core/src/agent/runner.ts`, `packages/core/src/agent/claude-code-runner.ts`, `packages/core/src/git.ts`, `packages/core/test/claude-code-runner.test.ts`, `packages/core/test/git.test.ts`

**Interfaces:**
- Produces:
  - `AgentTurnRequest.forkSession?: boolean` — with `resumeSessionId`, the runner starts a new session branched from it (`--fork-session` right after `--resume <id>`); ignored without `resumeSessionId`.
  - `Git.restorePath(dir: string, commit: string, relPath: string): Promise<void>` — serialized with `commitAll` (same lock); runs `git restore --source=<commit> --staged --worktree -- <relPath>`; throws `Error('Versione non trovata nel repository: <commit>')` when the commit does not exist (check with `git cat-file -e <commit>^{commit}`). `commit` must match `/^[0-9a-f]{7,40}$/` (else throws the same error).

- [ ] **Step 1: Test che falliscono**

Append to `packages/core/test/claude-code-runner.test.ts` inside `describe('buildClaudeArgs', …)`:
```ts
  it('adds --fork-session right after --resume, only when resuming', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p', resumeSessionId: 's1', forkSession: true });
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 3)).toEqual(['--resume', 's1', '--fork-session']);
    expect(buildClaudeArgs({ cwd: '/x', prompt: 'p', forkSession: true })).not.toContain('--fork-session');
  });
```

Append to `packages/core/test/git.test.ts`:
```ts
import { mkdir, readFile, readdir } from 'node:fs/promises';

describe('Git.restorePath', () => {
  it('restores a folder to a past commit, removing files added later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-restore-'));
    const git = new Git();
    await git.init(dir);
    await mkdir(join(dir, 'work'));
    await writeFile(join(dir, 'work', 'a.txt'), 'v1');
    const v1 = (await git.commitAll(dir, 'v1'))!;
    await writeFile(join(dir, 'work', 'a.txt'), 'v2');
    await writeFile(join(dir, 'work', 'b.txt'), 'new');
    await git.commitAll(dir, 'v2');
    await git.restorePath(dir, v1, 'work');
    expect(await readFile(join(dir, 'work', 'a.txt'), 'utf8')).toBe('v1');
    expect(await readdir(join(dir, 'work'))).toEqual(['a.txt']);
  });
  it('rejects unknown or malformed commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-restore-'));
    const git = new Git();
    await git.init(dir);
    await writeFile(join(dir, 'x'), '1');
    await git.commitAll(dir, 'c');
    await expect(git.restorePath(dir, 'deadbeef', 'x')).rejects.toThrow('Versione non trovata');
    await expect(git.restorePath(dir, '--help', 'x')).rejects.toThrow('Versione non trovata');
  });
});
```
(merge the new `node:fs/promises` names into the file's existing import instead of a second import line.)

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/claude-code-runner.test.ts packages/core/test/git.test.ts`
Expected: FAIL (`forkSession` ignorato, `restorePath` inesistente).

- [ ] **Step 3: Implementa**

`packages/core/src/agent/runner.ts` — add to `AgentTurnRequest`:
```ts
  /** With resumeSessionId: continue in a new session branched from it (used to restart from a past version). */
  forkSession?: boolean;
```

`packages/core/src/agent/claude-code-runner.ts` — in `buildClaudeArgs` replace the resume line with:
```ts
  if (req.resumeSessionId) {
    args.push('--resume', req.resumeSessionId);
    if (req.forkSession) args.push('--fork-session');
  }
```

`packages/core/src/git.ts` — add to class `Git`:
```ts
  restorePath(dir: string, commit: string, relPath: string): Promise<void> {
    return this.lock.run(resolve(dir), async () => {
      const exists = /^[0-9a-f]{7,40}$/.test(commit)
        && (await this.exec('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: dir })).code === 0;
      if (!exists) throw new Error(`Versione non trovata nel repository: ${commit}`);
      await this.must(dir, ['restore', `--source=${commit}`, '--staged', '--worktree', '--', relPath]);
    });
  }
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): fork agent sessions and restore a folder from a past commit"
```

---

### Task 8: CreativeTurnService (turno → validazione → versione)

**Files:**
- Create: `packages/core/src/creatives/creative-turns.ts`, `packages/core/test/creative-turns.test.ts`
- Modify: `packages/core/test/fixtures/fake-claude.mjs`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `JobQueue`, `JobConflictError` (Fase 1); `AgentRunner` (+`forkSession`, Task 7); `Git` (+`restorePath`, Task 7); `CreativeStore` (Task 3); `MediaTools` (Task 4); `validateOutputs` (Task 5); `buildCreativePrompt` (Task 6); `CONTEXT_MD` (Task 6); `ServerMessage`, `Pin`, `FormatPreset`, `CreativeFile` (Task 1).
- Produces:
  ```ts
  export interface CreativeTurnDeps {
    queue: JobQueue; runner: AgentRunner; git: Git; media: MediaTools;
    presets: () => Promise<FormatPreset[]>;
    model: () => Promise<string | null>;
    broadcast: (msg: ServerMessage) => void;
    maxAttempts?: number; // default 3 (agent turns per version, including the first)
  }
  export interface CreativeRef { root: string; projectSlug: string; projectDir: string; creativeSlug: string }
  export const creativeJobKey: (root: string, projectSlug: string, creativeSlug: string) => string; // `creative:${root}:${p}:${c}`
  export class CreativeTurnService {
    constructor(deps: CreativeTurnDeps)
    /** Without message: generate from the brief (first version, or "Rigenera" after a brief edit). */
    start(ref: CreativeRef, message?: { text: string; pins: Pin[] }): Promise<JobSummary>; // JobConflictError if a job is active for this creative
    /** Restore work/ to version n and make the next turn fork that version's agent session. 409 while a job is active. */
    restore(ref: CreativeRef, n: number): Promise<CreativeFile>;
  }
  ```
- Behaviour of a job (all steps write to the creative's files; every change ends with `broadcast({ type: 'creative', project, creative })`):
  1. On `start`: append `user` entry (when a message is given), set status `working`, `error: null`, then enqueue (label `Creatività · <title>`).
  2. In the job: rewrite `<projectDir>/.studio/context.md` with `CONTEXT_MD`; `n = nextVersionNumber`; for pins with `timeSec` on a format that has an output in the latest version and `media.available`, extract a frame to `work/.feedback/<n>-<i>.jpg` (attachments are project-relative paths).
  3. Session: `resumeFrom` → resume its sessionId with `forkSession: true`; else resume the latest version's `sessionId`; else a new session.
  4. Prompt kind: `first` when there are no versions yet (message text becomes "Indicazioni aggiuntive"), else `iteration` (no message → text `Rigenera tutti i formati partendo dal brief aggiornato.`).
  5. Each agent event: broadcast `{type:'agent'}`, append an `agent` conversation entry, `queue.patch(jobId, { sessionId })` on session/result events.
  6. After a successful turn: `validateOutputs` on `outputs/v<n>`. Problems and attempts left → append `system` info `Controllo output: <k> problemi. Chiedo una correzione (tentativo <a+1> di <max>).`, run a `fix` turn resuming the session just used (no fork). No problems, or attempts exhausted → version.
  7. Version: `commit = git.commitAll(projectDir, '<title>: v<n>')`; append `VersionEntry` (`status` complete/incomplete, `request` = message text or `Generazione dal brief`, `basedOn` = `resumeFrom.version` or previous version n or null); append `version` entry; status `ready`/`incomplete`, `resumeFrom: null`.
  8. Agent failed → status `error` with the error text, `system` error entry, job fails. Cancelled → status back to the one before `start` (`interrupted`/`error` become `ready` when versions exist, else `draft`), `system` info `Generazione annullata.`, job `cancelled`. Any thrown error inside the job (e.g. git) is handled like a failure.

- [ ] **Step 1: Estendi il finto `claude`**

In `packages/core/test/fixtures/fake-claude.mjs`:

1. Replace the `sessionId` line with:
```js
const resumeAt = args.indexOf('--resume');
const resumed = resumeAt >= 0 ? args[resumeAt + 1] : null;
const sessionId = resumed ? (args.includes('--fork-session') ? `${resumed}-fork` : resumed) : 'fake-session-1';
```
2. Add imports `mkdirSync`, `appendFileSync` to the `node:fs` import and `dirname, join` from `node:path`.
3. Right after `const prompt = …` add:
```js
  if (process.env.FAKE_CLAUDE_PROMPT_FILE) appendFileSync(process.env.FAKE_CLAUDE_PROMPT_FILE, `${JSON.stringify({ prompt, args })}\n`);
  const block = (() => { const m = prompt.match(/```motion-studio\n([\s\S]*?)\n```/); return m ? JSON.parse(m[1]) : null; })();
  const isFix = prompt.includes('non rispettano il contratto');
  const render = (skipLast) => {
    mkdirSync(block.outputDir, { recursive: true });
    mkdirSync(block.workDir, { recursive: true });
    writeFileSync(join(block.workDir, 'scene.txt'), `${prompt.length}:${Date.now()}`);
    const formats = skipLast ? block.formats.slice(0, -1) : block.formats;
    const files = formats.map((f) => {
      const file = `${f.id}.${f.extensions[0]}`;
      writeFileSync(join(block.outputDir, file), 'fake-media');
      return { format: f.id, file, width: f.width, height: f.height, ...(f.kind === 'video' ? { durationSec: block.durationSec ?? 10 } : {}) };
    });
    writeFileSync(join(block.outputDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files, tools: ['fake'], renderCommand: 'node render.js' }));
  };
  if (block && scenario === 'render') render(false);
  if (block && scenario === 'render_missing_once') render(!isFix);
  if (block && scenario === 'render_never') render(true);
```
(`dirname` is only needed if you prefer `mkdirSync(dirname(...))`; omit it if unused.)

- [ ] **Step 2: Test che falliscono**

`packages/core/test/creative-turns.test.ts`:
```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMATS, type Brief, type ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { CreativeStore } from '../src/creatives/creative-store.ts';
import { CreativeTurnService, type CreativeRef } from '../src/creatives/creative-turns.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { JobConflictError, JobQueue } from '../src/jobs/job-queue.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { CONTEXT_MD } from '../src/project-template.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief: Brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };

let ref: CreativeRef;
let store: CreativeStore;
let queue: JobQueue;
let service: CreativeTurnService;
let messages: ServerMessage[];
let promptFile: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ms-turn è '));
  const git = new Git();
  const ws = await WorkspaceStore.open(join(base, 'ws'), git);
  const { slug } = await ws.createProject({ name: 'Acme' });
  const projectDir = ws.projectDir(slug);
  store = new CreativeStore(projectDir);
  const created = await store.create({ title: 'Lancio', brief });
  ref = { root: ws.root, projectSlug: slug, projectDir, creativeSlug: created.slug };
  messages = [];
  queue = new JobQueue({ concurrency: 2 });
  service = new CreativeTurnService({
    queue, git, media: NoMediaTools,
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
    presets: async () => DEFAULT_FORMATS, model: async () => null,
    broadcast: (m) => messages.push(m),
  });
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
});
afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_PROMPT_FILE; });

const prompts = async () => (await readFile(promptFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { prompt: string; args: string[] });
const finalState = async (jobId: string) => { await queue.whenIdle(); return queue.list().find((j) => j.id === jobId)!.state; };

describe('CreativeTurnService', () => {
  it('generates v1 from the brief: outputs, version, commit, conversation, status', async () => {
    const job = await service.start(ref);
    expect(job.key).toBe(`creative:${ref.root}:${ref.projectSlug}:${ref.creativeSlug}`);
    expect(await finalState(job.id)).toBe('succeeded');
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1).toMatchObject({ n: 1, status: 'complete', problems: [], sessionId: 'fake-session-1', request: 'Generazione dal brief', basedOn: null, tools: ['fake'] });
    expect(v1!.outputs.map((o) => o.file)).toEqual(['instagram-post-1x1.mp4', 'web-banner-300x250.png']);
    expect(v1!.commit).toMatch(/^[0-9a-f]{40}$/);
    const log = await execCommand('git', ['log', '-1', '--format=%s'], { cwd: ref.projectDir });
    expect(log.stdout.trim()).toBe('Lancio: v1');
    expect((await store.get(ref.creativeSlug)).status).toBe('ready');
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'agent')).toBe(true);
    expect(conv.at(-1)).toMatchObject({ type: 'version', n: 1, status: 'complete' });
    expect(messages.some((m) => m.type === 'creative')).toBe(true);
    expect((await prompts())[0]!.prompt).toContain('Realizza la creatività "Lancio" (versione 1)');
  });

  it('rewrites .studio/context.md before each turn', async () => {
    await writeFile(join(ref.projectDir, '.studio', 'context.md'), 'manomesso');
    await finalState((await service.start(ref)).id);
    expect(await readFile(join(ref.projectDir, '.studio', 'context.md'), 'utf8')).toBe(CONTEXT_MD);
  });

  it('asks the agent to fix missing outputs and then succeeds', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'render_missing_once';
    await finalState((await service.start(ref)).id);
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1!.status).toBe('complete');
    const all = await prompts();
    expect(all).toHaveLength(2);
    expect(all[1]!.prompt).toContain('Manca il formato Web · Banner 300×250 (web-banner-300x250)');
    expect(all[1]!.args).toContain('--resume');
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.text.includes('tentativo 2 di 3'))).toBe(true);
  });

  it('saves an incomplete version after 3 attempts', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'render_never';
    await finalState((await service.start(ref)).id);
    const [v1] = await store.readVersions(ref.creativeSlug);
    expect(v1).toMatchObject({ status: 'incomplete', problems: ['Manca il formato Web · Banner 300×250 (web-banner-300x250)'] });
    expect(await prompts()).toHaveLength(3);
    expect((await store.get(ref.creativeSlug)).status).toBe('incomplete');
  });

  it('marks the creative as error when the agent crashes, without a version', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'crash';
    const job = await service.start(ref);
    expect(await finalState(job.id)).toBe('failed');
    const c = await store.get(ref.creativeSlug);
    expect(c.status).toBe('error');
    expect(c.error).toContain('boom');
    expect(await store.readVersions(ref.creativeSlug)).toEqual([]);
    expect((await store.readConversation(ref.creativeSlug)).at(-1)).toMatchObject({ type: 'system', level: 'error' });
  });

  it('restores the previous status when cancelled', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = await service.start(ref);
    await new Promise((r) => setTimeout(r, 400));
    queue.cancel(job.id);
    expect(await finalState(job.id)).toBe('cancelled');
    expect((await store.get(ref.creativeSlug)).status).toBe('draft');
    expect((await store.readConversation(ref.creativeSlug)).at(-1)).toMatchObject({ type: 'system', text: 'Generazione annullata.' });
  });

  it('iterates with a message and pins on the same session', async () => {
    await finalState((await service.start(ref)).id);
    await finalState((await service.start(ref, { text: 'Logo più grande', pins: [{ format: 'instagram-post-1x1', x: 0.5, y: 0.25, timeSec: 2, note: 'qui' }] })).id);
    const versions = await store.readVersions(ref.creativeSlug);
    expect(versions.map((v) => [v.n, v.request, v.basedOn])).toEqual([[1, 'Generazione dal brief', null], [2, 'Logo più grande', 1]]);
    const last = (await prompts()).at(-1)!;
    expect(last.prompt).toContain('instagram-post-1x1 @ 2.0s, punto (50%, 25%): qui');
    expect(last.args.slice(last.args.indexOf('--resume'), last.args.indexOf('--resume') + 2)).toEqual(['--resume', 'fake-session-1']);
    expect((await store.readConversation(ref.creativeSlug)).find((e) => e.type === 'user')).toMatchObject({ text: 'Logo più grande' });
  });

  it('rejects a second job on the same creative', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = await service.start(ref);
    await expect(service.start(ref)).rejects.toBeInstanceOf(JobConflictError);
    queue.cancel(job.id);
    await queue.whenIdle();
  });

  it('restores work/ to a past version and forks its session for the next turn', async () => {
    await finalState((await service.start(ref)).id);
    const v1Scene = await readFile(join(store.workDir(ref.creativeSlug), 'scene.txt'), 'utf8');
    await finalState((await service.start(ref, { text: 'cambia', pins: [] })).id);
    const restored = await service.restore(ref, 1);
    expect(restored.resumeFrom).toEqual({ version: 1, sessionId: 'fake-session-1' });
    expect(await readFile(join(store.workDir(ref.creativeSlug), 'scene.txt'), 'utf8')).toBe(v1Scene);
    await finalState((await service.start(ref, { text: 'da v1', pins: [] })).id);
    const last = (await prompts()).at(-1)!;
    expect(last.args).toContain('--fork-session');
    const v3 = (await store.readVersions(ref.creativeSlug)).at(-1)!;
    expect(v3).toMatchObject({ n: 3, basedOn: 1, sessionId: 'fake-session-1-fork' });
    expect((await store.get(ref.creativeSlug)).resumeFrom).toBeNull();
  });

  it('refuses to restore an unknown version with 404', async () => {
    const err = await service.restore(ref, 7).catch((e) => e);
    expect(err.status).toBe(404);
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/creative-turns.test.ts`
Expected: FAIL (modulo inesistente).

- [ ] **Step 4: Implementa**

`packages/core/src/creatives/creative-turns.ts`:
```ts
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { CreativeFile, CreativeStatus, FormatPreset, JobSummary, Pin, ServerMessage } from '@motion-studio/shared';
import type { AgentRunner } from '../agent/runner.ts';
import type { Git } from '../git.ts';
import { JobConflictError, type JobQueue } from '../jobs/job-queue.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { CONTEXT_MD } from '../project-template.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { CreativeStore } from './creative-store.ts';
import { validateOutputs } from './output-contract.ts';
import { buildCreativePrompt, type PromptKind } from './prompt.ts';

export interface CreativeTurnDeps {
  queue: JobQueue; runner: AgentRunner; git: Git; media: MediaTools;
  presets: () => Promise<FormatPreset[]>;
  model: () => Promise<string | null>;
  broadcast: (msg: ServerMessage) => void;
  maxAttempts?: number;
}
export interface CreativeRef { root: string; projectSlug: string; projectDir: string; creativeSlug: string }

export const creativeJobKey = (root: string, projectSlug: string, creativeSlug: string) => `creative:${root}:${projectSlug}:${creativeSlug}`;
const REGENERATE = 'Rigenera tutti i formati partendo dal brief aggiornato.';
const now = () => new Date().toISOString();

class AgentFailure extends Error {}

export class CreativeTurnService {
  private readonly maxAttempts: number;
  constructor(private readonly deps: CreativeTurnDeps) { this.maxAttempts = deps.maxAttempts ?? 3; }

  async start(ref: CreativeRef, message?: { text: string; pins: Pin[] }): Promise<JobSummary> {
    const store = new CreativeStore(ref.projectDir);
    const before = await store.get(ref.creativeSlug);
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    // Same check the queue does, but before touching the creative's files.
    if (this.deps.queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'))) throw new JobConflictError(key);
    if (message) await store.appendConversation(ref.creativeSlug, { type: 'user', at: now(), text: message.text, pins: message.pins, attachments: [] });
    await store.update(ref.creativeSlug, { status: 'working', error: null });
    this.changed(ref);
    return this.deps.queue.enqueue({
      key,
      label: `Creatività · ${before.title}`,
      run: (signal, jobId) => this.run(ref, store, before.status, message, signal, jobId),
    });
  }

  async restore(ref: CreativeRef, n: number): Promise<CreativeFile> {
    const key = creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug);
    if (this.deps.queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'))) {
      throw new WorkspaceError(409, 'Attendi la fine della generazione in corso prima di ripartire da una versione');
    }
    const store = new CreativeStore(ref.projectDir);
    const version = (await store.readVersions(ref.creativeSlug)).find((v) => v.n === n);
    if (!version) throw new WorkspaceError(404, `Versione ${n} non trovata`);
    if (!version.commit || !version.sessionId) throw new WorkspaceError(409, `La versione ${n} non può essere ripristinata (manca commit o sessione)`);
    await this.deps.git.restorePath(ref.projectDir, version.commit, relative(ref.projectDir, store.workDir(ref.creativeSlug)));
    const updated = await store.update(ref.creativeSlug, { resumeFrom: { version: n, sessionId: version.sessionId } });
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: `Ripartenza dalla versione ${n}: il prossimo messaggio lavora su quella base.` });
    this.changed(ref);
    return updated;
  }

  private async run(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, message: { text: string; pins: Pin[] } | undefined, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const slug = ref.creativeSlug;
    try {
      await writeFile(join(ref.projectDir, '.studio', 'context.md'), CONTEXT_MD);
      const creative = await store.get(slug);
      const versions = await store.readVersions(slug);
      const latest = versions.at(-1);
      const n = await store.nextVersionNumber(slug);
      const presets = await this.deps.presets();
      const model = (await this.deps.model()) ?? undefined;
      const attachments = await this.extractPinFrames(ref, store, message?.pins ?? [], latest, n);

      let resumeSessionId = creative.resumeFrom?.sessionId ?? latest?.sessionId ?? undefined;
      let forkSession = Boolean(creative.resumeFrom);
      let kind: PromptKind = versions.length === 0 ? 'first' : 'iteration';
      let problems: string[] = [];
      let result = null as Awaited<ReturnType<typeof validateOutputs>> | null;
      let lastWrite: Promise<void> = Promise.resolve();

      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const prompt = buildCreativePrompt({
          slug, creative, presets, version: n, kind,
          userText: kind === 'fix' ? undefined : message?.text || (kind === 'iteration' ? REGENERATE : undefined),
          pins: kind === 'iteration' ? message?.pins : undefined,
          attachments: kind === 'iteration' ? attachments : undefined,
          problems,
        });
        const run = this.deps.runner.start({ cwd: ref.projectDir, prompt, resumeSessionId, forkSession, model }, (event) => {
          this.deps.broadcast({ type: 'agent', jobId, event });
          lastWrite = store.appendConversation(slug, { type: 'agent', at: now(), jobId, event });
          const sid = event.kind === 'session' || event.kind === 'result' ? event.sessionId : undefined;
          if (sid) this.deps.queue.patch(jobId, { sessionId: sid });
        });
        const onAbort = () => run.cancel();
        signal.addEventListener('abort', onAbort, { once: true });
        const outcome = await run.done;
        signal.removeEventListener('abort', onAbort);
        await lastWrite;
        if (outcome.status === 'cancelled') return await this.cancelled(ref, store, previous, versions.length > 0);
        if (outcome.status === 'failed') throw new AgentFailure(outcome.error ?? 'Turno non riuscito');
        resumeSessionId = outcome.sessionId ?? resumeSessionId;
        forkSession = false;

        result = await validateOutputs({ dir: store.outputsDir(slug, n), requested: creative.brief.formats, presets, durationSec: creative.brief.durationSec, media: this.deps.media });
        problems = result.problems;
        if (problems.length === 0 || attempt === this.maxAttempts) break;
        await store.appendConversation(slug, { type: 'system', at: now(), level: 'info', text: `Controllo output: ${problems.length} problemi. Chiedo una correzione (tentativo ${attempt + 1} di ${this.maxAttempts}).` });
        this.changed(ref);
        kind = 'fix';
      }

      const status = problems.length === 0 ? 'complete' : 'incomplete';
      const commit = await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n}`);
      await store.appendVersion(slug, {
        n, commit, sessionId: resumeSessionId ?? null, status, createdAt: now(),
        request: message?.text || (versions.length === 0 ? 'Generazione dal brief' : REGENERATE),
        outputs: result?.outputs ?? [], problems, tools: result?.tools ?? [], renderCommand: result?.renderCommand ?? null,
        basedOn: creative.resumeFrom?.version ?? latest?.n ?? null,
      });
      await store.appendConversation(slug, { type: 'version', at: now(), n, status });
      await store.update(slug, { status: status === 'complete' ? 'ready' : 'incomplete', error: null, resumeFrom: null });
      this.changed(ref);
    } catch (err) {
      if (signal.aborted) return await this.cancelled(ref, store, previous, (await store.readVersions(slug)).length > 0);
      const text = err instanceof Error ? err.message : String(err);
      await store.update(slug, { status: 'error', error: text }).catch(() => {});
      await store.appendConversation(slug, { type: 'system', at: now(), level: 'error', text: `Generazione non riuscita: ${text}` }).catch(() => {});
      this.changed(ref);
      throw err;
    }
  }

  private async cancelled(ref: CreativeRef, store: CreativeStore, previous: CreativeStatus, hasVersions: boolean): Promise<'cancelled'> {
    const restored: CreativeStatus = previous === 'ready' || previous === 'incomplete' || previous === 'draft'
      ? previous : hasVersions ? 'ready' : 'draft';
    await store.update(ref.creativeSlug, { status: restored, error: null });
    await store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text: 'Generazione annullata.' });
    this.changed(ref);
    return 'cancelled';
  }

  private async extractPinFrames(ref: CreativeRef, store: CreativeStore, pins: Pin[], latest: { n: number; outputs: Array<{ format: string; file: string }> } | undefined, n: number): Promise<string[]> {
    if (!this.deps.media.available || !latest) return [];
    const out: string[] = [];
    for (const [i, pin] of pins.entries()) {
      if (pin.timeSec === null) continue;
      const output = latest.outputs.find((o) => o.format === pin.format);
      if (!output) continue;
      const target = join(store.workDir(ref.creativeSlug), '.feedback', `${n}-${i + 1}.jpg`);
      if (await this.deps.media.frame(join(store.outputsDir(ref.creativeSlug, latest.n), output.file), target, pin.timeSec)) {
        out.push(relative(ref.projectDir, target));
      }
    }
    return out;
  }

  private changed(ref: CreativeRef) {
    this.deps.broadcast({ type: 'creative', project: ref.projectSlug, creative: ref.creativeSlug });
  }
}
```

Note on `start`: the conflict check runs before any file is touched, so a refused start leaves the creative unchanged.

Append to `packages/core/src/index.ts`:
```ts
export * from './creatives/creative-turns.ts';
```

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS, ripetuti 3 volte di fila senza flaky (`for i in 1 2 3; do pnpm vitest run packages/core/test/creative-turns.test.ts || break; done`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): creative turns with output validation, auto-fix attempts and git-backed versions"
```

---

### Task 9: API delle creatività, catalogo formati, file e recupero all'avvio

**Files:**
- Create: `packages/core/src/server/creative-routes.ts`, `packages/core/test/creative-routes.test.ts`
- Modify: `packages/core/src/server/app.ts`, `packages/core/src/server/main.ts`, `packages/core/package.json` (dep `open`), `packages/core/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–8; `buildServer`, `EventHub`, `WorkspaceStore`, `WorkspaceError` (Fase 1).
- Produces:
  - `ServerDeps` gains `media?: MediaTools` (default `NoMediaTools`) and `openPath?: (path: string) => Promise<void>` (default: no-op that resolves).
  - `startServer` passes `media: await createFfmpegTools()` and `openPath: (p) => open(p).then(() => {})` (package `open`).
  - `registerCreativeRoutes(app: FastifyInstance, ctx: CreativeRoutesContext): void` with
    `CreativeRoutesContext = { requireWorkspace: () => WorkspaceStore; turns: CreativeTurnService; media: MediaTools; openPath: (p: string) => Promise<void>; isJobActive: (key: string) => boolean }`
  - `recoverWorkspace(ws: WorkspaceStore): Promise<void>` — runs `CreativeStore.recoverInterrupted()` for every readable project; called when the workspace is opened (startup and `PUT /api/workspace`).
  - REST (errors `{ error }`):
    | Method | Path | Body | Result |
    |---|---|---|---|
    | GET | `/api/formats` | — | `CatalogState` |
    | PUT | `/api/formats` | `{ presets: FormatPreset[] }` | `CatalogState`; 400 if invalid |
    | POST | `/api/formats/reset` | — | `CatalogState` |
    | GET | `/api/projects/:slug/creatives` | — | `CreativeListItem[]` |
    | POST | `/api/projects/:slug/creatives` | `{ title, brief, generate?: boolean }` | 201 `{ slug, creative, job: JobSummary \| null }` |
    | GET | `/api/projects/:slug/creatives/:c` | — | `CreativeDetail` |
    | PUT | `/api/projects/:slug/creatives/:c` | `{ title?, brief? }` | `CreativeFile`; 409 while a job is active |
    | GET | `/api/projects/:slug/creatives/:c/conversation` | — | `ConversationEntry[]` |
    | POST | `/api/projects/:slug/creatives/:c/turns` | `{ text?: string; pins?: Pin[] }` | 202 `JobSummary`; 400 on invalid pins / text > 10000 chars; 409 if active |
    | POST | `/api/projects/:slug/creatives/:c/versions/:n/restore` | — | `CreativeFile` |
    | POST | `/api/projects/:slug/creatives/:c/versions/:n/reveal` | — | `{ ok: true }`; 404 if the folder is missing |
    | GET | `/api/projects/:slug/creatives/:c/files/*` | — | the file; only under `outputs/` or `work/.feedback/`, never through symlinks or `..`; else 404 |

- [ ] **Step 1: Dipendenza**

Run: `pnpm --filter @motion-studio/core add open@^10.1.0`

- [ ] **Step 2: Test che falliscono**

`packages/core/test/creative-routes.test.ts`:
```ts
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const brief = { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 10, assets: [], notes: '' };
let app: FastifyInstance;
let base: string;
let opened: string[];

const build = () => buildServer({
  appConfig: new AppConfigStore(join(base, 'config')),
  git: new Git(),
  runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }),
  doctor: async () => [],
  openPath: async (p) => { opened.push(p); },
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-crr-'));
  opened = [];
  process.env.FAKE_CLAUDE_SCENARIO = 'render';
  app = await build();
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; });

const waitJobs = async () => {
  for (let i = 0; i < 250; i++) {
    const jobs = (await app.inject('/api/jobs')).json() as Array<{ state: string }>;
    if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) return jobs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};
const createCreative = async (generate = true) =>
  (await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'Lancio', brief, generate } })).json();

describe('formats', () => {
  it('serves, validates and resets the catalog', async () => {
    const s = (await app.inject('/api/formats')).json();
    expect(s.presets.length).toBeGreaterThan(30);
    expect((await app.inject({ method: 'PUT', url: '/api/formats', payload: { presets: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/formats', payload: { presets: [s.presets[0]] } })).json().presets).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/formats/reset' })).json().presets.length).toBe(s.presets.length);
  });
});

describe('creatives', () => {
  it('creates and generates, then exposes detail, conversation and files', async () => {
    const created = await createCreative();
    expect(created.job).toMatchObject({ state: expect.any(String) });
    await waitJobs();
    const list = (await app.inject('/api/projects/acme/creatives')).json();
    expect(list[0]).toMatchObject({ ok: true, slug: created.slug, status: 'ready', versions: 1 });
    const detail = (await app.inject(`/api/projects/acme/creatives/${created.slug}`)).json();
    expect(detail.versions[0].outputs).toHaveLength(2);
    expect(detail.jobKey).toContain(created.slug);
    expect((await app.inject(`/api/projects/acme/creatives/${created.slug}/conversation`)).json().at(-1)).toMatchObject({ type: 'version', n: 1 });
    const file = await app.inject(`/api/projects/acme/creatives/${created.slug}/files/outputs/v1/manifest.json`);
    expect(file.statusCode).toBe(200);
    expect(file.json().schemaVersion).toBe(1);
  });
  it('creates a draft without generating and validates the brief', async () => {
    const created = await createCreative(false);
    expect(created.job).toBeNull();
    expect(created.creative.status).toBe('draft');
    const bad = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'X', brief: { ...brief, goal: '' } } });
    expect(bad.statusCode).toBe(400);
  });
  it('iterates with text and pins, and validates them', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const url = `/api/projects/acme/creatives/${slug}/turns`;
    expect((await app.inject({ method: 'POST', url, payload: { pins: [{ format: 'x', x: 3, y: 0, timeSec: null }] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, payload: { text: 'x'.repeat(10001) } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url, payload: { text: 'Logo più grande', pins: [{ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 1 }] } });
    expect(res.statusCode).toBe(202);
    await waitJobs();
    expect((await app.inject(`/api/projects/acme/creatives/${slug}`)).json().versions).toHaveLength(2);
  });
  it('blocks brief edits while a job runs and allows them afterwards', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const { slug, job } = await createCreative();
    const url = `/api/projects/acme/creatives/${slug}`;
    await new Promise((r) => setTimeout(r, 300));
    expect((await app.inject({ method: 'PUT', url, payload: { title: 'Nuovo' } })).statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    await waitJobs();
    expect((await app.inject({ method: 'PUT', url, payload: { title: 'Nuovo', brief: { ...brief, durationSec: 6 } } })).json()).toMatchObject({ title: 'Nuovo', brief: { durationSec: 6 } });
  });
  it('restores a version and reveals its folder', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const r = await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/restore` });
    expect(r.json().resumeFrom).toMatchObject({ version: 1 });
    expect((await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/1/reveal` })).json()).toEqual({ ok: true });
    expect(opened[0]).toMatch(/outputs[/\\]v1$/);
    expect((await app.inject({ method: 'POST', url: `/api/projects/acme/creatives/${slug}/versions/9/reveal` })).statusCode).toBe(404);
  });
});

describe('file serving safety', () => {
  it('refuses traversal, non-output paths and symlinks', async () => {
    const { slug } = await createCreative();
    await waitJobs();
    const dir = join(base, 'ws', 'acme', 'creatives', slug);
    await symlink('/etc/hosts', join(dir, 'outputs', 'v1', 'leak.txt'));
    const files = `/api/projects/acme/creatives/${slug}/files/`;
    for (const p of ['creative.json', 'outputs/../creative.json', 'outputs/%2e%2e/creative.json', '..%2f..%2fproject.json', 'outputs/v1/leak.txt', 'work/scene.txt']) {
      expect((await app.inject(files + p)).statusCode, p).toBe(404);
    }
  });
});

describe('startup recovery', () => {
  it('marks creatives left in working as interrupted', async () => {
    const { slug } = await createCreative(false);
    const file = join(base, 'ws', 'acme', 'creatives', slug, 'creative.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"draft"', '"working"'));
    await app.close();
    app = await build();
    expect((await app.inject(`/api/projects/acme/creatives/${slug}`)).json().creative.status).toBe('interrupted');
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/creative-routes.test.ts`
Expected: FAIL (route inesistenti).

- [ ] **Step 4: Implementa `creative-routes.ts`**

```ts
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, normalize, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { briefSchema, pinSchema, type CreativeDetail } from '@motion-studio/shared';
import { z } from 'zod';
import { CreativeStore } from '../creatives/creative-store.ts';
import { creativeJobKey, type CreativeRef, type CreativeTurnService } from '../creatives/creative-turns.ts';
import { FormatCatalog } from '../formats/format-catalog.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';

export interface CreativeRoutesContext {
  requireWorkspace: () => WorkspaceStore;
  turns: CreativeTurnService;
  media: MediaTools;
  openPath: (p: string) => Promise<void>;
  isJobActive: (key: string) => boolean;
}

const turnBody = z.object({ text: z.string().max(10_000).optional(), pins: z.array(pinSchema).max(50).optional() });
const createBody = z.object({ title: z.string(), brief: briefSchema, generate: z.boolean().optional() });
const editBody = z.object({ title: z.string().optional(), brief: briefSchema.optional() });
const SERVED_PREFIXES = [`outputs${sep}`, `work${sep}.feedback${sep}`];

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new WorkspaceError(400, `Richiesta non valida: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

export async function recoverWorkspace(ws: WorkspaceStore): Promise<void> {
  for (const p of await ws.listProjects()) {
    if (p.ok) await new CreativeStore(ws.projectDir(p.slug)).recoverInterrupted().catch(() => []);
  }
}

export function registerCreativeRoutes(app: FastifyInstance, ctx: CreativeRoutesContext): void {
  const catalog = () => new FormatCatalog(ctx.requireWorkspace().root);
  const refOf = async (slug: string, creativeSlug: string): Promise<CreativeRef & { store: CreativeStore }> => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug); // 404 for unknown projects
    const projectDir = ws.projectDir(slug);
    const store = new CreativeStore(projectDir);
    store.dir(creativeSlug); // 400 for invalid slugs
    return { root: ws.root, projectSlug: slug, projectDir, creativeSlug, store };
  };

  app.get('/api/formats', async () => catalog().load());
  app.put<{ Body: { presets?: unknown } }>('/api/formats', async (req) => catalog().save((req.body?.presets ?? []) as never));
  app.post('/api/formats/reset', async () => catalog().resetToDefaults());

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/creatives', async (req) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    return new CreativeStore(ws.projectDir(req.params.slug)).list();
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/creatives', async (req, reply) => {
    const body = parse(createBody, req.body);
    const ws = ctx.requireWorkspace();
    await ws.getProject(req.params.slug);
    const store = new CreativeStore(ws.projectDir(req.params.slug));
    const { slug, creative } = await store.create({ title: body.title, brief: body.brief });
    const ref = { root: ws.root, projectSlug: req.params.slug, projectDir: ws.projectDir(req.params.slug), creativeSlug: slug };
    const job = body.generate ? await ctx.turns.start(ref) : null;
    return reply.status(201).send({ slug, creative: job ? await store.get(slug) : creative, job });
  });

  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c', async (req): Promise<CreativeDetail> => {
    const ref = await refOf(req.params.slug, req.params.c);
    return {
      slug: ref.creativeSlug,
      creative: await ref.store.get(ref.creativeSlug),
      versions: await ref.store.readVersions(ref.creativeSlug),
      jobKey: creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug),
    };
  });

  app.put<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c', async (req) => {
    const body = parse(editBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    if (ctx.isJobActive(creativeJobKey(ref.root, ref.projectSlug, ref.creativeSlug))) {
      throw new WorkspaceError(409, 'Attendi la fine della generazione in corso prima di modificare il brief');
    }
    return ref.store.update(ref.creativeSlug, { ...(body.title !== undefined ? { title: body.title } : {}), ...(body.brief ? { brief: body.brief } : {}) });
  });

  app.get<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/conversation', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    await ref.store.get(ref.creativeSlug);
    return ref.store.readConversation(ref.creativeSlug);
  });

  app.post<{ Params: { slug: string; c: string } }>('/api/projects/:slug/creatives/:c/turns', async (req, reply) => {
    const body = parse(turnBody, req.body);
    const ref = await refOf(req.params.slug, req.params.c);
    const text = body.text?.trim() ?? '';
    const pins = body.pins ?? [];
    const job = await ctx.turns.start(ref, text || pins.length ? { text, pins } : undefined);
    return reply.status(202).send(job);
  });

  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/restore', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    return ctx.turns.restore(ref, Number(req.params.n));
  });

  app.post<{ Params: { slug: string; c: string; n: string } }>('/api/projects/:slug/creatives/:c/versions/:n/reveal', async (req) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const n = Number(req.params.n);
    const dir = Number.isInteger(n) && n > 0 ? ref.store.outputsDir(ref.creativeSlug, n) : null;
    if (!dir || !(await stat(dir).catch(() => null))?.isDirectory()) throw new WorkspaceError(404, 'Cartella degli output non trovata');
    await ctx.openPath(dir);
    return { ok: true };
  });

  app.get<{ Params: { slug: string; c: string; '*': string } }>('/api/projects/:slug/creatives/:c/files/*', async (req, reply) => {
    const ref = await refOf(req.params.slug, req.params.c);
    const base = ref.store.dir(ref.creativeSlug);
    const rel = normalize(req.params['*'] ?? ''); // Fastify already decoded the wildcard: never decode twice
    const notFound = () => reply.status(404).send({ error: 'File non trovato' });
    if (!rel || isAbsolute(rel) || rel.split(sep).includes('..') || !SERVED_PREFIXES.some((p) => rel.startsWith(p))) return notFound();
    const info = await lstat(`${base}${sep}${rel}`).catch(() => null);
    if (!info?.isFile()) return notFound();
    const real = await realpath(`${base}${sep}${rel}`).catch(() => null);
    const realBase = await realpath(base).catch(() => base);
    if (!real || relative(realBase, real).startsWith('..')) return notFound();
    return reply.sendFile(rel, base);
  });
}
```

Note: `lstat(...).isFile()` is false for symlinks, so symlinked outputs are never served; the `realpath` check additionally rejects paths that escape through a symlinked parent folder.

- [ ] **Step 5: Collega in `app.ts`**

In `packages/core/src/server/app.ts`:
1. Imports:
```ts
import { tmpdir } from 'node:os';
import { CreativeTurnService } from '../creatives/creative-turns.ts';
import { FormatCatalog } from '../formats/format-catalog.ts';
import { NoMediaTools, type MediaTools } from '../media/media-tools.ts';
import { recoverWorkspace, registerCreativeRoutes } from './creative-routes.ts';
```
2. `ServerDeps` gains:
```ts
  media?: MediaTools;
  openPath?: (path: string) => Promise<void>;
```
3. After `const queue = …`:
```ts
  const media = deps.media ?? NoMediaTools;
  const isJobActive = (key: string) => queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'));
```
4. In the startup block, after `workspace = ws;` add `await recoverWorkspace(ws);`. In `PUT /api/workspace`, before `workspace = ws;` add `if (workspace?.root !== ws.root) await recoverWorkspace(ws);` (re-selecting the workspace in use must not mark its running creatives as interrupted).
5. After the `requireWorkspace` definition:
```ts
  const turns = new CreativeTurnService({
    queue, runner: deps.runner, git: deps.git, media,
    presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets,
    model: async () => (await requireWorkspace().readSettings()).model,
    broadcast: (msg) => hub.broadcast(msg),
  });
```
6. Replace the static registration with an always-registered plugin (it provides `reply.sendFile` to the file route), serving the web build only when present:
```ts
  const serveWeb = Boolean(deps.webDir && (await stat(deps.webDir).catch(() => null))?.isDirectory());
  await app.register(fastifyStatic, { root: serveWeb ? deps.webDir! : tmpdir(), serve: serveWeb });
```
7. Before that static registration, register the routes:
```ts
  registerCreativeRoutes(app, { requireWorkspace, turns, media, openPath: deps.openPath ?? (async () => {}), isJobActive });
```

- [ ] **Step 6: `main.ts` reale**

In `packages/core/src/server/main.ts` add imports `import open from 'open';` and `import { createFfmpegTools } from '../media/media-tools.ts';`, and pass to `buildServer`:
```ts
    media: await createFfmpegTools(),
    openPath: async (p) => { await open(p); },
```

Append to `packages/core/src/index.ts`:
```ts
export * from './server/creative-routes.ts';
```

- [ ] **Step 7: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS (anche `server.test.ts` della Fase 1).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): creative, format and output-file API with startup recovery"
```

---

### Task 10: Web — API, routing, aggiornamenti live, elenco creatività

**Files:**
- Create: `packages/web/src/routes.ts`, `packages/web/src/useCreative.ts`, `packages/web/src/screens/CreativeList.tsx`, `packages/web/src/components/StatusBadge.tsx`, `packages/web/src/components/MediaThumb.tsx`, `packages/web/test/routes.test.ts`, `packages/web/test/eventsReducer.creative.test.ts`, `packages/web/test/CreativeList.test.tsx`
- Modify: `packages/web/src/api.ts`, `packages/web/src/eventsReducer.ts`, `packages/web/src/App.tsx`, `packages/web/src/screens/ProjectPage.tsx`, `packages/web/src/theme.css`

**Interfaces:**
- Consumes: API del Task 9; tipi del Task 1.
- Produces:
  - `routes.ts`:
    ```ts
    export type Route =
      | { name: 'projects' }
      | { name: 'project'; slug: string; tab: 'creatives' | 'console' }
      | { name: 'new-creative'; slug: string }
      | { name: 'creative'; slug: string; creative: string };
    export function parseRoute(hash: string): Route;
    export const href: { projects(): string; project(slug: string, tab?: 'creatives' | 'console'): string; newCreative(slug: string): string; creative(slug: string, c: string): string };
    ```
    Hashes: `#/`, `#/p/<slug>`, `#/p/<slug>/console`, `#/p/<slug>/new`, `#/p/<slug>/c/<creative>`; anything else → `projects`.
  - `api` gains: `getFormats(): Promise<CatalogState>`, `listCreatives(slug)`, `createCreative(slug, body: { title: string; brief: Brief; generate: boolean }): Promise<{ slug: string; creative: CreativeFile; job: JobSummary | null }>`, `getCreative(slug, c): Promise<CreativeDetail>`, `updateCreative(slug, c, body: { title?: string; brief?: Brief }): Promise<CreativeFile>`, `getConversation(slug, c): Promise<ConversationEntry[]>`, `sendCreativeTurn(slug, c, body: { text?: string; pins?: Pin[] }): Promise<JobSummary>`, `restoreVersion(slug, c, n): Promise<CreativeFile>`, `revealVersion(slug, c, n): Promise<{ ok: true }>`, `fileUrl(slug, c, rel: string): string`.
    `CatalogState` is declared in `api.ts` as `{ presets: FormatPreset[]; error: string | null; path: string }` (same shape as the core type).
  - `EventsState` gains `creativeTicks: Record<string, number>` (key `<project>/<creative>`, incremented on each `creative` message); `initialEventsState.creativeTicks = {}`.
  - `useCreative(slug: string, creative: string, tick: number): { detail: CreativeDetail | null; conversation: ConversationEntry[]; error: string | null; reload(): void }` — refetches detail and conversation whenever `tick` changes.
  - `<StatusBadge status: CreativeStatus />` — Italian labels: Bozza, In lavorazione, Pronta, Incompleta, Errore, Interrotta.
  - `<MediaThumb src: string; alt: string; style? />` — `<video muted preload="metadata">` for `.mp4/.webm/.mov`, else `<img>`.
  - `<CreativeList slug: string; tick: number />` — cards (cover, title, badge, n. formati, n. versioni, data) linking to the creative; status filter; "Nuova creatività" link; unreadable creatives shown with their error.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/routes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { href, parseRoute } from '../src/routes.ts';

describe('parseRoute', () => {
  it.each([
    ['', { name: 'projects' }],
    ['#/', { name: 'projects' }],
    ['#/p/acme', { name: 'project', slug: 'acme', tab: 'creatives' }],
    ['#/p/acme/console', { name: 'project', slug: 'acme', tab: 'console' }],
    ['#/p/acme/new', { name: 'new-creative', slug: 'acme' }],
    ['#/p/acme/c/2026-10-07-lancio', { name: 'creative', slug: 'acme', creative: '2026-10-07-lancio' }],
    ['#/p/ACME/../x', { name: 'projects' }],
  ])('%s', (hash, route) => { expect(parseRoute(hash)).toEqual(route); });
  it('round-trips href', () => {
    expect(parseRoute(href.creative('acme', 'c-1'))).toEqual({ name: 'creative', slug: 'acme', creative: 'c-1' });
    expect(parseRoute(href.project('acme', 'console'))).toEqual({ name: 'project', slug: 'acme', tab: 'console' });
  });
});
```

`packages/web/test/eventsReducer.creative.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { eventsReducer, initialEventsState } from '../src/eventsReducer.ts';

describe('creative messages', () => {
  it('bump a per-creative tick', () => {
    let s = eventsReducer(initialEventsState, { type: 'creative', project: 'acme', creative: 'c1' });
    s = eventsReducer(s, { type: 'creative', project: 'acme', creative: 'c1' });
    expect(s.creativeTicks).toEqual({ 'acme/c1': 2 });
  });
});
```

`packages/web/test/CreativeList.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/api.ts', () => ({
  api: {
    listCreatives: vi.fn(async () => [
      { ok: true, slug: 'c1', title: 'Lancio', status: 'ready', formats: ['a', 'b'], versions: 2, updatedAt: '2026-10-07T10:00:00.000Z', cover: 'outputs/v2/.previews/a.jpg' },
      { ok: true, slug: 'c2', title: 'Teaser', status: 'draft', formats: ['a'], versions: 0, updatedAt: '2026-10-06T10:00:00.000Z', cover: null },
      { ok: false, slug: 'c3', error: 'creative.json: JSON non valido' },
    ]),
    fileUrl: (s: string, c: string, rel: string) => `/files/${s}/${c}/${rel}`,
  },
  ApiError: class extends Error {},
}));
const { CreativeList } = await import('../src/screens/CreativeList.tsx');

describe('CreativeList', () => {
  it('shows cards with status, counts and cover, and broken items', async () => {
    render(<CreativeList slug="acme" tick={0} />);
    await waitFor(() => expect(screen.getByText('Lancio')).toBeTruthy());
    expect(screen.getByText('Pronta')).toBeTruthy();
    expect(screen.getByText('2 formati · 2 versioni')).toBeTruthy();
    expect((screen.getByAltText('Lancio') as HTMLImageElement).src).toContain('/files/acme/c1/outputs/v2/.previews/a.jpg');
    expect(screen.getByText(/JSON non valido/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '+ Nuova creatività' }).getAttribute('href')).toBe('#/p/acme/new');
  });
  it('filters by status', async () => {
    render(<CreativeList slug="acme" tick={0} />);
    await waitFor(() => screen.getByText('Lancio'));
    await userEvent.click(screen.getByRole('button', { name: 'Bozza' }));
    expect(screen.queryByText('Lancio')).toBeNull();
    expect(screen.getByText('Teaser')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web`
Expected: FAIL (moduli inesistenti).

- [ ] **Step 3: Implementa `routes.ts`**

```ts
export type Route =
  | { name: 'projects' }
  | { name: 'project'; slug: string; tab: 'creatives' | 'console' }
  | { name: 'new-creative'; slug: string }
  | { name: 'creative'; slug: string; creative: string };

const SLUG = '[a-z0-9][a-z0-9-]*';

export function parseRoute(hash: string): Route {
  let m = hash.match(new RegExp(`^#/p/(${SLUG})/c/(${SLUG})$`));
  if (m) return { name: 'creative', slug: m[1]!, creative: m[2]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})/new$`));
  if (m) return { name: 'new-creative', slug: m[1]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})(/console)?$`));
  if (m) return { name: 'project', slug: m[1]!, tab: m[2] ? 'console' : 'creatives' };
  return { name: 'projects' };
}

export const href = {
  projects: () => '#/',
  project: (slug: string, tab: 'creatives' | 'console' = 'creatives') => (tab === 'console' ? `#/p/${slug}/console` : `#/p/${slug}`),
  newCreative: (slug: string) => `#/p/${slug}/new`,
  creative: (slug: string, c: string) => `#/p/${slug}/c/${c}`,
};
```

- [ ] **Step 4: Reducer, API, hook**

`packages/web/src/eventsReducer.ts` — change the state type and the `creative` case:
```ts
export interface EventsState { jobs: Record<string, JobSummary>; events: Record<string, AgentEvent[]>; creativeTicks: Record<string, number> }
export const initialEventsState: EventsState = { jobs: {}, events: {}, creativeTicks: {} };
```
```ts
    case 'creative': {
      const key = `${msg.project}/${msg.creative}`;
      return { ...state, creativeTicks: { ...state.creativeTicks, [key]: (state.creativeTicks[key] ?? 0) + 1 } };
    }
```

`packages/web/src/api.ts` — add imports of `Brief, ConversationEntry, CreativeDetail, CreativeFile, CreativeListItem, FormatPreset, Pin` from `@motion-studio/shared`, then:
```ts
export interface CatalogState { presets: FormatPreset[]; error: string | null; path: string }
const p = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;
const c = (slug: string, creative: string) => `${p(slug)}/creatives/${encodeURIComponent(creative)}`;
```
and add to the `api` object:
```ts
  getFormats: () => request<CatalogState>('GET', '/api/formats'),
  listCreatives: (slug: string) => request<CreativeListItem[]>('GET', `${p(slug)}/creatives`),
  createCreative: (slug: string, body: { title: string; brief: Brief; generate: boolean }) =>
    request<{ slug: string; creative: CreativeFile; job: JobSummary | null }>('POST', `${p(slug)}/creatives`, body),
  getCreative: (slug: string, creative: string) => request<CreativeDetail>('GET', c(slug, creative)),
  updateCreative: (slug: string, creative: string, body: { title?: string; brief?: Brief }) => request<CreativeFile>('PUT', c(slug, creative), body),
  getConversation: (slug: string, creative: string) => request<ConversationEntry[]>('GET', `${c(slug, creative)}/conversation`),
  sendCreativeTurn: (slug: string, creative: string, body: { text?: string; pins?: Pin[] }) => request<JobSummary>('POST', `${c(slug, creative)}/turns`, body),
  restoreVersion: (slug: string, creative: string, n: number) => request<CreativeFile>('POST', `${c(slug, creative)}/versions/${n}/restore`),
  revealVersion: (slug: string, creative: string, n: number) => request<{ ok: true }>('POST', `${c(slug, creative)}/versions/${n}/reveal`),
  fileUrl: (slug: string, creative: string, rel: string) => `${c(slug, creative)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`,
```

`packages/web/src/useCreative.ts`:
```ts
import type { ConversationEntry, CreativeDetail } from '@motion-studio/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';

export function useCreative(slug: string, creative: string, tick: number) {
  const [detail, setDetail] = useState<CreativeDetail | null>(null);
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([api.getCreative(slug, creative), api.getConversation(slug, creative)])
      .then(([d, conv]) => { if (alive) { setDetail(d); setConversation(conv); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [slug, creative, tick, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { detail, conversation, error, reload };
}
```

- [ ] **Step 5: Componenti e schermata elenco**

`packages/web/src/components/StatusBadge.tsx`:
```tsx
import type { CreativeStatus } from '@motion-studio/shared';

export const STATUS_LABEL: Record<CreativeStatus, string> = {
  draft: 'Bozza', working: 'In lavorazione', ready: 'Pronta', incomplete: 'Incompleta', error: 'Errore', interrupted: 'Interrotta',
};
const CLASS: Record<CreativeStatus, string> = { draft: '', working: 'run', ready: 'ok', incomplete: 'warn-badge', error: 'err', interrupted: 'warn-badge' };

export function StatusBadge({ status }: { status: CreativeStatus }) {
  return <span className={`badge ${CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}
```

`packages/web/src/components/MediaThumb.tsx`:
```tsx
import type { CSSProperties } from 'react';

const VIDEO = /\.(mp4|webm|mov)$/i;

export function MediaThumb({ src, alt, style }: { src: string; alt: string; style?: CSSProperties }) {
  const base: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...style };
  return VIDEO.test(src)
    ? <video src={src} muted preload="metadata" aria-label={alt} style={base} />
    : <img src={src} alt={alt} style={base} />;
}
```

Append to `packages/web/src/theme.css`:
```css
.badge.warn-badge { background: var(--warn-bg); color: var(--warn-text); }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.tabs a, .tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; padding: 8px 12px; color: var(--muted); text-decoration: none; min-height: 40px; }
.tabs [aria-current='page'], .tabs [aria-selected='true'] { color: var(--text); border-bottom-color: var(--accent); font-weight: 700; }
.chip { min-height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--border); background: transparent; font-size: 13px; }
.chip[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-ink); font-weight: 700; }
.dots { background-color: var(--bg); background-image: radial-gradient(var(--dot) 1px, transparent 1px); background-size: 20px 20px; }
```

`packages/web/src/screens/CreativeList.tsx`:
```tsx
import type { CreativeListItem, CreativeStatus } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { MediaThumb } from '../components/MediaThumb.tsx';
import { STATUS_LABEL, StatusBadge } from '../components/StatusBadge.tsx';
import { href } from '../routes.ts';

export function CreativeList({ slug, tick }: { slug: string; tick: number }) {
  const [items, setItems] = useState<CreativeListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CreativeStatus | 'all'>('all');
  useEffect(() => {
    api.listCreatives(slug).then(setItems).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [slug, tick]);

  const visible = (items ?? []).filter((i) => filter === 'all' || (i.ok && i.status === filter));
  return (
    <section className="stack" aria-label="Creatività">
      <div className="row">
        <div className="row" role="group" aria-label="Filtra per stato" style={{ gap: 6 }}>
          <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Tutte</button>
          {(Object.keys(STATUS_LABEL) as CreativeStatus[]).map((s) => (
            <button key={s} type="button" className="chip" aria-pressed={filter === s} onClick={() => setFilter(s)}>{STATUS_LABEL[s]}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <a className="button primary" href={href.newCreative(slug)} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 36, padding: '0 14px', borderRadius: 8, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 700, textDecoration: 'none' }}>+ Nuova creatività</a>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {items?.length === 0 && <p className="muted">Nessuna creatività: creane una dal brief.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
        {visible.map((it) => it.ok ? (
          <a key={it.slug} href={href.creative(slug, it.slug)} className="card stack" style={{ textDecoration: 'none', color: 'inherit', gap: 8, padding: 12 }}>
            <div className="dots" style={{ aspectRatio: '16 / 10', borderRadius: 10, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {it.cover ? <MediaThumb src={api.fileUrl(slug, it.slug, it.cover)} alt={it.title} /> : <span className="muted">Nessun output</span>}
            </div>
            <div className="row" style={{ gap: 8 }}><strong style={{ flex: 1 }}>{it.title}</strong><StatusBadge status={it.status} /></div>
            <span className="muted" style={{ fontSize: 13 }}>{it.formats.length} formati · {it.versions} versioni</span>
            <span className="muted" style={{ fontSize: 12 }}>Aggiornata {new Date(it.updatedAt).toLocaleDateString('it-IT')}</span>
          </a>
        ) : (
          <div key={it.slug} className="card stack" style={{ gap: 4 }}>
            <strong>{it.slug}</strong>
            <span className="badge err" style={{ alignSelf: 'flex-start' }}>Non leggibile</span>
            <span className="mono" style={{ overflowWrap: 'anywhere' }}>{it.error}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
```

Note: the test expects the text `2 formati · 2 versioni` in one node: keep the expression in a single `<span>` as written.

- [ ] **Step 6: ProjectPage con schede e App con routing**

`packages/web/src/screens/ProjectPage.tsx` — rename the current component to `ProjectConsole` (unchanged body, without the back link and `<h1>`; keep its props `{ slug, live, expert }`), and export a new `ProjectPage`:
```tsx
export function ProjectPage({ slug, tab, live, expert }: { slug: string; tab: 'creatives' | 'console'; live: EventsState; expert: boolean }) {
  const [name, setName] = useState<string>(slug);
  useEffect(() => { api.getProject(slug).then((r) => setName(r.project.name)).catch(() => {}); }, [slug]);
  const tick = Object.entries(live.creativeTicks).filter(([k]) => k.startsWith(`${slug}/`)).reduce((a, [, v]) => a + v, 0);
  return (
    <main className="page stack">
      <a href={href.projects()} className="muted">← Progetti</a>
      <h1 style={{ margin: 0, fontSize: 24 }}>{name}</h1>
      <nav className="tabs" aria-label="Sezioni progetto">
        <a href={href.project(slug)} aria-current={tab === 'creatives' ? 'page' : undefined}>Creatività</a>
        <a href={href.project(slug, 'console')} aria-current={tab === 'console' ? 'page' : undefined}>Console agente</a>
      </nav>
      {tab === 'creatives' ? <CreativeList slug={slug} tick={tick} /> : <ProjectConsole slug={slug} live={live} expert={expert} />}
    </main>
  );
}
```
(add imports: `CreativeList`, `href`; `ProjectConsole` renders its form/console inside a `<div className="stack">` instead of `<main>`). Update `packages/web/test/ProjectPage.test.tsx` to render `ProjectPage` with `tab="console"` (and `live` including `creativeTicks: {}`), keeping its assertions.

`packages/web/src/App.tsx` — replace `useHashRoute`'s consumers: compute `const r = parseRoute(route);` and render:
```tsx
      {r.name === 'project' && <ProjectPage key={r.slug} slug={r.slug} tab={r.tab} live={live} expert={settings.expertMode} />}
      {r.name === 'new-creative' && <NewCreative key={r.slug} slug={r.slug} />}
      {r.name === 'creative' && <CreativePage key={`${r.slug}/${r.creative}`} slug={r.slug} creative={r.creative} live={live} expert={settings.expertMode} />}
      {r.name === 'projects' && <ProjectList />}
```
Until Tasks 11–12 exist, create minimal placeholders so the build passes:
`packages/web/src/screens/NewCreative.tsx`: `export function NewCreative({ slug }: { slug: string }) { return <main className="page">Nuova creatività per {slug}</main>; }`
`packages/web/src/screens/CreativePage.tsx`: `import type { EventsState } from '../eventsReducer.ts'; export function CreativePage({ slug, creative }: { slug: string; creative: string; live: EventsState; expert: boolean }) { return <main className="page">{slug}/{creative}</main>; }`

Also update any test that builds an `EventsState` literal to include `creativeTicks: {}`.

- [ ] **Step 7: Verifica**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: tutti PASS, build OK.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): creative routes, live refresh and creative list in project tabs"
```

---

### Task 11: Web — Nuova creatività (brief guidato + anteprima formati)

**Files:**
- Create: `packages/web/src/frameSize.ts`, `packages/web/src/components/FormatPicker.tsx`, `packages/web/src/components/FormatPreview.tsx`, `packages/web/test/frameSize.test.ts`, `packages/web/test/NewCreative.test.tsx`
- Modify: `packages/web/src/screens/NewCreative.tsx` (replace placeholder)

**Interfaces:**
- Consumes: `api.getFormats`, `api.createCreative`, `href` (Task 10); `FormatPreset`, `Brief` (Task 1).
- Produces:
  - `fitFrame(width: number, height: number, maxW: number, maxH: number): { width: number; height: number }` — scales into the box keeping the ratio, min 8 px per side.
  - `<FormatPicker presets: FormatPreset[]; selected: string[]; onToggle(id: string): void />` — one row per channel (catalog order), chips `aria-pressed`, `title` = `W×H · video|immagine`.
  - `<FormatPreview presets: FormatPreset[]; selected: string[] />` — dashed frames in real proportions (`fitFrame(w, h, 220, 170)`), caption `Channel · Name` and `W×H`; ids missing from the catalog render a frame-less item "<id>: preset sconosciuto". Heading text: `Cosa riceverai · <n> formati`.
  - `<NewCreative slug />` — form: titolo (facoltativo: default = primi 60 caratteri dell'obiettivo), "Cosa vuoi realizzare?" (obiettivo, obbligatorio), messaggio chiave, formati (FormatPicker), durata (chip 6s/15s/30s/60s/Nessuna; default 15s), asset (percorsi nel progetto separati da virgola), note; pulsanti "Salva bozza" (`generate: false`) e "Genera" (`generate: true`), disabilitati senza obiettivo o formati; on success `location.hash = href.creative(slug, created.slug)`; errori API in `role="alert"`; avviso se il catalogo ha `error`.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/frameSize.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fitFrame } from '../src/frameSize.ts';

describe('fitFrame', () => {
  it('fits portrait, landscape and extreme banners', () => {
    expect(fitFrame(1080, 1920, 260, 170)).toEqual({ width: 96, height: 170 });
    expect(fitFrame(1920, 1080, 260, 170)).toEqual({ width: 260, height: 146 });
    expect(fitFrame(728, 90, 260, 170)).toEqual({ width: 260, height: 32 });
    expect(fitFrame(160, 600, 260, 170)).toEqual({ width: 45, height: 170 });
  });
  it('never goes below 8px', () => {
    expect(fitFrame(10000, 10, 100, 100)).toEqual({ width: 100, height: 8 });
  });
});
```

`packages/web/test/NewCreative.test.tsx`:
```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createCreative = vi.fn(async () => ({ slug: '2026-10-07-lancio', creative: {}, job: null }));
vi.mock('../src/api.ts', () => ({
  api: { getFormats: vi.fn(async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' })), createCreative },
  ApiError: class extends Error {},
}));
const { NewCreative } = await import('../src/screens/NewCreative.tsx');

beforeEach(() => { createCreative.mockClear(); location.hash = ''; });

describe('NewCreative', () => {
  it('updates the preview while picking formats and generates', async () => {
    render(<NewCreative slug="acme" />);
    await waitFor(() => screen.getByRole('group', { name: 'Instagram' }));
    const generate = screen.getByRole('button', { name: 'Genera' }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Lancio della nuova app');
    await userEvent.click(within(screen.getByRole('group', { name: 'Instagram' })).getByRole('button', { name: 'Post 1:1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Banner 300×250' }));
    expect(screen.getByText('Cosa riceverai · 2 formati')).toBeTruthy();
    expect(generate.disabled).toBe(false);
    await userEvent.click(generate);
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]).toEqual(['acme', {
      title: 'Lancio della nuova app',
      brief: { goal: 'Lancio della nuova app', message: '', formats: ['instagram-post-1x1', 'web-banner-300x250'], durationSec: 15, assets: [], notes: '' },
      generate: true,
    }]);
    expect(location.hash).toBe('#/p/acme/c/2026-10-07-lancio');
  });
  it('saves a draft with duration "Nessuna" and parsed assets', async () => {
    render(<NewCreative slug="acme" />);
    await waitFor(() => screen.getByRole('group', { name: 'Web' }));
    await userEvent.type(screen.getByLabelText('Cosa vuoi realizzare?'), 'Banner');
    await userEvent.click(screen.getByRole('button', { name: 'Banner 728×90' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nessuna' }));
    await userEvent.type(screen.getByLabelText(/Asset da usare/), 'assets/logo.svg, assets/foto.jpg');
    await userEvent.click(screen.getByRole('button', { name: 'Salva bozza' }));
    await waitFor(() => expect(createCreative).toHaveBeenCalledOnce());
    expect(createCreative.mock.calls[0]![1]).toMatchObject({ generate: false, brief: { durationSec: null, assets: ['assets/logo.svg', 'assets/foto.jpg'] } });
  });
});
```

Note: `Post 1:1` exists in several channels, so the test scopes the click to the Instagram group.

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web/test/frameSize.test.ts packages/web/test/NewCreative.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementa**

`packages/web/src/frameSize.ts`:
```ts
export function fitFrame(width: number, height: number, maxW: number, maxH: number): { width: number; height: number } {
  const s = Math.min(maxW / width, maxH / height);
  return { width: Math.max(8, Math.round(width * s)), height: Math.max(8, Math.round(height * s)) };
}
```

`packages/web/src/components/FormatPicker.tsx`:
```tsx
import type { FormatPreset } from '@motion-studio/shared';

export function groupByChannel(presets: FormatPreset[]): Array<[string, FormatPreset[]]> {
  const map = new Map<string, FormatPreset[]>();
  for (const p of presets) map.set(p.channel, [...(map.get(p.channel) ?? []), p]);
  return [...map.entries()];
}

export function FormatPicker({ presets, selected, onToggle }: { presets: FormatPreset[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {groupByChannel(presets).map(([channel, items]) => (
        <div key={channel} role="group" aria-label={channel} className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ flex: '0 0 96px', fontSize: 12, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{channel}</span>
          {items.map((p) => (
            <button key={p.id} type="button" className="chip" aria-pressed={selected.includes(p.id)} title={`${p.width}×${p.height} · ${p.kind === 'video' ? 'video' : 'immagine'}`} onClick={() => onToggle(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

`packages/web/src/components/FormatPreview.tsx`:
```tsx
import type { FormatPreset } from '@motion-studio/shared';
import { fitFrame } from '../frameSize.ts';

export function FormatPreview({ presets, selected }: { presets: FormatPreset[]; selected: string[] }) {
  return (
    <section className="stack dots" aria-label="Anteprima formati" style={{ padding: 16, borderRadius: 14, minHeight: 240 }}>
      <strong>Cosa riceverai · {selected.length} formati</strong>
      <div className="row" style={{ alignItems: 'flex-end', gap: 20 }}>
        {selected.map((id) => {
          const p = presets.find((x) => x.id === id);
          if (!p) return <span key={id} className="error">{id}: preset sconosciuto</span>;
          const size = fitFrame(p.width, p.height, 220, 170);
          return (
            <figure key={id} style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ ...size, border: '2px dashed var(--accent)', borderRadius: 4, background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="mono muted">{p.width}×{p.height}</span>
              </div>
              <figcaption style={{ fontSize: 12, fontWeight: 700, maxWidth: 220 }}>{p.channel} · {p.name}</figcaption>
            </figure>
          );
        })}
        {selected.length === 0 && <p className="muted" style={{ margin: 0 }}>Scegli almeno un formato.</p>}
      </div>
    </section>
  );
}
```

`packages/web/src/screens/NewCreative.tsx`:
```tsx
import type { FormatPreset } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { FormatPicker } from '../components/FormatPicker.tsx';
import { FormatPreview } from '../components/FormatPreview.tsx';
import { href } from '../routes.ts';

const DURATIONS: Array<[string, number | null]> = [['6s', 6], ['15s', 15], ['30s', 30], ['60s', 60], ['Nessuna', null]];

export function NewCreative({ slug }: { slug: string }) {
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [message, setMessage] = useState('');
  const [formats, setFormats] = useState<string[]>([]);
  const [durationSec, setDurationSec] = useState<number | null>(15);
  const [assets, setAssets] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getFormats().then((s) => { setPresets(s.presets); setCatalogError(s.error); }).catch((e: unknown) => setError(String((e as Error).message)));
  }, []);

  const toggle = (id: string) => setFormats((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const ready = goal.trim() !== '' && formats.length > 0 && !busy;

  const submit = async (generate: boolean) => {
    setBusy(true); setError(null);
    try {
      const created = await api.createCreative(slug, {
        title: title.trim() || goal.trim().slice(0, 60),
        brief: {
          goal: goal.trim(), message: message.trim(), formats, durationSec,
          assets: assets.split(',').map((a) => a.trim()).filter(Boolean), notes: notes.trim(),
        },
        generate,
      });
      location.hash = href.creative(slug, created.slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page" style={{ maxWidth: 1280 }}>
      <a href={href.project(slug)} className="muted">← Creatività</a>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginTop: 12 }}>
        <form className="card stack" style={{ flex: '1 1 520px', minWidth: 0 }} onSubmit={(e) => { e.preventDefault(); void submit(true); }}>
          <label htmlFor="goal" style={{ fontSize: 24, fontWeight: 800 }}>Cosa vuoi realizzare?</label>
          <textarea id="goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Es. un video di lancio della nuova app: deve far capire in pochi secondi che prenotare è immediato" />
          <label htmlFor="message"><strong>Messaggio chiave</strong> <span className="muted">(facoltativo)</span></label>
          <input id="message" value={message} onChange={(e) => setMessage(e.target.value)} />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend style={{ fontWeight: 800, marginBottom: 8 }}>Dove verrà pubblicata?</legend>
            {catalogError && <p className="warn" style={{ margin: 0 }}>{catalogError}</p>}
            <FormatPicker presets={presets} selected={formats} onToggle={toggle} />
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend style={{ fontWeight: 800, marginBottom: 8 }}>Durata dei video</legend>
            <div className="row" style={{ gap: 6 }}>
              {DURATIONS.map(([label, v]) => (
                <button key={label} type="button" className="chip" aria-pressed={durationSec === v} onClick={() => setDurationSec(v)}>{label}</button>
              ))}
            </div>
          </fieldset>
          <label htmlFor="assets"><strong>Asset da usare</strong> <span className="muted">(percorsi nel progetto, separati da virgola)</span></label>
          <input id="assets" value={assets} onChange={(e) => setAssets(e.target.value)} placeholder="assets/logo.svg" />
          <label htmlFor="notes"><strong>Note per l'agente</strong> <span className="muted">(facoltative)</span></label>
          <input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <label htmlFor="title"><strong>Titolo</strong> <span className="muted">(facoltativo)</span></label>
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
          <div className="row">
            <div style={{ flex: 1 }} />
            <button type="button" disabled={!ready} onClick={() => void submit(false)}>Salva bozza</button>
            <button type="submit" className="primary" disabled={!ready}>Genera</button>
          </div>
        </form>
        <div style={{ flex: '1 1 420px', minWidth: 0 }}>
          <FormatPreview presets={presets} selected={formats} />
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Verifica**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): guided brief with live format preview"
```

---

### Task 12: Web — Pagina creatività: tavola dei formati, vista focus, versioni

**Files:**
- Create: `packages/web/src/components/FormatBoard.tsx`, `packages/web/src/components/FocusView.tsx`, `packages/web/src/components/ConversationPanel.tsx` (stub, completed in Task 13), `packages/web/test/FormatBoard.test.tsx`, `packages/web/test/FocusView.test.tsx`
- Modify: `packages/web/src/screens/CreativePage.tsx` (replace placeholder), `packages/web/src/theme.css`

**Interfaces:**
- Consumes: `api` (Task 10), `useCreative`, `StatusBadge`, `MediaThumb`, `groupByChannel` (Task 11), `fitFrame` (Task 11), `EventsState` (Task 10).
- Produces:
  - `<FormatBoard presets: FormatPreset[]; formats: string[]; version: VersionEntry | null; compare: VersionEntry | null; fileUrl(n: number, file: string): string; pins: Pin[]; showSafeZone: boolean; onOpen(id: string): void />`
    - groups by channel (catalog order; unknown ids in a final group "Altro"); each format is a `<button>` labelled `<Channel> · <Name>` that calls `onOpen(id)`;
    - frame size `fitFrame(w, h, 300, 260)`; content: the version's output (`MediaThumb`, alt `<Channel> · <Name> v<n>`) or a dashed placeholder with text `In attesa` (no version) / `Mancante in v<n>` (version without that output); unknown preset → text `<id>: preset sconosciuto`;
    - with `compare`, each format shows two frames side by side captioned `v<compare.n>` and `v<version.n>`;
    - pins of that format drawn as numbered markers (`aria-label="Commento <k>"`) at `x%/y%`; `showSafeZone` draws the preset safe zone as translucent bands.
  - `<FocusView preset: FormatPreset; src: string | null; compareSrc: string | null; versionN: number | null; compareN: number | null; pins: Pin[]; onAddPin(pin: Pin): void; onClose(): void />`
    - `role="dialog"`, `aria-modal`, title `<Channel> · <Name>`; Escape and "Chiudi" call `onClose`;
    - large media (video with `controls`); button "Aggiungi commento" toggles an overlay (`aria-label="Clicca sul punto da commentare"`) that turns the next click into `onAddPin({ format, x, y, timeSec })` with x/y in 0..1 rounded to 3 decimals and `timeSec` = video `currentTime` rounded to 0.1 (null for images), then leaves comment mode.
  - `ConversationPanel` stub: `export function ConversationPanel(_: ConversationPanelProps) { return <aside className="card">Conversazione</aside>; }` with the props interface of Task 13 already declared.
  - `<CreativePage slug creative live expert />`: header (← Creatività, titolo, `StatusBadge`, gruppo radio versioni `v1…vN`, select "Confronta con", checkbox "Safe zone", "Mostra nella cartella" → `api.revealVersion`, "Riparti da v<k>" quando la versione selezionata non è l'ultima → `api.restoreVersion`); banner when `creative.resumeFrom`; alert with `creative.error` when status `error`/`interrupted`; warning list of `problems` when the selected version is incomplete; layout: `FormatBoard` (fluid, `.dots` background) + `ConversationPanel` aside (max 420px); `FocusView` when a format is open. Pending pins live here and go to the panel.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/FormatBoard.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type VersionEntry } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { FormatBoard } from '../src/components/FormatBoard.tsx';

const v1: VersionEntry = {
  n: 1, commit: 'c', sessionId: 's', status: 'incomplete', createdAt: '2026-10-07T10:00:00.000Z', request: 'r', problems: ['x'], tools: [], renderCommand: null, basedOn: null,
  outputs: [{ format: 'instagram-post-1x1', file: 'instagram-post-1x1.mp4', width: 1080, height: 1080, durationSec: 10, verified: true, preview: '.previews/instagram-post-1x1.jpg' }],
};
const url = (n: number, f: string) => `/f/v${n}/${f}`;

describe('FormatBoard', () => {
  it('renders outputs, missing placeholders, unknown presets and pins', async () => {
    const onOpen = vi.fn();
    render(<FormatBoard presets={DEFAULT_FORMATS} formats={['instagram-post-1x1', 'web-banner-300x250', 'ghost']} version={v1} compare={null}
      fileUrl={url} pins={[{ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 2 }]} showSafeZone={false} onOpen={onOpen} />);
    expect(screen.getByLabelText('Instagram · Post 1:1 v1')).toBeTruthy();
    expect(screen.getByText('Mancante in v1')).toBeTruthy();
    expect(screen.getByText('ghost: preset sconosciuto')).toBeTruthy();
    expect(screen.getByLabelText('Commento 1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Web · Banner 300×250/ }));
    expect(onOpen).toHaveBeenCalledWith('web-banner-300x250');
  });
  it('shows a waiting placeholder without versions and two frames when comparing', () => {
    const { rerender } = render(<FormatBoard presets={DEFAULT_FORMATS} formats={['instagram-post-1x1']} version={null} compare={null} fileUrl={url} pins={[]} showSafeZone={false} onOpen={() => {}} />);
    expect(screen.getByText('In attesa')).toBeTruthy();
    rerender(<FormatBoard presets={DEFAULT_FORMATS} formats={['instagram-post-1x1']} version={{ ...v1, n: 2 }} compare={v1} fileUrl={url} pins={[]} showSafeZone={false} onOpen={() => {}} />);
    expect(screen.getByLabelText('Instagram · Post 1:1 v1')).toBeTruthy();
    expect(screen.getByLabelText('Instagram · Post 1:1 v2')).toBeTruthy();
  });
});
```

`packages/web/test/FocusView.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { FocusView } from '../src/components/FocusView.tsx';

const banner = DEFAULT_FORMATS.find((f) => f.id === 'web-banner-300x250')!;

describe('FocusView', () => {
  it('adds a pin where the user clicks, then leaves comment mode', async () => {
    const onAddPin = vi.fn();
    render(<FocusView preset={banner} src="/f/banner.png" compareSrc={null} versionN={1} compareN={null} pins={[]} onAddPin={onAddPin} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi commento' }));
    const overlay = screen.getByLabelText('Clicca sul punto da commentare');
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(overlay, { clientX: 50, clientY: 25 });
    expect(onAddPin).toHaveBeenCalledWith({ format: 'web-banner-300x250', x: 0.25, y: 0.25, timeSec: null });
    expect(screen.queryByLabelText('Clicca sul punto da commentare')).toBeNull();
  });
  it('closes with Escape', () => {
    const onClose = vi.fn();
    render(<FocusView preset={banner} src={null} compareSrc={null} versionN={null} compareN={null} pins={[]} onAddPin={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web/test/FormatBoard.test.tsx packages/web/test/FocusView.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementa `FormatBoard.tsx`**

```tsx
import type { FormatPreset, OutputFileInfo, Pin, VersionEntry } from '@motion-studio/shared';
import type { CSSProperties } from 'react';
import { fitFrame } from '../frameSize.ts';
import { groupByChannel } from './FormatPicker.tsx';
import { MediaThumb } from './MediaThumb.tsx';

interface BoardProps {
  presets: FormatPreset[]; formats: string[]; version: VersionEntry | null; compare: VersionEntry | null;
  fileUrl: (n: number, file: string) => string; pins: Pin[]; showSafeZone: boolean; onOpen: (id: string) => void;
}

function Frame({ preset, version, fileUrl, pins, showSafeZone }: { preset: FormatPreset; version: VersionEntry | null; fileUrl: BoardProps['fileUrl']; pins: Pin[]; showSafeZone: boolean }) {
  const size = fitFrame(preset.width, preset.height, 300, 260);
  const out: OutputFileInfo | undefined = version?.outputs.find((o) => o.format === preset.id);
  const label = `${preset.channel} · ${preset.name}`;
  const band = (s: CSSProperties): CSSProperties => ({ position: 'absolute', background: 'var(--accent)', opacity: 0.18, ...s });
  const sz = preset.safeZone;
  return (
    <div style={{ ...size, position: 'relative', borderRadius: 4, overflow: 'hidden', background: 'var(--surface)', border: out ? '1px solid var(--border)' : '2px dashed var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {out && version
        ? <MediaThumb src={fileUrl(version.n, out.file)} alt={`${label} v${version.n}`} />
        : <span className="muted" style={{ fontSize: 12 }}>{version ? `Mancante in v${version.n}` : 'In attesa'}</span>}
      {showSafeZone && sz && (
        <>
          <span style={band({ left: 0, right: 0, top: 0, height: `${(sz.top / preset.height) * 100}%` })} />
          <span style={band({ left: 0, right: 0, bottom: 0, height: `${(sz.bottom / preset.height) * 100}%` })} />
        </>
      )}
      {pins.map((p, k) => (
        <span key={k} aria-label={`Commento ${k + 1}`} style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: 'translate(-50%, -100%)', width: 22, height: 22, borderRadius: '50% 50% 50% 0', background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--on-accent)' }}>{k + 1}</span>
      ))}
    </div>
  );
}

export function FormatBoard({ presets, formats, version, compare, fileUrl, pins, showSafeZone, onOpen }: BoardProps) {
  const known = presets.filter((p) => formats.includes(p.id));
  const unknown = formats.filter((id) => !presets.some((p) => p.id === id));
  return (
    <div className="row" style={{ alignItems: 'flex-start', gap: 24, padding: 20 }}>
      {groupByChannel(known).map(([channel, items]) => (
        <section key={channel} aria-label={channel} className="stack" style={{ gap: 10, padding: 14, borderRadius: 14, border: '1px dashed var(--border)' }}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{channel}</span>
          <div className="row" style={{ alignItems: 'flex-end', gap: 18 }}>
            {items.map((p) => {
              const formatPins = pins.filter((x) => x.format === p.id);
              return (
                <button key={p.id} type="button" onClick={() => onOpen(p.id)} aria-label={`${p.channel} · ${p.name} — apri`} style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
                    {compare && (
                      <div className="stack" style={{ gap: 4 }}>
                        <Frame preset={p} version={compare} fileUrl={fileUrl} pins={[]} showSafeZone={showSafeZone} />
                        <span className="muted" style={{ fontSize: 12 }}>v{compare.n}</span>
                      </div>
                    )}
                    <div className="stack" style={{ gap: 4 }}>
                      <Frame preset={p} version={version} fileUrl={fileUrl} pins={formatPins} showSafeZone={showSafeZone} />
                      {compare && version && <span className="muted" style={{ fontSize: 12 }}>v{version.n}</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name} <span className="mono muted">{p.width}×{p.height}</span></span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {unknown.length > 0 && (
        <section aria-label="Altro" className="stack" style={{ gap: 6, padding: 14 }}>
          {unknown.map((id) => <span key={id} className="error">{id}: preset sconosciuto</span>)}
        </section>
      )}
    </div>
  );
}
```

Note: the test queries the frame's open button with `/Web · Banner 300×250/` — matched by the `aria-label` `Web · Banner 300×250 — apri`.

- [ ] **Step 4: Implementa `FocusView.tsx`**

```tsx
import type { FormatPreset, Pin } from '@motion-studio/shared';
import { useEffect, useRef, useState, type MouseEvent } from 'react';

const VIDEO = /\.(mp4|webm|mov)(\?|$)/i;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export function FocusView({ preset, src, compareSrc, versionN, compareN, pins, onAddPin, onClose }: {
  preset: FormatPreset; src: string | null; compareSrc: string | null; versionN: number | null; compareN: number | null;
  pins: Pin[]; onAddPin: (pin: Pin) => void; onClose: () => void;
}) {
  const [commenting, setCommenting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { dialogRef.current?.focus(); }, []);

  const place = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, round((e.clientX - r.left) / r.width, 3)));
    const y = Math.min(1, Math.max(0, round((e.clientY - r.top) / r.height, 3)));
    const video = videoRef.current;
    onAddPin({ format: preset.id, x, y, timeSec: video ? round(video.currentTime, 1) : null });
    setCommenting(false);
  };

  const media = (url: string | null, n: number | null, main: boolean) => (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 0', minWidth: 0 }}>
      <div style={{ position: 'relative', aspectRatio: `${preset.width} / ${preset.height}`, maxHeight: '70vh', background: 'var(--surface-2)', borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!url && <span className="muted">Nessun output</span>}
        {url && VIDEO.test(url) && <video ref={main ? videoRef : undefined} src={url} controls style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
        {url && !VIDEO.test(url) && <img src={url} alt={`${preset.channel} · ${preset.name}${n ? ` v${n}` : ''}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
        {main && pins.map((p, k) => (
          <span key={k} aria-label={`Commento ${k + 1}`} style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, transform: 'translate(-50%, -100%)', width: 24, height: 24, borderRadius: '50% 50% 50% 0', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 800, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{k + 1}</span>
        ))}
        {main && commenting && (
          <button type="button" aria-label="Clicca sul punto da commentare" onClick={place}
            style={{ position: 'absolute', inset: 0, background: 'transparent', border: '2px dashed var(--accent)', cursor: 'crosshair', borderRadius: 0 }} />
        )}
      </div>
      {n !== null && <figcaption className="muted" style={{ fontSize: 12 }}>v{n}</figcaption>}
    </figure>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label={`${preset.channel} · ${preset.name}`} tabIndex={-1} ref={dialogRef}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50 }}>
      <div className="card stack" style={{ width: 'min(1100px, 100%)', maxHeight: '95vh', overflow: 'auto' }}>
        <div className="row">
          <strong>{preset.channel} · {preset.name}</strong>
          <span className="mono muted">{preset.width}×{preset.height}</span>
          <div style={{ flex: 1 }} />
          <button type="button" aria-pressed={commenting} onClick={() => setCommenting((c) => !c)} disabled={!src}>Aggiungi commento</button>
          <button type="button" onClick={onClose}>Chiudi</button>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'nowrap' }}>
          {compareSrc !== null && media(compareSrc, compareN, false)}
          {media(src, versionN, true)}
        </div>
        {commenting && <p className="muted" style={{ margin: 0 }}>Clicca sul punto da commentare{videoRef.current ? ': il commento usa il tempo corrente del video' : ''}.</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Stub del pannello e pagina**

`packages/web/src/components/ConversationPanel.tsx`:
```tsx
import type { ConversationEntry, CreativeDetail, JobSummary, AgentEvent, Pin, FormatPreset } from '@motion-studio/shared';

export interface ConversationPanelProps {
  slug: string; detail: CreativeDetail; conversation: ConversationEntry[]; presets: FormatPreset[];
  job: JobSummary | undefined; liveEvents: AgentEvent[]; expert: boolean;
  pins: Pin[]; onRemovePin(index: number): void; onSent(): void; onSelectVersion(n: number): void; onChanged(): void;
}

export function ConversationPanel(_: ConversationPanelProps) {
  return <aside className="card" aria-label="Conversazione">Conversazione</aside>;
}
```

`packages/web/src/screens/CreativePage.tsx`:
```tsx
import type { FormatPreset, Pin } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { ConversationPanel } from '../components/ConversationPanel.tsx';
import { FocusView } from '../components/FocusView.tsx';
import { FormatBoard } from '../components/FormatBoard.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { href } from '../routes.ts';
import { useCreative } from '../useCreative.ts';

export function CreativePage({ slug, creative, live, expert }: { slug: string; creative: string; live: EventsState; expert: boolean }) {
  const { detail, conversation, error, reload } = useCreative(slug, creative, live.creativeTicks[`${slug}/${creative}`] ?? 0);
  const [presets, setPresets] = useState<FormatPreset[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [compareN, setCompareN] = useState<number | null>(null);
  const [safeZone, setSafeZone] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => { api.getFormats().then((s) => setPresets(s.presets)).catch(() => {}); }, []);
  const versions = detail?.versions ?? [];
  const latest = versions.at(-1) ?? null;
  // Follow new versions automatically unless the user picked an older one.
  useEffect(() => { setSelected((s) => (s === null || s === (versions.at(-2)?.n ?? null) ? latest?.n ?? null : s)); }, [latest?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const version = versions.find((v) => v.n === selected) ?? latest;
  const compare = compareN !== null ? versions.find((v) => v.n === compareN) ?? null : null;
  const job = useMemo(() => Object.values(live.jobs).find((j) => j.key === detail?.jobKey && (j.state === 'queued' || j.state === 'running'))
    ?? Object.values(live.jobs).filter((j) => j.key === detail?.jobKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [live.jobs, detail?.jobKey]);
  const fileUrl = (n: number, file: string) => api.fileUrl(slug, creative, `outputs/v${n}/${file}`);
  const act = (p: Promise<unknown>) => { setActionError(null); p.then(reload).catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e))); };

  if (error) return <main className="page"><p role="alert" className="error">{error}</p></main>;
  if (!detail) return <main className="page muted">Caricamento…</main>;
  const c = detail.creative;
  const focusPreset = focus ? presets.find((p) => p.id === focus) : undefined;
  const outFor = (v: typeof version, id: string) => v?.outputs.find((o) => o.format === id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 57px)' }}>
      <header className="topbar" style={{ position: 'static' }}>
        <a href={href.project(slug)} className="muted">← Creatività</a>
        <strong>{c.title}</strong>
        <StatusBadge status={c.status} />
        <div style={{ flex: 1 }} />
        {versions.length > 0 && (
          <div role="radiogroup" aria-label="Versione" className="row" style={{ gap: 4 }}>
            {versions.map((v) => (
              <button key={v.n} type="button" role="radio" aria-checked={version?.n === v.n} className={version?.n === v.n ? 'primary' : ''} onClick={() => setSelected(v.n)}>
                v{v.n}{v.status === 'incomplete' ? ' ⚠' : ''}
              </button>
            ))}
          </div>
        )}
        {versions.length > 1 && (
          <label className="row" style={{ gap: 6 }}>Confronta con
            <select value={compareN ?? ''} onChange={(e) => setCompareN(e.target.value ? Number(e.target.value) : null)} style={{ minHeight: 36, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>
              <option value="">—</option>
              {versions.filter((v) => v.n !== version?.n).map((v) => <option key={v.n} value={v.n}>v{v.n}</option>)}
            </select>
          </label>
        )}
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={safeZone} onChange={(e) => setSafeZone(e.target.checked)} style={{ width: 16, height: 16 }} />Safe zone</label>
        {version && <button type="button" onClick={() => act(api.revealVersion(slug, creative, version.n))}>Mostra nella cartella</button>}
        {version && latest && version.n !== latest.n && (
          <button type="button" onClick={() => act(api.restoreVersion(slug, creative, version.n))}>Riparti da v{version.n}</button>
        )}
      </header>
      {c.resumeFrom && <p className="warn" style={{ margin: 12 }}>Il prossimo messaggio riparte dalla versione {c.resumeFrom.version}.</p>}
      {(c.status === 'error' || c.status === 'interrupted') && c.error && <p role="alert" className="error" style={{ margin: 12 }}>{c.error}</p>}
      {version?.status === 'incomplete' && (
        <div className="warn" style={{ margin: 12 }}>
          <strong>v{version.n} incompleta:</strong>
          <ul style={{ margin: '4px 0 0' }}>{version.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {actionError && <p role="alert" className="error" style={{ margin: 12 }}>{actionError}</p>}
      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', minHeight: 0 }}>
        <main className="dots" style={{ flex: '999 1 560px', minWidth: 0, overflow: 'auto' }}>
          <FormatBoard presets={presets} formats={c.brief.formats} version={version ?? null} compare={compare} fileUrl={fileUrl} pins={pins} showSafeZone={safeZone} onOpen={setFocus} />
        </main>
        <div style={{ flex: '1 1 360px', maxWidth: 440, minWidth: 0, display: 'flex' }}>
          <ConversationPanel slug={slug} detail={detail} conversation={conversation} presets={presets} job={job} liveEvents={job ? live.events[job.id] ?? [] : []}
            expert={expert} pins={pins} onRemovePin={(i) => setPins((p) => p.filter((_, k) => k !== i))} onSent={() => setPins([])}
            onSelectVersion={setSelected} onChanged={reload} />
        </div>
      </div>
      {focusPreset && (
        <FocusView preset={focusPreset}
          src={version && outFor(version, focusPreset.id) ? fileUrl(version.n, outFor(version, focusPreset.id)!.file) : null}
          compareSrc={compare ? (outFor(compare, focusPreset.id) ? fileUrl(compare.n, outFor(compare, focusPreset.id)!.file) : '') : null}
          versionN={version?.n ?? null} compareN={compare?.n ?? null}
          pins={pins.filter((p) => p.format === focusPreset.id)}
          onAddPin={(pin) => setPins((p) => [...p, pin])} onClose={() => setFocus(null)} />
      )}
    </div>
  );
}
```

Note: when comparing and the older version has no output for that format, `compareSrc` is `''` so the left column still renders "Nessun output".

Append to `packages/web/src/theme.css`:
```css
.topbar select { padding: 0 8px; }
```

- [ ] **Step 6: Verifica**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): creative page with format board, focus view, pins and versions"
```

---

### Task 13: Web — Pannello conversazione (Conversazione / Brief / Esperto)

**Files:**
- Modify: `packages/web/src/components/ConversationPanel.tsx` (replace stub), `packages/web/src/components/AgentConsole.tsx` (export `ExpertLine`)
- Create: `packages/web/test/ConversationPanel.test.tsx`

**Interfaces:**
- Consumes: `ConversationPanelProps` (declared in Task 12); `api.sendCreativeTurn`, `api.updateCreative`, `api.cancelJob` (Task 10); `FormatPicker` (Task 11); `ExpertLine` (Fase 1, now exported).
- Produces: `<ConversationPanel … />` with:
  - tabs `Conversazione`, `Brief`, and `Esperto` only when `expert`;
  - **Conversazione**: entries in order — `user` (bubble with text and pin chips `k · <format>[ @ t s]`), `agent` `text` events (assistant bubbles; other agent events hidden), `version` (card `v<n> · Pronta|Incompleta` with button `Vedi v<n>` → `onSelectVersion(n)`), `system` (muted line; `level: 'error'` in `.error` with `role="alert"`). Persisted `agent` entries of the active job are skipped and its `liveEvents` are shown instead (no duplicates). While `job` is queued/running: progress card "In lavorazione" with the last 5 tool steps (`Usa lo strumento <name>`) and button `Annulla` → `api.cancelJob(job.id)`.
  - Composer: pending pin chips with `Rimuovi commento <k>` buttons → `onRemovePin(k-1)`; textarea labelled `Chiedi una modifica`; `Invia` → `api.sendCreativeTurn(slug, detail.slug, { text, pins })`, then clears text, calls `onSent()` and `onChanged()`. Disabled while a job is active, or when text is empty and there are no pins. When the creative has no versions, an extra `Genera` button sends `{}`.
  - **Brief**: editable titolo, obiettivo, messaggio, durata (number, empty = nessuna), asset (comma separated), note, formati (`FormatPicker`); `Salva` → `api.updateCreative`; `Salva e rigenera` → `updateCreative` then `sendCreativeTurn({})`; both disabled while a job is active; errors in `role="alert"`; afterwards `onChanged()`.
  - **Esperto**: every agent event (persisted + live) rendered with `ExpertLine` in monospace.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/ConversationPanel.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS, type ConversationEntry, type CreativeDetail, type JobSummary } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  sendCreativeTurn: vi.fn(async () => ({})),
  updateCreative: vi.fn(async () => ({})),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ConversationPanel } = await import('../src/components/ConversationPanel.tsx');

const at = '2026-10-07T10:00:00.000Z';
const detail = (versions = 1): CreativeDetail => ({
  slug: 'c1', jobKey: 'creative:k',
  creative: { schemaVersion: 1, title: 'Lancio', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null,
    brief: { goal: 'Lancio app', message: '', formats: ['instagram-post-1x1'], durationSec: 15, assets: [], notes: '' } },
  versions: Array.from({ length: versions }, (_, i) => ({ n: i + 1, commit: 'c', sessionId: 's', status: 'complete' as const, createdAt: at, request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null })),
});
const conversation: ConversationEntry[] = [
  { type: 'user', at, text: 'Logo più grande', pins: [{ format: 'instagram-post-1x1', x: 0.5, y: 0.5, timeSec: 2 }], attachments: [] },
  { type: 'agent', at, jobId: 'old', event: { kind: 'text', text: 'Ingrandisco il logo.' } },
  { type: 'agent', at, jobId: 'old', event: { kind: 'tool_use', id: 't', name: 'Write', input: {} } },
  { type: 'version', at, n: 1, status: 'complete' },
  { type: 'system', at, level: 'error', text: 'Generazione non riuscita: boom' },
];
const running: JobSummary = { id: 'j1', key: 'creative:k', label: 'x', state: 'running', createdAt: at };
const base = {
  slug: 'acme', presets: DEFAULT_FORMATS, liveEvents: [], expert: false, pins: [],
  onRemovePin: vi.fn(), onSent: vi.fn(), onSelectVersion: vi.fn(), onChanged: vi.fn(),
};

beforeEach(() => { vi.clearAllMocks(); });

describe('ConversationPanel', () => {
  it('renders the history and selects versions', async () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={conversation} job={undefined} />);
    expect(screen.getByText('Logo più grande')).toBeTruthy();
    expect(screen.getByText('1 · instagram-post-1x1 @ 2.0s')).toBeTruthy();
    expect(screen.getByText('Ingrandisco il logo.')).toBeTruthy();
    expect(screen.queryByText(/Usa lo strumento Write/)).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('boom');
    await userEvent.click(screen.getByRole('button', { name: 'Vedi v1' }));
    expect(base.onSelectVersion).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('tab', { name: 'Esperto' })).toBeNull();
  });
  it('sends a message with pending pins', async () => {
    const pins = [{ format: 'instagram-post-1x1', x: 0.1, y: 0.2, timeSec: null }];
    render(<ConversationPanel {...base} pins={pins} detail={detail()} conversation={[]} job={undefined} />);
    await userEvent.type(screen.getByLabelText('Chiedi una modifica'), 'Più contrasto');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', { text: 'Più contrasto', pins }));
    expect(base.onSent).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi commento 1' }));
    expect(base.onRemovePin).toHaveBeenCalledWith(0);
  });
  it('shows live progress, cancels and blocks sending while a job runs', async () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={[{ type: 'agent', at, jobId: 'j1', event: { kind: 'text', text: 'persistito' } }]}
      job={running} liveEvents={[{ kind: 'text', text: 'dal vivo' }, { kind: 'tool_use', id: 't', name: 'Bash', input: {} }]} />);
    expect(screen.getByText('dal vivo')).toBeTruthy();
    expect(screen.queryByText('persistito')).toBeNull();
    expect(screen.getByText('Usa lo strumento Bash')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Invia' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(api.cancelJob).toHaveBeenCalledWith('j1');
  });
  it('offers "Genera" when there are no versions', async () => {
    render(<ConversationPanel {...base} detail={detail(0)} conversation={[]} job={undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Genera' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', {}));
  });
  it('edits the brief and regenerates', async () => {
    render(<ConversationPanel {...base} detail={detail()} conversation={[]} job={undefined} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Brief' }));
    const goal = screen.getByLabelText('Obiettivo');
    await userEvent.clear(goal);
    await userEvent.type(goal, 'Nuovo obiettivo');
    await userEvent.click(screen.getByRole('button', { name: 'Salva e rigenera' }));
    await waitFor(() => expect(api.sendCreativeTurn).toHaveBeenCalledWith('acme', 'c1', {}));
    expect(api.updateCreative).toHaveBeenCalledWith('acme', 'c1', { title: 'Lancio', brief: expect.objectContaining({ goal: 'Nuovo obiettivo', formats: ['instagram-post-1x1'] }) });
    expect(base.onChanged).toHaveBeenCalled();
  });
  it('shows every agent event in the expert tab', async () => {
    render(<ConversationPanel {...base} expert detail={detail()} conversation={conversation} job={undefined} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Esperto' }));
    expect(screen.getByText('tool Write')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web/test/ConversationPanel.test.tsx`
Expected: FAIL (stub).

- [ ] **Step 3: Esporta `ExpertLine`**

In `packages/web/src/components/AgentConsole.tsx` change `function ExpertLine` to `export function ExpertLine`. Its `tool_use` tag renders `tool <name>` (as in Fase 1), which the expert test relies on.

- [ ] **Step 4: Implementa `ConversationPanel.tsx`**

```tsx
import type { AgentEvent, Brief, ConversationEntry, CreativeDetail, FormatPreset, JobSummary, Pin } from '@motion-studio/shared';
import { useState } from 'react';
import { api } from '../api.ts';
import { ExpertLine } from './AgentConsole.tsx';
import { FormatPicker } from './FormatPicker.tsx';

export interface ConversationPanelProps {
  slug: string; detail: CreativeDetail; conversation: ConversationEntry[]; presets: FormatPreset[];
  job: JobSummary | undefined; liveEvents: AgentEvent[]; expert: boolean;
  pins: Pin[]; onRemovePin(index: number): void; onSent(): void; onSelectVersion(n: number): void; onChanged(): void;
}

type Tab = 'chat' | 'brief' | 'expert';
const pinLabel = (p: Pin, k: number) => `${k + 1} · ${p.format}${p.timeSec !== null ? ` @ ${p.timeSec.toFixed(1)}s` : ''}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function BriefEditor({ slug, detail, presets, disabled, onChanged }: { slug: string; detail: CreativeDetail; presets: FormatPreset[]; disabled: boolean; onChanged(): void }) {
  const c = detail.creative;
  const [title, setTitle] = useState(c.title);
  const [brief, setBrief] = useState<Brief>(c.brief);
  const [assets, setAssets] = useState(c.brief.assets.join(', '));
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const save = async (regenerate: boolean) => {
    setError(null);
    try {
      await api.updateCreative(slug, detail.slug, { title, brief: { ...brief, assets: assets.split(',').map((a) => a.trim()).filter(Boolean) } });
      if (regenerate) await api.sendCreativeTurn(slug, detail.slug, {});
      onChanged();
    } catch (e) { setError(message(e)); }
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(false); }} style={{ padding: 14, overflow: 'auto' }}>
      <label htmlFor="b-title">Titolo</label><input id="b-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="b-goal">Obiettivo</label><textarea id="b-goal" rows={3} value={brief.goal} onChange={(e) => set('goal', e.target.value)} />
      <label htmlFor="b-msg">Messaggio chiave</label><input id="b-msg" value={brief.message} onChange={(e) => set('message', e.target.value)} />
      <label htmlFor="b-dur">Durata (secondi, vuoto = nessuna)</label>
      <input id="b-dur" type="number" min={1} max={600} value={brief.durationSec ?? ''} onChange={(e) => set('durationSec', e.target.value ? Number(e.target.value) : null)} />
      <label htmlFor="b-assets">Asset (separati da virgola)</label><input id="b-assets" value={assets} onChange={(e) => setAssets(e.target.value)} />
      <label htmlFor="b-notes">Note</label><input id="b-notes" value={brief.notes} onChange={(e) => set('notes', e.target.value)} />
      <strong>Formati</strong>
      <FormatPicker presets={presets} selected={brief.formats} onToggle={(id) => set('formats', brief.formats.includes(id) ? brief.formats.filter((x) => x !== id) : [...brief.formats, id])} />
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <button type="submit" disabled={disabled}>Salva</button>
        <button type="button" className="primary" disabled={disabled} onClick={() => void save(true)}>Salva e rigenera</button>
      </div>
    </form>
  );
}

export function ConversationPanel(props: ConversationPanelProps) {
  const { slug, detail, conversation, job, liveEvents, expert, pins } = props;
  const [tab, setTab] = useState<Tab>('chat');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const active = job && (job.state === 'queued' || job.state === 'running') ? job : undefined;
  const persistedAgent = (e: ConversationEntry) => e.type === 'agent' && e.jobId !== active?.id;

  const send = async (body: { text?: string; pins?: Pin[] }) => {
    setError(null);
    try {
      await api.sendCreativeTurn(slug, detail.slug, body);
      setText('');
      props.onSent();
      props.onChanged();
    } catch (e) { setError(message(e)); }
  };

  const tabs: Array<[Tab, string]> = [['chat', 'Conversazione'], ['brief', 'Brief'], ...(expert ? [['expert', 'Esperto'] as [Tab, string]] : [])];
  const allAgentEvents = [
    ...conversation.filter((e): e is Extract<ConversationEntry, { type: 'agent' }> => persistedAgent(e)).map((e) => e.event),
    ...(active ? liveEvents : []),
  ];

  return (
    <aside aria-label="Conversazione" style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderLeft: '1px solid var(--border)', minHeight: 0 }}>
      <div role="tablist" aria-label="Pannello" className="tabs" style={{ padding: '0 10px' }}>
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>

      {tab === 'chat' && (
        <div className="stack" style={{ flex: 1, overflow: 'auto', padding: 14, gap: 10 }}>
          {conversation.map((e, i) => {
            if (e.type === 'user') return (
              <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '88%', padding: '10px 12px', borderRadius: '14px 14px 4px 14px', background: 'var(--text)', color: 'var(--bg)' }}>
                {e.pins.length > 0 && <div className="row" style={{ gap: 4, marginBottom: 6 }}>{e.pins.map((p, k) => <span key={k} className="badge run">{pinLabel(p, k)}</span>)}</div>}
                <span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span>
              </div>
            );
            if (e.type === 'agent') return persistedAgent(e) && e.event.kind === 'text'
              ? <p key={i} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.event.text}</p> : null;
            if (e.type === 'version') return (
              <div key={i} className="card row" style={{ padding: 10, background: 'var(--surface-2)' }}>
                <span className={`badge ${e.status === 'complete' ? 'ok' : 'warn-badge'}`}>v{e.n} · {e.status === 'complete' ? 'Pronta' : 'Incompleta'}</span>
                <div style={{ flex: 1 }} />
                <button type="button" onClick={() => props.onSelectVersion(e.n)}>Vedi v{e.n}</button>
              </div>
            );
            return e.level === 'error'
              ? <p key={i} role="alert" className="error" style={{ margin: 0 }}>{e.text}</p>
              : <p key={i} className="muted" style={{ margin: 0, fontSize: 13 }}>{e.text}</p>;
          })}
          {active && (
            <div className="card stack" style={{ padding: 12, gap: 6, background: 'var(--surface-2)' }}>
              <div className="row"><span className="badge run">In lavorazione</span><div style={{ flex: 1 }} /><button type="button" onClick={() => void api.cancelJob(active.id).catch((e: unknown) => setError(message(e)))}>Annulla</button></div>
              {liveEvents.filter((e) => e.kind === 'text').map((e, k) => <p key={k} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.kind === 'text' ? e.text : ''}</p>)}
              {liveEvents.filter((e) => e.kind === 'tool_use').slice(-5).map((e, k) => <span key={k} className="muted" style={{ fontSize: 13 }}>Usa lo strumento {e.kind === 'tool_use' ? e.name : ''}</span>)}
            </div>
          )}
        </div>
      )}

      {tab === 'brief' && <BriefEditor slug={slug} detail={detail} presets={props.presets} disabled={Boolean(active)} onChanged={props.onChanged} />}

      {tab === 'expert' && (
        <div className="mono stack" style={{ flex: 1, overflow: 'auto', padding: 14, gap: 4 }}>
          {allAgentEvents.map((e, i) => <ExpertLine key={i} e={e} />)}
        </div>
      )}

      {tab === 'chat' && (
        <form className="stack" style={{ padding: 12, borderTop: '1px solid var(--border)', gap: 8 }} onSubmit={(e) => { e.preventDefault(); void send({ text: text.trim(), pins }); }}>
          {pins.length > 0 && (
            <div className="row" style={{ gap: 4 }}>
              {pins.map((p, k) => (
                <span key={k} className="badge run row" style={{ gap: 4 }}>{pinLabel(p, k)}
                  <button type="button" aria-label={`Rimuovi commento ${k + 1}`} onClick={() => props.onRemovePin(k)} style={{ minHeight: 20, padding: '0 6px', border: 0, background: 'transparent' }}>×</button>
                </span>
              ))}
            </div>
          )}
          <label htmlFor="cp-text" className="muted" style={{ fontSize: 12 }}>Chiedi una modifica</label>
          <textarea id="cp-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Es. rallenta il finale e alza la CTA nel 9:16" />
          {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
          <div className="row">
            {detail.versions.length === 0 && <button type="button" disabled={Boolean(active)} onClick={() => void send({})}>Genera</button>}
            <div style={{ flex: 1 }} />
            <button type="submit" className="primary" disabled={Boolean(active) || (!text.trim() && pins.length === 0)}>Invia</button>
          </div>
        </form>
      )}
    </aside>
  );
}
```

Note: the "renders the history" test expects a single `role="alert"`: the system error line. Keep the composer's error alert conditional (it is, `error` starts `null`).

- [ ] **Step 5: Verifica**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): conversation panel with live progress, pins, brief editing and expert log"
```

---

### Task 14: README e verifica end-to-end (finto e reale)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

In `README.md` replace the status line with `> Stato: fase 2 (creatività). Vedi \`docs/superpowers/specs/\` per il design completo.` and add after "Avvio":
```markdown
## Come funziona una creatività
1. In un progetto apri **Creatività → + Nuova creatività**, descrivi cosa vuoi, scegli canali e formati e premi **Genera**.
2. L'agente lavora in `creatives/<data-titolo>/work/` e consegna in `outputs/vN/` un file per formato più `manifest.json`.
3. Motion Studio controlla gli output (presenza, risoluzione, durata; con ffmpeg/ffprobe installati li verifica davvero): se qualcosa non torna chiede all'agente di correggere, fino a 3 tentativi; poi salva la versione, anche se incompleta.
4. Ogni versione è un commit git del progetto. Dalla pagina della creatività puoi aprire un formato, aggiungere commenti su un punto/istante, chiedere modifiche, confrontare versioni e ripartire da una versione precedente.

Limiti attuali: brand kit, asset e codebase collegate arrivano nella fase 3; approvazioni dalla UI, tool MCP e rigenerazione automatica col comando del manifest nella fase 4; app desktop ed export in cartella scelta nella fase 5.
```

- [ ] **Step 2: Controlli automatici**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: tutto verde.

- [ ] **Step 3: Smoke con il finto `claude`**

```bash
MOTION_STUDIO_CONFIG_DIR="$(mktemp -d)" FAKE_CLAUDE_SCENARIO=render \
MOTION_STUDIO_CLAUDE_COMMAND="[\"node\",\"$PWD/packages/core/test/fixtures/fake-claude.mjs\"]" \
node apps/cli/dist/main.js --port 4399 --no-open
```
In un altro terminale:
```bash
B=localhost:4399/api
curl -s -X PUT $B/workspace -H 'content-type: application/json' -d "{\"path\":\"$(mktemp -d)/ws prova\"}" >/dev/null
curl -s -X POST $B/projects -H 'content-type: application/json' -d '{"name":"Acme"}' >/dev/null
curl -s -X POST $B/projects/acme/creatives -H 'content-type: application/json' \
  -d '{"title":"Lancio","generate":true,"brief":{"goal":"Lancio app","message":"","formats":["instagram-post-1x1","web-banner-300x250"],"durationSec":6,"assets":[],"notes":""}}'
sleep 3; curl -s $B/projects/acme/creatives
```
Expected: la creatività risulta `ready` con `versions: 1`.

- [ ] **Step 4: Verifica con il vero Claude Code**

Avvia `MOTION_STUDIO_CONFIG_DIR="$(mktemp -d)" node apps/cli/dist/main.js --port 4398 --no-open` e, via curl:
1. workspace temporaneo, progetto "Prova Motion";
2. creatività con formati `web-banner-300x250` (immagine) e `instagram-post-1x1` (video), `durationSec: 6`, `generate: true`, obiettivo "Banner e breve animazione per il lancio di un'app di prenotazioni: sfondo blu, testo bianco 'Prenota in 3 tap'";
3. attendi la fine del job (`/api/jobs`), poi `GET …/creatives/<slug>`: versione 1 `complete` (o `incomplete` con problemi espliciti), output presenti, `preview` del video valorizzata se ffmpeg è installato;
4. `GET …/files/outputs/v1/<file>` restituisce 200 per entrambi;
5. turno di iterazione `{"text":"Rendi il testo più grande","pins":[{"format":"instagram-post-1x1","x":0.5,"y":0.5,"timeSec":2}]}` → v2, con `basedOn: 1` e stesso `sessionId` di v1;
6. `POST …/versions/1/restore` e un nuovo turno → v3 con `basedOn: 1` e `sessionId` diverso (fork);
7. annota tempi, esiti, eventuali problemi di validazione e differenze di comportamento rispetto al finto `claude`.
I controlli visivi nel browser (tavola, vista focus, pin, confronto, temi) restano all'utente.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: describe creatives workflow and phase 2 limits"
```
