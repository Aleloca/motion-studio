# Motion Studio — Fase 3: Brand, asset e codebase collegate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ogni progetto ha un brand kit strutturato (palette, font, loghi, tono, do/don't, stile fotografico; ogni voce con la sua fonte) più `guidelines.md` libero; l'utente aggiunge siti web e immagini di riferimento e lancia un'**analisi brand** con l'agente, che propone modifiche (approvabili voce per voce) e scarica gli asset trovati; gestisce asset e riferimenti (upload, metadati, descrizione con l'agente); collega cartelle codebase in **sola lettura** a livello di progetto e di creatività. Le creatività usano automaticamente brand kit, linee guida, asset e codebase collegate.

**Architecture:** Si estende la Fase 2. `packages/shared` aggiunge gli schemi di brand, sorgenti, proposte, asset e riferimenti. `packages/core` aggiunge `BrandStore` (+ `diffBrandKits`/`applyBrandChanges`), `LibraryStore` (asset e riferimenti), upload multipart, `readOnlyRules` + `codebaseSnapshot` per le codebase collegate (passate con `--add-dir` e regole `--disallowedTools Edit(//path/**)`, verificate dal vivo su claude 2.1.292), `BrandAnalysisService` e `AssetDescribeService` (job sulla `JobQueue` esistente), e le route. `packages/web` aggiunge le schede di progetto Brand, Asset, Riferimenti, Impostazioni.

**Tech Stack:** come Fase 2. Nuovo: `@fastify/multipart` (upload).

**Spec:** `docs/superpowers/specs/2026-10-07-motion-studio-design.md` (§3 struttura, §6.1 analisi brand, §6.3 permessi, §8.2 contenuti UI). Base: branch `feat/phase2-creatives` (Fase 2 completata).

## Global Constraints

- Tutti i vincoli delle Fasi 1–2 restano validi (tutto locale, `schemaVersion: 1`, mai sovrascrivere JSON non validi, git serializzato per progetto, loopback-only, file serviti con CSP sandbox + nosniff e confinati, token CSS, copy in italiano, `AgentRunner` neutro, `AGENT_ALLOWED_TOOLS` solo nei turni agente di creatività/analisi/descrizione).
- File del progetto (spec §3): `brand/brand-kit.json`, `brand/guidelines.md`, `brand/sources.json`, `brand/proposals/<id>/…`, `assets/` + `assets/assets.json`, `references/` + `references/references.json`.
- **Ogni voce del brand kit ha una fonte** (`manual`, `website` con URL, `image` con file). Un'analisi **non sovrascrive mai** il kit: produce una proposta; l'utente applica solo le modifiche accettate; le voci manuali non vengono mai proposte per la rimozione.
- Gli asset scaricati dai siti finiscono in `assets/` con `origin: 'website'` e `sourceUrl`.
- Codebase collegate: percorsi assoluti esistenti, **mai copiate**, in sola lettura: `--add-dir <path>` + `--disallowedTools Edit(/<path>/**)` per ogni cartella (con path assoluto la regola diventa `Edit(//abs/path/**)`); il prompt le dichiara in sola lettura con la nota; dopo il turno, se la cartella è un repo git e `git status --porcelain` è cambiato, la conversazione riporta un avviso. Cartella mancante → avviso nel prompt e nella conversazione, il turno parte senza.
- Limiti upload: 200 MB per file, 50 file per richiesta; nomi file ripuliti (niente separatori, niente `..`), collisioni risolte con `-2`, `-3`…
- Gli strumenti aggiuntivi dell'analisi brand sono `WebFetch` e `Bash(curl:*)` oltre ad `AGENT_ALLOWED_TOOLS` (spec §6.1: fetch del sito, download asset).
- Fuori scope (README): provider MCP Google Fonts/stock/gpt-image-2 e screenshot via MCP (Fase 4), approvazioni dalla UI (Fase 4), dialog nativo per scegliere cartelle (Fase 5: in Fase 3 il percorso si incolla).

## Review Focus

1. **Proposta dell'agente malformata o parziale** (brand-kit proposto non valido, colori con hex sbagliati, file di logo inesistente, assets.json assente): l'analisi non rompe il kit esistente; la proposta viene scartata con un errore leggibile in UI (job `failed`) oppure, se valida, include solo voci valide. → test in Task 3 e Task 8.
2. **Codebase collegata scrivibile per errore**: ogni turno con codebase collegate ha la regola deny per ciascuna; percorsi con spazi/accenti; cartella mancante non fa fallire il turno. → test in Task 6 e Task 7.
3. **Upload ostili** (nome `../../x`, nome vuoto, file enorme, tanti file, symlink già presente con lo stesso nome): nessuna scrittura fuori da `assets/`/`references/`, errore 400/413 chiaro. → test in Task 5.
4. **Modifiche manuali preservate**: applicare una proposta tocca solo le voci accettate; una voce `manual` non viene mai rimossa da una proposta; `guidelines.md` cambia solo se l'utente lo sceglie. → test in Task 3 e Task 9.
5. **File di metadati corrotti** (`brand-kit.json`, `assets.json`, `references.json` modificati a mano): le pagine mostrano l'errore senza perdere i file, nessuna riscrittura automatica; upload/modifiche rifiutati con 422 finché il file non viene sistemato. → test in Task 3, Task 4 e Task 9.

---

## File Structure

```
packages/shared/src/
  brand.ts              # brandKitSchema, brandSourceSchema, brandChangeSchema, brandProposalSchema
  library.ts            # assetEntrySchema, assetsFileSchema, referenceEntrySchema, referencesFileSchema
  creative.ts           # (modify) creative.linkedCodebases
  events.ts             # (modify) ServerMessage 'brand' | 'library'
packages/core/src/
  brand/brand-store.ts  # kit, guidelines, sources, proposals (file I/O)
  brand/brand-diff.ts   # diffBrandKits, applyBrandChanges
  brand/brand-analysis.ts   # BrandAnalysisService (job)
  brand/brand-prompt.ts     # buildBrandPrompt, buildDescribePrompt
  library/library-store.ts  # asset e riferimenti
  library/describe.ts       # AssetDescribeService (job)
  library/upload.ts         # salvataggio file caricati
  codebases.ts              # validateCodebases, readOnlyRules, codebaseSnapshot
  server/serve-file.ts      # sendConfinedFile (estratto dalla route dei file creatività)
  server/brand-routes.ts  server/library-routes.ts  server/project-routes.ts
  agent/runner.ts             # (modify) disallowedTools, BRAND_ALLOWED_TOOLS
  agent/claude-code-runner.ts # (modify) --disallowedTools
  creatives/creative-turns.ts # (modify) commit metadati, codebase, contesto brand
  creatives/prompt.ts         # (modify) sezione brand + codebase
  project-template.ts         # (modify) CONTEXT_MD sezione brand
  workspace-store.ts          # (modify) updateProject
packages/web/src/
  routes.ts api.ts eventsReducer.ts   # (modify)
  screens/ProjectPage.tsx             # (modify) schede
  screens/BrandPage.tsx  screens/AssetsPage.tsx  screens/ReferencesPage.tsx  screens/ProjectSettings.tsx
  components/ProposalReview.tsx  components/UploadZone.tsx  components/CodebaseList.tsx  components/SourceBadge.tsx
```

---

### Task 1: Residui della Fase 2 (commit dei metadati, selezione versione)

**Files:**
- Modify: `packages/core/src/creatives/creative-turns.ts`, `packages/core/test/creative-turns.test.ts`, `packages/web/src/screens/CreativePage.tsx`, `packages/web/test/` (new `CreativePage.userPicked.test.tsx`)

**Interfaces:**
- Produces: after a version is saved (and after `updateBrief` and `restore`), the project working tree is clean: a follow-up commit `"<title>: v<n> · stato"` (resp. `"<title>: brief aggiornato"`, `"<title>: ripartenza da v<n>"`) includes `creative.json`, `versions.json`, `conversation.jsonl` (`commitAll` returns `null` and creates nothing when there is nothing to commit). The version's `commit` field keeps pointing at the work commit (restore unchanged).
- Web: `CreativePage` resets `userPicked` to `false` when a message is sent (`onSent`), so the next version is selected automatically.

- [ ] **Step 1: Test che falliscono**

Append to `packages/core/test/creative-turns.test.ts`:
```ts
  it('leaves the project tree clean after a version, a brief edit and a restore', async () => {
    const clean = async () => (await execCommand('git', ['status', '--porcelain'], { cwd: ref.projectDir })).stdout.trim();
    await finalState((await service.start(ref)).id);
    expect(await clean()).toBe('');
    const log = (await execCommand('git', ['log', '--format=%s'], { cwd: ref.projectDir })).stdout.trim().split('\n');
    expect(log.slice(0, 2)).toEqual(['Lancio: v1 · stato', 'Lancio: v1']);
    const [v1] = await store.readVersions(ref.creativeSlug);
    const workCommit = (await execCommand('git', ['rev-parse', 'HEAD~1'], { cwd: ref.projectDir })).stdout.trim();
    expect(v1!.commit).toBe(workCommit);
    await service.updateBrief(ref, { title: 'Lancio 2' });
    expect(await clean()).toBe('');
    await finalState((await service.start(ref, { text: 'x', pins: [] })).id);
    await service.restore(ref, 1);
    expect(await clean()).toBe('');
  });
```

`packages/web/test/CreativePage.userPicked.test.tsx`:
```tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FORMATS } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';

const at = '2026-10-07T10:00:00.000Z';
const version = (n: number) => ({ n, commit: 'c', sessionId: 's', status: 'complete', createdAt: at, request: 'r', outputs: [], problems: [], tools: [], renderCommand: null, basedOn: null });
let versions = [version(1), version(2)];
vi.mock('../src/api.ts', () => ({
  api: {
    getFormats: async () => ({ presets: DEFAULT_FORMATS, error: null, path: '/x' }),
    getCreative: async () => ({ slug: 'c1', jobKey: 'k', versions, creative: { schemaVersion: 1, title: 'T', status: 'ready', error: null, createdAt: at, updatedAt: at, resumeFrom: null, linkedCodebases: [], brief: { goal: 'g', message: '', formats: ['instagram-post-1x1'], durationSec: 6, assets: [], notes: '' } } }),
    getConversation: async () => [],
    sendCreativeTurn: vi.fn(async () => ({})),
    fileUrl: () => '/f',
  },
  ApiError: class extends Error {},
}));
const { CreativePage } = await import('../src/screens/CreativePage.tsx');

describe('CreativePage version selection', () => {
  it('follows new versions again after the user sends a message', async () => {
    const live = { jobs: {}, events: {}, creativeTicks: {} as Record<string, number> };
    const { rerender } = render(<CreativePage slug="acme" creative="c1" live={live} expert={false} />);
    await waitFor(() => screen.getByRole('radio', { name: 'v2' }));
    await userEvent.click(screen.getByRole('radio', { name: 'v1' }));
    await userEvent.type(screen.getByLabelText('Chiedi una modifica'), 'ciao');
    await userEvent.click(screen.getByRole('button', { name: 'Invia' }));
    versions = [version(1), version(2), version(3)];
    await act(async () => { rerender(<CreativePage slug="acme" creative="c1" live={{ ...live, creativeTicks: { 'acme/c1': 1 } }} expert={false} />); });
    await waitFor(() => expect(screen.getByRole('radio', { name: 'v3' }).getAttribute('aria-checked')).toBe('true'));
  });
});
```
(The creative mock already includes `linkedCodebases: []`, added in Task 2; until then the extra field is ignored by TypeScript-free mock objects.)

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/creative-turns.test.ts packages/web/test/CreativePage.userPicked.test.tsx`
Expected: FAIL (tree dirty; v1 still selected).

- [ ] **Step 3: Implementa**

In `packages/core/src/creatives/creative-turns.ts`:
1. In `run()`, right after `await store.update(slug, { status: …, resumeFrom: null });` (and after the optional late-abort message), add:
```ts
      await this.deps.git.commitAll(ref.projectDir, `${creative.title}: v${n} · stato`);
