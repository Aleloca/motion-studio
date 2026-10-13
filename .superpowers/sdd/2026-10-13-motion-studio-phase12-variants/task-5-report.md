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
