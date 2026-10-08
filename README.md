# Motion Studio

🇮🇹 [Italiano](README.it.md)

A local, open-source app for creating motion-graphics videos and images with your coding agent (initially **Claude Code**). Describe what you want, pick channels and formats: the agent produces a dedicated recomposition for each format. Everything stays on your computer: projects are folders of JSON/Markdown files versioned with git.

<!-- screenshot: add -->

> The full design is in `docs/superpowers/specs/`. Developer guides: [CONTRIBUTING.md](CONTRIBUTING.md), [output contract](docs/output-contract.md), [providers](docs/providers.md), [agent backends](docs/agent-backends.md).

## Language
Motion Studio is available in English and Italian. On first launch it uses your system language: the first of your preferred languages that Motion Studio supports, English if none is. Change it in **Settings → Language** (System / English / Italiano): the interface, the desktop menus and the messages of the terminal launcher switch language, and the agent replies, and writes the texts meant for you, in the chosen language. When the desktop app attaches to a Motion Studio that is already running, its native menu keeps the language it started with; the interface follows the change live. To add another language, see [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-language).

Texts saved in the past (validation problems in a version, conversation messages, brand guidelines) are not translated; only new texts use the current language.

## Installation

**Desktop app (Electron).** Download the installer from the project's GitHub *Releases* page, once it is published (macOS: Apple Silicon `arm64` and Intel `x64`). Unsigned builds (those without the maintainers' certificates) need an extra step the first time:
- macOS: right-click the app, then **Open** (and confirm); a normal double-click is blocked by Gatekeeper.
- Automatic app updates (check at launch, install on restart) require **signed** builds on macOS; with an unsigned build, update by downloading the new version by hand.

**From npm.** `npx @motion-studio/cli` (the installed command is called `motion-studio`), once it is published. Publishing it requires the `motion-studio` npm organization. Until then, use the sources.

**From source.**
```bash
pnpm install
pnpm motion-studio        # build + start on http://127.0.0.1:4317 and open the browser
```

Launcher options (after the script name, e.g. `pnpm motion-studio --port 5000 --no-open`):
- `--port <n>` — port of the local server (1–65535, default 4317).
- `--no-open` — do not open the browser (if opening fails, the launcher prints the address to open by hand).
- `--print-url` — print the address of the Motion Studio that is already running, without starting another one (useful if you closed the tab).

The address printed at startup contains an access code (`#t=…`): open Motion Studio from that link. The browser remembers it; if the interface asks you to reopen it from the terminal link, use `--print-url`. The desktop app opens its own window.

Only one Motion Studio runs per configuration folder: if one is already running (from the terminal or as the desktop app), `motion-studio` prints `Motion Studio is already running: <address>`, opens it in the browser (unless `--no-open`) and exits, and the desktop app opens that address instead of starting another (if that Motion Studio quits, the app offers to restart).