```
2. In `updateBrief`, after `store.update(...)` (keep its result), add `await this.deps.git.commitAll(ref.projectDir, \`${updated.title}: brief aggiornato\`);` and return `updated`.
3. In `restoreLocked`, after the two `appendConversation` calls, add `await this.deps.git.commitAll(ref.projectDir, \`${updated.title}: ripartenza da v${n}\`);`.
4. In `cancelled()` and in the error branch of `run()`, after writing the status, add `await this.deps.git.commitAll(ref.projectDir, \`${title}: stato\`).catch(() => null);` where `title` is the creative title read at the start (`before.title` passed down, or `(await store.get(slug)).title` inside a `.catch`).

In `packages/web/src/screens/CreativePage.tsx`, pass to `ConversationPanel`:
```tsx
onSent={() => { setPins([]); setUserPicked(false); }}
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core packages/web && pnpm typecheck`
Expected: tutti PASS (aggiorna eventuali test di Fase 2 che contavano i commit, ad es. `git log -1` → ora è il commit "· stato": usa `--format=%s` su `HEAD~1` dove serve il commit della versione).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: commit creative metadata after each change and follow new versions after sending"
```

---

### Task 2: Schemi di brand, libreria e codebase della creatività (shared)

**Files:**
- Create: `packages/shared/src/brand.ts`, `packages/shared/src/library.ts`, `packages/shared/test/brand.test.ts`, `packages/shared/test/library.test.ts`
- Modify: `packages/shared/src/creative.ts`, `packages/shared/src/events.ts`, `packages/shared/src/index.ts`, `packages/web/src/eventsReducer.ts`

**Interfaces:**
- Produces (`brand.ts`):
  ```ts
  export type SourceKind = 'manual' | 'website' | 'image';
  export interface SourceRef { kind: SourceKind; ref: string | null }        // url for website, project-relative file for image, null for manual
  export interface BrandColor { id: string; name: string; hex: string; role: 'primary'|'secondary'|'accent'|'background'|'text'|'other'; source: SourceRef }
  export interface BrandFont { id: string; family: string; role: 'heading'|'body'|'accent'|'other'; weights: number[]; file: string | null; source: SourceRef }
  export interface BrandLogo { id: string; file: string; variant: 'primary'|'secondary'|'mono'|'icon'|'other'; background: 'light'|'dark'|'any'; source: SourceRef }
  export interface BrandNote { id: string; text: string; source: SourceRef }
  export interface BrandKit { schemaVersion: 1; colors: BrandColor[]; fonts: BrandFont[]; logos: BrandLogo[]; tone: BrandNote | null; dos: BrandNote[]; donts: BrandNote[]; photoStyle: BrandNote | null }
  export const EMPTY_BRAND_KIT: BrandKit;
  export interface BrandSource { id: string; kind: 'website' | 'image'; url: string | null; file: string | null; addedAt: string; lastAnalyzedAt: string | null }
  export interface BrandSourcesFile { schemaVersion: 1; sources: BrandSource[] }
  export type BrandField = 'colors' | 'fonts' | 'logos' | 'dos' | 'donts' | 'tone' | 'photoStyle';
  export interface BrandChange { id: string; field: BrandField; op: 'add' | 'update' | 'remove'; itemId: string | null; before: unknown; after: unknown }
  export interface BrandProposal { schemaVersion: 1; id: string; createdAt: string; sourceIds: string[]; status: 'open' | 'applied' | 'discarded';
    summary: string; changes: BrandChange[]; guidelines: { current: string; proposed: string } | null; assetsAdded: string[] }
  // zod: sourceRefSchema, brandKitSchema, brandSourceSchema, brandSourcesFileSchema, brandChangeSchema, brandProposalSchema
  ```
  Ids: `/^[a-z0-9][a-z0-9-]{0,62}$/`. `hex`: `/^#[0-9a-fA-F]{6}$/` (normalized to upper case by the schema). Files (`logo.file`, `font.file`, `source.ref` for images): project-relative, no leading `/`, no `..` segment, no backslash. Website URLs: `http:` or `https:` only.
- Produces (`library.ts`):
  ```ts
  export type AssetKind = 'image' | 'video' | 'svg' | 'font' | 'audio' | 'other';
  export type AssetOrigin = 'upload' | 'website' | 'generated' | 'stock';
  export interface AssetEntry { file: string; kind: AssetKind; origin: AssetOrigin; sourceUrl: string | null; description: string; tags: string[]; width: number | null; height: number | null; addedAt: string }
  export interface AssetsFile { schemaVersion: 1; assets: AssetEntry[] }        // file relative to assets/, may contain sub-folders
  export interface ReferenceEntry { file: string; note: string; useForBrand: boolean; addedAt: string }
  export interface ReferencesFile { schemaVersion: 1; references: ReferenceEntry[] } // file relative to references/
  export function assetKindOf(file: string): AssetKind;  // by extension
  export const relativeFileSchema: z.ZodString;          // shared path rule above
  // zod: assetEntrySchema, assetsFileSchema, referenceEntrySchema, referencesFileSchema
  ```
- Modifies: `creativeFileSchema` gains `linkedCodebases: z.array(linkedCodebaseSchema).default([])`; `ServerMessage` gains `| { type: 'brand'; project: string } | { type: 'library'; project: string }`; web `EventsState` gains `projectTicks: Record<string, number>` incremented (key = project slug) on `brand` and `library` messages.

- [ ] **Step 1: Test che falliscono**

`packages/shared/test/brand.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { brandKitSchema, brandSourceSchema, EMPTY_BRAND_KIT } from '../src/index.ts';

const manual = { kind: 'manual', ref: null } as const;

describe('brandKitSchema', () => {
  it('fills defaults and normalizes hex to upper case', () => {
    expect(brandKitSchema.parse({ schemaVersion: 1 })).toEqual(EMPTY_BRAND_KIT);
    const kit = brandKitSchema.parse({ schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1e3a5f', role: 'primary', source: manual }] });
    expect(kit.colors[0]!.hex).toBe('#1E3A5F');
  });
  it('rejects bad hex, duplicate ids and unsafe files', () => {
    const c = { id: 'a', name: 'A', hex: '#123456', role: 'other', source: manual };
    expect(brandKitSchema.safeParse({ schemaVersion: 1, colors: [{ ...c, hex: 'blue' }] }).success).toBe(false);
    expect(brandKitSchema.safeParse({ schemaVersion: 1, colors: [c, c] }).success).toBe(false);
    const logo = { id: 'l', file: '../x.svg', variant: 'primary', background: 'any', source: manual };
    expect(brandKitSchema.safeParse({ schemaVersion: 1, logos: [logo] }).success).toBe(false);
    expect(brandKitSchema.safeParse({ schemaVersion: 1, logos: [{ ...logo, file: '/etc/x' }] }).success).toBe(false);
  });
});

describe('brandSourceSchema', () => {
  it('accepts http(s) websites only', () => {
    const s = { id: 's1', kind: 'website', url: 'https://example.com', file: null, addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: null };
    expect(brandSourceSchema.safeParse(s).success).toBe(true);
    expect(brandSourceSchema.safeParse({ ...s, url: 'file:///etc/passwd' }).success).toBe(false);
    expect(brandSourceSchema.safeParse({ ...s, url: null }).success).toBe(false);
  });
});
```

`packages/shared/test/library.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { assetEntrySchema, assetKindOf, assetsFileSchema, creativeFileSchema } from '../src/index.ts';

describe('assetKindOf', () => {
  it.each([['a.PNG', 'image'], ['b.svg', 'svg'], ['c.mp4', 'video'], ['d.woff2', 'font'], ['e.mp3', 'audio'], ['f.pdf', 'other']])('%s → %s', (f, k) => {
    expect(assetKindOf(f)).toBe(k);
  });
});

describe('assetEntrySchema', () => {
  const a = { file: 'fonts/brand.woff2', kind: 'font', origin: 'website', sourceUrl: 'https://x.it/f.woff2', description: '', tags: [], width: null, height: null, addedAt: '2026-10-07T10:00:00.000Z' };
  it('accepts sub-folders and rejects traversal', () => {
    expect(assetEntrySchema.safeParse(a).success).toBe(true);
    expect(assetEntrySchema.safeParse({ ...a, file: '../brand/x' }).success).toBe(false);
    expect(assetEntrySchema.safeParse({ ...a, file: 'a\\b' }).success).toBe(false);
  });
  it('rejects duplicate files in assets.json', () => {
    expect(assetsFileSchema.safeParse({ schemaVersion: 1, assets: [a, a] }).success).toBe(false);
  });
});

describe('creativeFileSchema', () => {
  it('defaults linkedCodebases to []', () => {
    const at = '2026-10-07T10:00:00.000Z';
    const c = creativeFileSchema.parse({ schemaVersion: 1, title: 'T', status: 'draft', error: null, createdAt: at, updatedAt: at, resumeFrom: null,
      brief: { goal: 'g', message: '', formats: ['x'], durationSec: null, assets: [], notes: '' } });
    expect(c.linkedCodebases).toEqual([]);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/shared`
Expected: FAIL.

- [ ] **Step 3: Implementa `library.ts`** (defines the shared path rule used by `brand.ts`)

```ts
import { z } from 'zod';

export const relativeFileSchema = z.string().min(1).max(300).refine(
  (f) => !f.startsWith('/') && !f.includes('\\') && !f.split('/').some((s) => s === '..' || s === '.' || s === '') && !f.includes('\0'),
  'percorso non valido (deve essere relativo, senza ".." o "\\")',
);

export type AssetKind = 'image' | 'video' | 'svg' | 'font' | 'audio' | 'other';
export type AssetOrigin = 'upload' | 'website' | 'generated' | 'stock';

const EXT: Record<string, AssetKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', heic: 'image',
  svg: 'svg', mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio',
};
export function assetKindOf(file: string): AssetKind {
  return EXT[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'other';
}

export const assetEntrySchema = z.object({
  file: relativeFileSchema,
  kind: z.enum(['image', 'video', 'svg', 'font', 'audio', 'other']),
  origin: z.enum(['upload', 'website', 'generated', 'stock']),
  sourceUrl: z.string().url().nullable(),
  description: z.string().max(2000),
  tags: z.array(z.string().min(1).max(40)).max(30),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  addedAt: z.iso.datetime(),
});
export type AssetEntry = z.infer<typeof assetEntrySchema>;

const uniqueFiles = <T extends { file: string }>(items: T[]) => new Set(items.map((i) => i.file)).size === items.length;

export const assetsFileSchema = z.object({ schemaVersion: z.literal(1), assets: z.array(assetEntrySchema).default([]) })
  .refine((f) => uniqueFiles(f.assets), { message: 'file duplicati', path: ['assets'] });
export type AssetsFile = z.infer<typeof assetsFileSchema>;

export const referenceEntrySchema = z.object({
  file: relativeFileSchema, note: z.string().max(2000), useForBrand: z.boolean(), addedAt: z.iso.datetime(),
});
export type ReferenceEntry = z.infer<typeof referenceEntrySchema>;
export const referencesFileSchema = z.object({ schemaVersion: z.literal(1), references: z.array(referenceEntrySchema).default([]) })
  .refine((f) => uniqueFiles(f.references), { message: 'file duplicati', path: ['references'] });
export type ReferencesFile = z.infer<typeof referencesFileSchema>;
```

- [ ] **Step 4: Implementa `brand.ts`**

```ts
import { z } from 'zod';
import { relativeFileSchema } from './library.ts';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const webUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'solo indirizzi http(s)');

export const sourceRefSchema = z.object({ kind: z.enum(['manual', 'website', 'image']), ref: z.string().nullable() });
export type SourceKind = 'manual' | 'website' | 'image';
export type SourceRef = z.infer<typeof sourceRefSchema>;

const colorSchema = z.object({
  id, name: z.string().trim().min(1).max(60),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((h) => h.toUpperCase()),
  role: z.enum(['primary', 'secondary', 'accent', 'background', 'text', 'other']), source: sourceRefSchema,
});
const fontSchema = z.object({
  id, family: z.string().trim().min(1).max(80), role: z.enum(['heading', 'body', 'accent', 'other']),
  weights: z.array(z.number().int().min(100).max(900)).max(9), file: relativeFileSchema.nullable(), source: sourceRefSchema,
});
const logoSchema = z.object({
  id, file: relativeFileSchema, variant: z.enum(['primary', 'secondary', 'mono', 'icon', 'other']),
  background: z.enum(['light', 'dark', 'any']), source: sourceRefSchema,
});
const noteSchema = z.object({ id, text: z.string().trim().min(1).max(2000), source: sourceRefSchema });

const uniqueIds = (items: Array<{ id: string }>) => new Set(items.map((i) => i.id)).size === items.length;

export const brandKitSchema = z.object({
  schemaVersion: z.literal(1),
  colors: z.array(colorSchema).max(40).default([]),
  fonts: z.array(fontSchema).max(20).default([]),
  logos: z.array(logoSchema).max(30).default([]),
  tone: noteSchema.nullable().default(null),
  dos: z.array(noteSchema).max(50).default([]),
  donts: z.array(noteSchema).max(50).default([]),
  photoStyle: noteSchema.nullable().default(null),
}).refine((k) => [k.colors, k.fonts, k.logos, k.dos, k.donts].every(uniqueIds), { message: 'id duplicati' });
export type BrandKit = z.infer<typeof brandKitSchema>;
export type BrandColor = BrandKit['colors'][number];
export type BrandFont = BrandKit['fonts'][number];
export type BrandLogo = BrandKit['logos'][number];
export type BrandNote = BrandKit['dos'][number];
export const EMPTY_BRAND_KIT: BrandKit = { schemaVersion: 1, colors: [], fonts: [], logos: [], tone: null, dos: [], donts: [], photoStyle: null };

export const brandSourceSchema = z.object({
  id, kind: z.enum(['website', 'image']), url: webUrl.nullable(), file: relativeFileSchema.nullable(),
  addedAt: z.iso.datetime(), lastAnalyzedAt: z.iso.datetime().nullable(),
}).refine((s) => (s.kind === 'website' ? s.url !== null : s.file !== null), 'sorgente incompleta');
export type BrandSource = z.infer<typeof brandSourceSchema>;
export const brandSourcesFileSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(brandSourceSchema).default([]) });
export type BrandSourcesFile = z.infer<typeof brandSourcesFileSchema>;

export const brandFieldSchema = z.enum(['colors', 'fonts', 'logos', 'dos', 'donts', 'tone', 'photoStyle']);
export type BrandField = z.infer<typeof brandFieldSchema>;
export const brandChangeSchema = z.object({
  id: z.string().min(1), field: brandFieldSchema, op: z.enum(['add', 'update', 'remove']),
  itemId: z.string().nullable(), before: z.unknown(), after: z.unknown(),
});
export type BrandChange = z.infer<typeof brandChangeSchema>;
export const brandProposalSchema = z.object({
  schemaVersion: z.literal(1), id, createdAt: z.iso.datetime(), sourceIds: z.array(z.string()),
  status: z.enum(['open', 'applied', 'discarded']), summary: z.string(),
  changes: z.array(brandChangeSchema), guidelines: z.object({ current: z.string(), proposed: z.string() }).nullable(),
  assetsAdded: z.array(z.string()),
});
export type BrandProposal = z.infer<typeof brandProposalSchema>;
```

Note: `brandKitSchema.parse({ schemaVersion: 1 })` equals `EMPTY_BRAND_KIT` because of the defaults.

- [ ] **Step 5: creative, events, reducer, index**

`packages/shared/src/creative.ts`: import `linkedCodebaseSchema` from `./schemas.ts` and add to `creativeFileSchema`:
```ts
  linkedCodebases: z.array(linkedCodebaseSchema).default([]),
```
`packages/shared/src/events.ts`: add to `ServerMessage`:
```ts
  /** Brand kit, guidelines, sources or proposals of a project changed. */
  | { type: 'brand'; project: string }
  /** Assets or references of a project changed. */
  | { type: 'library'; project: string };
```
`packages/shared/src/index.ts`: `export * from './brand.ts'; export * from './library.ts';`
`packages/web/src/eventsReducer.ts`: add `projectTicks: Record<string, number>` to `EventsState` and `initialEventsState` (`{}`), and:
```ts
    case 'brand':
    case 'library':
      return { ...state, projectTicks: { ...state.projectTicks, [msg.project]: (state.projectTicks[msg.project] ?? 0) + 1 } };
```
Update every test literal of `EventsState` to include `projectTicks: {}`.

- [ ] **Step 6: Verifica**

Run: `pnpm vitest run packages/shared packages/web && pnpm typecheck`
Expected: tutti PASS. (Core creative tests still pass: `linkedCodebases` defaults to `[]` when reading old files.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(shared): brand kit, sources, proposals, asset and reference schemas"
```

---
### Task 3: BrandStore, diff e applicazione delle proposte

**Files:**
- Create: `packages/core/src/brand/brand-store.ts`, `packages/core/src/brand/brand-diff.ts`, `packages/core/test/brand-store.test.ts`, `packages/core/test/brand-diff.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: schemi del Task 2; `readJsonFile`, `writeJsonFileAtomic`, `JsonFileError`, `KeyedMutex`, `WorkspaceError` (Fase 1).
- Produces (`brand-diff.ts`):
  ```ts
  export function diffBrandKits(current: BrandKit, proposed: BrandKit): BrandChange[];
  export function applyBrandChanges(current: BrandKit, changes: BrandChange[], acceptedIds: string[]): BrandKit; // WorkspaceError 400 if the result is invalid
  ```
  Rules: list fields (`colors`, `fonts`, `logos`, `dos`, `donts`) matched by `id`; equal ignoring `source` → no change; same id, different → `update` (`before` current, `after` proposed); only in proposed → `add`; only in current → `remove` **unless** `current.source.kind === 'manual'`. Scalars (`tone`, `photoStyle`): proposed `null` → no change; current `null` → `add`; different text → `update`. Change id: `` `${field}:${op}:${itemId ?? '-'}` `` (scalars use `itemId: null`). Order: fields in the order colors, fonts, logos, tone, dos, donts, photoStyle; within a field, proposed order then removals. `applyBrandChanges` ignores ids not in `acceptedIds` and unknown ids; `add`/`update` replace an existing item with the same id or append; `remove` filters it out.
- Produces (`brand-store.ts`):
  ```ts
  export class BrandStore {
    constructor(projectDir: string)
    readKit(): Promise<BrandKit>                       // missing → EMPTY_BRAND_KIT (nothing written); invalid → JsonFileError
    writeKit(kit: unknown): Promise<BrandKit>          // validates (WorkspaceError 400), writes atomically
    readGuidelines(): Promise<string>                  // missing → ''
    writeGuidelines(text: string): Promise<void>       // max 200_000 chars (400)
    readSources(): Promise<BrandSource[]>
    addSource(input: { kind: 'website'; url: string } | { kind: 'image'; file: string }): Promise<BrandSource> // id `s-<n>`; 400 invalid; 409 duplicate url/file
    removeSource(id: string): Promise<void>            // 404 unknown
    markAnalyzed(ids: string[], at: string): Promise<void>
    newProposalId(now?: Date): Promise<string>         // `p-YYYYMMDD-HHMMSS[-n]`, creates brand/proposals/<id>/
    proposalDir(id: string): string                    // 400 on invalid id
    readProposal(id: string): Promise<BrandProposal>   // 404
    writeProposal(p: BrandProposal): Promise<void>
    listProposals(): Promise<BrandProposal[]>          // newest first, skips unreadable ones
  }
  ```
  All writes serialized with one `KeyedMutex` per store file.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/brand-diff.test.ts`:
```ts
import { EMPTY_BRAND_KIT, type BrandKit } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { applyBrandChanges, diffBrandKits } from '../src/brand/brand-diff.ts';

const manual = { kind: 'manual' as const, ref: null };
const site = { kind: 'website' as const, ref: 'https://acme.example' };
const kit = (p: Partial<BrandKit>): BrandKit => ({ ...EMPTY_BRAND_KIT, ...p });

const current = kit({
  colors: [
    { id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: manual },
    { id: 'grigio', name: 'Grigio', hex: '#888888', role: 'other', source: site },
    { id: 'rosso', name: 'Rosso', hex: '#FF0000', role: 'accent', source: manual },
  ],
  tone: { id: 'tone', text: 'Amichevole', source: manual },
});
const proposed = kit({
  colors: [
    { id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: site },     // same apart from source → nothing
    { id: 'arancio', name: 'Arancio', hex: '#FF7A45', role: 'accent', source: site }, // add
  ],
  tone: { id: 'tone', text: 'Energico e diretto', source: site },                  // update
  photoStyle: null,
});

describe('diffBrandKits', () => {
  it('adds, updates, removes non-manual items and never removes manual ones', () => {
    const changes = diffBrandKits(current, proposed);
    expect(changes.map((c) => c.id)).toEqual(['colors:add:arancio', 'colors:remove:grigio', 'tone:update:-']);
    expect(changes[2]).toMatchObject({ field: 'tone', before: { text: 'Amichevole' }, after: { text: 'Energico e diretto' } });
  });
  it('returns nothing for identical kits', () => {
    expect(diffBrandKits(current, current)).toEqual([]);
  });
});

describe('applyBrandChanges', () => {
  it('applies only accepted changes and keeps the rest', () => {
    const changes = diffBrandKits(current, proposed);
    const next = applyBrandChanges(current, changes, ['colors:add:arancio', 'unknown:id']);
    expect(next.colors.map((c) => c.id)).toEqual(['blu', 'grigio', 'rosso', 'arancio']);
    expect(next.tone?.text).toBe('Amichevole');
  });
  it('applies updates and removals', () => {
    const changes = diffBrandKits(current, proposed);
    const next = applyBrandChanges(current, changes, changes.map((c) => c.id));
    expect(next.colors.map((c) => c.id)).toEqual(['blu', 'rosso', 'arancio']);
    expect(next.tone).toMatchObject({ text: 'Energico e diretto', source: site });
  });
});
```

`packages/core/test/brand-store.test.ts`:
```ts
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_BRAND_KIT } from '@motion-studio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrandStore } from '../src/brand/brand-store.ts';

let dir: string;
let store: BrandStore;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ms-brand è ')); store = new BrandStore(dir); });

describe('kit and guidelines', () => {
  it('reads an empty kit without writing, then writes a validated one', async () => {
    expect(await store.readKit()).toEqual(EMPTY_BRAND_KIT);
    await expect(readFile(join(dir, 'brand', 'brand-kit.json'))).rejects.toBeTruthy();
    const kit = await store.writeKit({ schemaVersion: 1, colors: [{ id: 'b', name: 'Blu', hex: '#1e3a5f', role: 'primary', source: { kind: 'manual', ref: null } }] });
    expect(kit.colors[0]!.hex).toBe('#1E3A5F');
    expect((await store.readKit()).colors).toHaveLength(1);
    expect((await store.writeKit({ schemaVersion: 1, colors: [{ id: 'x' }] }).catch((e) => e)).status).toBe(400);
  });
  it('reports a corrupt kit without rewriting it', async () => {
    await mkdir(join(dir, 'brand'), { recursive: true });
    await writeFile(join(dir, 'brand', 'brand-kit.json'), '{oops');
    await expect(store.readKit()).rejects.toMatchObject({ reason: 'invalid-json' });
    expect(await readFile(join(dir, 'brand', 'brand-kit.json'), 'utf8')).toBe('{oops');
  });
  it('round-trips guidelines', async () => {
    expect(await store.readGuidelines()).toBe('');
    await store.writeGuidelines('# Linee guida\nTono diretto.');
    expect(await store.readGuidelines()).toBe('# Linee guida\nTono diretto.');
  });
});

describe('sources', () => {
  it('adds, refuses duplicates and invalid urls, removes', async () => {
    const s = await store.addSource({ kind: 'website', url: 'https://acme.example' });
    expect(s).toMatchObject({ id: 's-1', kind: 'website', url: 'https://acme.example', file: null, lastAnalyzedAt: null });
    expect((await store.addSource({ kind: 'website', url: 'https://acme.example' }).catch((e) => e)).status).toBe(409);
    expect((await store.addSource({ kind: 'website', url: 'javascript:alert(1)' }).catch((e) => e)).status).toBe(400);
    const img = await store.addSource({ kind: 'image', file: 'references/moodboard.jpg' });
    expect(img.id).toBe('s-2');
    await store.markAnalyzed(['s-1'], '2026-10-07T10:00:00.000Z');
    expect((await store.readSources())[0]!.lastAnalyzedAt).toBe('2026-10-07T10:00:00.000Z');
    await store.removeSource('s-1');
    expect((await store.readSources()).map((x) => x.id)).toEqual(['s-2']);
    expect((await store.removeSource('nope').catch((e) => e)).status).toBe(404);
  });
});

describe('proposals', () => {
  it('creates unique ids and lists newest first', async () => {
    const now = new Date('2026-10-07T10:00:00.000Z');
    const a = await store.newProposalId(now);
    const b = await store.newProposalId(now);
    expect(a).toMatch(/^p-20261007-\d{6}$/);
    expect(b).toBe(`${a}-2`);
    const base = { schemaVersion: 1 as const, sourceIds: [], status: 'open' as const, summary: '', changes: [], guidelines: null, assetsAdded: [] };
    await store.writeProposal({ ...base, id: a, createdAt: '2026-10-07T10:00:00.000Z' });
    await store.writeProposal({ ...base, id: b, createdAt: '2026-10-07T11:00:00.000Z' });
    expect((await store.listProposals()).map((p) => p.id)).toEqual([b, a]);
    expect((await store.readProposal('p-nope').catch((e) => e)).status).toBe(404);
    expect((await store.readProposal('../x').catch((e) => e)).status).toBe(400);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/brand-diff.test.ts packages/core/test/brand-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `brand-diff.ts`**

```ts
import { brandKitSchema, type BrandChange, type BrandField, type BrandKit } from '@motion-studio/shared';
import { WorkspaceError } from '../workspace-store.ts';

type ListField = 'colors' | 'fonts' | 'logos' | 'dos' | 'donts';
type ScalarField = 'tone' | 'photoStyle';
const ORDER: BrandField[] = ['colors', 'fonts', 'logos', 'tone', 'dos', 'donts', 'photoStyle'];
const SCALARS = new Set<BrandField>(['tone', 'photoStyle']);

const withoutSource = (v: unknown) => {
  if (!v || typeof v !== 'object') return v;
  const { source: _s, ...rest } = v as Record<string, unknown>;
  return JSON.stringify(rest);
};
const changeId = (field: BrandField, op: BrandChange['op'], itemId: string | null) => `${field}:${op}:${itemId ?? '-'}`;

export function diffBrandKits(current: BrandKit, proposed: BrandKit): BrandChange[] {
  const out: BrandChange[] = [];
  for (const field of ORDER) {
    if (SCALARS.has(field)) {
      const cur = current[field as ScalarField];
      const next = proposed[field as ScalarField];
      if (!next) continue;
      if (!cur) out.push({ id: changeId(field, 'add', null), field, op: 'add', itemId: null, before: null, after: next });
      else if (cur.text !== next.text) out.push({ id: changeId(field, 'update', null), field, op: 'update', itemId: null, before: cur, after: next });
      continue;
    }
    const cur = current[field as ListField] as Array<{ id: string; source: { kind: string } }>;
    const next = proposed[field as ListField] as Array<{ id: string }>;
    for (const item of next) {
      const existing = cur.find((c) => c.id === item.id);
      if (!existing) out.push({ id: changeId(field, 'add', item.id), field, op: 'add', itemId: item.id, before: null, after: item });
      else if (withoutSource(existing) !== withoutSource(item)) out.push({ id: changeId(field, 'update', item.id), field, op: 'update', itemId: item.id, before: existing, after: item });
    }
    for (const item of cur) {
      if (item.source.kind !== 'manual' && !next.some((n) => n.id === item.id)) {
        out.push({ id: changeId(field, 'remove', item.id), field, op: 'remove', itemId: item.id, before: item, after: null });
      }
    }
  }
  return out;
}

export function applyBrandChanges(current: BrandKit, changes: BrandChange[], acceptedIds: string[]): BrandKit {
  const accepted = new Set(acceptedIds);
  const next = structuredClone(current) as Record<string, unknown>;
  for (const c of changes) {
    if (!accepted.has(c.id)) continue;
    if (SCALARS.has(c.field)) { next[c.field] = c.op === 'remove' ? null : c.after; continue; }
    const arr = [...(next[c.field] as Array<{ id: string }>)];
    if (c.op === 'remove') { next[c.field] = arr.filter((i) => i.id !== c.itemId); continue; }
    const index = arr.findIndex((i) => i.id === c.itemId);
    if (index >= 0) arr[index] = c.after as { id: string }; else arr.push(c.after as { id: string });
    next[c.field] = arr;
  }
  const parsed = brandKitSchema.safeParse(next);
  if (!parsed.success) throw new WorkspaceError(400, `Brand kit risultante non valido: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return parsed.data;
}
```

- [ ] **Step 4: Implementa `brand-store.ts`**

```ts
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  brandKitSchema, brandProposalSchema, brandSourcesFileSchema, brandSourceSchema, EMPTY_BRAND_KIT,
  type BrandKit, type BrandProposal, type BrandSource,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { WorkspaceError } from '../workspace-store.ts';

const PROPOSAL_RE = /^p-\d{8}-\d{6}(-\d+)?$/;
const issues = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) => e.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ');

export class BrandStore {
  private readonly dir: string;
  private readonly lock = new KeyedMutex();
  constructor(projectDir: string) { this.dir = join(projectDir, 'brand'); }

  private path(name: string) { return join(this.dir, name); }

  async readKit(): Promise<BrandKit> {
    try { return await readJsonFile(this.path('brand-kit.json'), brandKitSchema); }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return EMPTY_BRAND_KIT; throw e; }
  }

  writeKit(kit: unknown): Promise<BrandKit> {
    return this.lock.run('kit', async () => {
      const parsed = brandKitSchema.safeParse(kit);
      if (!parsed.success) throw new WorkspaceError(400, `Brand kit non valido: ${issues(parsed.error)}`);
      await writeJsonFileAtomic(this.path('brand-kit.json'), parsed.data);
      return parsed.data;
    });
  }

  async readGuidelines(): Promise<string> {
    return readFile(this.path('guidelines.md'), 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e; });
  }

  writeGuidelines(text: string): Promise<void> {
    if (text.length > 200_000) throw new WorkspaceError(400, 'Linee guida troppo lunghe (massimo 200.000 caratteri)');
    return this.lock.run('guidelines', async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.path('guidelines.md'), text);
    });
  }

  async readSources(): Promise<BrandSource[]> {
    try { return (await readJsonFile(this.path('sources.json'), brandSourcesFileSchema)).sources; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }

  addSource(input: { kind: 'website'; url: string } | { kind: 'image'; file: string }): Promise<BrandSource> {
    return this.lock.run('sources', async () => {
      const sources = await this.readSources();
      const n = Math.max(0, ...sources.map((s) => Number(s.id.slice(2)) || 0)) + 1;
      const parsed = brandSourceSchema.safeParse({
        id: `s-${n}`, kind: input.kind, url: input.kind === 'website' ? input.url.trim() : null,
        file: input.kind === 'image' ? input.file : null, addedAt: new Date().toISOString(), lastAnalyzedAt: null,
      });
      if (!parsed.success) throw new WorkspaceError(400, `Sorgente non valida: ${issues(parsed.error)}`);
      const s = parsed.data;
      if (sources.some((x) => (s.url && x.url === s.url) || (s.file && x.file === s.file))) throw new WorkspaceError(409, 'Sorgente già presente');
      await writeJsonFileAtomic(this.path('sources.json'), { schemaVersion: 1, sources: [...sources, s] });
      return s;
    });
  }

  removeSource(id: string): Promise<void> {
    return this.lock.run('sources', async () => {
      const sources = await this.readSources();
      if (!sources.some((s) => s.id === id)) throw new WorkspaceError(404, `Sorgente ${id} non trovata`);
      await writeJsonFileAtomic(this.path('sources.json'), { schemaVersion: 1, sources: sources.filter((s) => s.id !== id) });
    });
  }

  markAnalyzed(ids: string[], at: string): Promise<void> {
    return this.lock.run('sources', async () => {
      const sources = await this.readSources();
      await writeJsonFileAtomic(this.path('sources.json'), { schemaVersion: 1, sources: sources.map((s) => (ids.includes(s.id) ? { ...s, lastAnalyzedAt: at } : s)) });
    });
  }

  newProposalId(now = new Date()): Promise<string> {
    return this.lock.run('proposals', async () => {
      const pad = (n: number) => String(n).padStart(2, '0');
      const base = `p-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      await mkdir(join(this.dir, 'proposals'), { recursive: true });
      for (let i = 1; ; i++) {
        const id = i === 1 ? base : `${base}-${i}`;
        try { await mkdir(join(this.dir, 'proposals', id)); return id; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
    });
  }

  proposalDir(id: string): string {
    if (!PROPOSAL_RE.test(id)) throw new WorkspaceError(400, `Identificativo proposta non valido: ${id}`);
    return join(this.dir, 'proposals', id);
  }

  async readProposal(id: string): Promise<BrandProposal> {
    try { return await readJsonFile(join(this.proposalDir(id), 'proposal.json'), brandProposalSchema); }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') throw new WorkspaceError(404, `Proposta ${id} non trovata`); throw e; }
  }

  writeProposal(p: BrandProposal): Promise<void> {
    return this.lock.run(`p:${p.id}`, () => writeJsonFileAtomic(join(this.proposalDir(p.id), 'proposal.json'), p));
  }

  async listProposals(): Promise<BrandProposal[]> {
    const entries = await readdir(join(this.dir, 'proposals'), { withFileTypes: true }).catch(() => []);
    const out: BrandProposal[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !PROPOSAL_RE.test(e.name)) continue;
      try { out.push(await this.readProposal(e.name)); } catch { /* in progress or unreadable */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
```

Note: `newProposalId` uses local time on purpose (consistent with the local-date creative slugs of Phase 2); the test only checks the shape and the `-2` suffix.

Append to `packages/core/src/index.ts`:
```ts
export * from './brand/brand-diff.ts';
export * from './brand/brand-store.ts';
```

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/core/test/brand-diff.test.ts packages/core/test/brand-store.test.ts && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): brand store with sources, proposals and field-level kit diff"
```

---

### Task 4: LibraryStore (asset e riferimenti)

**Files:**
- Create: `packages/core/src/library/library-store.ts`, `packages/core/test/library-store.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: schemi del Task 2; `MediaTools` (Fase 2); `readJsonFile`, `writeJsonFileAtomic`, `JsonFileError`, `KeyedMutex`, `WorkspaceError`.
- Produces:
  ```ts
  export type LibraryKind = 'assets' | 'references';
  export class LibraryStore {
    constructor(projectDir: string, media: MediaTools)
    dir(kind: LibraryKind): string                         // <project>/assets | <project>/references
    resolve(kind: LibraryKind, file: string): string       // validated with relativeFileSchema → 400; returns the absolute path inside dir(kind)
    listAssets(): Promise<AssetEntry[]>                    // missing json → []; invalid → JsonFileError
    listReferences(): Promise<ReferenceEntry[]>
    registerAssets(items: Array<{ file: string; origin: AssetOrigin; sourceUrl?: string | null; description?: string; tags?: string[] }>): Promise<AssetEntry[]>
      // each file must exist under assets/ as a regular file (symlinks refused → 400); kind from extension; width/height from media.probe for image/video (null otherwise);
      // upsert by file: an existing entry keeps addedAt and its non-empty description/tags unless new ones are given
    updateAsset(file: string, patch: { description?: string; tags?: string[] }): Promise<AssetEntry> // 404 unknown
    removeAsset(file: string): Promise<void>               // deletes the entry and the file (if a regular file); 404 unknown
    registerReferences(files: string[]): Promise<ReferenceEntry[]> // note '', useForBrand true
    updateReference(file: string, patch: { note?: string; useForBrand?: boolean }): Promise<ReferenceEntry>
    removeReference(file: string): Promise<void>
    unregisteredAssets(): Promise<string[]>                // regular files under assets/ (recursive, skipping dot-files and assets.json) without an entry
  }
  ```

- [ ] **Step 1: Test che falliscono**

`packages/core/test/library-store.test.ts`:
```ts
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools, type MediaTools } from '../src/media/media-tools.ts';

const media: MediaTools = { ...NoMediaTools, available: true, probe: async (f) => (f.endsWith('.png') ? { width: 300, height: 250, durationSec: null } : null) };
let project: string;
let lib: LibraryStore;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'ms-lib è '));
  await mkdir(join(project, 'assets', 'fonts'), { recursive: true });
  await mkdir(join(project, 'references'), { recursive: true });
  lib = new LibraryStore(project, media);
});

describe('assets', () => {
  it('registers files with kind and probed size, upserting by file', async () => {
    await writeFile(join(project, 'assets', 'logo.png'), 'x');
    await writeFile(join(project, 'assets', 'fonts', 'brand.woff2'), 'x');
    const [logo, font] = await lib.registerAssets([
      { file: 'logo.png', origin: 'upload' },
      { file: 'fonts/brand.woff2', origin: 'website', sourceUrl: 'https://acme.example/f.woff2', description: 'Font titoli', tags: ['font'] },
    ]);
    expect(logo).toMatchObject({ file: 'logo.png', kind: 'image', origin: 'upload', width: 300, height: 250, description: '', tags: [] });
    expect(font).toMatchObject({ kind: 'font', width: null, sourceUrl: 'https://acme.example/f.woff2' });
    const again = await lib.registerAssets([{ file: 'logo.png', origin: 'upload' }]);
    expect(again[0]!.addedAt).toBe(logo!.addedAt);
    expect(await lib.listAssets()).toHaveLength(2);
  });
  it('refuses missing files, symlinks and traversal', async () => {
    expect((await lib.registerAssets([{ file: 'nope.png', origin: 'upload' }]).catch((e) => e)).status).toBe(400);
    await symlink('/etc/hosts', join(project, 'assets', 'link.png'));
    expect((await lib.registerAssets([{ file: 'link.png', origin: 'upload' }]).catch((e) => e)).status).toBe(400);
    expect((await lib.registerAssets([{ file: '../project.json', origin: 'upload' }]).catch((e) => e)).status).toBe(400);
  });
  it('updates, lists unregistered files and removes', async () => {
    await writeFile(join(project, 'assets', 'a.png'), 'x');
    await writeFile(join(project, 'assets', 'b.svg'), 'x');
    await writeFile(join(project, 'assets', '.DS_Store'), 'x');
    await lib.registerAssets([{ file: 'a.png', origin: 'upload' }]);
    expect(await lib.unregisteredAssets()).toEqual(['b.svg']);
    expect(await lib.updateAsset('a.png', { description: 'Logo', tags: ['logo'] })).toMatchObject({ description: 'Logo', tags: ['logo'] });
    await lib.removeAsset('a.png');
    await expect(stat(join(project, 'assets', 'a.png'))).rejects.toBeTruthy();
    expect((await lib.removeAsset('a.png').catch((e) => e)).status).toBe(404);
  });
  it('reports a corrupt assets.json without rewriting it', async () => {
    await writeFile(join(project, 'assets', 'assets.json'), '{"schemaVersion":1,"assets":[{}]}');
    await expect(lib.listAssets()).rejects.toMatchObject({ reason: 'schema' });
    await writeFile(join(project, 'assets', 'c.png'), 'x');
    await expect(lib.registerAssets([{ file: 'c.png', origin: 'upload' }])).rejects.toMatchObject({ reason: 'schema' });
    expect(await readFile(join(project, 'assets', 'assets.json'), 'utf8')).toBe('{"schemaVersion":1,"assets":[{}]}');
  });
});

describe('references', () => {
  it('registers, updates and removes', async () => {
    await writeFile(join(project, 'references', 'mood.jpg'), 'x');
    expect(await lib.registerReferences(['mood.jpg'])).toEqual([expect.objectContaining({ file: 'mood.jpg', note: '', useForBrand: true })]);
    expect(await lib.updateReference('mood.jpg', { note: 'Luce calda', useForBrand: false })).toMatchObject({ note: 'Luce calda', useForBrand: false });
    await lib.removeReference('mood.jpg');
    expect(await lib.listReferences()).toEqual([]);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/library-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa**

`packages/core/src/library/library-store.ts`:
```ts
import { lstat, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  assetKindOf, assetsFileSchema, referencesFileSchema, relativeFileSchema,
  type AssetEntry, type AssetOrigin, type ReferenceEntry,
} from '@motion-studio/shared';
import { JsonFileError, readJsonFile, writeJsonFileAtomic } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';

export type LibraryKind = 'assets' | 'references';
const now = () => new Date().toISOString();

export class LibraryStore {
  private readonly lock = new KeyedMutex();
  constructor(private readonly projectDir: string, private readonly media: MediaTools) {}

  dir(kind: LibraryKind) { return join(this.projectDir, kind); }

  resolve(kind: LibraryKind, file: string): string {
    if (!relativeFileSchema.safeParse(file).success) throw new WorkspaceError(400, `Percorso non valido: ${file}`);
    return join(this.dir(kind), ...file.split('/'));
  }

  private async mustBeFile(kind: LibraryKind, file: string): Promise<string> {
    const abs = this.resolve(kind, file);
    const info = await lstat(abs).catch(() => null);
    if (!info?.isFile()) throw new WorkspaceError(400, `File non trovato o non valido: ${kind}/${file}`);
    return abs;
  }

  async listAssets(): Promise<AssetEntry[]> {
    try { return (await readJsonFile(join(this.dir('assets'), 'assets.json'), assetsFileSchema)).assets; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }

  async listReferences(): Promise<ReferenceEntry[]> {
    try { return (await readJsonFile(join(this.dir('references'), 'references.json'), referencesFileSchema)).references; }
    catch (e) { if (e instanceof JsonFileError && e.reason === 'missing') return []; throw e; }
  }

  private writeAssets(assets: AssetEntry[]) { return writeJsonFileAtomic(join(this.dir('assets'), 'assets.json'), { schemaVersion: 1, assets }); }
  private writeReferences(references: ReferenceEntry[]) { return writeJsonFileAtomic(join(this.dir('references'), 'references.json'), { schemaVersion: 1, references }); }

  registerAssets(items: Array<{ file: string; origin: AssetOrigin; sourceUrl?: string | null; description?: string; tags?: string[] }>): Promise<AssetEntry[]> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      const out: AssetEntry[] = [];
      for (const item of items) {
        const abs = await this.mustBeFile('assets', item.file);
        const kind = assetKindOf(item.file);
        const probed = (kind === 'image' || kind === 'video') && this.media.available ? await this.media.probe(abs) : null;
        const existing = assets.find((a) => a.file === item.file);
        const entry: AssetEntry = {
          file: item.file, kind, origin: item.origin, sourceUrl: item.sourceUrl ?? existing?.sourceUrl ?? null,
          description: item.description || existing?.description || '', tags: item.tags?.length ? item.tags : existing?.tags ?? [],
          width: probed?.width ?? existing?.width ?? null, height: probed?.height ?? existing?.height ?? null,
          addedAt: existing?.addedAt ?? now(),
        };
        if (existing) assets[assets.indexOf(existing)] = entry; else assets.push(entry);
        out.push(entry);
      }
      await this.writeAssets(assets);
      return out;
    });
  }

  updateAsset(file: string, patch: { description?: string; tags?: string[] }): Promise<AssetEntry> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      const i = assets.findIndex((a) => a.file === file);
      if (i < 0) throw new WorkspaceError(404, `Asset ${file} non trovato`);
      const next = { ...assets[i]!, ...(patch.description !== undefined ? { description: patch.description } : {}), ...(patch.tags ? { tags: patch.tags } : {}) };
      const parsed = assetsFileSchema.safeParse({ schemaVersion: 1, assets: assets.map((a, k) => (k === i ? next : a)) });
      if (!parsed.success) throw new WorkspaceError(400, 'Metadati dell\'asset non validi');
      await this.writeAssets(parsed.data.assets);
      return parsed.data.assets[i]!;
    });
  }

  removeAsset(file: string): Promise<void> {
    return this.lock.run('assets', async () => {
      const assets = await this.listAssets();
      if (!assets.some((a) => a.file === file)) throw new WorkspaceError(404, `Asset ${file} non trovato`);
      const abs = this.resolve('assets', file);
      if ((await lstat(abs).catch(() => null))?.isFile()) await rm(abs);
      await this.writeAssets(assets.filter((a) => a.file !== file));
    });
  }

  registerReferences(files: string[]): Promise<ReferenceEntry[]> {
    return this.lock.run('references', async () => {
      const refs = await this.listReferences();
      const out: ReferenceEntry[] = [];
      for (const file of files) {
        await this.mustBeFile('references', file);
        const entry = refs.find((r) => r.file === file) ?? { file, note: '', useForBrand: true, addedAt: now() };
        if (!refs.includes(entry)) refs.push(entry);
        out.push(entry);
      }
      await this.writeReferences(refs);
      return out;
    });
  }

  updateReference(file: string, patch: { note?: string; useForBrand?: boolean }): Promise<ReferenceEntry> {
    return this.lock.run('references', async () => {
      const refs = await this.listReferences();
      const i = refs.findIndex((r) => r.file === file);
      if (i < 0) throw new WorkspaceError(404, `Riferimento ${file} non trovato`);
      refs[i] = { ...refs[i]!, ...patch };
      const parsed = referencesFileSchema.safeParse({ schemaVersion: 1, references: refs });
      if (!parsed.success) throw new WorkspaceError(400, 'Metadati del riferimento non validi');
      await this.writeReferences(parsed.data.references);
      return parsed.data.references[i]!;
    });
  }

  removeReference(file: string): Promise<void> {
    return this.lock.run('references', async () => {
      const refs = await this.listReferences();
      if (!refs.some((r) => r.file === file)) throw new WorkspaceError(404, `Riferimento ${file} non trovato`);
      const abs = this.resolve('references', file);
      if ((await lstat(abs).catch(() => null))?.isFile()) await rm(abs);
      await this.writeReferences(refs.filter((r) => r.file !== file));
    });
  }

  async unregisteredAssets(): Promise<string[]> {
    const known = new Set((await this.listAssets()).map((a) => a.file));
    const root = this.dir('assets');
    const found: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.')) continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) {
          const rel = relative(root, abs).split(sep).join('/');
          if (rel !== 'assets.json' && !known.has(rel)) found.push(rel);
        }
      }
    };
    await walk(root);
    return found.sort();
  }
}
```

Note: `listAssets()` throws on a corrupt file, so `registerAssets` (which calls it first) refuses to write (Review Focus 5). The route layer maps `JsonFileError` to 422 (already in the Phase 1 error handler).

Append to `packages/core/src/index.ts`:
```ts
export * from './library/library-store.ts';
```

- [ ] **Step 4: Verifica che passino**

Run: `pnpm vitest run packages/core/test/library-store.test.ts && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): asset and reference library with probed metadata"
```

---

### Task 5: Upload multipart sicuro

**Files:**
- Create: `packages/core/src/library/upload.ts`, `packages/core/test/upload.test.ts`, `packages/core/test/helpers/multipart.ts`
- Modify: `packages/core/package.json` (dep `@fastify/multipart`), `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export const UPLOAD_LIMITS = { fileSize: 200 * 1024 * 1024, files: 50 };
  export function sanitizeFileName(name: string): string;   // basename only; [^A-Za-z0-9._-] → '-'; collapse '-'; strip leading dots/dashes; max 120 chars keeping the extension; '' → 'file'
  export function saveUploads(req: FastifyRequest, targetDir: string): Promise<string[]>;
    // iterates req.files(); each file → unique name in targetDir (`name-2.ext`, … if any entry with that name exists, symlinks included);
    // streams to `<name>.<rand>.part` then renames; a truncated file (over fileSize) is deleted and the call throws WorkspaceError 413
    // (files already saved in the same request are kept and their names returned only on success; on error they are removed);
    // too many files → 413; no files → 400. Returns saved names (relative to targetDir).
  ```
  The multipart plugin is registered by the app (Task 9) with `limits: UPLOAD_LIMITS`.

- [ ] **Step 1: Dipendenza e helper di test**

Run: `pnpm --filter @motion-studio/core add @fastify/multipart@^9`

`packages/core/test/helpers/multipart.ts`:
```ts
export function multipart(files: Array<{ name: string; content: string | Buffer; field?: string }>) {
  const boundary = '----ms' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'files'}"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
