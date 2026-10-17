# Phase 15 - live checks: creative variants (Task 7)

Date: 2026-10-17. macOS, Claude Code **2.1.302**, model `haiku`, branch `feat/phase15-variants` at `ca2546f`. Every path below under the throwaway folder is written `<tmp>`.

**Verdict:** the five variant flows work in the dev Electron app. The canvas screenshots found two layout defects (D1, D2); both were fixed after the check (decisions 869 and 870, commit `5d05289`). One side observation about `git add -A` was triaged and fixed too (decisions 868 and 871).

| Check | Result |
|---|---|
| 1. Creative with 3 variants, directions mixed (typed and agent-proposed), run all | **PASS** |
| 2. "Tutte" with one request to every variant | **PASS** |
| 3. Mixed ★ across variants and the group export | **PASS** |
| 4. Identity group: logo + favicon + app icon, 3 concepts as variants | **PASS** |
| 5. Discard and restore, with the refusals | **PASS** |
| 6. Canvas screenshots (it, 1280 and 1024 px, both groupings) | **D1 and D2 found**, then fixed (see below) |

## Setup
- **Throwaway folders:** `<tmp>` holds the config folder (`MOTION_STUDIO_CONFIG_DIR`), the Electron data folder (`MOTION_STUDIO_USER_DATA_DIR`, logged as "MOTION_STUDIO_USER_DATA_DIR set, Electron data in `<tmp>/userdata`"), the workspace and the logs.
- **Dev Electron app:** the built `apps/desktop/dist` started with its cwd in the worktree's `apps/desktop`. The worktree's install had no Electron binary, so the Electron 44.7.0 binary was taken read-only from the main checkout by absolute path (an orchestrator ruling). The render engine was `electron`; "PATH source: login-shell".
- **Environment:** started with `env -i`, every `CLAUDE*` and `ANTHROPIC*` variable removed. The `claude` wrapper received only the pointer to the login folder and stripped `NODE_OPTIONS`.
- **Keychain:** a keyring stub registered through `module.registerHooks` (logged "keyring stub active") plus `--use-mock-keychain --password-store=basic`. No keychain dialog appeared. No provider key was set.
- **Paid services:** every type `none`. So no paid-batch card was expected: with no usable paid service the batch starts at once (decision 840). The card itself was not exercised (see the manual list).
- **Driving:** the app window was open but not clicked. Every flow went through the core HTTP API of the running app, with the UI token header, the same calls the web UI makes. Approvals seen at any poll: none.

## Results

### 1. Three variants, directions, run
Creative "Lancio caffe" (instagram-image-1x1 + youtube-thumbnail). `POST …/variants` with 3 directions `[typed, null, null]`, then `POST …/variants/run` for all active variants: 202 with the three jobs and a `directionsJobId`, no `batchId`.
- The directions turn had only `mcp__studio__submit_variant_directions` (no Write, Edit or Bash). It proposed B "Foto calda e materica…" and C "Narrazione di viaggio: mappa stilizzata…"; A kept the user's text.
- A and B ran first, C waited with `waitReason` `variant-slot` (limit of 2); all succeeded.
- **Isolation:** the `Write` and `Edit` paths of each agent were only inside its own variant folder (A 12, B 12, C 6).

### 2. "Tutte"
The request "Rendi il titolo più grande e aggiungi la scritta 'Disponibile da lunedì'" became 3 jobs, C again in `variant-slot`, all succeeded. Each variant has a v2.

### 3. Mixed ★ and group export
★ on the Instagram image: C v2; on the thumbnail: B v1 (`PUT` picks). The export-group plan showed c v2 and b v1, `needs-render`. `POST export-group` rendered on demand inside each member and wrote `lancio-caffe-instagram-image-1x1-v2.png` (from C) and `lancio-caffe-youtube-thumbnail-v1.png` (from B): host naming, no `~` in the names, `skipped` and `unavailable` empty. The images match their directions (C: the map and "Disponibile da lunedì"; B: warm beans, from before "Tutte").

### 4. Identity as variants
"Logo Torrefazione" from scratch, 3 concepts, logo + favicon + app icon, generate on. The create response carried `variantRun` with 3 jobs and a `directionsJobId`. The agent proposed 3 directions (vintage stamp, single-line geometric, slow spiral). Every member has the three identity formats. B was rendered: logo, favicon and app icon all come from the same single-line bean mark.

### 5. Discard and restore (group of check 1)
- Discarding B dropped its thumbnail ★; the pick fell back to the default (A v2).
- `POST` a turn on `~b`: 409 `variant-discarded`, "Ripristina la variante per lavorarci".
- Restoring B made it active again; the old ★ was not restored.
- Discarding the last active variant: 409 `variant-last-active`, "La variante B è l'ultima attiva: tienine almeno una".

### 6. Canvas screenshots (Chrome harness, headless, mock keychain)
Italian, 1280 and 1024 px wide, both groupings. The "Formato" grouping was correct. The "Variante" grouping at 1280 px had two defects:
- **D1.** In the left formats column, long direction headers ("B · FOTO CALDA E MATERICA: …") wrapped and overlapped the format rows below them.
- **D2.** In the same column the ★ marks did not follow the group selection: ★ appeared on A's image and thumbnail while the picks were C v2 and B v1; the "Formato" grouping showed ★ only on C Instagram. The two groupings disagreed with each other and with the core plan.

**Fixed after the check:** decision 869 (the header takes at most two lines and no longer covers the rows) and decision 870 (the column's ★ reads the same core plan as "Selezione finale"), commit `5d05289`. The Chrome layout test now has a long-direction case. The fixes were not re-checked live.

## Observation: `git add -A` and sister variants
Core commits use `git add -A`, so the commit of one variant's version can include files another variant is still writing (it was already true for concurrent creatives; with sisters running in parallel it is more frequent). Triage:
- Restore is path-scoped, so restoring a version never brings back wrong content.
- The real bug was a version commit that could come out null because another creative had already committed its files. Fixed in decision 868 (commit `1fb0999`) and completed in decision 871 (commit `05a878d`: the "nothing to commit" check looks only at what is staged).

## Cost and real folders
- 11 Claude runs, **$0.261** in total.
- The mtimes of the user's real folders are identical before and after; `~/Library/Application Support/Electron` does not exist; the main checkout was untouched (only the user's untracked `branding/`).
- Screenshots are not committed: they were kept in the throwaway folder.

## Note on the commit
The live run was made on `ca2546f`, before the fixes of decisions 868-871 (commits `1fb0999`, `05a878d`, `5d05289`).

## Da verificare a mano dall'utente
- Click in the Electron window: the variant selector, the ★ on another variant's board, "Apri questa variante", the ⋯ menu "+ Variante", the greyed rows of "Mostra scartate".
- The paid-batch card with real paid services on (not exercised: services were off by ruling). One card should cover the whole batch and hold the starts.
- Drag and scroll of the canvas.
- The canvas "Variante" grouping after the fixes of D1 and D2, at 1280 and 1024 px.