## Requirements
- [Claude Code](https://docs.claude.com/claude-code) installed and signed in (`claude auth login`)
- Git
- FFmpeg (recommended: without it, outputs are shown as "unverified")
- Node.js 22+ for `npx` and the sources (not needed for the desktop app)

## How it works
1. In a project, open **Creatives → + New creative**, describe what you want, pick channels and formats and press **Generate**.
2. The agent works in `creatives/<date-title>/work/` and delivers, in `outputs/vN/`, one file per format plus `manifest.json` ([full contract](docs/output-contract.md)).
3. Motion Studio checks the outputs (presence, resolution, duration; with ffmpeg/ffprobe installed it really verifies them): if something is off it asks the agent to fix it, up to 3 attempts in total; then it saves the version, even if incomplete.
4. Each version is a git commit of the project. From the creative's page you can open a format, add comments on a spot/moment, ask for changes, compare versions and restart from an earlier version.

### Export
From the creative's page, **Export…** copies the outputs of a version into a folder of your choice (the desktop app also has **Choose folder…**). Files are named `<slug>-<format>-vN.<extension>` (e.g. `launch-instagram-reel-9x16-v2.mp4`); it never overwrites anything (if the name exists it appends `-2`, `-3`…) and refuses destinations inside the Motion Studio workspace. Outputs that cannot be exported (missing or irregular file) are skipped and the interface lists them.

### Adding formats
If you add formats to the brief of an already generated creative and press **Generate** again, Motion Studio asks the agent to add only the missing formats, reusing the sources already in `work/` and the same style as the previous version; the request includes the render command recorded in the manifest (`renderCommand`), if there is one. The agent runs and adapts it: Motion Studio does not run the command itself, and every new format is still a recomposition.

Current limits: regenerating only the new formats is therefore driven by the agent, not an automatic render of the manifest command; signed desktop builds depend on the maintainers' certificates (see Release). On Ubuntu 24.04 and later the AppImage may fail to start because the system restricts unprivileged user namespaces (AppArmor, `kernel.apparmor_restrict_unprivileged_userns`), which Chromium's sandbox needs: you need an AppArmor profile for the app (or, at your own risk, disable that restriction); avoid `--no-sandbox`, which removes the window's isolation.

## Security
- **Agent sandbox** (macOS; Linux with `bubblewrap` and `socat`): every agent job runs isolated. It can only write in the project folder and cannot read sensitive folders (`~/.ssh`, cloud credentials, keychains, the Motion Studio configuration). The network depends on the job: creatives and the console use only package registries, CDNs and the domains you add in **Settings → Network**; brand analysis has no network in the sandbox: it reads pages with `WebFetch` and downloads logos and fonts only with Motion Studio's `download_file` tool, which blocks private or local addresses (checked on the resolved IP, at every redirect); asset description has no network. The sandbox does not fall back to unrestricted execution: if it cannot start, commands do not run, and the agent cannot ask to run a command outside it.
- **Files that configure Motion Studio and the agent**: in every job, with or without the sandbox, the agent cannot modify the project's `.git/`, `.claude/`, `.studio/`, `CLAUDE.md`, `CLAUDE.local.md` and `.mcp.json`; Motion Studio runs git without the project's hooks.
- **Linked codebases**: readable, never writable (interpreters included, thanks to the sandbox); Motion Studio still reports it if a git codebase changes during a turn.
- **Approvals**: anything outside the perimeter (e.g. installing a program, writing outside the project) appears as a request on the job's page and at the top right: *Allow once*, *Always for this project* (revocable in the project's settings) or *Deny*. "Always for this project" is offered only for a short list of safe commands (`ls`, `mkdir`, `ffprobe`, image optimizers), for folders outside sensitive locations and the workspace, for web domains and for paid providers; other commands are approved one at a time. Rules live in `<project>/.studio/permissions.json`, protected from the agent. With no answer within 10 minutes the request is denied.
- **API keys**: in the system keychain (or in the `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` environment variables); the agent never sees them: the key variables are removed from the agent's environment (and its MCP server's) and the MCP tools ask Motion Studio to call the providers.
- **Costs**: image and voice generations ask for confirmation before each call (can be turned off in Settings with **Ask before using paid providers**).
- **Interface access code**: Motion Studio's APIs answer only to the interface opened from the terminal link (the code is in `ui-token` in the configuration folder). It is a defense against stray local requests, for example web pages open in the browser or programs that do not know the code; it is not a barrier against a process of the same user that can read the configuration folder.
- **Without the sandbox** (Windows, Linux without bubblewrap, or isolation turned off): Motion Studio uses the restricted command list of the previous phase and reports it in the Doctor and in Settings. Without the sandbox the allowed commands (node, python, npm/npx, pip, ffmpeg) can read and write anywhere and contact Motion Studio itself: use the sandbox. In particular, an interpreter started by the agent could modify `.studio/permissions.json`: Motion Studio accepts only rules in the formats that "Always for this project" can produce (safe commands, folders outside sensitive locations and the workspace, web domains, provider confirmations), so the agent could grant itself those permissions or skip a provider's cost confirmation, but not go beyond those limits.
- **Unverified outputs:** without ffmpeg/ffprobe installed, Motion Studio cannot really check resolution and duration, and shows the outputs as "unverified".

## Providers
| Tool | Provider | Key |
|---|---|---|
| Images | OpenAI gpt-image-2 | `OPENAI_API_KEY` |
| Voice-over | OpenAI TTS, ElevenLabs | `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` |
| Stock photos and videos | Pexels, Unsplash | `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` |
| Fonts | Google Fonts | none |