```

- [ ] **Step 2: Test che falliscono**

`packages/core/test/upload.test.ts`:
```ts
import { mkdir, mkdtemp, readdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeFileName, saveUploads } from '../src/library/upload.ts';
import { WorkspaceError } from '../src/workspace-store.ts';
import { multipart } from './helpers/multipart.ts';

let app: FastifyInstance;
let dir: string;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'ms-up è ')), 'assets');
  await mkdir(dir);
  app = Fastify();
  await app.register(fastifyMultipart, { limits: { fileSize: 1024, files: 3 } });
  app.setErrorHandler((err, _r, reply) => reply.status(err instanceof WorkspaceError ? err.status : 500).send({ error: (err as Error).message }));
  app.post('/up', async (req) => ({ saved: await saveUploads(req, dir) }));
});
afterEach(() => app.close());

describe('sanitizeFileName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['Logo Acme (finale).PNG', 'Logo-Acme-finale-.PNG'],
    ['..hidden', 'hidden'],
    ['', 'file'],
    ['a'.repeat(200) + '.png', 'a'.repeat(116) + '.png'],
    ['C:\\Users\\x\\logo.svg', 'logo.svg'],
  ])('%s → %s', (input, out) => { expect(sanitizeFileName(input)).toBe(out); });
});

describe('saveUploads', () => {
  it('saves files with safe, unique names', async () => {
    const r = await app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'logo.png', content: 'a' }, { name: 'logo.png', content: 'b' }, { name: '../x.svg', content: 'c' }]) });
    expect(r.json().saved).toEqual(['logo.png', 'logo-2.png', 'x.svg']);
    expect(await readFile(join(dir, 'logo-2.png'), 'utf8')).toBe('b');
    expect((await readdir(dir)).sort()).toEqual(['logo-2.png', 'logo.png', 'x.svg']);
  });
  it('never writes through an existing symlink name', async () => {
    await symlink('/etc/hosts', join(dir, 'a.png'));
    const r = await app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'a.png', content: 'x' }]) });
    expect(r.json().saved).toEqual(['a-2.png']);
  });
  it('rejects oversize files with 413 and leaves nothing behind', async () => {
    const r = await app.inject({ method: 'POST', url: '/up', ...multipart([{ name: 'ok.png', content: 'a' }, { name: 'big.png', content: Buffer.alloc(4096) }]) });
    expect(r.statusCode).toBe(413);
    expect(await readdir(dir)).toEqual([]);
  });
  it('rejects too many files with 413 and an empty request with 400', async () => {
    const many = await app.inject({ method: 'POST', url: '/up', ...multipart([1, 2, 3, 4].map((i) => ({ name: `${i}.png`, content: 'a' }))) });
    expect(many.statusCode).toBe(413);
    const none = await app.inject({ method: 'POST', url: '/up', ...multipart([]) });
    expect(none.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/upload.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementa**

`packages/core/src/library/upload.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, rename, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { WorkspaceError } from '../workspace-store.ts';

export const UPLOAD_LIMITS = { fileSize: 200 * 1024 * 1024, files: 50 };

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let s = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+/, '');
  if (s.length > 120) {
    const ext = extname(s);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || 'file';
}

async function uniqueName(dir: string, name: string, taken: Set<string>): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
    if (taken.has(candidate)) continue;
    if (!(await lstat(join(dir, candidate)).catch(() => null))) return candidate;
  }
}

export async function saveUploads(req: FastifyRequest, targetDir: string): Promise<string[]> {
  const saved: string[] = [];
  const taken = new Set<string>();
  let tmp: string | null = null;
  try {
    for await (const part of req.files()) {
      const name = await uniqueName(targetDir, sanitizeFileName(part.filename), taken);
      taken.add(name);
      tmp = join(targetDir, `.${name}.${randomBytes(4).toString('hex')}.part`);
      await pipeline(part.file, createWriteStream(tmp, { flags: 'wx' }));
      if (part.file.truncated) throw new WorkspaceError(413, `File troppo grande: ${part.filename}`);
      await rename(tmp, join(targetDir, name));
      tmp = null;
      saved.push(name);
    }
  } catch (err) {
    if (tmp) await rm(tmp, { force: true });
    await Promise.all(saved.map((n) => rm(join(targetDir, n), { force: true })));
    if (err instanceof WorkspaceError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'FST_FILES_LIMIT' || code === 'FST_REQ_FILE_TOO_LARGE') throw new WorkspaceError(413, 'Troppi file o file troppo grandi in un solo caricamento');
    throw err;
  }
  if (saved.length === 0) throw new WorkspaceError(400, 'Nessun file ricevuto');
  return saved;
}
```

Also widen `WorkspaceError.status` in `packages/core/src/workspace-store.ts` to `400 | 404 | 409 | 413 | 422`.

Note on `sanitizeFileName('Logo Acme (finale).PNG')`: spaces and parentheses become `-`, consecutive dashes collapse: `Logo-Acme-finale-.PNG`.

Append to `packages/core/src/index.ts`:
```ts
export * from './library/upload.ts';
```

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/core/test/upload.test.ts && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): safe multipart uploads with unique sanitized names and limits"
```

---

### Task 6: Codebase collegate in sola lettura (core)

**Files:**
- Create: `packages/core/src/codebases.ts`, `packages/core/test/codebases.test.ts`
- Modify: `packages/core/src/agent/runner.ts`, `packages/core/src/agent/claude-code-runner.ts`, `packages/core/src/workspace-store.ts`, `packages/core/test/claude-code-runner.test.ts`, `packages/core/test/workspace-store.test.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces (`codebases.ts`):
  ```ts
  export function normalizeCodebasePath(p: string): string;            // trims, expands ~ / ~/…, requires absolute (else WorkspaceError 400), strips trailing '/'
  export interface CodebaseCheck { path: string; note?: string; exists: boolean }
  export function checkCodebases(list: LinkedCodebase[]): Promise<CodebaseCheck[]>; // exists = is a directory; dedupes by path, first note wins
  export function readOnlyRules(paths: string[]): string[];             // ['Edit(/' + abs + '/**)', …] → 'Edit(//Users/me/app/**)'
  export function codebaseSnapshot(path: string, exec?: CommandExec): Promise<string | null>; // `git -C <path> status --porcelain=v1 -uall`; null when not a repo / git fails
  ```
  (`Edit(...)` rules cover every file-editing tool of Claude Code — verified live with `Write` on claude 2.1.292, including a path with a space.)
- Produces (`runner.ts`): `AgentTurnRequest.disallowedTools?: string[]`; `BRAND_ALLOWED_TOOLS = [...AGENT_ALLOWED_TOOLS, 'WebFetch', 'Bash(curl:*)']`.
- Produces (`claude-code-runner.ts`): `buildClaudeArgs` pushes `--disallowedTools ...rules` right before the `--allowedTools` group (both variadic; each group is terminated by the next flag).
- Produces (`workspace-store.ts`): `updateProject(slug, patch: { name?: string; description?: string; linkedCodebases?: LinkedCodebase[] }): Promise<ProjectFile>` — paths normalized with `normalizeCodebasePath` (400), deduped; validates with `projectFileSchema`; bumps `updatedAt`; serialized per slug; commits `Progetto aggiornato`.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/codebases.test.ts`:
```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCodebases, codebaseSnapshot, normalizeCodebasePath, readOnlyRules } from '../src/codebases.ts';
import { execCommand } from '../src/exec.ts';

describe('normalizeCodebasePath', () => {
  it('expands ~, strips trailing slashes and requires absolute paths', () => {
    expect(normalizeCodebasePath(' ~/dev/app/ ')).toBe(join(homedir(), 'dev', 'app'));
    expect(normalizeCodebasePath('/Users/me/My App/')).toBe('/Users/me/My App');
    expect((() => { try { normalizeCodebasePath('dev/app'); } catch (e) { return (e as { status: number }).status; } })()).toBe(400);
  });
});

describe('readOnlyRules', () => {
  it('builds absolute Edit deny rules', () => {
    expect(readOnlyRules(['/Users/me/My App', '/opt/x'])).toEqual(['Edit(//Users/me/My App/**)', 'Edit(//opt/x/**)']);
  });
});

describe('checkCodebases', () => {
  it('flags missing folders and files, and dedupes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ms-cb è '));
    await mkdir(join(base, 'app'));
    await writeFile(join(base, 'file.txt'), 'x');
    const r = await checkCodebases([
      { path: join(base, 'app'), note: 'iOS' }, { path: join(base, 'app') }, { path: join(base, 'missing') }, { path: join(base, 'file.txt') },
    ]);
    expect(r).toEqual([
      { path: join(base, 'app'), note: 'iOS', exists: true },
      { path: join(base, 'missing'), exists: false },
      { path: join(base, 'file.txt'), exists: false },
    ]);
  });
});

describe('codebaseSnapshot', () => {
  it('returns git status for repos and null otherwise', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ms-cb-git-'));
    await execCommand('git', ['init', '-q'], { cwd: repo });
    expect(await codebaseSnapshot(repo)).toBe('');
    await writeFile(join(repo, 'new.txt'), 'x');
    expect(await codebaseSnapshot(repo)).toContain('new.txt');
    expect(await codebaseSnapshot(await mkdtemp(join(tmpdir(), 'ms-cb-plain-')))).toBeNull();
  });
});
```

Append to `packages/core/test/claude-code-runner.test.ts` (inside `describe('buildClaudeArgs')`):
```ts
  it('puts deny rules before the allow group', () => {
    const args = buildClaudeArgs({ cwd: '/x', prompt: 'p', addDirs: ['/a b'], disallowedTools: ['Edit(//a b/**)'], allowedTools: ['Bash(node:*)'] });
    expect(args.slice(-4)).toEqual(['--disallowedTools', 'Edit(//a b/**)', '--allowedTools', 'Bash(node:*)']);
    expect(args).toContain('--add-dir');
  });
