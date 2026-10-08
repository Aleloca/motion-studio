# Contributing to Motion Studio

🇮🇹 The user guide is also available in [Italian](README.it.md). Contributions are written in English (code comments, commits, documentation).

Thanks for your interest! This guide explains how to set up the environment and what we expect from a change.

## Setup
You need Node.js 22+ (CI uses 24), pnpm, Git and FFmpeg (some tests use it). You do not need Claude Code to run the tests.

```bash
pnpm install
pnpm test        # all tests
pnpm typecheck
pnpm check:i18n  # Italian text left outside the language catalogs
pnpm dev         # core (port 4317) + web (Vite, 5173)
```

A single file: `npx vitest run packages/core/test/export.test.ts`. Tests that use ffmpeg have `{ timeout: 20_000 }`.

## Monorepo map
- `packages/shared` — shared types and zod schemas (manifest, events, settings, format catalog) and the language catalogs (`src/i18n`).
- `packages/core` — the Fastify server and all the logic: projects and creatives, agent (runner, launcher, policy, sandbox), approvals, MCP bridge, providers, export.
- `packages/web` — the interface (React + Vite).
- `packages/mcp-studio` — the `studio` MCP server (stdio) the agent uses to talk to the core.
- `apps/cli` — the `@motion-studio/cli` npm package (tsup bundle that includes the web app).
- `apps/desktop` — the Electron app, which runs the core in the same process.

Other guides: [output contract](docs/output-contract.md), [providers](docs/providers.md), [agent backends](docs/agent-backends.md); the design is in `docs/superpowers/specs/`.

## How we work
- **TDD**: write the failing test first, then the code that makes it pass. A bug fix starts from a test that reproduces the bug. Run the focused test while you develop and the whole suite (`pnpm test && pnpm typecheck`) before opening the pull request.
- **Never the real `claude` in tests**: use the fake agent `packages/core/test/fixtures/fake-claude.mjs` (scenario with `FAKE_CLAUDE_SCENARIO`, command with `MOTION_STUDIO_CLAUDE_COMMAND`). Do not touch the real keychain: use `MemoryVault`. No real network calls: test providers with an injected `fetch`.
- **No secrets in tests** or commits: use fake keys, never real ones.
- **Conventions**:
  - Interface and agent texts are in English and Italian, and always go through the catalogs (see Languages below): never write user-visible text directly in the code.
  - The agent's instructions are in English, with an explicit request to reply in the language chosen in Settings.
  - In the interface use only CSS tokens (no hard-coded colors).
  - JSON files have `schemaVersion: 1` and a corrupt JSON is never rewritten.
  - The server accepts only loopback Host and Origin.
  - Code comments are in English.
- **Commits**: messages in English in the Conventional Commits style (`feat(core): …`, `fix(web): …`, `docs: …`, `build(desktop): …`, `ci: …`), one coherent change per commit. Do not commit `dist/`, `release/`, `resources/` or `.tgz` files.
- **Security**: a change to the sandbox, policy, bridge or providers comes with a test and, if it changes what is allowed, with an update to the Security section of the README (and of `README.it.md`).

## Languages
Texts live in two catalogs in `packages/shared/src/i18n/`: `en.ts` is the source of truth (it defines the keys and the placeholder shapes) and `it.ts` is typed as `Messages`, so the type checker rejects a missing key or a function with different parameters. In the code use `t()` (core) or the web hook; never a literal.

Copy style (English): short, direct sentences, active voice, names the user recognizes. Errors say what happened and how to fix it, without apologies.

`pnpm check:i18n` (also run by CI after the type check) scans string literals, template literals and JSX text in `packages/*/src` and `apps/*/src` — excluding the catalogs and the tests — and fails on Italian accented letters or frequent Italian words. For a real exception add `// i18n-ignore <reason>` on the same line (or `{/* i18n-ignore <reason> */}` in JSX).

Texts already saved in a user's project (validation problems in `versions.json`, conversation messages, guidelines) are never translated: only new texts use the current language. Do not base logic on the text of a label: use structured fields.

### Adding a language
1. Copy `packages/shared/src/i18n/en.ts` to `packages/shared/src/i18n/<code>.ts` (for example `fr.ts`) type it as `Messages` (`export const fr: Messages = …`, as `it.ts` does) and translate every value. Keep the keys and the placeholders (`p.name`) exactly as they are.
2. In `packages/shared/src/i18n/index.ts`: add the code to `LOCALES` (the `Locale` type, `isLocale`, the `language` setting enum, the server-side validation and the system-language resolution all derive from it), register the catalog in `CATALOGS` and add the language's English name to `LANGUAGE_NAMES` (it is the language the agent is asked to reply in, e.g. `French`). The type checker flags a missing entry in either table.
3. Add the language's own name (for example `Français`) to `web.settings.languageNames` in `en.ts`, then in every other catalog (the type checker lists the ones you miss). The selector in **Settings → Language** is built from `LOCALES`, so it lists the new language by itself.
4. Run `pnpm typecheck`: it lists every key that is missing from the new catalog. Then run `pnpm test` and `pnpm check:i18n`.

## Releases
See the *Release* section of the README (`vX.Y.Z` tag, workflow secrets).

Building the npm package requires Node ≥ 22.18 (prepack in TypeScript).
