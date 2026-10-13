# Task 5 report: web Languages UI

Status: done. One commit on feat/phase12-variants (from 6d7f965).

## Gates (after last edit)
- MS_REQUIRE_CHROME=1 pnpm test: 266 files / 5384 tests, all pass (no flake). pnpm typecheck, check:i18n, web build: ok.
- mtimes before/after: 1791621882, 1791538433, 1791822737 (unchanged); AppSupport/Electron absent.

## Core (small)
- composition-server `attachLocaleAssets(projectDir, files)` (preview sessions only): serves only listed `assets/audio|fonts/<file>`, sha256-verified, confined (no symlink/hard link/traversal, project folder identity), composition folder wins, ranges.
- `PreviewService.attachLocale` + route `POST …/localizations/:locale/:instanceId/preview-assets {token}` (paths = overlayAssetPaths ∩ row.assetHashes). Tests: composition-server-locale (7), localization-preview-assets (2).

## Web
- New in screens/creative: languagesModel, LanguagesPanel, LocalizationTable, PaidBatchCard, LanguagesButton, useLocalePreview, LocaleSwitcher (+LocaleOutline), RenderLanguagesDialog, BriefLanguages, languages.css.
- ApprovalCard delegates paid-batch to PaidBatchCard (approvals center, conversation, dialogs, panel).
- Wired: BriefEditor, FormatView, EditorScreen (read-only locale preview), CreativeCanvas (render dialog), ExportDialog (languages, 409 list, Render anyway/force). api.ts and en/it catalogs extended.
- Tests: LanguagesPanel (24), LocalizationTable (8), PaidBatchCard (7), locale-preview (8).
- Decisions log 479-485.

## Concerns
- Live overflow measurement in the preview not turned on (optional); outline only for the focused flagged clip (runtime reports one clip box).
- NewCreative has no language picker (brief editor only).
- Problem-to-clip matching relies on the clip name in quotes inside the stored sentence.
- Preview assets attach replaces the list on a shared session; only one locale per session is served at a time.
- Full-run `timeout 900` wrapper was used once (run finished in 300 s).

## Fix round 1
- I1: preview server checks the winning file (composition folder or project) against the recorded hash, 404 on mismatch; test changed (planted mismatching file 404, matching file 200).
- I2/Ruling M: `LocalizationRow.issues` (code, clipId, message), filled in store.finishOverlay, localize-turn (final rows, voice phase, submit), carry, PUT, render-jobs (measured overflow, assetChanged add/strip). GET, PUT and `?locale=` answer it. UI flags by code+clipId, label from code; name matching only for old rows and only exact overflow sentences. Tests: localization-issues (core), carry, voice-batch, render-locale; web locale-preview and LocalizationTable (same-name clips).
- Ruling N: not cheap (runtime reports one clip box; all boxes would need a protocol message or time-stale sequential selects). Kept: focused outline + labelled list.
- Minors done: M1 (failed original re-sent), M2 version/format check, M3 shown version, M4 clear selection, M6 RTL in the primary list. Deferred: M5 hash cache, M2 per-viewer list on shared session, M7.
- Decisions log 486-489.