```

Append to `packages/core/test/workspace-store.test.ts`:
```ts
describe('updateProject', () => {
  it('normalizes and stores linked codebases and commits', async () => {
    const ws = await WorkspaceStore.open(join(base, 'ws'), new Git());
    const { slug } = await ws.createProject({ name: 'Acme' });
    const p = await ws.updateProject(slug, { linkedCodebases: [{ path: '/Users/me/app/', note: 'iOS' }, { path: '/Users/me/app' }] });
    expect(p.linkedCodebases).toEqual([{ path: '/Users/me/app', note: 'iOS' }]);
    const log = await execCommand('git', ['log', '-1', '--format=%s'], { cwd: ws.projectDir(slug) });
    expect(log.stdout.trim()).toBe('Progetto aggiornato');
    expect((await ws.updateProject(slug, { linkedCodebases: [{ path: 'relative' }] }).catch((e) => e)).status).toBe(400);
    expect((await ws.updateProject(slug, { name: ' ' }).catch((e) => e)).status).toBe(400);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/codebases.test.ts packages/core/test/claude-code-runner.test.ts packages/core/test/workspace-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementa `codebases.ts`**

```ts
import { stat } from 'node:fs/promises';
import type { LinkedCodebase } from '@motion-studio/shared';
import { execCommand, type CommandExec } from './exec.ts';

// Defined next to WorkspaceStore (which needs it) to avoid an import cycle.
export { normalizeCodebasePath } from './workspace-store.ts';

export interface CodebaseCheck { path: string; note?: string; exists: boolean }

export async function checkCodebases(list: LinkedCodebase[]): Promise<CodebaseCheck[]> {
  const seen = new Set<string>();
  const out: CodebaseCheck[] = [];
  for (const c of list) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const exists = Boolean((await stat(c.path).catch(() => null))?.isDirectory());
    out.push({ path: c.path, ...(c.note ? { note: c.note } : {}), exists });
  }
  return out;
}

/** Claude Code permission rule syntax: an absolute path is written with a leading '//'. */
export const readOnlyRules = (paths: string[]) => paths.map((p) => `Edit(/${p}/**)`);

export async function codebaseSnapshot(path: string, exec: CommandExec = execCommand): Promise<string | null> {
  const r = await exec('git', ['-C', path, 'status', '--porcelain=v1', '-uall'], { timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}
```

- [ ] **Step 4: Runner e WorkspaceStore**

`runner.ts`: add to `AgentTurnRequest`:
```ts
  /** Permission rules that are always denied (e.g. read-only linked codebases: `Edit(//abs/path/**)`). */
  disallowedTools?: string[];
```
and after `AGENT_ALLOWED_TOOLS`:
```ts
/** Brand analysis also fetches websites and downloads files (spec §6.1). */
export const BRAND_ALLOWED_TOOLS: readonly string[] = [...AGENT_ALLOWED_TOOLS, 'WebFetch', 'Bash(curl:*)'];
```

`claude-code-runner.ts`: in `buildClaudeArgs`, immediately before the `allowedTools` line:
```ts
  if (req.disallowedTools?.length) args.push('--disallowedTools', ...req.disallowedTools);
```

`workspace-store.ts`: add the path helper (re-exported by `codebases.ts`):
```ts
export function normalizeCodebasePath(p: string): string {
  let s = p.trim();
  if (s === '~') s = homedir();
  else if (s.startsWith('~/')) s = join(homedir(), s.slice(2));
  if (!isAbsolute(s)) throw new WorkspaceError(400, `La cartella collegata deve essere un percorso assoluto: ${p}`);
  s = normalize(s);
  return s.length > 1 ? s.replace(/[\\/]+$/, '') : s;
}
```
then add to `WorkspaceStore` (with a `private readonly projectLock = new KeyedMutex();`):
```ts
  updateProject(slug: string, patch: { name?: string; description?: string; linkedCodebases?: LinkedCodebase[] }): Promise<ProjectFile> {
    return this.projectLock.run(slug, async () => {
      const current = await this.getProject(slug);
      const linkedCodebases = patch.linkedCodebases
        ? patch.linkedCodebases.map((c) => ({ path: normalizeCodebasePath(c.path), ...(c.note?.trim() ? { note: c.note.trim() } : {}) }))
            .filter((c, i, all) => all.findIndex((x) => x.path === c.path) === i)
        : current.linkedCodebases;
      const parsed = projectFileSchema.safeParse({ ...current, ...patch, linkedCodebases, updatedAt: new Date().toISOString() });
      if (!parsed.success) throw new WorkspaceError(400, `Progetto non valido: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
      const dir = this.projectDir(slug);
      await writeJsonFileAtomic(join(dir, 'project.json'), parsed.data);
      await this.git.commitAll(dir, 'Progetto aggiornato');
      return parsed.data;
    });
  }
```
(import the `LinkedCodebase` type from `@motion-studio/shared`, `homedir` from `node:os`, `isAbsolute` and `normalize` from `node:path`.)

Append to `packages/core/src/index.ts`: `export * from './codebases.ts';`

- [ ] **Step 5: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): read-only linked codebases with deny rules and integrity snapshots"
```

---

### Task 7: Creatività con brand, asset e codebase collegate

**Files:**
- Modify: `packages/core/src/creatives/prompt.ts`, `packages/core/src/creatives/creative-turns.ts`, `packages/core/src/project-template.ts`, `packages/core/src/server/creative-routes.ts`, `packages/core/test/fixtures/fake-claude.mjs`, `packages/core/test/prompt.test.ts`, `packages/core/test/creative-turns.test.ts`, `packages/core/test/creative-routes.test.ts`

**Interfaces:**
- Consumes: `BrandStore` (Task 3), `LibraryStore` (Task 4), `checkCodebases`, `readOnlyRules`, `codebaseSnapshot`, `normalizeCodebasePath` (Task 6), `projectFileSchema` (Fase 1).
- Produces:
  - `PromptInput.context?: CreativeContext` with
    ```ts
    export interface CreativeContext {
      kit: BrandKit; hasGuidelines: boolean; assets: number; references: number;
      codebases: Array<{ path: string; note?: string }>; missingCodebases: string[];
    }
    ```
    `buildCreativePrompt` adds (before "## Formati richiesti", on `first` and `iteration` prompts only) a `## Brand` section: one line per color `- Colore <name> (<role>): <hex>`, per font `- Font <role>: <family>[ (pesi …)][ — file <file>]`, per logo `- Logo <variant> (sfondo <background>): <file>`, `- Tono: …`, `- Fare: …` / `- Evitare: …` per item, `- Stile fotografico: …`, `- Linee guida complete: brand/guidelines.md` when present, `- Asset disponibili: <n> (elenco in assets/assets.json)`, `- Riferimenti: <n> (references/references.json)`; omitted lines when empty; the whole section omitted when everything is empty. Then a `## Codebase di riferimento (sola lettura)` section listing `- <path>[: <note>]` and `- <path>: non disponibile in questo turno` for missing ones, plus `Non modificare mai file in queste cartelle: leggile soltanto.`
  - `CONTEXT_MD` gains `## Brand e asset` explaining `brand/brand-kit.json`, `brand/guidelines.md`, `assets/assets.json`, `references/references.json`, and that brand rules have priority over generic choices.
  - `CreativeTurnService.run`: builds the context (project `linkedCodebases` ∪ creative `linkedCodebases`), passes `addDirs` (existing ones) and `disallowedTools: readOnlyRules(existing)`; appends a `system` info entry `Codebase non trovata, ignorata in questo turno: <path>` for each missing one; snapshots existing ones before and after **each** agent turn and appends a `system` error entry `Attenzione: la codebase <path> risulta modificata durante il turno. Controlla le modifiche.` when a snapshot changed. A corrupt brand kit or library file must not block the turn: the context then omits that part and a `system` info entry says `Brand kit non leggibile: <errore>` (resp. asset).
  - `CreativeTurnService.updateBrief` patch gains `linkedCodebases?: LinkedCodebase[]` (normalized); creative routes accept `linkedCodebases` in create (`POST …/creatives`) and edit (`PUT …/creatives/:c`) bodies.

- [ ] **Step 1: Finto `claude`: scenario che tocca una codebase**

In `fake-claude.mjs`, after the `render` scenarios add:
```js
  if (scenario === 'render_touch' && block) { render(false); if (process.env.FAKE_CLAUDE_TOUCH) writeFileSync(process.env.FAKE_CLAUDE_TOUCH, 'modified'); }
```

- [ ] **Step 2: Test che falliscono**

Append to `packages/core/test/prompt.test.ts`:
```ts
describe('brand and codebase context', () => {
  const manual = { kind: 'manual' as const, ref: null };
  const context = {
    kit: { schemaVersion: 1 as const, colors: [{ id: 'blu', name: 'Blu Acme', hex: '#1E3A5F', role: 'primary' as const, source: manual }],
      fonts: [{ id: 'titoli', family: 'Manrope', role: 'heading' as const, weights: [700, 800], file: 'assets/fonts/manrope.woff2', source: manual }],
      logos: [{ id: 'logo', file: 'assets/logo.svg', variant: 'primary' as const, background: 'light' as const, source: manual }],
      tone: { id: 'tone', text: 'Diretto', source: manual }, dos: [{ id: 'd1', text: 'Usa foto reali', source: manual }],
      donts: [{ id: 'n1', text: 'Niente gradienti', source: manual }], photoStyle: null },
    hasGuidelines: true, assets: 12, references: 3,
    codebases: [{ path: '/Users/me/app ios', note: 'schermate in /Screens' }], missingCodebases: ['/Users/me/old'],
  };
  it('adds brand and read-only codebase sections to first and iteration prompts', () => {
    for (const kind of ['first', 'iteration'] as const) {
      const p = buildCreativePrompt({ ...base, kind, userText: 'x', context });
      expect(p).toContain('- Colore Blu Acme (primary): #1E3A5F');
      expect(p).toContain('- Font heading: Manrope (pesi 700, 800) — file assets/fonts/manrope.woff2');
      expect(p).toContain('- Logo primary (sfondo light): assets/logo.svg');
      expect(p).toContain('- Evitare: Niente gradienti');
      expect(p).toContain('- Linee guida complete: brand/guidelines.md');
      expect(p).toContain('- Asset disponibili: 12 (elenco in assets/assets.json)');
      expect(p).toContain('## Codebase di riferimento (sola lettura)');
      expect(p).toContain('- /Users/me/app ios: schermate in /Screens');
      expect(p).toContain('- /Users/me/old: non disponibile in questo turno');
    }
  });
  it('omits empty sections and never adds them to fix prompts', () => {
    const empty = { ...context, kit: { ...context.kit, colors: [], fonts: [], logos: [], tone: null, dos: [], donts: [] }, hasGuidelines: false, assets: 0, references: 0, codebases: [], missingCodebases: [] };
    expect(buildCreativePrompt({ ...base, kind: 'first', context: empty })).not.toContain('## Brand');
    expect(buildCreativePrompt({ ...base, kind: 'fix', problems: ['x'], context })).not.toContain('## Brand');
  });
});
```

Append to `packages/core/test/creative-turns.test.ts`:
```ts
describe('brand and codebases in creative turns', () => {
  it('passes existing codebases read-only, warns about missing ones and adds the brand to the prompt', async () => {
    const cbBase = await mkdtemp(join(tmpdir(), 'ms-cb è '));
    const appDir = join(cbBase, 'app ios');
    await mkdir(appDir);
    const ws = await WorkspaceStore.open(ref.root, new Git());
    await ws.updateProject(ref.projectSlug, { linkedCodebases: [{ path: appDir, note: 'iOS' }, { path: join(cbBase, 'missing') }] });
    await new BrandStore(ref.projectDir).writeKit({ schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: { kind: 'manual', ref: null } }] });
    await finalState((await service.start(ref)).id);
    const { prompt, args } = (await prompts())[0]!;
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', appDir]);
    expect(args).toContain(`Edit(/${appDir}/**)`);
    expect(prompt).toContain('- Colore Blu (primary): #1E3A5F');
    expect(prompt).toContain(`- ${appDir}: iOS`);
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.text === `Codebase non trovata, ignorata in questo turno: ${join(cbBase, 'missing')}`)).toBe(true);
  });
  it('warns when a linked git codebase changed during the turn', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ms-cb-git-'));
    await execCommand('git', ['init', '-q'], { cwd: repo });
    const ws = await WorkspaceStore.open(ref.root, new Git());
    await ws.updateProject(ref.projectSlug, { linkedCodebases: [{ path: repo }] });
    process.env.FAKE_CLAUDE_SCENARIO = 'render_touch';
    process.env.FAKE_CLAUDE_TOUCH = join(repo, 'touched.txt');
    await finalState((await service.start(ref)).id);
    delete process.env.FAKE_CLAUDE_TOUCH;
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.level === 'error' && e.text.includes(`la codebase ${repo} risulta modificata`))).toBe(true);
  });
  it('keeps working with a corrupt brand kit', async () => {
    await mkdir(join(ref.projectDir, 'brand'), { recursive: true });
    await writeFile(join(ref.projectDir, 'brand', 'brand-kit.json'), '{oops');
    const job = await service.start(ref);
    expect(await finalState(job.id)).toBe('succeeded');
    const conv = await store.readConversation(ref.creativeSlug);
    expect(conv.some((e) => e.type === 'system' && e.text.startsWith('Brand kit non leggibile'))).toBe(true);
  });
});
```
(add imports: `mkdir` from `node:fs/promises`, `BrandStore` from `../src/brand/brand-store.ts`.)

Append to `packages/core/test/creative-routes.test.ts`:
```ts
describe('creative linked codebases', () => {
  it('accepts and normalizes linkedCodebases on create and edit', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects/acme/creatives', payload: { title: 'C', brief, linkedCodebases: [{ path: '/tmp/app/' }] } });
    expect(res.json().creative.linkedCodebases).toEqual([{ path: '/tmp/app' }]);
    const bad = await app.inject({ method: 'PUT', url: `/api/projects/acme/creatives/${res.json().slug}`, payload: { linkedCodebases: [{ path: 'rel' }] } });
    expect(bad.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/prompt.test.ts packages/core/test/creative-turns.test.ts packages/core/test/creative-routes.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementa il prompt**

In `packages/core/src/creatives/prompt.ts`:
```ts
import type { BrandKit } from '@motion-studio/shared';

export interface CreativeContext {
  kit: BrandKit; hasGuidelines: boolean; assets: number; references: number;
  codebases: Array<{ path: string; note?: string }>; missingCodebases: string[];
}

export function contextSections(c: CreativeContext): string[] {
  const k = c.kit;
  const brand = [
    ...k.colors.map((x) => `- Colore ${x.name} (${x.role}): ${x.hex}`),
    ...k.fonts.map((x) => `- Font ${x.role}: ${x.family}${x.weights.length ? ` (pesi ${x.weights.join(', ')})` : ''}${x.file ? ` — file ${x.file}` : ''}`),
    ...k.logos.map((x) => `- Logo ${x.variant} (sfondo ${x.background}): ${x.file}`),
    ...(k.tone ? [`- Tono: ${k.tone.text}`] : []),
    ...k.dos.map((x) => `- Fare: ${x.text}`),
    ...k.donts.map((x) => `- Evitare: ${x.text}`),
    ...(k.photoStyle ? [`- Stile fotografico: ${k.photoStyle.text}`] : []),
    ...(c.hasGuidelines ? ['- Linee guida complete: brand/guidelines.md'] : []),
    ...(c.assets ? [`- Asset disponibili: ${c.assets} (elenco in assets/assets.json)`] : []),
    ...(c.references ? [`- Riferimenti: ${c.references} (references/references.json)`] : []),
  ];
  const out: string[] = [];
  if (brand.length) out.push('', '## Brand', ...brand);
  if (c.codebases.length || c.missingCodebases.length) {
    out.push('', '## Codebase di riferimento (sola lettura)',
      ...c.codebases.map((x) => `- ${x.path}${x.note ? `: ${x.note}` : ''}`),
      ...c.missingCodebases.map((p) => `- ${p}: non disponibile in questo turno`),
      'Non modificare mai file in queste cartelle: leggile soltanto.');
  }
  return out;
}
```
Add `context?: CreativeContext` to `PromptInput`, and in `buildCreativePrompt`, right before the `'', '## Formati richiesti'` push: `if (i.context && i.kind !== 'fix') parts.push(...contextSections(i.context));`

In `project-template.ts` append to `CONTEXT_MD`:
```md

## Brand e asset
- \`brand/brand-kit.json\`: colori, font, loghi, tono, cose da fare e da evitare (ogni voce con la sua fonte).
- \`brand/guidelines.md\`: linee guida discorsive.
- \`assets/assets.json\`: elenco degli asset con descrizione, tag e origine; i file sono in \`assets/\`.
- \`references/references.json\`: immagini di riferimento con note; i file sono in \`references/\`.
Le regole del brand hanno la precedenza sulle scelte generiche. Usa gli asset del progetto prima di generarne di nuovi.
```

- [ ] **Step 5: Implementa nel servizio**

In `packages/core/src/creatives/creative-turns.ts`:
1. Imports: `readJsonFile` (`../json-file.ts`), `projectFileSchema`, `type LinkedCodebase` (`@motion-studio/shared`), `BrandStore` (`../brand/brand-store.ts`), `LibraryStore` (`../library/library-store.ts`), `checkCodebases, codebaseSnapshot, normalizeCodebasePath, readOnlyRules` (`../codebases.ts`), `type CreativeContext` (`./prompt.ts`).
2. New private method:
```ts
  private async buildContext(ref: CreativeRef, store: CreativeStore, creativeCodebases: LinkedCodebase[]): Promise<{ context: CreativeContext; existing: string[] }> {
    const note = (text: string) => store.appendConversation(ref.creativeSlug, { type: 'system', at: now(), level: 'info', text });
    const brand = new BrandStore(ref.projectDir);
    const library = new LibraryStore(ref.projectDir, this.deps.media);
    let kit = EMPTY_BRAND_KIT;
    try { kit = await brand.readKit(); } catch (e) { await note(`Brand kit non leggibile: ${(e as Error).message}`); }
    const hasGuidelines = (await brand.readGuidelines().catch(() => '')).trim() !== '';
    let assets = 0;
    try { assets = (await library.listAssets()).length; } catch (e) { await note(`Elenco asset non leggibile: ${(e as Error).message}`); }
    const references = (await library.listReferences().catch(() => [])).length;
    const project = await readJsonFile(join(ref.projectDir, 'project.json'), projectFileSchema);
    const checks = await checkCodebases([...project.linkedCodebases, ...creativeCodebases]);
    for (const c of checks.filter((x) => !x.exists)) await note(`Codebase non trovata, ignorata in questo turno: ${c.path}`);
    const existing = checks.filter((c) => c.exists);
    return {
      context: { kit, hasGuidelines, assets, references, codebases: existing.map(({ path, note: n }) => ({ path, ...(n ? { note: n } : {}) })), missingCodebases: checks.filter((c) => !c.exists).map((c) => c.path) },
      existing: existing.map((c) => c.path),
    };
  }
```
3. In `run()`, after computing `presets`/`model`: `const { context, existing } = await this.buildContext(ref, store, creative.linkedCodebases);`
4. Pass `context` to `buildCreativePrompt({...})` and add to the runner request: `addDirs: existing, disallowedTools: readOnlyRules(existing),`.
5. Around each agent turn: before `this.deps.runner.start`, `const before = await Promise.all(existing.map((p) => codebaseSnapshot(p)));`; after `await lastWrite;` (and before the cancelled/failed checks):
```ts
        const after = await Promise.all(existing.map((p) => codebaseSnapshot(p)));
        for (const [k, p] of existing.entries()) {
          if (before[k] !== null && after[k] !== before[k]) {
            await store.appendConversation(slug, { type: 'system', at: now(), level: 'error', text: `Attenzione: la codebase ${p} risulta modificata durante il turno. Controlla le modifiche.` });
          }
        }
```
6. `updateBrief` patch type gains `linkedCodebases?: LinkedCodebase[]`; normalize with `normalizeCodebasePath` (dedupe) before `store.update(...)` (extend `CreativeStore.update`'s accepted keys with `'linkedCodebases'`).

In `packages/core/src/server/creative-routes.ts`: add `linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional()` to `createBody` and `editBody`; on create, normalize the paths (`normalizeCodebasePath`, dedupe) and pass them via `store.update(slug, { linkedCodebases })` right after `store.create` (before generating); on edit, forward to `turns.updateBrief`.

- [ ] **Step 6: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS, `creative-turns.test.ts` 3 volte di fila senza flaky.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): creatives use brand kit, library and read-only linked codebases"
```

---

### Task 8: Analisi brand e descrizione asset con l'agente

**Files:**
- Create: `packages/core/src/brand/brand-prompt.ts`, `packages/core/src/brand/brand-analysis.ts`, `packages/core/test/brand-analysis.test.ts`
- Modify: `packages/core/test/fixtures/fake-claude.mjs`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `BrandStore`, `diffBrandKits`, `applyBrandChanges` (Task 3); `LibraryStore` (Task 4); `BRAND_ALLOWED_TOOLS`, `AGENT_ALLOWED_TOOLS` (Task 6); `JobQueue`, `AgentRunner`, `Git`, `MediaTools`, `KeyedMutex`, `WorkspaceError` (Fasi 1–2).
- Produces (`brand-prompt.ts`):
  ```ts
  export interface BrandBlock { proposalDir: string; kitFile: string; guidelinesFile: string; assetsListFile: string; summaryFile: string;
    sources: Array<{ id: string; kind: 'website' | 'image'; url: string | null; file: string | null }> }   // paths relative to the project
  export function buildBrandPrompt(block: BrandBlock): string;     // ends with ```motion-studio-brand\n<json>\n```
  export interface DescribeBlock { outFile: string; files: string[] }  // files relative to the project (assets/…)
  export function buildDescribePrompt(block: DescribeBlock): string; // ends with ```motion-studio-describe\n<json>\n```
  ```
- Produces (`brand-analysis.ts`):
  ```ts
  export interface ProjectRef { root: string; projectSlug: string; projectDir: string }
  export const brandJobKey: (root: string, slug: string) => string;     // `brand:${root}:${slug}` (analysis and description share it: one brand job per project)
  export interface BrandServiceDeps { queue: JobQueue; runner: AgentRunner; git: Git; media: MediaTools; model: () => Promise<string | null>; broadcast: (m: ServerMessage) => void }
  export class BrandService {
    constructor(deps: BrandServiceDeps)
    analyze(ref: ProjectRef, sourceIds?: string[]): Promise<JobSummary>   // default: all sources; 400 none; 409 active
    describeAssets(ref: ProjectRef, files?: string[]): Promise<JobSummary> // default: assets with empty description; 400 none; 409 active
    applyProposal(ref: ProjectRef, id: string, acceptedIds: string[], applyGuidelines: boolean): Promise<{ kit: BrandKit; proposal: BrandProposal }> // 409 if not open
    discardProposal(ref: ProjectRef, id: string): Promise<BrandProposal>   // 409 if not open
  }
  ```
- Analysis job behaviour:
  1. `id = newProposalId()`; copy the current kit to `<proposalDir>/brand-kit.json` and current guidelines to `<proposalDir>/guidelines.md` (the agent edits these copies: existing ids stay stable, manual items stay untouched unless clearly wrong); snapshot `unregisteredAssets()`.
  2. Run the agent (cwd project, `allowedTools: BRAND_ALLOWED_TOOLS`, new session) with `buildBrandPrompt`; agent events are broadcast and appended to `<proposalDir>/log.jsonl`.
  3. Failed/cancelled agent → remove the proposal folder, job failed/cancelled.
  4. Read `<proposalDir>/brand-kit.json` with `brandKitSchema`: invalid → remove the folder and fail with `Proposta non valida: <issues>`. Logos/fonts whose `file` does not exist as a regular file in the project are dropped and listed in the summary (`Voci scartate: …`).
  5. Read `<proposalDir>/assets.json` leniently (array; each item `{ file, sourceUrl?, description?, tags? }` validated alone; invalid items skipped); register existing ones with `origin: 'website'`; also register files under `assets/` that appeared during the job and were not listed (`origin: 'website'`, `sourceUrl: null`).
  6. `changes = diffBrandKits(currentKit, proposedKit)`; `guidelines = proposed !== current ? { current, proposed } : null`; `summary` = `<proposalDir>/summary.md` (first 2000 chars) + discarded items note; write `proposal.json` (`status: 'open'`, `assetsAdded`); `markAnalyzed(sourceIds)`; commit `Analisi brand <id>`; broadcast `brand` and `library`.
- Describe job: run the agent (`allowedTools: AGENT_ALLOWED_TOOLS`) with `buildDescribePrompt({ outFile: 'assets/.describe/<jobId>.json', files })`; read the out file leniently (`[{ file, description, tags }]`), `updateAsset` for the requested files only, delete the out file, commit `Descrizione asset`, broadcast `library`.
- `applyProposal`: `applyBrandChanges(currentKit, proposal.changes, acceptedIds)` → `writeKit`; when `applyGuidelines` and `proposal.guidelines`, write `proposal.guidelines.proposed`; proposal `status: 'applied'`; commit `Applica proposta <id>`; broadcast `brand`. `discardProposal`: status `discarded`, commit, broadcast.

- [ ] **Step 1: Finto `claude`: scenari brand e describe**

In `fake-claude.mjs`, after the creative scenarios:
```js
  const brandBlock = (() => { const m = prompt.match(/```motion-studio-brand\n([\s\S]*?)\n```/); return m ? JSON.parse(m[1]) : null; })();
  if (brandBlock && (scenario === 'brand' || scenario === 'render')) {
    const kit = JSON.parse(readFileSync(brandBlock.kitFile, 'utf8'));
    const url = brandBlock.sources.find((s) => s.kind === 'website')?.url ?? 'https://acme.example';
    kit.colors.push({ id: 'arancio', name: 'Arancio', hex: '#FF7A45', role: 'accent', source: { kind: 'website', ref: url } });
    mkdirSync('assets/brand', { recursive: true });
    writeFileSync('assets/brand/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync('assets/brand/unlisted.png', 'x');
    kit.logos.push({ id: 'logo', file: 'assets/brand/logo.svg', variant: 'primary', background: 'light', source: { kind: 'website', ref: url } });
    kit.logos.push({ id: 'ghost', file: 'assets/brand/ghost.svg', variant: 'icon', background: 'any', source: { kind: 'website', ref: url } });
    writeFileSync(brandBlock.kitFile, JSON.stringify(kit));
    writeFileSync(brandBlock.guidelinesFile, '# Linee guida\nTono energico.');
    writeFileSync(brandBlock.assetsListFile, JSON.stringify([{ file: 'brand/logo.svg', sourceUrl: `${url}/logo.svg`, description: 'Logo principale', tags: ['logo'] }, { file: '../evil' }]));
    writeFileSync(brandBlock.summaryFile, 'Palette arancio/blu, tono energico.');
  }
  if (brandBlock && scenario === 'brand_invalid') writeFileSync(brandBlock.kitFile, '{oops');
  const describeBlock = (() => { const m = prompt.match(/```motion-studio-describe\n([\s\S]*?)\n```/); return m ? JSON.parse(m[1]) : null; })();
  if (describeBlock) {
    mkdirSync(dirname(describeBlock.outFile), { recursive: true });
    writeFileSync(describeBlock.outFile, JSON.stringify(describeBlock.files.map((f) => ({ file: f.replace(/^assets\//, ''), description: `Descrizione di ${f}`, tags: ['auto'] }))));
  }
```
(add `readFileSync` to the `node:fs` import and `dirname` to the `node:path` import.)

- [ ] **Step 2: Test che falliscono**

`packages/core/test/brand-analysis.test.ts`:
```ts
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage } from '@motion-studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { BrandService, type ProjectRef } from '../src/brand/brand-analysis.ts';
import { BrandStore } from '../src/brand/brand-store.ts';
import { execCommand } from '../src/exec.ts';
import { Git } from '../src/git.ts';
import { JobQueue } from '../src/jobs/job-queue.ts';
import { LibraryStore } from '../src/library/library-store.ts';
import { NoMediaTools } from '../src/media/media-tools.ts';
import { WorkspaceStore } from '../src/workspace-store.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let ref: ProjectRef;
let queue: JobQueue;
let service: BrandService;
let brand: BrandStore;
let messages: ServerMessage[];
let promptFile: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ms-ba è '));
  const git = new Git();
  const ws = await WorkspaceStore.open(join(base, 'ws'), git);
  const { slug } = await ws.createProject({ name: 'Acme' });
  ref = { root: ws.root, projectSlug: slug, projectDir: ws.projectDir(slug) };
  queue = new JobQueue({ concurrency: 2 });
  messages = [];
  service = new BrandService({ queue, git, media: NoMediaTools, runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }), model: async () => null, broadcast: (m) => messages.push(m) });
  brand = new BrandStore(ref.projectDir);
  await brand.writeKit({ schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: { kind: 'manual', ref: null } }] });
  await brand.addSource({ kind: 'website', url: 'https://acme.example' });
  promptFile = join(base, 'prompts.jsonl');
  process.env.FAKE_CLAUDE_PROMPT_FILE = promptFile;
  process.env.FAKE_CLAUDE_SCENARIO = 'brand';
});
afterEach(() => { delete process.env.FAKE_CLAUDE_SCENARIO; delete process.env.FAKE_CLAUDE_PROMPT_FILE; });
const done = async (id: string) => { await queue.whenIdle(); return queue.list().find((j) => j.id === id)!; };

describe('analyze', () => {
  it('produces an open proposal, registers downloaded assets and never touches the kit', async () => {
    const job = await service.analyze(ref);
    expect((await done(job.id)).state).toBe('succeeded');
    const [p] = await brand.listProposals();
    expect(p).toMatchObject({ status: 'open', sourceIds: ['s-1'], assetsAdded: ['brand/logo.svg', 'brand/unlisted.png'] });
    expect(p!.changes.map((c) => c.id)).toEqual(['colors:add:arancio', 'logos:add:logo']);
    expect(p!.summary).toContain('Palette arancio/blu');
    expect(p!.summary).toContain('ghost');
    expect(p!.guidelines).toEqual({ current: '', proposed: '# Linee guida\nTono energico.' });
    expect((await brand.readKit()).colors.map((c) => c.id)).toEqual(['blu']);
    const assets = await new LibraryStore(ref.projectDir, NoMediaTools).listAssets();
    expect(assets.find((a) => a.file === 'brand/logo.svg')).toMatchObject({ origin: 'website', description: 'Logo principale', sourceUrl: 'https://acme.example/logo.svg' });
    expect(assets.find((a) => a.file === 'brand/unlisted.png')).toMatchObject({ origin: 'website', sourceUrl: null });
    expect((await brand.readSources())[0]!.lastAnalyzedAt).not.toBeNull();
    const { prompt, args } = JSON.parse((await readFile(promptFile, 'utf8')).trim().split('\n')[0]!);
    expect(prompt).toContain('https://acme.example');
    expect(args).toContain('WebFetch');
    expect(messages.some((m) => m.type === 'brand')).toBe(true);
    const log = await execCommand('git', ['log', '-1', '--format=%s'], { cwd: ref.projectDir });
    expect(log.stdout.trim()).toBe(`Analisi brand ${p!.id}`);
  });
  it('fails cleanly on an invalid proposed kit and leaves no proposal', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'brand_invalid';
    const job = await done((await service.analyze(ref)).id);
    expect(job.state).toBe('failed');
    expect(job.error).toContain('Proposta non valida');
    expect(await brand.listProposals()).toEqual([]);
  });
  it('refuses to start without sources and while another brand job runs', async () => {
    await brand.removeSource('s-1');
    expect((await service.analyze(ref).catch((e) => e)).status).toBe(400);
    await brand.addSource({ kind: 'website', url: 'https://acme.example' });
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const job = await service.analyze(ref);
    expect((await service.analyze(ref).catch((e) => e)).status).toBe(409);
    queue.cancel(job.id);
    await queue.whenIdle();
    expect(await brand.listProposals()).toEqual([]);
  });
});

describe('apply / discard', () => {
  it('applies only accepted changes and the guidelines when asked', async () => {
    await done((await service.analyze(ref)).id);
    const [p] = await brand.listProposals();
    const { kit, proposal } = await service.applyProposal(ref, p!.id, ['colors:add:arancio'], true);
    expect(kit.colors.map((c) => c.id)).toEqual(['blu', 'arancio']);
    expect(kit.logos).toEqual([]);
    expect(proposal.status).toBe('applied');
    expect(await brand.readGuidelines()).toBe('# Linee guida\nTono energico.');
    expect((await service.applyProposal(ref, p!.id, [], false).catch((e) => e)).status).toBe(409);
  });
  it('discards without touching the kit', async () => {
    await done((await service.analyze(ref)).id);
    const [p] = await brand.listProposals();
    expect((await service.discardProposal(ref, p!.id)).status).toBe('discarded');
    expect((await brand.readKit()).colors).toHaveLength(1);
  });
});

describe('describeAssets', () => {
  it('fills descriptions of assets without one', async () => {
    const lib = new LibraryStore(ref.projectDir, NoMediaTools);
    await writeFile(join(ref.projectDir, 'assets', 'foto.jpg'), 'x');
    await lib.registerAssets([{ file: 'foto.jpg', origin: 'upload' }]);
    const job = await done((await service.describeAssets(ref)).id);
    expect(job.state).toBe('succeeded');
    expect((await lib.listAssets())[0]).toMatchObject({ description: 'Descrizione di assets/foto.jpg', tags: ['auto'] });
    await expect(stat(join(ref.projectDir, 'assets', '.describe'))).resolves.toBeTruthy();
    expect((await service.describeAssets(ref).catch((e) => e)).status).toBe(400);
  });
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/brand-analysis.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementa `brand-prompt.ts`**

```ts
export interface BrandBlock {
  proposalDir: string; kitFile: string; guidelinesFile: string; assetsListFile: string; summaryFile: string;
  sources: Array<{ id: string; kind: 'website' | 'image'; url: string | null; file: string | null }>;
}
export interface DescribeBlock { outFile: string; files: string[] }

export function buildBrandPrompt(b: BrandBlock): string {
  return [
    'Analizza il brand di questo progetto a partire dalle sorgenti indicate e proponi un aggiornamento del brand kit.',
    '', '## Sorgenti',
    ...b.sources.map((s) => (s.kind === 'website' ? `- Sito (${s.id}): ${s.url}` : `- Immagine (${s.id}): ${s.file} (leggila)`)),
    '', '## Cosa fare',
    `1. Visita i siti (WebFetch; per scaricare file usa curl) e osserva le immagini. Ricava palette, font, loghi, tono di voce, cose da fare e da evitare, stile fotografico.`,
    `2. Aggiorna la COPIA del brand kit in ${b.kitFile} (stesso formato di brand/brand-kit.json): mantieni gli id delle voci esistenti, usa id nuovi in kebab-case per le voci nuove, imposta source = {"kind":"website","ref":"<url>"} o {"kind":"image","ref":"<file>"}. Non modificare le voci con source "manual" a meno che siano chiaramente sbagliate.`,
    `3. Scarica in assets/brand/ (immagini, loghi) e assets/fonts/ (font) solo gli asset utili e con licenza d'uso plausibile per il brand; i loghi e i font nel kit devono puntare a file esistenti (es. "assets/brand/logo.svg").`,
    `4. Elenca gli asset scaricati in ${b.assetsListFile}: array JSON di {"file": "<percorso relativo ad assets/>", "sourceUrl": "<url>", "description": "<breve>", "tags": ["…"]}.`,
    `5. Aggiorna la COPIA delle linee guida in ${b.guidelinesFile} (Markdown, in italiano): integra, non riscrivere da zero quello che c'è.`,
    `6. Scrivi in ${b.summaryFile} un riepilogo di 3-6 righe di cosa hai trovato.`,
    'Non modificare brand/brand-kit.json né brand/guidelines.md: Motion Studio mostrerà le modifiche all\'utente per l\'approvazione.',
    'Rispondi sempre in italiano.',
    '', '```motion-studio-brand', JSON.stringify(b), '```',
  ].join('\n');
}

export function buildDescribePrompt(d: DescribeBlock): string {
  return [
    'Descrivi questi asset del progetto per aiutare a sceglierli nelle creatività.',
    ...d.files.map((f) => `- ${f}`),
    '', `Leggi ogni file (immagini e video: guardali; font e altri file: deduci dal nome e dal contenuto) e scrivi in ${d.outFile} un array JSON di {"file": "<percorso relativo ad assets/>", "description": "<1-2 frasi in italiano>", "tags": ["3-6 tag brevi"]}.`,
    'Non modificare né spostare gli asset. Rispondi sempre in italiano.',
    '', '```motion-studio-describe', JSON.stringify(d), '```',
  ].join('\n');
}
```

- [ ] **Step 5: Implementa `brand-analysis.ts`**

```ts
import { appendFile, copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { brandKitSchema, relativeFileSchema, type BrandKit, type BrandProposal, type JobSummary, type ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import { AGENT_ALLOWED_TOOLS, BRAND_ALLOWED_TOOLS, type AgentRunner } from '../agent/runner.ts';
import type { Git } from '../git.ts';
import { JobConflictError, type JobQueue } from '../jobs/job-queue.ts';
import { JsonFileError, readJsonFile } from '../json-file.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError } from '../workspace-store.ts';
import { applyBrandChanges, diffBrandKits } from './brand-diff.ts';
import { buildBrandPrompt, buildDescribePrompt } from './brand-prompt.ts';
import { BrandStore } from './brand-store.ts';

export interface ProjectRef { root: string; projectSlug: string; projectDir: string }
export const brandJobKey = (root: string, slug: string) => `brand:${root}:${slug}`;
export interface BrandServiceDeps { queue: JobQueue; runner: AgentRunner; git: Git; media: MediaTools; model: () => Promise<string | null>; broadcast: (m: ServerMessage) => void }

const listedAsset = z.object({ file: relativeFileSchema, sourceUrl: z.string().url().nullish(), description: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const describedAsset = z.object({ file: relativeFileSchema, description: z.string().max(2000), tags: z.array(z.string().min(1).max(40)).max(30).optional() });

async function readLenient<T>(path: string, item: z.ZodType<T>): Promise<T[]> {
  const raw = await readFile(path, 'utf8').catch(() => '[]');
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  return Array.isArray(data) ? data.flatMap((d) => { const r = item.safeParse(d); return r.success ? [r.data] : []; }) : [];
}
const isFile = async (p: string) => Boolean((await lstat(p).catch(() => null))?.isFile());

export class BrandService {
  private readonly locks = new KeyedMutex();
  constructor(private readonly deps: BrandServiceDeps) {}

  private isActive(key: string) { return this.deps.queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running')); }
  private changed(ref: ProjectRef, ...types: Array<'brand' | 'library'>) { for (const type of types) this.deps.broadcast({ type, project: ref.projectSlug }); }

  analyze(ref: ProjectRef, sourceIds?: string[]): Promise<JobSummary> {
    const key = brandJobKey(ref.root, ref.projectSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new JobConflictError(key);
      const store = new BrandStore(ref.projectDir);
      const all = await store.readSources();
      const sources = sourceIds ? all.filter((s) => sourceIds.includes(s.id)) : all;
      if (sources.length === 0) throw new WorkspaceError(400, 'Aggiungi almeno un sito o un\'immagine da analizzare');
      return this.deps.queue.enqueue({ key, label: 'Analisi brand', run: (signal, jobId) => this.runAnalysis(ref, store, sources, signal, jobId) });
    });
  }

  private async runAgent(ref: ProjectRef, prompt: string, allowedTools: readonly string[], logFile: string | null, signal: AbortSignal, jobId: string): Promise<'ok' | 'cancelled'> {
    const run = this.deps.runner.start({ cwd: ref.projectDir, prompt, model: (await this.deps.model()) ?? undefined, allowedTools: [...allowedTools] }, (event) => {
      this.deps.broadcast({ type: 'agent', jobId, event });
      if (logFile) void appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`).catch(() => {});
    });
    const onAbort = () => run.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const outcome = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
    if (outcome.status === 'cancelled') return 'cancelled';
    if (outcome.status === 'failed') throw new Error(outcome.error ?? 'Turno non riuscito');
    return 'ok';
  }

  private async runAnalysis(ref: ProjectRef, store: BrandStore, sources: Awaited<ReturnType<BrandStore['readSources']>>, signal: AbortSignal, jobId: string): Promise<void | 'cancelled'> {
    const library = new LibraryStore(ref.projectDir, this.deps.media);
    const id = await store.newProposalId();
    const dir = store.proposalDir(id);
    const rel = (p: string) => relative(ref.projectDir, p).split('\\').join('/');
    try {
      const currentKit = await store.readKit();
      const currentGuidelines = await store.readGuidelines();
      await writeFile(join(dir, 'brand-kit.json'), JSON.stringify(currentKit, null, 2));
      await writeFile(join(dir, 'guidelines.md'), currentGuidelines);
      const before = new Set(await library.unregisteredAssets());
      const block = {
        proposalDir: rel(dir), kitFile: rel(join(dir, 'brand-kit.json')), guidelinesFile: rel(join(dir, 'guidelines.md')),
        assetsListFile: rel(join(dir, 'assets.json')), summaryFile: rel(join(dir, 'summary.md')),
        sources: sources.map((s) => ({ id: s.id, kind: s.kind, url: s.url, file: s.file })),
      };
      if ((await this.runAgent(ref, buildBrandPrompt(block), BRAND_ALLOWED_TOOLS, join(dir, 'log.jsonl'), signal, jobId)) === 'cancelled') {
        await rm(dir, { recursive: true, force: true });
        return 'cancelled';
      }
      let proposed: BrandKit;
      try { proposed = await readJsonFile(join(dir, 'brand-kit.json'), brandKitSchema); }
      catch (e) { throw new Error(`Proposta non valida: ${e instanceof JsonFileError ? e.message.replace(/^.*?: /, '') : (e as Error).message}`); }
      const dropped: string[] = [];
      const keepFile = async (file: string | null, label: string) => {
        if (file === null || await isFile(join(ref.projectDir, ...file.split('/')))) return true;
        dropped.push(`${label} (${file} non trovato)`);
        return false;
      };
      proposed = { ...proposed,
        logos: (await Promise.all(proposed.logos.map(async (l) => ((await keepFile(l.file, l.id)) ? l : null)))).filter((l) => l !== null),
        fonts: (await Promise.all(proposed.fonts.map(async (f) => ((await keepFile(f.file, f.id)) ? f : null)))).filter((f) => f !== null) };

      const listed = (await readLenient(join(dir, 'assets.json'), listedAsset)).filter((a) => !a.file.startsWith('.'));
      const existingListed = [];
      for (const a of listed) if (await isFile(library.resolve('assets', a.file))) existingListed.push(a);
      const appeared = (await library.unregisteredAssets()).filter((f) => !before.has(f) && !existingListed.some((a) => a.file === f));
      const registered = await library.registerAssets([
        ...existingListed.map((a) => ({ file: a.file, origin: 'website' as const, sourceUrl: a.sourceUrl ?? null, description: a.description, tags: a.tags })),
        ...appeared.map((file) => ({ file, origin: 'website' as const, sourceUrl: null })),
      ]);

      const proposedGuidelines = await readFile(join(dir, 'guidelines.md'), 'utf8').catch(() => currentGuidelines);
      const summaryText = (await readFile(join(dir, 'summary.md'), 'utf8').catch(() => '')).slice(0, 2000).trim();
      const proposal: BrandProposal = {
        schemaVersion: 1, id, createdAt: new Date().toISOString(), sourceIds: sources.map((s) => s.id), status: 'open',
        summary: [summaryText, dropped.length ? `Voci scartate: ${dropped.join('; ')}` : ''].filter(Boolean).join('\n\n'),
        changes: diffBrandKits(await store.readKit(), proposed),
        guidelines: proposedGuidelines !== currentGuidelines ? { current: currentGuidelines, proposed: proposedGuidelines } : null,
        assetsAdded: registered.map((a) => a.file),
      };
      await store.writeProposal(proposal);
      await store.markAnalyzed(proposal.sourceIds, proposal.createdAt);
      await this.deps.git.commitAll(ref.projectDir, `Analisi brand ${id}`);
      this.changed(ref, 'brand', 'library');
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      this.changed(ref, 'brand');
      throw err;
    }
  }

  describeAssets(ref: ProjectRef, files?: string[]): Promise<JobSummary> {
    const key = brandJobKey(ref.root, ref.projectSlug);
    return this.locks.run(key, async () => {
      if (this.isActive(key)) throw new JobConflictError(key);
      const library = new LibraryStore(ref.projectDir, this.deps.media);
      const assets = await library.listAssets();
      const targets = files ? assets.filter((a) => files.includes(a.file)) : assets.filter((a) => a.description.trim() === '');
      if (targets.length === 0) throw new WorkspaceError(400, 'Nessun asset da descrivere');
      return this.deps.queue.enqueue({
        key, label: 'Descrizione asset',
        run: async (signal, jobId) => {
          const outRel = `assets/.describe/${jobId}.json`;
          const outAbs = join(ref.projectDir, 'assets', '.describe', `${jobId}.json`);
          await mkdir(join(ref.projectDir, 'assets', '.describe'), { recursive: true });
          const prompt = buildDescribePrompt({ outFile: outRel, files: targets.map((t) => `assets/${t.file}`) });
          if ((await this.runAgent(ref, prompt, AGENT_ALLOWED_TOOLS, null, signal, jobId)) === 'cancelled') return 'cancelled';
          const wanted = new Set(targets.map((t) => t.file));
          for (const d of await readLenient(outAbs, describedAsset)) {
            if (wanted.has(d.file)) await library.updateAsset(d.file, { description: d.description, ...(d.tags ? { tags: d.tags } : {}) });
          }
          await rm(outAbs, { force: true });
          await this.deps.git.commitAll(ref.projectDir, 'Descrizione asset');
          this.changed(ref, 'library');
        },
      });
    });
  }

  applyProposal(ref: ProjectRef, id: string, acceptedIds: string[], applyGuidelines: boolean): Promise<{ kit: BrandKit; proposal: BrandProposal }> {
    return this.locks.run(`apply:${ref.projectDir}`, async () => {
      const store = new BrandStore(ref.projectDir);
      const proposal = await store.readProposal(id);
      if (proposal.status !== 'open') throw new WorkspaceError(409, 'La proposta è già stata applicata o scartata');
      const kit = await store.writeKit(applyBrandChanges(await store.readKit(), proposal.changes, acceptedIds));
      if (applyGuidelines && proposal.guidelines) await store.writeGuidelines(proposal.guidelines.proposed);
      const next: BrandProposal = { ...proposal, status: 'applied' };
      await store.writeProposal(next);
      await this.deps.git.commitAll(ref.projectDir, `Applica proposta ${id}`);
      this.changed(ref, 'brand');
      return { kit, proposal: next };
    });
  }

  discardProposal(ref: ProjectRef, id: string): Promise<BrandProposal> {
    return this.locks.run(`apply:${ref.projectDir}`, async () => {
      const store = new BrandStore(ref.projectDir);
      const proposal = await store.readProposal(id);
      if (proposal.status !== 'open') throw new WorkspaceError(409, 'La proposta è già stata applicata o scartata');
      const next: BrandProposal = { ...proposal, status: 'discarded' };
      await store.writeProposal(next);
      await this.deps.git.commitAll(ref.projectDir, `Scarta proposta ${id}`);
      this.changed(ref, 'brand');
      return next;
    });
  }
}
```

Notes:
- `copyFile` is not needed (the copies are written from the parsed data); drop it from the import.
- The `.describe/` folder starts with a dot, so `unregisteredAssets()` ignores it, and the out file is removed after use; the folder itself stays (the test checks it still exists, i.e. the job did not delete outside its file).
- The fake `ghost` logo points to a missing file: it is dropped and named in the summary (Review Focus 1).

Append to `packages/core/src/index.ts`:
```ts
export * from './brand/brand-prompt.ts';
export * from './brand/brand-analysis.ts';
```

- [ ] **Step 6: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS (3 volte di fila per `brand-analysis.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): brand analysis proposals and agent asset descriptions"
```

---

### Task 9: API di brand, libreria, impostazioni progetto e file

**Files:**
- Create: `packages/core/src/server/serve-file.ts`, `packages/core/src/server/brand-routes.ts`, `packages/core/src/server/library-routes.ts`, `packages/core/src/server/project-routes.ts`, `packages/core/test/brand-routes.test.ts`, `packages/core/test/library-routes.test.ts`
- Modify: `packages/core/src/server/creative-routes.ts` (use `sendConfinedFile`), `packages/core/src/server/app.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces (`serve-file.ts`):
  ```ts
  /** Serves base/rel only if rel is under one of the prefixes ('outputs/', 'assets/', …), never through symlinks or '..'; CSP sandbox + nosniff. */
  export function sendConfinedFile(reply: FastifyReply, base: string, rel: string, prefixes: string[]): Promise<FastifyReply>;
  ```
  (the body is the creative file route logic above, moved verbatim; prefixes use '/' and are converted with `sep`.)
- Produces (routes; all mutate → commit in the project and broadcast `brand`/`library`; errors `{ error }`):
  | Method | Path | Body | Result |
  |---|---|---|---|
  | GET | `/api/projects/:slug/brand` | — | `BrandOverview = { kit: BrandKit; kitError: string \| null; guidelines: string; sources: BrandSource[]; sourcesError: string \| null; proposals: BrandProposal[]; jobKey: string }` |
  | PUT | `/api/projects/:slug/brand/kit` | `{ kit }` | `BrandKit` (400 invalid; 422 if the file on disk is corrupt — never overwritten) · commit `Brand kit aggiornato` |
  | PUT | `/api/projects/:slug/brand/guidelines` | `{ text }` | `{ ok: true }` · commit `Linee guida aggiornate` |
  | POST | `/api/projects/:slug/brand/sources` | `{ kind: 'website', url } \| { kind: 'image', file }` | 201 `BrandSource` (image `file` must exist under `references/`) |
  | DELETE | `/api/projects/:slug/brand/sources/:id` | — | `{ ok: true }` |
  | POST | `/api/projects/:slug/brand/analyze` | `{ sourceIds?: string[] }` | 202 `JobSummary`; first adds an image source for every reference with `useForBrand` (409 ignored) |
  | POST | `/api/projects/:slug/brand/proposals/:id/apply` | `{ acceptedIds: string[]; applyGuidelines: boolean }` | `{ kit, proposal }` |
  | POST | `/api/projects/:slug/brand/proposals/:id/discard` | — | `BrandProposal` |
  | GET | `/api/projects/:slug/assets` | — | `{ assets: AssetEntry[]; error: string \| null; unregistered: string[] }` |
  | POST | `/api/projects/:slug/assets` | multipart `files` | 201 `{ assets: AssetEntry[] }` (422 first if `assets.json` is corrupt) |
  | POST | `/api/projects/:slug/assets/register` | `{ files: string[] }` | `{ assets }` (origin `upload`) |
  | POST | `/api/projects/:slug/assets/describe` | `{ files?: string[] }` | 202 `JobSummary` |
  | PATCH | `/api/projects/:slug/assets/item/*` | `{ description?, tags? }` | `AssetEntry` |
  | DELETE | `/api/projects/:slug/assets/item/*` | — | `{ ok: true }` |
  | GET | `/api/projects/:slug/references` | — | `{ references: ReferenceEntry[]; error: string \| null }` |
  | POST | `/api/projects/:slug/references` | multipart `files` | 201 `{ references }` |
  | PATCH / DELETE | `/api/projects/:slug/references/item/*` | `{ note?, useForBrand? }` | `ReferenceEntry` / `{ ok: true }` |
  | GET | `/api/projects/:slug/files/*` | — | file under `assets/` or `references/` only (`sendConfinedFile`) |
  | PUT | `/api/projects/:slug` | `{ name?, description?, linkedCodebases? }` | `ProjectDetail` |
  | GET | `/api/projects/:slug/codebases` | — | `CodebaseCheck[]` (project-level) |
  `BrandOverview` is exported from `@motion-studio/shared` (`brand.ts`) as an interface.
- App wiring (`app.ts`): `await app.register(fastifyMultipart, { limits: UPLOAD_LIMITS })`; `const brandService = new BrandService({ queue, runner: deps.runner, git: deps.git, media, model: …, broadcast })`; `registerBrandRoutes(app, { requireWorkspace, brand: brandService, media, git: deps.git, broadcast })`, `registerLibraryRoutes(app, same)`, `registerProjectRoutes(app, { requireWorkspace })`.

- [ ] **Step 1: Test che falliscono**

`packages/core/test/library-routes.test.ts`:
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
import { multipart } from './helpers/multipart.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;
const P = '/api/projects/acme';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-lr-'));
  app = await buildServer({ appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(() => app.close());

describe('assets API', () => {
  it('uploads, lists, edits, serves and deletes assets', async () => {
    const up = await app.inject({ method: 'POST', url: `${P}/assets`, ...multipart([{ name: 'Logo Acme.svg', content: '<svg/>' }, { name: '../x.png', content: 'p' }]) });
    expect(up.statusCode).toBe(201);
    expect(up.json().assets.map((a: { file: string }) => a.file)).toEqual(['Logo-Acme.svg', 'x.png']);
    const edited = await app.inject({ method: 'PATCH', url: `${P}/assets/item/Logo-Acme.svg`, payload: { description: 'Logo', tags: ['logo'] } });
    expect(edited.json()).toMatchObject({ description: 'Logo', tags: ['logo'] });
    const file = await app.inject(`${P}/files/assets/Logo-Acme.svg`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-security-policy']).toBe('sandbox');
    expect((await app.inject({ method: 'DELETE', url: `${P}/assets/item/x.png` })).json()).toEqual({ ok: true });
    expect((await app.inject(`${P}/assets`)).json().assets).toHaveLength(1);
  });
  it('lists unregistered files and registers them', async () => {
    await writeFile(join(base, 'ws', 'acme', 'assets', 'manual.png'), 'x');
    expect((await app.inject(`${P}/assets`)).json().unregistered).toEqual(['manual.png']);
    const r = await app.inject({ method: 'POST', url: `${P}/assets/register`, payload: { files: ['manual.png'] } });
    expect(r.json().assets[0]).toMatchObject({ file: 'manual.png', origin: 'upload' });
  });
  it('refuses uploads while assets.json is corrupt, without touching it', async () => {
    const json = join(base, 'ws', 'acme', 'assets', 'assets.json');
    await writeFile(json, '{bad');
    const list = (await app.inject(`${P}/assets`)).json();
    expect(list.error).toContain('assets.json');
    const up = await app.inject({ method: 'POST', url: `${P}/assets`, ...multipart([{ name: 'a.png', content: 'x' }]) });
    expect(up.statusCode).toBe(422);
    expect(await readFile(json, 'utf8')).toBe('{bad');
  });
  it('never serves project files outside assets/ and references/', async () => {
    await symlink(join(base, 'ws', 'acme', 'project.json'), join(base, 'ws', 'acme', 'assets', 'leak.json'));
    for (const p of ['project.json', 'assets/../project.json', 'assets/leak.json', 'brand/brand-kit.json']) {
      expect((await app.inject(`${P}/files/${p}`)).statusCode, p).toBe(404);
    }
  });
});

describe('references API', () => {
  it('uploads and updates references', async () => {
    const up = await app.inject({ method: 'POST', url: `${P}/references`, ...multipart([{ name: 'mood.jpg', content: 'x' }]) });
    expect(up.json().references[0]).toMatchObject({ file: 'mood.jpg', useForBrand: true });
    const r = await app.inject({ method: 'PATCH', url: `${P}/references/item/mood.jpg`, payload: { note: 'Luce calda', useForBrand: false } });
    expect(r.json()).toMatchObject({ note: 'Luce calda', useForBrand: false });
  });
});

describe('project settings API', () => {
  it('updates linked codebases and reports their existence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-app è '));
    const r = await app.inject({ method: 'PUT', url: P, payload: { linkedCodebases: [{ path: `${dir}/`, note: 'iOS' }, { path: join(base, 'missing') }] } });
    expect(r.json().project.linkedCodebases).toEqual([{ path: dir, note: 'iOS' }, { path: join(base, 'missing') }]);
    expect((await app.inject(`${P}/codebases`)).json()).toEqual([{ path: dir, note: 'iOS', exists: true }, { path: join(base, 'missing'), exists: false }]);
    expect((await app.inject({ method: 'PUT', url: P, payload: { linkedCodebases: [{ path: 'rel' }] } })).statusCode).toBe(400);
  });
});
```

`packages/core/test/brand-routes.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from '../src/agent/claude-code-runner.ts';
import { AppConfigStore } from '../src/app-config.ts';
import { Git } from '../src/git.ts';
import { buildServer } from '../src/server/app.ts';
import { multipart } from './helpers/multipart.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let app: FastifyInstance;
let base: string;
const P = '/api/projects/acme';
const manual = { kind: 'manual', ref: null };

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ms-br-'));
  process.env.FAKE_CLAUDE_SCENARIO = 'brand';
  app = await buildServer({ appConfig: new AppConfigStore(join(base, 'config')), git: new Git(), doctor: async () => [],
    runner: new ClaudeCodeRunner([process.execPath, FAKE], { killGraceMs: 200 }) });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
});
afterEach(async () => { await app.close(); delete process.env.FAKE_CLAUDE_SCENARIO; });
const waitJobs = async () => {
  for (let i = 0; i < 250; i++) {
    const jobs = (await app.inject('/api/jobs')).json() as Array<{ state: string; error?: string }>;
    if (jobs.every((j) => j.state !== 'queued' && j.state !== 'running')) return jobs;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
};

describe('brand API', () => {
  it('edits kit and guidelines, analyzes a site and applies the proposal', async () => {
    const kit = await app.inject({ method: 'PUT', url: `${P}/brand/kit`, payload: { kit: { schemaVersion: 1, colors: [{ id: 'blu', name: 'Blu', hex: '#1e3a5f', role: 'primary', source: manual }] } } });
    expect(kit.json().colors[0].hex).toBe('#1E3A5F');
    expect((await app.inject({ method: 'PUT', url: `${P}/brand/guidelines`, payload: { text: 'Tono diretto' } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'website', url: 'https://acme.example' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `${P}/brand/analyze`, payload: {} })).statusCode).toBe(202);
    await waitJobs();
    const overview = (await app.inject(`${P}/brand`)).json();
    expect(overview.proposals[0]).toMatchObject({ status: 'open' });
    const p = overview.proposals[0];
    const applied = await app.inject({ method: 'POST', url: `${P}/brand/proposals/${p.id}/apply`, payload: { acceptedIds: ['colors:add:arancio'], applyGuidelines: false } });
    expect(applied.json().kit.colors.map((c: { id: string }) => c.id)).toEqual(['blu', 'arancio']);
    expect((await app.inject(`${P}/brand`)).json().guidelines).toBe('Tono diretto');
  });
  it('turns references marked for brand into image sources before analyzing', async () => {
    await app.inject({ method: 'POST', url: `${P}/references`, ...multipart([{ name: 'mood.jpg', content: 'x' }]) });
    expect((await app.inject({ method: 'POST', url: `${P}/brand/analyze`, payload: {} })).statusCode).toBe(202);
    await waitJobs();
    expect((await app.inject(`${P}/brand`)).json().sources).toEqual([expect.objectContaining({ kind: 'image', file: 'references/mood.jpg' })]);
  });
  it('reports a corrupt kit and refuses to overwrite it', async () => {
    await writeFile(join(base, 'ws', 'acme', 'brand', 'brand-kit.json'), '{oops');
    const o = (await app.inject(`${P}/brand`)).json();
    expect(o.kitError).toContain('brand-kit.json');
    expect(o.kit.colors).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: `${P}/brand/kit`, payload: { kit: { schemaVersion: 1 } } })).statusCode).toBe(422);
  });
  it('validates sources', async () => {
    expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'website', url: 'ftp://x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/brand/sources`, payload: { kind: 'image', file: 'references/none.jpg' } })).statusCode).toBe(400);
  });
});
```
(The `brand/` folder exists from project creation, so writing the corrupt kit there works.)

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/core/test/brand-routes.test.ts packages/core/test/library-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: `serve-file.ts` e refactor**

```ts
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { FastifyReply } from 'fastify';

export async function sendConfinedFile(reply: FastifyReply, base: string, relRaw: string, prefixes: string[]): Promise<FastifyReply> {
  const rel = normalize(relRaw || '.');
  const allowed = prefixes.map((p) => p.split('/').join(sep));
  const notFound = () => reply.status(404).send({ error: 'File non trovato' });
  if (isAbsolute(rel) || rel.split(sep).includes('..') || !allowed.some((p) => rel.startsWith(p))) return notFound();
  const info = await lstat(join(base, rel)).catch(() => null);
  if (!info?.isFile()) return notFound();
  const real = await realpath(join(base, rel)).catch(() => null);
  const realBase = await realpath(base).catch(() => base);
  // Exact match: rejects a symlink at any level below base (it would bypass the allowed prefixes).
  if (!real || real !== join(realBase, rel)) return notFound();
  // Agent-written HTML/SVG is served same-origin: sandbox it so scripts cannot reach the loopback API.
  reply.header('Content-Security-Policy', 'sandbox').header('X-Content-Type-Options', 'nosniff');
  return reply.sendFile(rel, base);
}
```
Replace the body of the creative files route with `return sendConfinedFile(reply, ref.store.dir(ref.creativeSlug), req.params['*'] ?? '', ['outputs/', 'work/.feedback/']);` (Fastify already decoded the wildcard). Keep the existing creative file tests green.

- [ ] **Step 4: `project-routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { linkedCodebaseSchema } from '@motion-studio/shared';
import { z } from 'zod';
import { checkCodebases } from '../codebases.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';

const body = z.object({ name: z.string().optional(), description: z.string().max(2000).optional(), linkedCodebases: z.array(linkedCodebaseSchema).max(20).optional() });

export function registerProjectRoutes(app: FastifyInstance, ctx: { requireWorkspace: () => WorkspaceStore; jobKeyOf: (root: string, slug: string) => string }) {
  app.put<{ Params: { slug: string } }>('/api/projects/:slug', async (req) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) throw new WorkspaceError(400, 'Richiesta non valida');
    const ws = ctx.requireWorkspace();
    const project = await ws.updateProject(req.params.slug, parsed.data);
    return { slug: req.params.slug, project, jobKey: ctx.jobKeyOf(ws.root, req.params.slug) };
  });
  app.get<{ Params: { slug: string } }>('/api/projects/:slug/codebases', async (req) => {
    const project = await ctx.requireWorkspace().getProject(req.params.slug);
    return checkCodebases(project.linkedCodebases);
  });
}
```
(`jobKeyOf` is the existing `projectJobKey` of `app.ts`.)

- [ ] **Step 5: `library-routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import type { BrandService } from '../brand/brand-analysis.ts';
import type { Git } from '../git.ts';
import { JsonFileError } from '../json-file.ts';
import { LibraryStore } from '../library/library-store.ts';
import { saveUploads } from '../library/upload.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';
import { sendConfinedFile } from './serve-file.ts';

export interface LibraryRoutesContext { requireWorkspace: () => WorkspaceStore; brand: BrandService; media: MediaTools; git: Git; broadcast: (m: ServerMessage) => void }

const assetPatch = z.object({ description: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(40)).max(30).optional() });
const refPatch = z.object({ note: z.string().max(2000).optional(), useForBrand: z.boolean().optional() });
const filesBody = z.object({ files: z.array(z.string()).min(1).max(500) });
const describeBody = z.object({ files: z.array(z.string()).max(500).optional() });
const parse = <T>(s: z.ZodType<T>, b: unknown): T => { const r = s.safeParse(b ?? {}); if (!r.success) throw new WorkspaceError(400, 'Richiesta non valida'); return r.data; };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerLibraryRoutes(app: FastifyInstance, ctx: LibraryRoutesContext) {
  const project = async (slug: string) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    const projectDir = ws.projectDir(slug);
    return { ws, projectDir, lib: new LibraryStore(projectDir, ctx.media), ref: { root: ws.root, projectSlug: slug, projectDir } };
  };
  const done = async (projectDir: string, slug: string, msg: string) => {
    await ctx.git.commitAll(projectDir, msg);
    ctx.broadcast({ type: 'library', project: slug });
  };

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/assets', async (req) => {
    const { lib } = await project(req.params.slug);
    try { return { assets: await lib.listAssets(), error: null, unregistered: await lib.unregisteredAssets() }; }
    catch (e) { if (e instanceof JsonFileError) return { assets: [], error: e.message, unregistered: [] }; throw e; }
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets', async (req, reply) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.listAssets(); // corrupt assets.json → 422 before any file is written
    const saved = await saveUploads(req, lib.dir('assets'));
    const assets = await lib.registerAssets(saved.map((file) => ({ file, origin: 'upload' as const })));
    await done(projectDir, req.params.slug, `Carica ${saved.length} asset`);
    return reply.status(201).send({ assets });
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets/register', async (req) => {
    const { files } = parse(filesBody, req.body);
    const { lib, projectDir } = await project(req.params.slug);
    const assets = await lib.registerAssets(files.map((file) => ({ file, origin: 'upload' as const })));
    await done(projectDir, req.params.slug, 'Registra asset');
    return { assets };
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/assets/describe', async (req, reply) => {
    const { files } = parse(describeBody, req.body);
    const { ref } = await project(req.params.slug);
    return reply.status(202).send(await ctx.brand.describeAssets(ref, files));
  });

  app.patch<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/assets/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    const entry = await lib.updateAsset(req.params['*'], parse(assetPatch, req.body));
    await done(projectDir, req.params.slug, `Aggiorna asset ${entry.file}`);
    return entry;
  });

  app.delete<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/assets/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.removeAsset(req.params['*']);
    await done(projectDir, req.params.slug, `Elimina asset ${req.params['*']}`);
    return { ok: true };
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/references', async (req) => {
    const { lib } = await project(req.params.slug);
    try { return { references: await lib.listReferences(), error: null }; }
    catch (e) { if (e instanceof JsonFileError) return { references: [], error: message(e) }; throw e; }
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/references', async (req, reply) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.listReferences();
    const saved = await saveUploads(req, lib.dir('references'));
    const references = await lib.registerReferences(saved);
    await done(projectDir, req.params.slug, `Carica ${saved.length} riferimenti`);
    return reply.status(201).send({ references });
  });

  app.patch<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/references/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    const entry = await lib.updateReference(req.params['*'], parse(refPatch, req.body));
    await done(projectDir, req.params.slug, `Aggiorna riferimento ${entry.file}`);
    return entry;
  });

  app.delete<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/references/item/*', async (req) => {
    const { lib, projectDir } = await project(req.params.slug);
    await lib.removeReference(req.params['*']);
    await done(projectDir, req.params.slug, `Elimina riferimento ${req.params['*']}`);
    return { ok: true };
  });

  app.get<{ Params: { slug: string; '*': string } }>('/api/projects/:slug/files/*', async (req, reply) => {
    const { projectDir } = await project(req.params.slug);
    return sendConfinedFile(reply, projectDir, req.params['*'] ?? '', ['assets/', 'references/']);
  });
}
```

- [ ] **Step 6: `brand-routes.ts`**

```ts
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { EMPTY_BRAND_KIT, type BrandOverview, type ServerMessage } from '@motion-studio/shared';
import { z } from 'zod';
import { brandJobKey, type BrandService } from '../brand/brand-analysis.ts';
import { BrandStore } from '../brand/brand-store.ts';
import type { Git } from '../git.ts';
import { JsonFileError } from '../json-file.ts';
import { LibraryStore } from '../library/library-store.ts';
import type { MediaTools } from '../media/media-tools.ts';
import { WorkspaceError, type WorkspaceStore } from '../workspace-store.ts';

export interface BrandRoutesContext { requireWorkspace: () => WorkspaceStore; brand: BrandService; media: MediaTools; git: Git; broadcast: (m: ServerMessage) => void }

const sourceBody = z.union([
  z.object({ kind: z.literal('website'), url: z.string() }),
  z.object({ kind: z.literal('image'), file: z.string() }),
]);
const applyBody = z.object({ acceptedIds: z.array(z.string()).max(500), applyGuidelines: z.boolean() });
const analyzeBody = z.object({ sourceIds: z.array(z.string()).optional() });
const parse = <T>(s: z.ZodType<T>, b: unknown): T => { const r = s.safeParse(b ?? {}); if (!r.success) throw new WorkspaceError(400, 'Richiesta non valida'); return r.data; };

export function registerBrandRoutes(app: FastifyInstance, ctx: BrandRoutesContext) {
  const project = async (slug: string) => {
    const ws = ctx.requireWorkspace();
    await ws.getProject(slug);
    const projectDir = ws.projectDir(slug);
    return { ws, projectDir, store: new BrandStore(projectDir), ref: { root: ws.root, projectSlug: slug, projectDir } };
  };
  const done = async (projectDir: string, slug: string, msg: string) => {
    await ctx.git.commitAll(projectDir, msg);
    ctx.broadcast({ type: 'brand', project: slug });
  };

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/brand', async (req): Promise<BrandOverview> => {
    const { ws, store } = await project(req.params.slug);
    let kit = EMPTY_BRAND_KIT; let kitError: string | null = null;
    try { kit = await store.readKit(); } catch (e) { if (!(e instanceof JsonFileError)) throw e; kitError = e.message; }
    let sources: BrandOverview['sources'] = []; let sourcesError: string | null = null;
    try { sources = await store.readSources(); } catch (e) { if (!(e instanceof JsonFileError)) throw e; sourcesError = e.message; }
    return { kit, kitError, guidelines: await store.readGuidelines(), sources, sourcesError, proposals: await store.listProposals(), jobKey: brandJobKey(ws.root, req.params.slug) };
  });

  app.put<{ Params: { slug: string }; Body: { kit?: unknown } }>('/api/projects/:slug/brand/kit', async (req) => {
    const { store, projectDir } = await project(req.params.slug);
    await store.readKit(); // a corrupt file on disk → 422, never overwritten from the UI
    const kit = await store.writeKit(req.body?.kit);
    await done(projectDir, req.params.slug, 'Brand kit aggiornato');
    return kit;
  });

  app.put<{ Params: { slug: string }; Body: { text?: unknown } }>('/api/projects/:slug/brand/guidelines', async (req) => {
    if (typeof req.body?.text !== 'string') throw new WorkspaceError(400, 'Testo mancante');
    const { store, projectDir } = await project(req.params.slug);
    await store.writeGuidelines(req.body.text);
    await done(projectDir, req.params.slug, 'Linee guida aggiornate');
    return { ok: true };
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/brand/sources', async (req, reply) => {
    const body = parse(sourceBody, req.body);
    const { store, projectDir } = await project(req.params.slug);
    if (body.kind === 'image') {
      const ok = body.file.startsWith('references/') && !body.file.split('/').includes('..') && (await lstat(join(projectDir, ...body.file.split('/'))).catch(() => null))?.isFile();
      if (!ok) throw new WorkspaceError(400, 'L\'immagine deve essere un riferimento del progetto');
    }
    const source = await store.addSource(body);
    await done(projectDir, req.params.slug, 'Aggiungi sorgente brand');
    return reply.status(201).send(source);
  });

  app.delete<{ Params: { slug: string; id: string } }>('/api/projects/:slug/brand/sources/:id', async (req) => {
    const { store, projectDir } = await project(req.params.slug);
    await store.removeSource(req.params.id);
    await done(projectDir, req.params.slug, 'Rimuovi sorgente brand');
    return { ok: true };
  });

  app.post<{ Params: { slug: string } }>('/api/projects/:slug/brand/analyze', async (req, reply) => {
    const { sourceIds } = parse(analyzeBody, req.body);
    const { store, ref } = await project(req.params.slug);
    const refs = await new LibraryStore(ref.projectDir, ctx.media).listReferences().catch(() => []);
    for (const r of refs.filter((x) => x.useForBrand)) {
      await store.addSource({ kind: 'image', file: `references/${r.file}` }).catch((e) => { if ((e as WorkspaceError).status !== 409) throw e; });
    }
    return reply.status(202).send(await ctx.brand.analyze(ref, sourceIds));
  });

  app.post<{ Params: { slug: string; id: string } }>('/api/projects/:slug/brand/proposals/:id/apply', async (req) => {
    const { acceptedIds, applyGuidelines } = parse(applyBody, req.body);
    const { ref } = await project(req.params.slug);
    return ctx.brand.applyProposal(ref, req.params.id, acceptedIds, applyGuidelines);
  });

  app.post<{ Params: { slug: string; id: string } }>('/api/projects/:slug/brand/proposals/:id/discard', async (req) => {
    const { ref } = await project(req.params.slug);
    return ctx.brand.discardProposal(ref, req.params.id);
  });
}
```

Add to `packages/shared/src/brand.ts`:
```ts
export interface BrandOverview {
  kit: BrandKit; kitError: string | null; guidelines: string; sources: BrandSource[]; sourcesError: string | null;
  proposals: BrandProposal[]; jobKey: string;
}
```

- [ ] **Step 7: Collega in `app.ts`**

In `buildServer`, after `turns` is created:
```ts
  await app.register(fastifyMultipart, { limits: UPLOAD_LIMITS });
  const brandService = new BrandService({
    queue, runner: deps.runner, git: deps.git, media,
    model: async () => (await requireWorkspace().readSettings()).model,
    broadcast: (msg) => hub.broadcast(msg),
  });
```
and next to `registerCreativeRoutes(...)`:
```ts
  const routeCtx = { requireWorkspace, brand: brandService, media, git: deps.git, broadcast: (m: ServerMessage) => hub.broadcast(m) };
  registerBrandRoutes(app, routeCtx);
  registerLibraryRoutes(app, routeCtx);
  registerProjectRoutes(app, { requireWorkspace, jobKeyOf: projectJobKey });
```
(imports: `fastifyMultipart` from `@fastify/multipart`, `UPLOAD_LIMITS`, `BrandService`, the three `register*` functions, `type ServerMessage`.)

Append to `packages/core/src/index.ts`:
```ts
export * from './server/serve-file.ts';
export * from './server/brand-routes.ts';
export * from './server/library-routes.ts';
export * from './server/project-routes.ts';
```

- [ ] **Step 8: Verifica che passino**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: tutti PASS (anche i test di creatività e server delle fasi precedenti).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): brand, library, project settings and confined file APIs"
```

---

### Task 10: Web — schede di progetto, API, upload, impostazioni e codebase

**Files:**
- Create: `packages/web/src/components/UploadZone.tsx`, `packages/web/src/components/CodebaseList.tsx`, `packages/web/src/components/SourceBadge.tsx`, `packages/web/src/screens/ProjectSettings.tsx`, `packages/web/src/useProjectData.ts`, `packages/web/test/CodebaseList.test.tsx`, `packages/web/test/UploadZone.test.tsx`
- Modify: `packages/web/src/routes.ts`, `packages/web/src/api.ts`, `packages/web/src/screens/ProjectPage.tsx`, `packages/web/src/screens/NewCreative.tsx`, `packages/web/src/components/ConversationPanel.tsx` (BriefEditor), `packages/web/test/routes.test.ts`

**Interfaces:**
- Consumes: API del Task 9; tipi dei Task 2 e 9.
- Produces:
  - `routes.ts`: `export type ProjectTab = 'creatives' | 'brand' | 'assets' | 'references' | 'settings' | 'console'`; `Route` project variant uses `tab: ProjectTab`; hashes `#/p/<slug>` (creatives) and `#/p/<slug>/<tab>` for the others; `href.project(slug, tab?)`.
  - `api` gains: `updateProject(slug, body: { name?: string; description?: string; linkedCodebases?: LinkedCodebase[] }): Promise<ProjectDetail>`, `getCodebases(slug): Promise<CodebaseCheck[]>`, `getBrand(slug): Promise<BrandOverview>`, `saveBrandKit(slug, kit: BrandKit): Promise<BrandKit>`, `saveGuidelines(slug, text): Promise<{ ok: true }>`, `addBrandSource(slug, body)`, `removeBrandSource(slug, id)`, `analyzeBrand(slug, sourceIds?)`, `applyProposal(slug, id, acceptedIds, applyGuidelines)`, `discardProposal(slug, id)`, `listAssets(slug): Promise<{ assets: AssetEntry[]; error: string | null; unregistered: string[] }>`, `uploadFiles(slug, kind: 'assets' | 'references', files: File[]): Promise<unknown>` (FormData, field `files`; errors as `ApiError`), `registerAssets(slug, files)`, `describeAssets(slug, files?)`, `updateAsset(slug, file, patch)`, `deleteAsset(slug, file)`, `listReferences(slug)`, `updateReference(slug, file, patch)`, `deleteReference(slug, file)`, `projectFileUrl(slug, rel)` (`/api/projects/<slug>/files/<rel>` with each segment encoded). `CodebaseCheck` is declared in `api.ts` as `{ path: string; note?: string; exists: boolean }`.
  - `useProjectData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload(): void }` — refetches when `deps` change (pages pass `live.projectTicks[slug]`).
  - `<UploadZone label: string; onFiles(files: File[]): Promise<void>; disabled?: boolean />` — drop area (`role="button"`, `aria-label={label}`, Enter/Space opens the picker) + hidden `<input type="file" multiple>` labelled the same; shows "Caricamento…" while `onFiles` runs and the error (`role="alert"`) if it rejects.
  - `<CodebaseList value: LinkedCodebase[]; checks?: CodebaseCheck[]; onChange(next: LinkedCodebase[]): void; disabled?: boolean />` — rows with path (mono), editable note, badge `Non trovata` when `checks` says `exists: false`, `Rimuovi`; add row: inputs "Percorso assoluto della cartella" + "Nota (facoltativa)" + `Collega`; adding an empty or relative path (not starting with `/` or `~`) shows `Indica un percorso assoluto` and does not call `onChange`; text `Le cartelle collegate sono in sola lettura: l'agente può leggerle ma non modificarle.`
  - `<SourceBadge source: SourceRef />` — `Manuale` | `Sito: <hostname>` (title = url) | `Immagine: <file name>`.
  - `<ProjectSettings slug tick />` — name, description, `CodebaseList` (project level) with `Salva` → `api.updateProject`; uses `api.getCodebases` for the badges.
  - `ProjectPage` tabs: Creatività, Brand, Asset, Riferimenti, Impostazioni, Console agente (Brand/Asset/Riferimenti render the screens of Tasks 12 and 13; until they exist, render a placeholder `<p className="muted">In arrivo</p>`).
  - `NewCreative` and `BriefEditor` gain a "Codebase di questa creatività" `CodebaseList` (creative level), sent as `linkedCodebases` on create/edit.

- [ ] **Step 1: Test che falliscono**

Append to `packages/web/test/routes.test.ts`:
```ts
describe('project tabs', () => {
  it.each(['brand', 'assets', 'references', 'settings', 'console'] as const)('%s', (tab) => {
    expect(parseRoute(href.project('acme', tab))).toEqual({ name: 'project', slug: 'acme', tab });
  });
  it('unknown tabs fall back to projects', () => {
    expect(parseRoute('#/p/acme/nope')).toEqual({ name: 'projects' });
  });
});
```

`packages/web/test/CodebaseList.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CodebaseList } from '../src/components/CodebaseList.tsx';

describe('CodebaseList', () => {
  it('adds absolute paths, rejects relative ones and flags missing folders', async () => {
    const onChange = vi.fn();
    render(<CodebaseList value={[{ path: '/Users/me/app', note: 'iOS' }]} checks={[{ path: '/Users/me/app', note: 'iOS', exists: false }]} onChange={onChange} />);
    expect(screen.getByText('Non trovata')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Percorso assoluto della cartella'), 'dev/app');
    await userEvent.click(screen.getByRole('button', { name: 'Collega' }));
    expect(screen.getByRole('alert').textContent).toBe('Indica un percorso assoluto');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Percorso assoluto della cartella'));
    await userEvent.type(screen.getByLabelText('Percorso assoluto della cartella'), '~/dev/web');
    await userEvent.type(screen.getByLabelText('Nota (facoltativa)'), 'sito');
    await userEvent.click(screen.getByRole('button', { name: 'Collega' }));
    expect(onChange).toHaveBeenLastCalledWith([{ path: '/Users/me/app', note: 'iOS' }, { path: '~/dev/web', note: 'sito' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi /Users/me/app' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
```

`packages/web/test/UploadZone.test.tsx`:
```tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UploadZone } from '../src/components/UploadZone.tsx';

describe('UploadZone', () => {
  it('passes dropped and picked files and shows errors', async () => {
    const onFiles = vi.fn(async () => {});
    render(<UploadZone label="Carica asset" onFiles={onFiles} />);
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    fireEvent.drop(screen.getByRole('button', { name: 'Carica asset' }), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]));
    onFiles.mockRejectedValueOnce(new Error('File troppo grande'));
    fireEvent.change(screen.getByLabelText('Carica asset', { selector: 'input' }), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('File troppo grande'));
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web`
Expected: FAIL.

- [ ] **Step 3: Routing e API**

`packages/web/src/routes.ts`:
```ts
export type ProjectTab = 'creatives' | 'brand' | 'assets' | 'references' | 'settings' | 'console';
const TABS: ProjectTab[] = ['brand', 'assets', 'references', 'settings', 'console'];
export type Route =
  | { name: 'projects' }
  | { name: 'project'; slug: string; tab: ProjectTab }
  | { name: 'new-creative'; slug: string }
  | { name: 'creative'; slug: string; creative: string };

const SLUG = '[a-z0-9][a-z0-9-]*';

export function parseRoute(hash: string): Route {
  let m = hash.match(new RegExp(`^#/p/(${SLUG})/c/(${SLUG})$`));
  if (m) return { name: 'creative', slug: m[1]!, creative: m[2]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})/new$`));
  if (m) return { name: 'new-creative', slug: m[1]! };
  m = hash.match(new RegExp(`^#/p/(${SLUG})(?:/([a-z]+))?$`));
  if (m) {
    const tab = (m[2] ?? 'creatives') as ProjectTab;
    if (tab === 'creatives' || TABS.includes(tab)) return { name: 'project', slug: m[1]!, tab };
  }
  return { name: 'projects' };
}

export const href = {
  projects: () => '#/',
  project: (slug: string, tab: ProjectTab = 'creatives') => (tab === 'creatives' ? `#/p/${slug}` : `#/p/${slug}/${tab}`),
  newCreative: (slug: string) => `#/p/${slug}/new`,
  creative: (slug: string, c: string) => `#/p/${slug}/c/${c}`,
};
```
(`new` is matched before the generic tab pattern, so it never becomes a tab.)

`packages/web/src/api.ts` — add (imports: `AssetEntry, BrandKit, BrandOverview, BrandProposal, BrandSource, LinkedCodebase, ReferenceEntry` from `@motion-studio/shared`):
```ts
export interface CodebaseCheck { path: string; note?: string; exists: boolean }
const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');

async function upload<T>(url: string, files: File[]): Promise<T> {
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  const res = await fetch(url, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Errore ${res.status}`);
  return data as T;
}
```
and in `api`:
```ts
  updateProject: (slug: string, body: { name?: string; description?: string; linkedCodebases?: LinkedCodebase[] }) => request<ProjectDetail>('PUT', p(slug), body),
  getCodebases: (slug: string) => request<CodebaseCheck[]>('GET', `${p(slug)}/codebases`),
  getBrand: (slug: string) => request<BrandOverview>('GET', `${p(slug)}/brand`),
  saveBrandKit: (slug: string, kit: BrandKit) => request<BrandKit>('PUT', `${p(slug)}/brand/kit`, { kit }),
  saveGuidelines: (slug: string, text: string) => request<{ ok: true }>('PUT', `${p(slug)}/brand/guidelines`, { text }),
  addBrandSource: (slug: string, body: { kind: 'website'; url: string } | { kind: 'image'; file: string }) => request<BrandSource>('POST', `${p(slug)}/brand/sources`, body),
  removeBrandSource: (slug: string, id: string) => request<{ ok: true }>('DELETE', `${p(slug)}/brand/sources/${encodeURIComponent(id)}`),
  analyzeBrand: (slug: string, sourceIds?: string[]) => request<JobSummary>('POST', `${p(slug)}/brand/analyze`, { sourceIds }),
  applyProposal: (slug: string, id: string, acceptedIds: string[], applyGuidelines: boolean) =>
    request<{ kit: BrandKit; proposal: BrandProposal }>('POST', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/apply`, { acceptedIds, applyGuidelines }),
  discardProposal: (slug: string, id: string) => request<BrandProposal>('POST', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/discard`),
  listAssets: (slug: string) => request<{ assets: AssetEntry[]; error: string | null; unregistered: string[] }>('GET', `${p(slug)}/assets`),
  uploadFiles: (slug: string, kind: 'assets' | 'references', files: File[]) => upload<unknown>(`${p(slug)}/${kind}`, files),
  registerAssets: (slug: string, files: string[]) => request<{ assets: AssetEntry[] }>('POST', `${p(slug)}/assets/register`, { files }),
  describeAssets: (slug: string, files?: string[]) => request<JobSummary>('POST', `${p(slug)}/assets/describe`, { files }),
  updateAsset: (slug: string, file: string, patch: { description?: string; tags?: string[] }) => request<AssetEntry>('PATCH', `${p(slug)}/assets/item/${enc(file)}`, patch),
  deleteAsset: (slug: string, file: string) => request<{ ok: true }>('DELETE', `${p(slug)}/assets/item/${enc(file)}`),
  listReferences: (slug: string) => request<{ references: ReferenceEntry[]; error: string | null }>('GET', `${p(slug)}/references`),
  updateReference: (slug: string, file: string, patch: { note?: string; useForBrand?: boolean }) => request<ReferenceEntry>('PATCH', `${p(slug)}/references/item/${enc(file)}`, patch),
  deleteReference: (slug: string, file: string) => request<{ ok: true }>('DELETE', `${p(slug)}/references/item/${enc(file)}`),
  projectFileUrl: (slug: string, rel: string) => `${p(slug)}/files/${enc(rel)}`,
```
Also extend `createCreative` / `updateCreative` bodies with `linkedCodebases?: LinkedCodebase[]`.

`packages/web/src/useProjectData.ts`:
```ts
import { useCallback, useEffect, useState } from 'react';

export function useProjectData<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    load().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [...deps, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload };
}
```

- [ ] **Step 4: Componenti**

`packages/web/src/components/UploadZone.tsx`:
```tsx
import { useId, useRef, useState, type DragEvent } from 'react';

export function UploadZone({ label, onFiles, disabled }: { label: string; onFiles: (files: File[]) => Promise<void>; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (!files.length || disabled) return;
    setBusy(true); setError(null);
    try { await onFiles(files); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void send(e.dataTransfer.files); };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div role="button" tabIndex={0} aria-label={label} aria-disabled={disabled || busy}
        onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        style={{ border: `2px dashed ${over ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 12, padding: 18, textAlign: 'center', background: over ? 'var(--accent-soft)' : 'var(--surface)', cursor: 'pointer' }}>
        <strong>{busy ? 'Caricamento…' : label}</strong>
        <div className="muted" style={{ fontSize: 13 }}>Trascina qui i file o clicca per sceglierli (massimo 200 MB per file)</div>
      </div>
      <input id={id} ref={input} type="file" multiple aria-label={label} hidden onChange={(e) => { void send(e.target.files); e.target.value = ''; }} />
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
```
(In the test the hidden input is found with `getByLabelText(label, { selector: 'input' })`.)

`packages/web/src/components/CodebaseList.tsx`:
```tsx
import type { LinkedCodebase } from '@motion-studio/shared';
import { useState } from 'react';
import type { CodebaseCheck } from '../api.ts';

export function CodebaseList({ value, checks, onChange, disabled }: { value: LinkedCodebase[]; checks?: CodebaseCheck[]; onChange: (next: LinkedCodebase[]) => void; disabled?: boolean }) {
  const [path, setPath] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const p = path.trim();
    if (!p || !(p.startsWith('/') || p.startsWith('~'))) { setError('Indica un percorso assoluto'); return; }
    setError(null);
    onChange([...value, { path: p, ...(note.trim() ? { note: note.trim() } : {}) }]);
    setPath(''); setNote('');
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Le cartelle collegate sono in sola lettura: l'agente può leggerle ma non modificarle.</p>
      {value.map((c, i) => (
        <div key={c.path} className="row" style={{ gap: 8 }}>
          <span className="mono" style={{ overflowWrap: 'anywhere', flex: '1 1 240px' }}>{c.path}</span>
          {checks?.find((x) => x.path === c.path)?.exists === false && <span className="badge err">Non trovata</span>}
          <input aria-label={`Nota per ${c.path}`} value={c.note ?? ''} disabled={disabled} style={{ flex: '1 1 160px', width: 'auto' }}
            onChange={(e) => onChange(value.map((x, k) => (k === i ? { path: x.path, ...(e.target.value ? { note: e.target.value } : {}) } : x)))} />
          <button type="button" disabled={disabled} aria-label={`Rimuovi ${c.path}`} onClick={() => onChange(value.filter((_, k) => k !== i))}>Rimuovi</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <input aria-label="Percorso assoluto della cartella" placeholder="/Users/tuonome/dev/app" value={path} disabled={disabled} onChange={(e) => setPath(e.target.value)} style={{ flex: '2 1 240px', width: 'auto' }} />
        <input aria-label="Nota (facoltativa)" placeholder="Es. app iOS, schermate in /Screens" value={note} disabled={disabled} onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 160px', width: 'auto' }} />
        <button type="button" disabled={disabled} onClick={add}>Collega</button>
      </div>
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
```

`packages/web/src/components/SourceBadge.tsx`:
```tsx
import type { SourceRef } from '@motion-studio/shared';

export function SourceBadge({ source }: { source: SourceRef }) {
  if (source.kind === 'website' && source.ref) {
    let host = source.ref;
    try { host = new URL(source.ref).hostname; } catch { /* keep raw */ }
    return <span className="badge" title={source.ref}>Sito: {host}</span>;
  }
  if (source.kind === 'image' && source.ref) return <span className="badge" title={source.ref}>Immagine: {source.ref.split('/').pop()}</span>;
  return <span className="badge">Manuale</span>;
}
```

`packages/web/src/screens/ProjectSettings.tsx`:
```tsx
import type { LinkedCodebase } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { CodebaseList } from '../components/CodebaseList.tsx';
import { useProjectData } from '../useProjectData.ts';

export function ProjectSettings({ slug, tick }: { slug: string; tick: number }) {
  const { data, error, reload } = useProjectData(() => Promise.all([api.getProject(slug), api.getCodebases(slug)]), [slug, tick]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [codebases, setCodebases] = useState<LinkedCodebase[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    setName(data[0].project.name); setDescription(data[0].project.description); setCodebases(data[0].project.linkedCodebases);
  }, [data]);
  const save = async () => {
    setStatus(null);
    try { await api.updateProject(slug, { name, description, linkedCodebases: codebases }); setStatus('Salvato'); reload(); }
    catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  };
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p className="muted">Caricamento…</p>;
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ maxWidth: 820 }}>
      <label htmlFor="ps-name"><strong>Nome</strong></label>
      <input id="ps-name" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="ps-desc"><strong>Descrizione</strong></label>
      <textarea id="ps-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      <strong>Codebase collegate al progetto</strong>
      <CodebaseList value={codebases} checks={data[1]} onChange={setCodebases} />
      <div className="row"><div style={{ flex: 1 }} />{status && <span role="status" className="muted">{status}</span>}<button type="submit" className="primary">Salva</button></div>
    </form>
  );
}
```

- [ ] **Step 5: Schede, NewCreative e BriefEditor**

`ProjectPage`: change the prop type to `tab: ProjectTab`; tabs list:
```tsx
const TABS: Array<[ProjectTab, string]> = [['creatives', 'Creatività'], ['brand', 'Brand'], ['assets', 'Asset'], ['references', 'Riferimenti'], ['settings', 'Impostazioni'], ['console', 'Console agente']];
```
render them as links (`aria-current` on the active one) and, under them, `creatives` → `CreativeList`, `settings` → `<ProjectSettings slug={slug} tick={live.projectTicks[slug] ?? 0} />`, `console` → `ProjectConsole`, the others → `<p className="muted">In arrivo</p>` (replaced in Tasks 12 and 13). Update `App.tsx` for the new `tab` type.

`NewCreative`: add state `const [codebases, setCodebases] = useState<LinkedCodebase[]>([]);`, render under the assets field:
```tsx
          <strong>Codebase di questa creatività <span className="muted" style={{ fontWeight: 400 }}>(oltre a quelle del progetto)</span></strong>
          <CodebaseList value={codebases} onChange={setCodebases} />
```
and send `linkedCodebases: codebases` in `api.createCreative`. Update `NewCreative.test.tsx` expectations to include `linkedCodebases: []` in the body.

`BriefEditor` (in `ConversationPanel.tsx`): state `codebases` initialised from `detail.creative.linkedCodebases`, a `CodebaseList` under the formats, and `linkedCodebases: codebases` added to the `api.updateCreative` body. Update the brief test expectation accordingly (`expect.objectContaining` on the body already tolerates the new key only if it is outside `brief`: assert `{ title: 'Lancio', brief: expect.objectContaining({...}), linkedCodebases: [] }`).

- [ ] **Step 6: Verifica**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): project tabs, settings with linked codebases, upload zone and brand/library API client"
```

---

### Task 11: Web — Revisione delle proposte di brand

**Files:**
- Create: `packages/web/src/components/ProposalReview.tsx`, `packages/web/test/ProposalReview.test.tsx`

**Interfaces:**
- Consumes: `api.applyProposal`, `api.discardProposal` (Task 10); `BrandProposal`, `BrandChange` (Task 2).
- Produces:
  - `describeChange(c: BrandChange): string` — Italian label: `Aggiungi|Aggiorna|Rimuovi` + `colore <name> <hex>` | `font <family>` | `logo <file>` | `tono` | `stile fotografico` | `regola "<text>"` (for `dos`: prefix `da fare:`, for `donts`: `da evitare:`), using `after` for add/update and `before` for remove.
  - `<ProposalReview slug: string; proposal: BrandProposal; onDone(): void />` — summary (`white-space: pre-wrap`), `<n> asset scaricati e aggiunti alla libreria` when `assetsAdded` is not empty, changes grouped under headings Colori / Font / Loghi / Tono / Fare / Evitare / Stile fotografico with one checkbox per change (checked by default, label = `describeChange`), each with a compact before → after preview (color swatches for colors; text otherwise); when `guidelines` is set, a checkbox `Applica le linee guida proposte` (checked) and two read-only columns "Attuali" / "Proposte"; buttons `Applica selezionate` → `api.applyProposal(slug, id, checkedIds, applyGuidelines)` then `onDone()`, and `Scarta proposta` → `api.discardProposal` then `onDone()`; with no changes and no guidelines it shows `Nessuna modifica proposta.` and only `Scarta proposta` (label `Chiudi`); errors in `role="alert"`.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/ProposalReview.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BrandProposal } from '@motion-studio/shared';
import { describe, expect, it, vi } from 'vitest';

const api = { applyProposal: vi.fn(async () => ({})), discardProposal: vi.fn(async () => ({})) };
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ProposalReview, describeChange } = await import('../src/components/ProposalReview.tsx');

const site = { kind: 'website' as const, ref: 'https://acme.example' };
const proposal: BrandProposal = {
  schemaVersion: 1, id: 'p-20261007-100000', createdAt: '2026-10-07T10:00:00.000Z', sourceIds: ['s-1'], status: 'open',
  summary: 'Palette arancio/blu.', assetsAdded: ['brand/logo.svg'],
  guidelines: { current: '', proposed: '# Linee guida' },
  changes: [
    { id: 'colors:add:arancio', field: 'colors', op: 'add', itemId: 'arancio', before: null, after: { id: 'arancio', name: 'Arancio', hex: '#FF7A45', role: 'accent', source: site } },
    { id: 'tone:update:-', field: 'tone', op: 'update', itemId: null, before: { id: 'tone', text: 'Amichevole', source: site }, after: { id: 'tone', text: 'Energico', source: site } },
    { id: 'donts:remove:n1', field: 'donts', op: 'remove', itemId: 'n1', before: { id: 'n1', text: 'Niente gradienti', source: site }, after: null },
  ],
};

describe('describeChange', () => {
  it('labels changes in Italian', () => {
    expect(proposal.changes.map(describeChange)).toEqual(['Aggiungi colore Arancio #FF7A45', 'Aggiorna tono', 'Rimuovi regola da evitare: "Niente gradienti"']);
  });
});

describe('ProposalReview', () => {
  it('applies only the checked changes and the guidelines choice', async () => {
    const onDone = vi.fn();
    render(<ProposalReview slug="acme" proposal={proposal} onDone={onDone} />);
    expect(screen.getByText('Palette arancio/blu.')).toBeTruthy();
    expect(screen.getByText('1 asset scaricati e aggiunti alla libreria')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Aggiorna tono' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Applica le linee guida proposte' }));
    await userEvent.click(screen.getByRole('button', { name: 'Applica selezionate' }));
    await waitFor(() => expect(api.applyProposal).toHaveBeenCalledWith('acme', proposal.id, ['colors:add:arancio', 'donts:remove:n1'], false));
    expect(onDone).toHaveBeenCalled();
  });
  it('discards', async () => {
    const onDone = vi.fn();
    render(<ProposalReview slug="acme" proposal={proposal} onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Scarta proposta' }));
    await waitFor(() => expect(api.discardProposal).toHaveBeenCalledWith('acme', proposal.id));
  });
  it('handles an empty proposal', () => {
    render(<ProposalReview slug="acme" proposal={{ ...proposal, changes: [], guidelines: null, assetsAdded: [] }} onDone={() => {}} />);
    expect(screen.getByText('Nessuna modifica proposta.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Applica selezionate' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Chiudi' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web/test/ProposalReview.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementa**

`packages/web/src/components/ProposalReview.tsx`:
```tsx
import type { BrandChange, BrandField, BrandProposal } from '@motion-studio/shared';
import { useState } from 'react';
import { api } from '../api.ts';

const VERB = { add: 'Aggiungi', update: 'Aggiorna', remove: 'Rimuovi' } as const;
const HEADINGS: Array<[BrandField, string]> = [['colors', 'Colori'], ['fonts', 'Font'], ['logos', 'Loghi'], ['tone', 'Tono'], ['dos', 'Fare'], ['donts', 'Evitare'], ['photoStyle', 'Stile fotografico']];
type Item = { name?: string; hex?: string; family?: string; file?: string; text?: string };

export function describeChange(c: BrandChange): string {
  const item = ((c.op === 'remove' ? c.before : c.after) ?? {}) as Item;
  const what = (() => {
    switch (c.field) {
      case 'colors': return `colore ${item.name} ${item.hex}`;
      case 'fonts': return `font ${item.family}`;
      case 'logos': return `logo ${item.file}`;
      case 'tone': return 'tono';
      case 'photoStyle': return 'stile fotografico';
      case 'dos': return `regola da fare: "${item.text}"`;
      case 'donts': return `regola da evitare: "${item.text}"`;
    }
  })();
  return `${VERB[c.op]} ${what}`;
}

function Preview({ value, field }: { value: unknown; field: BrandField }) {
  if (!value) return <span className="muted">—</span>;
  const v = value as Item;
  if (field === 'colors') return <span className="row" style={{ gap: 6 }}><span style={{ width: 18, height: 18, borderRadius: 4, background: v.hex, border: '1px solid var(--border)' }} />{v.name}</span>;
  return <span style={{ whiteSpace: 'pre-wrap' }}>{v.text ?? v.family ?? v.file ?? ''}</span>;
}

export function ProposalReview({ slug, proposal, onDone }: { slug: string; proposal: BrandProposal; onDone: () => void }) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(proposal.changes.map((c) => c.id)));
  const [guidelines, setGuidelines] = useState(Boolean(proposal.guidelines));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); onDone(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const toggle = (id: string) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const empty = proposal.changes.length === 0 && !proposal.guidelines;

  return (
    <section className="card stack" aria-label="Proposta di brand">
      <strong>Proposta dall'analisi del {new Date(proposal.createdAt).toLocaleString('it-IT')}</strong>
      {proposal.summary && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{proposal.summary}</p>}
      {proposal.assetsAdded.length > 0 && <p className="muted" style={{ margin: 0 }}>{proposal.assetsAdded.length} asset scaricati e aggiunti alla libreria</p>}
      {empty && <p className="muted" style={{ margin: 0 }}>Nessuna modifica proposta.</p>}
      {HEADINGS.map(([field, heading]) => {
        const changes = proposal.changes.filter((c) => c.field === field);
        if (!changes.length) return null;
        return (
          <fieldset key={field} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <legend style={{ fontWeight: 800, marginBottom: 4 }}>{heading}</legend>
            {changes.map((c) => (
              <div key={c.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <label className="row" style={{ gap: 6, flex: '1 1 260px' }}>
                  <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 16, height: 16 }} />
                  {describeChange(c)}
                </label>
                <span className="row muted" style={{ gap: 6, fontSize: 13, flex: '1 1 260px' }}>
                  <Preview value={c.before} field={field} /> → <Preview value={c.after} field={field} />
                </span>
              </div>
            ))}
          </fieldset>
        );
      })}
      {proposal.guidelines && (
        <div className="stack">
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={guidelines} onChange={(e) => setGuidelines(e.target.checked)} style={{ width: 16, height: 16 }} />
            Applica le linee guida proposte
          </label>
          <div className="row" style={{ alignItems: 'stretch', gap: 10 }}>
            {[['Attuali', proposal.guidelines.current], ['Proposte', proposal.guidelines.proposed]].map(([t, text]) => (
              <div key={t} className="stack" style={{ flex: '1 1 300px', gap: 4 }}>
                <span className="muted" style={{ fontSize: 12, fontWeight: 700 }}>{t}</span>
                <pre className="mono" style={{ margin: 0, padding: 10, background: 'var(--surface-2)', borderRadius: 8, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{text || '—'}</pre>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <div style={{ flex: 1 }} />
        <button type="button" disabled={busy} onClick={() => void act(() => api.discardProposal(slug, proposal.id))}>{empty ? 'Chiudi' : 'Scarta proposta'}</button>
        {!empty && <button type="button" className="primary" disabled={busy} onClick={() => void act(() => api.applyProposal(slug, proposal.id, proposal.changes.filter((c) => checked.has(c.id)).map((c) => c.id), guidelines))}>Applica selezionate</button>}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Verifica**

Run: `pnpm vitest run packages/web && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): field-by-field review of brand analysis proposals"
```

---

### Task 12: Web — Pagina Brand

**Files:**
- Create: `packages/web/src/screens/BrandPage.tsx`, `packages/web/test/BrandPage.test.tsx`
- Modify: `packages/web/src/screens/ProjectPage.tsx` (render `BrandPage` on the Brand tab)

**Interfaces:**
- Consumes: `api.getBrand`, `api.saveBrandKit`, `api.saveGuidelines`, `api.addBrandSource`, `api.removeBrandSource`, `api.analyzeBrand`, `api.listAssets`, `api.projectFileUrl`, `api.cancelJob` (Task 10); `useProjectData`, `SourceBadge` (Task 10); `ProposalReview` (Task 11); `EventsState` (live jobs, `projectTicks`).
- Produces: `<BrandPage slug: string; live: EventsState />` with:
  - alert with `kitError` (editing disabled, text `Il file brand/brand-kit.json non è leggibile: correggilo o eliminalo per continuare.`) and `sourcesError`;
  - **Palette**: one card per color (swatch, inputs `Nome colore <k>`, `Hex colore <k>`, select `Ruolo colore <k>`, `SourceBadge`, `Rimuovi colore <k>`), button `+ Colore`;
  - **Font**: rows (inputs `Famiglia font <k>`, select ruolo, `Pesi font <k>` comma-separated, select `File font <k>` from assets of kind `font` + "Nessun file", preview text "Aa Bb Cc 123" in that family), `+ Font`;
  - **Loghi**: cards with preview (`MediaThumb` of `api.projectFileUrl(slug, logo.file)`), selects variante/sfondo, `Rimuovi logo <k>`; select `Aggiungi logo dagli asset` (assets of kind `svg`/`image`, value = `assets/<file>`);
  - **Tono** and **Stile fotografico**: textareas (`Tono di voce`, `Stile fotografico`; empty → `null`);
  - **Fare** / **Evitare**: lists of inputs with `+ Regola` and `Rimuovi`;
  - any edit marks the edited item `source: { kind: 'manual', ref: null }` (new ids: `colore-<n>`, `font-<n>`, `logo-<n>`, `fare-<n>`, `evitare-<n>`, unique); `Salva brand kit` (enabled when changed) → `api.saveBrandKit`; `Annulla modifiche` resets the draft;
  - **Linee guida**: textarea `Linee guida (Markdown)` + `Salva linee guida`;
  - **Sorgenti**: list (`Sito`/`Immagine`, url/file, `Analizzata il …` or `Mai analizzata`, `Rimuovi`), input `Indirizzo del sito` + `Aggiungi sito`, hint about references marked "Usa per l'analisi brand"; `Analizza brand` (disabled while the brand job is active) → `api.analyzeBrand`; while the job with `jobKey` is queued/running: `Analisi in corso…` + `Annulla`; a failed job shows its error;
  - **Proposte**: the newest `open` proposal rendered with `ProposalReview` (`onDone` → reload); a short history of applied/discarded ones.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/BrandPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_BRAND_KIT, type BrandOverview } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const site = { kind: 'website' as const, ref: 'https://acme.example' };
let overview: BrandOverview;
const api = {
  getBrand: vi.fn(async () => overview),
  listAssets: vi.fn(async () => ({ assets: [], error: null, unregistered: [] })),
  saveBrandKit: vi.fn(async (_s: string, k: unknown) => k),
  saveGuidelines: vi.fn(async () => ({ ok: true })),
  addBrandSource: vi.fn(async () => ({})),
  removeBrandSource: vi.fn(async () => ({ ok: true })),
  analyzeBrand: vi.fn(async () => ({ id: 'j1' })),
  cancelJob: vi.fn(async () => ({ cancelled: true })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
  applyProposal: vi.fn(), discardProposal: vi.fn(),
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { BrandPage } = await import('../src/screens/BrandPage.tsx');
const live = { jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };

beforeEach(() => {
  vi.clearAllMocks();
  overview = {
    kit: { ...EMPTY_BRAND_KIT, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: site }] },
    kitError: null, guidelines: 'Tono diretto', sources: [{ id: 's-1', kind: 'website', url: 'https://acme.example', file: null, addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: null }],
    sourcesError: null, proposals: [], jobKey: 'brand:k',
  };
});

describe('BrandPage', () => {
  it('shows the kit with sources and saves manual edits as manual', async () => {
    render(<BrandPage slug="acme" live={live} />);
    await waitFor(() => screen.getByDisplayValue('Blu'));
    expect(screen.getByText('Sito: acme.example')).toBeTruthy();
    const hex = screen.getByLabelText('Hex colore 1');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#112233');
    await userEvent.click(screen.getByRole('button', { name: 'Salva brand kit' }));
    await waitFor(() => expect(api.saveBrandKit).toHaveBeenCalled());
    const saved = api.saveBrandKit.mock.calls[0]![1] as typeof overview.kit;
    expect(saved.colors[0]).toMatchObject({ hex: '#112233', source: { kind: 'manual', ref: null } });
  });
  it('adds a website source and starts an analysis', async () => {
    render(<BrandPage slug="acme" live={live} />);
    await waitFor(() => screen.getByText('Mai analizzata'));
    await userEvent.type(screen.getByLabelText('Indirizzo del sito'), 'https://acme.example/chi-siamo');
    await userEvent.click(screen.getByRole('button', { name: 'Aggiungi sito' }));
    await waitFor(() => expect(api.addBrandSource).toHaveBeenCalledWith('acme', { kind: 'website', url: 'https://acme.example/chi-siamo' }));
    await userEvent.click(screen.getByRole('button', { name: 'Analizza brand' }));
    await waitFor(() => expect(api.analyzeBrand).toHaveBeenCalledWith('acme'));
  });
  it('shows progress for a running analysis and disables a corrupt kit', async () => {
    overview = { ...overview, kitError: 'brand-kit.json: JSON non valido' };
    render(<BrandPage slug="acme" live={{ ...live, jobs: { j1: { id: 'j1', key: 'brand:k', label: 'Analisi brand', state: 'running', createdAt: '2026-10-07T10:00:00.000Z' } } }} />);
    await waitFor(() => screen.getByText('Analisi in corso…'));
    expect(screen.getByRole('alert').textContent).toContain('non è leggibile');
    expect((screen.getByRole('button', { name: 'Analizza brand' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '+ Colore' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(api.cancelJob).toHaveBeenCalledWith('j1');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web/test/BrandPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementa `BrandPage.tsx`**

```tsx
import type { AssetEntry, BrandKit, BrandNote } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { MediaThumb } from '../components/MediaThumb.tsx';
import { ProposalReview } from '../components/ProposalReview.tsx';
import { SourceBadge } from '../components/SourceBadge.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { useProjectData } from '../useProjectData.ts';

const MANUAL = { kind: 'manual' as const, ref: null };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nextId = (prefix: string, ids: string[]) => { for (let n = 1; ; n++) if (!ids.includes(`${prefix}-${n}`)) return `${prefix}-${n}`; };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="card stack" aria-label={title}><h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>{children}</section>;
}

function NoteList({ label, prefix, items, disabled, onChange }: { label: string; prefix: string; items: BrandNote[]; disabled: boolean; onChange(next: BrandNote[]): void }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {items.map((n, k) => (
        <div key={n.id} className="row" style={{ gap: 6 }}>
          <input aria-label={`${label} ${k + 1}`} value={n.text} disabled={disabled} style={{ flex: 1, width: 'auto' }}
            onChange={(e) => onChange(items.map((x, i) => (i === k ? { ...x, text: e.target.value, source: MANUAL } : x)))} />
          <SourceBadge source={n.source} />
          <button type="button" disabled={disabled} aria-label={`Rimuovi ${label.toLowerCase()} ${k + 1}`} onClick={() => onChange(items.filter((_, i) => i !== k))}>Rimuovi</button>
        </div>
      ))}
      <button type="button" disabled={disabled} style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...items, { id: nextId(prefix, items.map((i) => i.id)), text: 'Nuova regola', source: MANUAL }])}>+ Regola</button>
    </div>
  );
}