Stock assets keep the attribution required by Pexels and Unsplash (`attribution` field in `assets/assets.json`). Details in [docs/providers.md](docs/providers.md).

## Brand, assets and linked codebases
- **Brand**: palette, fonts, logos, tone, dos and don'ts, photographic style; each entry shows where it comes from (manual, website, image). The prose guidelines are in `brand/guidelines.md`.
- **Brand analysis**: add one or more websites (and reference images with "Use for brand analysis") and press **Analyze brand**. The agent visits the sites, downloads useful assets into `assets/` and proposes changes: you apply them entry by entry, and manually entered entries are never removed. The agent works on copies: the brand kit, guidelines, sources and asset and reference metadata cannot be modified by the editing tools and, if the agent changes them anyway, Motion Studio reverts the change and reports it.
- **Assets and references**: upload files by dragging them, filter by type and origin, add descriptions and tags (also with **Describe with the agent**).
- **Linked codebases** (project or single-creative Settings): folders on your computer that the agent can read; editing tools are blocked on every turn and, if a folder is a git repository and shows changes after a turn, the conversation reports it. You cannot link the project or workspace folder, a folder that contains them, or a folder inside them.

With the sandbox on, interpreters cannot write into linked codebases. Without the sandbox, the rules block only the agent's editing tools: interpreters (for example node or python) could still write into the folder. Motion Studio detects and reports changes only in folders that are git repositories; for the others, changes would not be detected. Prefer linking git repositories with their changes already committed.

General advice: analyze only websites you trust.

## Current agent limits
- **Project console:** with the sandbox on, commands run isolated; outside the sandbox the agent can modify the project's files, but requests that need an approval appear in the interface (see Security).
- **Image, voice and stock providers:** they are described in [docs/providers.md](docs/providers.md) but have not been verified live with real keys (tests use simulated responses).

## Development
```bash
pnpm install
pnpm dev                  # core (tsx watch, port 4317) + web (Vite, port 5173 with /api proxy); the core prints the link with the access code
pnpm test                 # all tests (they use a fake `claude`, no quota used)
npx vitest run packages/core/test/server.test.ts   # a single file (from the repository root)
pnpm typecheck
pnpm check:i18n           # flags Italian text left in the code outside the language catalogs
pnpm build                # web + npm package bundle (apps/cli/dist)
pnpm motion-studio        # build + start the local package

pnpm --filter motion-studio-desktop dev        # Electron app in development (first: `pnpm --filter @motion-studio/web build && pnpm --filter motion-studio-desktop build`)
pnpm --filter motion-studio-desktop smoke      # trial start of the app with a temporary configuration
pnpm --filter motion-studio-desktop dist:dir   # unpackaged app in apps/desktop/release (only this computer's architecture)
pnpm --filter motion-studio-desktop dist:mac   # local installer (dist:win, dist:linux; no argument: the current platform)
```

Useful variables:
- `MOTION_STUDIO_CONFIG_DIR` — where to store the app configuration (workspace path).
- `MOTION_STUDIO_CLAUDE_COMMAND` — the agent command as a JSON array, e.g. `["node","/path/fake-claude.mjs"]`.

To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Release
For maintainers. Align the version in `apps/desktop/package.json` and `apps/cli/package.json`, then create and push the matching `vX.Y.Z` tag: every job of the `.github/workflows/release.yml` workflow stops immediately if the tag does not match both versions. The workflow builds the desktop app on macOS (`arm64` and `x64`), Windows and Linux and creates a **draft** GitHub release with the installers (to be published by hand); in parallel, if `NPM_TOKEN` is present, it publishes `@motion-studio/cli` to npm (a failure in a desktop build does not block it). CI (`ci.yml`) runs the type check, the i18n check and the tests on every push to `main` and on pull requests.

Repository secrets used by the workflow (all optional: without them the build is unsigned or npm is skipped):
- macOS (signing and notarization): `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without `MAC_CERT_P12_BASE64` signing is off; notarization runs only if the certificate (`MAC_CERT_P12_BASE64`) and all three `APPLE_*` secrets are present, otherwise it is explicitly off.
- Windows: `WIN_CERT_PFX_BASE64`, `WIN_CERT_PASSWORD`.
- npm: `NPM_TOKEN`.
- `GITHUB_TOKEN` is provided by GitHub Actions.

## License
MIT