export function BrandPage({ slug, live }: { slug: string; live: EventsState }) {
  const tick = live.projectTicks[slug] ?? 0;
  const { data, error, reload } = useProjectData(() => Promise.all([api.getBrand(slug), api.listAssets(slug).catch(() => ({ assets: [] as AssetEntry[], error: null, unregistered: [] }))]), [slug, tick]);
  const [draft, setDraft] = useState<BrandKit | null>(null);
  const [guidelines, setGuidelines] = useState('');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const overview = data?.[0];
  const assets = data?.[1].assets ?? [];
  useEffect(() => { if (overview) { setDraft(overview.kit); setGuidelines(overview.guidelines); } }, [overview]);
  const job = useMemo(() => Object.values(live.jobs).filter((j) => j.key === overview?.jobKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0], [live.jobs, overview?.jobKey]);
  const running = job && (job.state === 'queued' || job.state === 'running');
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setActionError(null); setStatus(null);
    try { await fn(); if (ok) setStatus(ok); reload(); } catch (e) { setActionError(msg(e)); }
  };

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!overview || !draft) return <p className="muted">Caricamento…</p>;
  const locked = Boolean(overview.kitError);
  const dirty = JSON.stringify(draft) !== JSON.stringify(overview.kit);
  const set = <K extends keyof BrandKit>(k: K, v: BrandKit[K]) => setDraft({ ...draft, [k]: v });
  const openProposal = overview.proposals.find((p) => p.status === 'open');

  return (
    <div className="stack">
      {overview.kitError && <p role="alert" className="error">Il file brand/brand-kit.json non è leggibile: correggilo o eliminalo per continuare. ({overview.kitError})</p>}
      {overview.sourcesError && <p className="error">{overview.sourcesError}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      {openProposal && <ProposalReview key={openProposal.id} slug={slug} proposal={openProposal} onDone={reload} />}

      <Section title="Palette">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {draft.colors.map((c, k) => {
            const edit = (patch: Partial<typeof c>) => set('colors', draft.colors.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
            return (
              <div key={c.id} className="stack" style={{ gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
                <div style={{ height: 48, borderRadius: 8, background: /^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : 'transparent', border: '1px solid var(--border)' }} />
                <input aria-label={`Nome colore ${k + 1}`} value={c.name} disabled={locked} onChange={(e) => edit({ name: e.target.value })} />
                <input aria-label={`Hex colore ${k + 1}`} className="mono" value={c.hex} disabled={locked} onChange={(e) => edit({ hex: e.target.value })} />
                <select aria-label={`Ruolo colore ${k + 1}`} value={c.role} disabled={locked} onChange={(e) => edit({ role: e.target.value as typeof c.role })}>
                  {['primary', 'secondary', 'accent', 'background', 'text', 'other'].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <div className="row" style={{ gap: 6 }}><SourceBadge source={c.source} /><div style={{ flex: 1 }} />
                  <button type="button" disabled={locked} aria-label={`Rimuovi colore ${k + 1}`} onClick={() => set('colors', draft.colors.filter((_, i) => i !== k))}>Rimuovi</button></div>
              </div>
            );
          })}
        </div>
        <button type="button" disabled={locked} style={{ alignSelf: 'flex-start' }} onClick={() => set('colors', [...draft.colors, { id: nextId('colore', draft.colors.map((c) => c.id)), name: 'Nuovo colore', hex: '#000000', role: 'other', source: MANUAL }])}>+ Colore</button>
      </Section>

      <Section title="Font">
        {draft.fonts.map((f, k) => {
          const edit = (patch: Partial<typeof f>) => set('fonts', draft.fonts.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
          return (
            <div key={f.id} className="row" style={{ gap: 6 }}>
              <input aria-label={`Famiglia font ${k + 1}`} value={f.family} disabled={locked} onChange={(e) => edit({ family: e.target.value })} style={{ flex: '1 1 160px', width: 'auto' }} />
              <select aria-label={`Ruolo font ${k + 1}`} value={f.role} disabled={locked} onChange={(e) => edit({ role: e.target.value as typeof f.role })}>
                {['heading', 'body', 'accent', 'other'].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <input aria-label={`Pesi font ${k + 1}`} value={f.weights.join(', ')} disabled={locked} style={{ width: 120 }}
                onChange={(e) => edit({ weights: e.target.value.split(',').map((w) => Number(w.trim())).filter((w) => Number.isInteger(w) && w >= 100 && w <= 900) })} />
              <select aria-label={`File font ${k + 1}`} value={f.file ?? ''} disabled={locked} onChange={(e) => edit({ file: e.target.value || null })}>
                <option value="">Nessun file</option>
                {assets.filter((a) => a.kind === 'font').map((a) => <option key={a.file} value={`assets/${a.file}`}>{a.file}</option>)}
              </select>
              <span style={{ fontFamily: `'${f.family}', var(--font)`, fontSize: 18 }}>Aa Bb Cc 123</span>
              <SourceBadge source={f.source} />
              <button type="button" disabled={locked} aria-label={`Rimuovi font ${k + 1}`} onClick={() => set('fonts', draft.fonts.filter((_, i) => i !== k))}>Rimuovi</button>
            </div>
          );
        })}
        <button type="button" disabled={locked} style={{ alignSelf: 'flex-start' }} onClick={() => set('fonts', [...draft.fonts, { id: nextId('font', draft.fonts.map((x) => x.id)), family: 'Nuovo font', role: 'body', weights: [400], file: null, source: MANUAL }])}>+ Font</button>
      </Section>

      <Section title="Loghi">
        <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
          {draft.logos.map((l, k) => {
            const edit = (patch: Partial<typeof l>) => set('logos', draft.logos.map((x, i) => (i === k ? { ...x, ...patch, source: MANUAL } : x)));
            return (
              <div key={l.id} className="stack" style={{ gap: 6, width: 180 }}>
                <div style={{ height: 100, borderRadius: 8, background: l.background === 'dark' ? '#111' : '#fff', border: '1px solid var(--border)', overflow: 'hidden' }}>
                  <MediaThumb src={api.projectFileUrl(slug, l.file)} alt={`Logo ${l.id}`} style={{ objectFit: 'contain' }} />
                </div>
                <select aria-label={`Variante logo ${k + 1}`} value={l.variant} disabled={locked} onChange={(e) => edit({ variant: e.target.value as typeof l.variant })}>
                  {['primary', 'secondary', 'mono', 'icon', 'other'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <select aria-label={`Sfondo logo ${k + 1}`} value={l.background} disabled={locked} onChange={(e) => edit({ background: e.target.value as typeof l.background })}>
                  {['light', 'dark', 'any'].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <SourceBadge source={l.source} />
                <button type="button" disabled={locked} aria-label={`Rimuovi logo ${k + 1}`} onClick={() => set('logos', draft.logos.filter((_, i) => i !== k))}>Rimuovi</button>
              </div>
            );
          })}
        </div>
        <select aria-label="Aggiungi logo dagli asset" value="" disabled={locked} onChange={(e) => e.target.value && set('logos', [...draft.logos, { id: nextId('logo', draft.logos.map((x) => x.id)), file: e.target.value, variant: 'primary', background: 'any', source: MANUAL }])}>
          <option value="">Aggiungi logo dagli asset…</option>
          {assets.filter((a) => a.kind === 'svg' || a.kind === 'image').map((a) => <option key={a.file} value={`assets/${a.file}`}>{a.file}</option>)}
        </select>
      </Section>

      <Section title="Tono e stile">
        <label htmlFor="bp-tone"><strong>Tono di voce</strong></label>
        <textarea id="bp-tone" rows={2} disabled={locked} value={draft.tone?.text ?? ''} onChange={(e) => set('tone', e.target.value.trim() ? { id: 'tone', text: e.target.value, source: MANUAL } : null)} />
        <label htmlFor="bp-photo"><strong>Stile fotografico</strong></label>
        <textarea id="bp-photo" rows={2} disabled={locked} value={draft.photoStyle?.text ?? ''} onChange={(e) => set('photoStyle', e.target.value.trim() ? { id: 'photo-style', text: e.target.value, source: MANUAL } : null)} />
        <strong>Fare</strong>
        <NoteList label="Fare" prefix="fare" items={draft.dos} disabled={locked} onChange={(v) => set('dos', v)} />
        <strong>Evitare</strong>
        <NoteList label="Evitare" prefix="evitare" items={draft.donts} disabled={locked} onChange={(v) => set('donts', v)} />
      </Section>

      <div className="row">
        <div style={{ flex: 1 }} />
        {status && <span role="status" className="muted">{status}</span>}
        <button type="button" disabled={!dirty || locked} onClick={() => setDraft(overview.kit)}>Annulla modifiche</button>
        <button type="button" className="primary" disabled={!dirty || locked} onClick={() => void act(() => api.saveBrandKit(slug, draft), 'Brand kit salvato')}>Salva brand kit</button>
      </div>

      <Section title="Linee guida">
        <label htmlFor="bp-guidelines" className="muted">Linee guida (Markdown)</label>
        <textarea id="bp-guidelines" rows={10} className="mono" value={guidelines} onChange={(e) => setGuidelines(e.target.value)} />
        <button type="button" style={{ alignSelf: 'flex-end' }} disabled={guidelines === overview.guidelines} onClick={() => void act(() => api.saveGuidelines(slug, guidelines), 'Linee guida salvate')}>Salva linee guida</button>
      </Section>

      <Section title="Sorgenti e analisi">
        {overview.sources.map((s) => (
          <div key={s.id} className="row" style={{ gap: 8 }}>
            <span className="badge">{s.kind === 'website' ? 'Sito' : 'Immagine'}</span>
            <span className="mono" style={{ overflowWrap: 'anywhere', flex: 1 }}>{s.url ?? s.file}</span>
            <span className="muted" style={{ fontSize: 12 }}>{s.lastAnalyzedAt ? `Analizzata il ${new Date(s.lastAnalyzedAt).toLocaleDateString('it-IT')}` : 'Mai analizzata'}</span>
            <button type="button" aria-label={`Rimuovi sorgente ${s.id}`} onClick={() => void act(() => api.removeBrandSource(slug, s.id))}>Rimuovi</button>
          </div>
        ))}
        <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.addBrandSource(slug, { kind: 'website', url: url.trim() }); setUrl(''); }); }}>
          <input aria-label="Indirizzo del sito" placeholder="https://www.esempio.it" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, width: 'auto' }} />
          <button type="submit" disabled={!url.trim()}>Aggiungi sito</button>
        </form>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>Le immagini si aggiungono dalla scheda Riferimenti, spuntando "Usa per l'analisi brand".</p>
        <div className="row">
          {running && <><span className="badge run">Analisi in corso…</span><button type="button" onClick={() => void api.cancelJob(job!.id).catch((e: unknown) => setActionError(msg(e)))}>Annulla</button></>}
          {job?.state === 'failed' && <span className="error">Analisi non riuscita: {job.error}</span>}
          <div style={{ flex: 1 }} />
          <button type="button" className="primary" disabled={Boolean(running)} onClick={() => void act(() => api.analyzeBrand(slug))}>Analizza brand</button>
        </div>
        {overview.proposals.filter((p) => p.status !== 'open').slice(0, 5).map((p) => (
          <span key={p.id} className="muted" style={{ fontSize: 12 }}>{new Date(p.createdAt).toLocaleString('it-IT')} · proposta {p.status === 'applied' ? 'applicata' : 'scartata'}</span>
        ))}
      </Section>
    </div>
  );
}
```

Notes:
- "Analizza brand" is disabled only while a brand job runs: references flagged for the brand become sources server-side, and with no sources at all the API answers 400 and the message is shown.
- `import type React` is not needed with the automatic JSX runtime; if TypeScript complains about `React.ReactNode`, import `type ReactNode` from `react` and use it.

`ProjectPage`: Brand tab → `<BrandPage slug={slug} live={live} />`.

- [ ] **Step 4: Verifica**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): brand page with editable kit, guidelines, sources and analysis"
```

---

### Task 13: Web — Asset e Riferimenti

**Files:**
- Create: `packages/web/src/screens/AssetsPage.tsx`, `packages/web/src/screens/ReferencesPage.tsx`, `packages/web/src/components/AssetPreview.tsx`, `packages/web/test/AssetsPage.test.tsx`, `packages/web/test/ReferencesPage.test.tsx`
- Modify: `packages/web/src/screens/ProjectPage.tsx` (render the two pages)

**Interfaces:**
- Consumes: `api.listAssets`, `api.uploadFiles`, `api.registerAssets`, `api.describeAssets`, `api.updateAsset`, `api.deleteAsset`, `api.listReferences`, `api.updateReference`, `api.deleteReference`, `api.projectFileUrl`, `api.cancelJob`, `api.getBrand` (only for the brand `jobKey`) (Task 10); `UploadZone`, `useProjectData` (Task 10); `MediaThumb` (Fase 2).
- Produces:
  - `<AssetPreview url: string; kind: AssetKind; name: string />` — image/svg → `<img>`, video → `MediaThumb`, font → "Aa" in a generic serif box, other → the uppercase extension.
  - `<AssetsPage slug live />`:
    - alert with the `error` of `listAssets` (upload disabled);
    - `UploadZone` label `Carica asset` → `api.uploadFiles(slug, 'assets', files)` then reload;
    - banner `<n> file nella cartella assets/ non sono registrati` + `Registra` → `api.registerAssets(slug, unregistered)`;
    - filters: select `Tipo` (Tutti + kinds), select `Origine` (Tutte, Caricato, Da sito, Generato, Stock), search input `Cerca negli asset` (file, description, tags, case-insensitive);
    - grid of cards (`button` labelled `Apri <file>`): preview, file name, origin badge (`Caricato`/`Da sito`/`Generato`/`Stock`), size `W×H` when known;
    - detail panel for the selected asset (`aria-label="Dettaglio asset"`): preview, `Descrizione` textarea, `Tag (separati da virgola)` input, `Salva` → `api.updateAsset`, `Elimina` → `api.deleteAsset` (closes the panel), origin, `sourceUrl` as a link (`target="_blank" rel="noreferrer"`), added date;
    - `Descrivi con l'agente` → `api.describeAssets(slug)`; disabled while the brand job (key from `api.getBrand(slug).jobKey`) is active; while running `Descrizione in corso…`.
  - `<ReferencesPage slug live />`: alert with the list error; `UploadZone` label `Carica riferimenti` → `api.uploadFiles(slug, 'references', files)`; grid with preview, `Nota per <file>` textarea saved on blur (`api.updateReference`), checkbox `Usa per l'analisi brand` (immediate `api.updateReference`), `Elimina <file>`.
  - `ProjectPage`: Asset tab → `AssetsPage`, Riferimenti tab → `ReferencesPage`.

- [ ] **Step 1: Test che falliscono**

`packages/web/test/AssetsPage.test.tsx`:
```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const at = '2026-10-07T10:00:00.000Z';
let listing: { assets: unknown[]; error: string | null; unregistered: string[] };
const api = {
  listAssets: vi.fn(async () => listing),
  getBrand: vi.fn(async () => ({ jobKey: 'brand:k' })),
  uploadFiles: vi.fn(async () => ({})),
  registerAssets: vi.fn(async () => ({ assets: [] })),
  describeAssets: vi.fn(async () => ({ id: 'j' })),
  updateAsset: vi.fn(async (_s: string, file: string, patch: object) => ({ file, ...patch })),
  deleteAsset: vi.fn(async () => ({ ok: true })),
  cancelJob: vi.fn(),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { AssetsPage } = await import('../src/screens/AssetsPage.tsx');
const live = { jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };

beforeEach(() => {
  vi.clearAllMocks();
  listing = {
    error: null, unregistered: ['manual.png'],
    assets: [
      { file: 'logo.svg', kind: 'svg', origin: 'website', sourceUrl: 'https://acme.example/logo.svg', description: 'Logo principale', tags: ['logo'], width: null, height: null, addedAt: at },
      { file: 'foto.jpg', kind: 'image', origin: 'upload', sourceUrl: null, description: '', tags: [], width: 1920, height: 1080, addedAt: at },
    ],
  };
});

describe('AssetsPage', () => {
  it('filters, opens the detail and saves metadata', async () => {
    render(<AssetsPage slug="acme" live={live} />);
    await waitFor(() => screen.getByRole('button', { name: 'Apri logo.svg' }));
    expect(screen.getByText('1920×1080')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Origine'), 'website');
    expect(screen.queryByRole('button', { name: 'Apri foto.jpg' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Origine'), 'all');
    await userEvent.type(screen.getByLabelText('Cerca negli asset'), 'LOGO');
    expect(screen.queryByRole('button', { name: 'Apri foto.jpg' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Apri logo.svg' }));
    const panel = screen.getByLabelText('Dettaglio asset');
    expect(within(panel).getByRole('link', { name: 'https://acme.example/logo.svg' })).toBeTruthy();
    const tags = within(panel).getByLabelText('Tag (separati da virgola)');
    await userEvent.clear(tags);
    await userEvent.type(tags, 'logo, principale');
    await userEvent.click(within(panel).getByRole('button', { name: 'Salva' }));
    await waitFor(() => expect(api.updateAsset).toHaveBeenCalledWith('acme', 'logo.svg', { description: 'Logo principale', tags: ['logo', 'principale'] }));
  });
  it('registers unregistered files, deletes and asks for descriptions', async () => {
    render(<AssetsPage slug="acme" live={live} />);
    await waitFor(() => screen.getByText('1 file nella cartella assets/ non sono registrati'));
    await userEvent.click(screen.getByRole('button', { name: 'Registra' }));
    await waitFor(() => expect(api.registerAssets).toHaveBeenCalledWith('acme', ['manual.png']));
    await userEvent.click(screen.getByRole('button', { name: "Descrivi con l'agente" }));
    await waitFor(() => expect(api.describeAssets).toHaveBeenCalledWith('acme'));
    await userEvent.click(screen.getByRole('button', { name: 'Apri foto.jpg' }));
    await userEvent.click(within(screen.getByLabelText('Dettaglio asset')).getByRole('button', { name: 'Elimina' }));
    await waitFor(() => expect(api.deleteAsset).toHaveBeenCalledWith('acme', 'foto.jpg'));
  });
  it('shows a corrupt listing and disables uploads', async () => {
    listing = { assets: [], unregistered: [], error: 'assets.json: JSON non valido' };
    render(<AssetsPage slug="acme" live={live} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('assets.json'));
    expect(screen.getByRole('button', { name: 'Carica asset' }).getAttribute('aria-disabled')).toBe('true');
  });
});
```

`packages/web/test/ReferencesPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const api = {
  listReferences: vi.fn(async () => ({ references: [{ file: 'mood.jpg', note: '', useForBrand: true, addedAt: '2026-10-07T10:00:00.000Z' }], error: null })),
  uploadFiles: vi.fn(async () => ({})),
  updateReference: vi.fn(async () => ({})),
  deleteReference: vi.fn(async () => ({ ok: true })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { ReferencesPage } = await import('../src/screens/ReferencesPage.tsx');

describe('ReferencesPage', () => {
  it('edits notes, toggles brand use and deletes', async () => {
    render(<ReferencesPage slug="acme" live={{ jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} }} />);
    const note = await screen.findByLabelText('Nota per mood.jpg');
    await userEvent.type(note, 'Luce calda');
    note.blur();
    await waitFor(() => expect(api.updateReference).toHaveBeenCalledWith('acme', 'mood.jpg', { note: 'Luce calda' }));
    await userEvent.click(screen.getByRole('checkbox', { name: "Usa per l'analisi brand" }));
    await waitFor(() => expect(api.updateReference).toHaveBeenCalledWith('acme', 'mood.jpg', { useForBrand: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Elimina mood.jpg' }));
    await waitFor(() => expect(api.deleteReference).toHaveBeenCalledWith('acme', 'mood.jpg'));
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `pnpm vitest run packages/web/test/AssetsPage.test.tsx packages/web/test/ReferencesPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementa**

`packages/web/src/components/AssetPreview.tsx`:
```tsx
import type { AssetKind } from '@motion-studio/shared';
import { MediaThumb } from './MediaThumb.tsx';

export function AssetPreview({ url, kind, name }: { url: string; kind: AssetKind; name: string }) {
  if (kind === 'image' || kind === 'svg') return <img src={url} alt={name} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />;
  if (kind === 'video') return <MediaThumb src={url} alt={name} />;
  const label = kind === 'font' ? 'Aa' : (name.split('.').pop() ?? '').toUpperCase();
  return <span style={{ fontSize: kind === 'font' ? 40 : 18, fontFamily: kind === 'font' ? 'Georgia, serif' : 'var(--mono)', color: 'var(--muted)' }}>{label}</span>;
}
```

`packages/web/src/screens/AssetsPage.tsx`:
```tsx
import type { AssetEntry, AssetKind, AssetOrigin } from '@motion-studio/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { AssetPreview } from '../components/AssetPreview.tsx';
import { UploadZone } from '../components/UploadZone.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { useProjectData } from '../useProjectData.ts';

const ORIGIN: Record<AssetOrigin, string> = { upload: 'Caricato', website: 'Da sito', generated: 'Generato', stock: 'Stock' };
const KINDS: AssetKind[] = ['image', 'svg', 'video', 'font', 'audio', 'other'];
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Detail({ slug, asset, onChanged, onClose }: { slug: string; asset: AssetEntry; onChanged(): void; onClose(): void }) {
  const [description, setDescription] = useState(asset.description);
  const [tags, setTags] = useState(asset.tags.join(', '));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDescription(asset.description); setTags(asset.tags.join(', ')); }, [asset]);
  const run = async (fn: () => Promise<unknown>, close = false) => {
    setError(null);
    try { await fn(); onChanged(); if (close) onClose(); } catch (e) { setError(msg(e)); }
  };
  return (
    <aside aria-label="Dettaglio asset" className="card stack" style={{ flex: '1 1 300px', maxWidth: 380 }}>
      <div className="dots" style={{ height: 180, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <AssetPreview url={api.projectFileUrl(slug, `assets/${asset.file}`)} kind={asset.kind} name={asset.file} />
      </div>
      <strong className="mono" style={{ overflowWrap: 'anywhere' }}>{asset.file}</strong>
      <span className="muted" style={{ fontSize: 13 }}>{ORIGIN[asset.origin]} · aggiunto il {new Date(asset.addedAt).toLocaleDateString('it-IT')}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</span>
      {asset.sourceUrl && <a href={asset.sourceUrl} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{asset.sourceUrl}</a>}
      <label htmlFor="ad-desc">Descrizione</label>
      <textarea id="ad-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      <label htmlFor="ad-tags">Tag (separati da virgola)</label>
      <input id="ad-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
      {error && <p role="alert" className="error" style={{ margin: 0 }}>{error}</p>}
      <div className="row">
        <button type="button" onClick={() => void run(() => api.deleteAsset(slug, asset.file), true)}>Elimina</button>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose}>Chiudi</button>
        <button type="button" className="primary" onClick={() => void run(() => api.updateAsset(slug, asset.file, { description, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) }))}>Salva</button>
      </div>
    </aside>
  );
}

export function AssetsPage({ slug, live }: { slug: string; live: EventsState }) {
  const tick = live.projectTicks[slug] ?? 0;
  const { data, error, reload } = useProjectData(() => Promise.all([api.listAssets(slug), api.getBrand(slug).then((b) => b.jobKey).catch(() => null)]), [slug, tick]);
  const [kind, setKind] = useState<AssetKind | 'all'>('all');
  const [origin, setOrigin] = useState<AssetOrigin | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listing = data?.[0];
  const jobKey = data?.[1] ?? null;
  const job = Object.values(live.jobs).find((j) => j.key === jobKey && (j.state === 'queued' || j.state === 'running'));
  const visible = useMemo(() => (listing?.assets ?? []).filter((a) =>
    (kind === 'all' || a.kind === kind) && (origin === 'all' || a.origin === origin)
    && (!query.trim() || `${a.file} ${a.description} ${a.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))), [listing, kind, origin, query]);
  const act = async (fn: () => Promise<unknown>) => { setActionError(null); try { await fn(); reload(); } catch (e) { setActionError(msg(e)); } };

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!listing) return <p className="muted">Caricamento…</p>;
  const current = listing.assets.find((a) => a.file === selected);
  return (
    <div className="stack">
      {listing.error && <p role="alert" className="error">{listing.error}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      <UploadZone label="Carica asset" disabled={Boolean(listing.error)} onFiles={async (files) => { await api.uploadFiles(slug, 'assets', files); reload(); }} />
      {listing.unregistered.length > 0 && (
        <div className="warn row">
          <span style={{ flex: 1 }}>{listing.unregistered.length} file nella cartella assets/ non sono registrati</span>
          <button type="button" onClick={() => void act(() => api.registerAssets(slug, listing.unregistered))}>Registra</button>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <label className="row" style={{ gap: 6 }}>Tipo
          <select aria-label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as AssetKind | 'all')}>
            <option value="all">Tutti</option>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}>Origine
          <select aria-label="Origine" value={origin} onChange={(e) => setOrigin(e.target.value as AssetOrigin | 'all')}>
            <option value="all">Tutte</option>{(Object.keys(ORIGIN) as AssetOrigin[]).map((o) => <option key={o} value={o}>{ORIGIN[o]}</option>)}
          </select>
        </label>
        <input aria-label="Cerca negli asset" placeholder="Cerca per nome, descrizione o tag" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, width: 'auto' }} />
        {job ? <span className="badge run">Descrizione in corso…</span> : null}
        <button type="button" disabled={Boolean(job)} onClick={() => void act(() => api.describeAssets(slug))}>Descrivi con l'agente</button>
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: '999 1 480px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
          {visible.map((a) => (
            <button key={a.file} type="button" aria-label={`Apri ${a.file}`} onClick={() => setSelected(a.file)} className="card stack"
              style={{ padding: 8, gap: 6, textAlign: 'left', borderColor: selected === a.file ? 'var(--accent)' : undefined }}>
              <span className="dots" style={{ height: 110, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                <AssetPreview url={api.projectFileUrl(slug, `assets/${a.file}`)} kind={a.kind} name={a.file} />
              </span>
              <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{a.file}</span>
              <span className="row" style={{ gap: 6 }}><span className="badge">{ORIGIN[a.origin]}</span>{a.width && <span className="muted" style={{ fontSize: 12 }}>{a.width}×{a.height}</span>}</span>
            </button>
          ))}
          {visible.length === 0 && <p className="muted">Nessun asset.</p>}
        </div>
        {current && <Detail slug={slug} asset={current} onChanged={reload} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
```

`packages/web/src/screens/ReferencesPage.tsx`:
```tsx
import { useState } from 'react';
import { api } from '../api.ts';
import { UploadZone } from '../components/UploadZone.tsx';
import type { EventsState } from '../eventsReducer.ts';
import { useProjectData } from '../useProjectData.ts';

export function ReferencesPage({ slug, live }: { slug: string; live: EventsState }) {
  const { data, error, reload } = useProjectData(() => api.listReferences(slug), [slug, live.projectTicks[slug] ?? 0]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setActionError(null); try { await fn(); reload(); } catch (e) { setActionError(e instanceof Error ? e.message : String(e)); } };
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p className="muted">Caricamento…</p>;
  return (
    <div className="stack">
      {data.error && <p role="alert" className="error">{data.error}</p>}
      {actionError && <p role="alert" className="error">{actionError}</p>}
      <UploadZone label="Carica riferimenti" disabled={Boolean(data.error)} onFiles={async (files) => { await api.uploadFiles(slug, 'references', files); reload(); }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {data.references.map((r) => (
          <div key={r.file} className="card stack" style={{ padding: 10, gap: 6 }}>
            <img src={api.projectFileUrl(slug, `references/${r.file}`)} alt={r.file} style={{ width: '100%', height: 150, objectFit: 'cover', borderRadius: 8 }} />
            <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{r.file}</span>
            <textarea aria-label={`Nota per ${r.file}`} rows={2} value={notes[r.file] ?? r.note}
              onChange={(e) => setNotes((n) => ({ ...n, [r.file]: e.target.value }))}
              onBlur={() => { const v = notes[r.file]; if (v !== undefined && v !== r.note) void act(() => api.updateReference(slug, r.file, { note: v })); }} />
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={r.useForBrand} onChange={(e) => void act(() => api.updateReference(slug, r.file, { useForBrand: e.target.checked }))} style={{ width: 16, height: 16 }} />
              Usa per l'analisi brand
            </label>
            <button type="button" aria-label={`Elimina ${r.file}`} onClick={() => void act(() => api.deleteReference(slug, r.file))}>Elimina</button>
          </div>
        ))}
      </div>
      {data.references.length === 0 && <p className="muted">Nessun riferimento: carica immagini di ispirazione o del brand.</p>}
    </div>
  );
}
```

`ProjectPage`: Asset → `<AssetsPage slug={slug} live={live} />`, Riferimenti → `<ReferencesPage slug={slug} live={live} />`.

- [ ] **Step 4: Verifica**

Run: `pnpm vitest run packages/web && pnpm --filter @motion-studio/web build && pnpm typecheck`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): asset library and references with upload, filters and agent descriptions"
```

---

### Task 14: README e verifica end-to-end (finto e reale)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

Update the status line to `> Stato: fase 3 (brand, asset e codebase collegate).` and add a section:
```markdown
## Brand, asset e codebase collegate
- **Brand**: palette, font, loghi, tono, cose da fare e da evitare, stile fotografico; ogni voce mostra da dove arriva (manuale, sito, immagine). Le linee guida discorsive sono in `brand/guidelines.md`.
- **Analisi brand**: aggiungi uno o più siti (e le immagini di riferimento con "Usa per l'analisi brand") e premi **Analizza brand**. L'agente visita i siti, scarica gli asset utili in `assets/` e propone modifiche: le applichi voce per voce, le voci inserite a mano non vengono mai rimosse.
- **Asset e riferimenti**: carica file trascinandoli, filtra per tipo e origine, aggiungi descrizioni e tag (anche con **Descrivi con l'agente**).
- **Codebase collegate** (Impostazioni del progetto o della singola creatività): cartelle del tuo computer che l'agente può leggere ma non modificare (regole di sola lettura su ogni turno; se una cartella è un repository git e risulta modificata dopo un turno, la conversazione lo segnala).

Sicurezza: durante l'analisi brand l'agente può anche usare `WebFetch` e `curl` per scaricare i file dai siti indicati.
```

- [ ] **Step 2: Controlli automatici**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: tutto verde.

- [ ] **Step 3: Smoke con il finto `claude`**

Avvia come nella Fase 2 (`FAKE_CLAUDE_SCENARIO=render`, porta 4399; lo scenario `render` gestisce anche l'analisi brand). Via curl:
1. workspace, progetto "Acme";
2. `POST /api/projects/acme/brand/sources {"kind":"website","url":"https://acme.example"}` e `POST …/brand/analyze`; dopo la fine del job `GET …/brand` mostra una proposta `open` con `colors:add:arancio`;
3. `POST …/brand/proposals/<id>/apply {"acceptedIds":["colors:add:arancio"],"applyGuidelines":true}` → kit con 1 colore, linee guida aggiornate;
4. upload di un PNG in `/assets` (curl `-F files=@file.png`), `GET …/assets` lo elenca;
5. creatività con `generate: true` → `ready`, e il prompt registrato contiene `## Brand`.

- [ ] **Step 4: Verifica con il vero Claude Code**

Avvia `MOTION_STUDIO_CONFIG_DIR="$(mktemp -d)" node apps/cli/dist/main.js --port 4398 --no-open` e, via curl (costi bassi: un sito, brief brevi):
1. workspace temporaneo, progetto "Prova Brand";
2. sorgente `https://www.python.org`, `analyze`; attendi il job: proposta `open` con colori/font/loghi plausibili, asset scaricati in `assets/` e registrati con `origin: website` e `sourceUrl`; annota tempo e numero di modifiche proposte; verifica che `brand/brand-kit.json` NON sia cambiato prima dell'apply;
3. applica tutte le modifiche e le linee guida;
4. crea una cartella temporanea `cb` (copia di `packages/web/src` con `git init` e un commit) e collegala al progetto (`PUT /api/projects/prova-brand {"linkedCodebases":[{"path":"<cb>","note":"UI di riferimento"}]}`);
5. creatività con un formato immagine (`web-banner-300x250`) e brief "Banner che riprende i colori del brand e lo stile dei componenti nella codebase collegata", `generate: true`; attendi: versione `complete`, prompt con `## Brand` e `## Codebase di riferimento (sola lettura)`, nessun avviso di codebase modificata, `git -C <cb> status --porcelain` vuoto;
6. turno di iterazione che chiede esplicitamente all'agente di "aggiungere un file README nella codebase collegata": deve essere rifiutato (la regola di sola lettura) e la codebase resta invariata; riporta la risposta dell'agente;
7. `POST …/assets/describe` su 1–2 asset: descrizioni compilate in italiano.
I controlli visivi nel browser (pagine Brand, Asset, Riferimenti, Impostazioni, revisione proposta) restano all'utente.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: describe brand, library and linked codebases (phase 3)"
```
