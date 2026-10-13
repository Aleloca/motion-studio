# Providers

Providers are external services the agent uses through MCP tools of the `studio` server. The agent never sees the keys: it asks Motion Studio (the core) to call the provider; the core reads the key, makes the call and saves the result in `assets/`, recording it in `assets/assets.json`.

> Verification status: providers are covered by tests with a simulated `fetch`. Images, voice, sound effects, music and stock have not been tried live with real keys: the details below describe the code, not a guarantee about the services' behavior (models, prices and APIs change). The key checks were tried live only against a simulated endpoint (the core's `keyCheckHttp` hook). Google Fonts (picker, previews, add, `fonts_fetch`) and `inspect_site_fonts` were tried live on 2026-10-13 (`docs/superpowers/notes/2026-10-13-phase11-live-checks.md`).

## Where the keys live
- In the system keychain (`@napi-rs/keyring`, service "Motion Studio", one entry per provider; Secret Service on Linux), set from **Settings**.
- Or in environment variables, which take precedence: `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`.
- Keys do not end up in project files. The variables are removed from the environment of the agent and its MCP server; provider error messages are scrubbed of keys (`redact`).
- A missing key produces the error "Set the <Provider> key in the Motion Studio settings" (shown in the language chosen in Settings → Language); in the request to the agent, unconfigured tools appear as "not configured".

## Services per creative (`brief.services`)
A creative's brief can choose, per kind, which service the agent may use: `images` (`auto`, `openai`, `stock`, `none`), `voice` (`auto`, `openai`, `elevenlabs`, `none`), `music` and `sfx` (`auto`, `elevenlabs`, `none`). Absent kinds are `auto`, the behavior from before (old briefs load unchanged). The core decides in `services/service-policy.ts` (`resolveService`), never the agent, before any confirmation or request:
- `none`: the tool is refused with a message that tells the agent to point the user at the **Services** button;
- a named provider wins over the one the agent asked for, and without its key the tool is refused (never a silent switch to another provider);
- `stock` (images only): `generate_image` is refused, the free stock tools stay allowed (they are allowed under every images choice but `none`);
- `auto`: the provider the agent asked for, else the first one with a key.

The choice is read when the turn starts and written into the prompt ("Services for this creative: …", and "off for this creative" next to the tools that are off). The chat's **Services** chip saves the brief with the new `services`; the change applies from the next message, and the chip is disabled while a turn runs. The project console has no brief and runs with every kind `auto`. **Generate** in Assets is a direct user action and ignores `brief.services`.

## Costs and confirmations
`generate_image`, `tts`, `sound_effect` and `music` are paid: if the option **Ask before using paid providers** is on in Settings (default), every call appears as a request on the job's page (*Allow once*, *Always for this project*, *Deny*; with no answer in 10 minutes it is denied). "Always" saves the rule `provider:openai-images`, `provider:tts-openai`, `provider:tts-elevenlabs`, `provider:sfx-elevenlabs` or `provider:music-elevenlabs` in `<project>/.studio/permissions.json`. `list_voices`, stock search and download and fonts do not ask for confirmation (they are not paid).

## Images: OpenAI gpt-image-2 (`generate_image`)
- Key: `OPENAI_API_KEY`. Model `gpt-image-2`, PNG output.
- Parameters: `prompt`, `width`, `height`, `quality` (`low|medium|high|auto`), `background` (`transparent|opaque|auto`), `references` (up to 16 project images, png/jpg/webp, for editing), `name`.
- Sizes are brought to the nearest supported format (multiples of 16, aspect ratio between 1:3 and 3:1, between about 0.65 and 8.3 megapixels, longest side 3840); if they change, the response says so.
- The file goes in `assets/generated/`, with origin "generated" and tag `gpt-image-2`.

## Voice-over: OpenAI TTS and ElevenLabs (`tts`)
- Keys: `OPENAI_API_KEY` (model `gpt-4o-mini-tts`, default voice `marin`, text up to 4096 characters, optional tone instructions) or `ELEVENLABS_API_KEY` (model `eleven_multilingual_v2`, text up to 5000 characters; with no voice given it uses the first in the account's list).
- If the provider is not given, it uses the provider of the brand kit voice (`sound.voice`) when its key is present, else OpenAI when the key is present, otherwise ElevenLabs. If no voice is given, the brand kit voice is used when it belongs to the chosen provider.
- Formats `mp3` (default) and `wav`; files in `assets/audio/`, with the attribution "AI-generated voice (<Provider>)" (in the language set in Settings).

## Sound effects, music and voices: ElevenLabs (`sound_effect`, `music`, `list_voices`)
- Key: `ELEVENLABS_API_KEY`, sent in the `xi-api-key` header. API shapes checked against the public ElevenLabs documentation on 2026-10-13 (not tried live).
- `sound_effect`: `POST /v1/sound-generation?output_format=mp3_44100_128`, body `{ text, duration_seconds?, prompt_influence?, loop?, model_id: "eleven_text_to_sound_v2" }`. Parameters: `prompt` (up to 1000 characters), `durationSec` (0.5 to 30; left out, the service infers it), `loop`, `promptInfluence` (0 to 1), `name`.
- `music`: `POST /v1/music?output_format=mp3_44100_128`, body `{ prompt, music_length_ms, force_instrumental?, model_id: "music_v1" }`. Parameters: `prompt` (up to 1000 characters), `durationSec` (10 to 300; the API itself allows 3 to 600 s), `instrumental`, `name`.
- `list_voices`: `GET /v2/voices?page_size=&search=` (free, no confirmation): `id`, `name`, `labels`, `previewUrl`; up to 100 voices per call.
- Both generators are paid and ask for confirmation (rules `provider:sfx-elevenlabs`, `provider:music-elevenlabs`; the request shows provider, duration and prompt). Files (mp3, 50 MB maximum) go in `assets/audio/`, registered with the prompt as description, `provider`, `model`, the probed `durationSec`, `loop` and the attribution "AI-generated (ElevenLabs)".
- A 401 or 403 from these calls is recorded in the in-memory key-check cache (`providers/key-check.ts`, never persisted) as `missing` for that capability, with the permission name `sound_generation`, `music_generation` or `voices_read`; a success records it as `ok` (see [Key checks](#key-checks)).

## Stock photos and videos: Pexels and Unsplash (`stock_search`, `stock_download`)
- Keys: `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY`. Unsplash offers only photos; search videos on Pexels.
- Search: `query`, `kind` (`photo|video`), `orientation`, `limit` (1–20). Download by `id`: file in `assets/stock/`.
- Attribution: every download records the text the service requires (e.g. "Photo by <author> on Pexels") in the `attribution` field of `assets/assets.json`; for Unsplash the download also notifies the download event and the source link carries the `utm` parameters. Keep the attribution wherever the license requires it.
- 200 MB limit per file. For videos Pexels picks the largest mp4 up to 1920 px wide.

## Fonts: Google Fonts (`fonts_fetch` and the brand's picker)
- No key. Parameters: `family`, `weights` (multiples of 100, default 400 and 700), `italic`. Files in `assets/fonts/`, registered with origin `google-fonts`, the specimen link as source and the attribution "Google Fonts · OFL / Apache 2.0".
- Accepts only files served from `fonts.gstatic.com`; `css2` and the files are read through `safe-fetch.ts` with the caller's abort signal. OFL or Apache 2.0 license (the response reminds you).
- **Picker** (Brand → Typography → Add from Google Fonts): the core reads the catalog from `https://fonts.google.com/metadata/fonts` (8 MB cap, cached for 7 days in the config folder's `cache/`, the stale copy used when a refresh fails) and shows up to 24 families per search. Each family's preview (a `css2` subset with only the sample's characters, 200 KB cap, cached by the core) is fetched by the core and served to the page through a short-lived signed URL, so the interface never loads Google. **Add** uses the same download path as `fonts_fetch` and links the brand font to its file under the brand kit's lock; adding a family already in the kit merges the weights.
- **Site fonts** (`inspect_site_fonts`, brand analysis only): reads the site's page and stylesheets through `safe-fetch.ts` (same-site sheets and known font CDNs only, checked at every redirect; 2 MB per file, up to 20 sheets, 30 s in all, at most 5 calls per job) and returns each family with roles, weights, italic and source: `google` (read from the link's URL, nothing downloaded), `self-hosted` (with its file URLs, for `download_file`), `adobe` or `system` (name only). Adobe's page-view beacon `p.typekit.net` is never requested. Warnings go into the proposal.

## Generate in Assets
**Generate** in the asset library makes an image (OpenAI), a voice-over (OpenAI or ElevenLabs), a sound effect or a music track (ElevenLabs) as a background job (`POST /api/projects/:slug/generate`). It calls the same provider functions as the agent tools, asks the same paid confirmation (`approvals/confirm-paid.ts`, same `provider:*` rules), and records 401/403 and successes in the key-check cache. The result is registered with origin `generated`, `provider` and `model`. A tab is enabled only when its provider's key is set; without any key the dialog says so and links to Settings. `brief.services` does not apply.

## Downloads from outside: `download_file` (brand analysis)
Only for brand analysis, whose sandbox has no network: downloads a logo, image or font from a website into `assets/brand/` or `assets/fonts/` (image and font extensions, 50 MB maximum). All downloads of externally supplied URLs (provider ones too) go through `safe-fetch.ts`: private, local or reserved addresses are refused by checking the resolved IPs at every redirect, and the connection goes to the very address that was checked. Providers accept only https.

## Key checks
When a key is saved in **Settings → Paid services**, and with the **Test** button of each row (keys from environment variables too), the core tries the key with read-only, free requests and reports what it can do, per capability. The requests run in parallel, each with a 15 s deadline, over `requestProbe` (`http.ts`: `redirect: 'error'`, bounded and redacted bodies). Results live in the core's memory only (`KeyCheckCache`): they are never written to disk, never hold the key, and are forgotten when the key is replaced or removed.

| Provider | Request | Capabilities reported |
|---|---|---|
| OpenAI | `GET /v1/models`, `GET /v1/models/gpt-image-2`, `GET /v1/models/gpt-4o-mini-tts` | key, images, voice-over |
| ElevenLabs | `GET /v1/user` | key, account |
| ElevenLabs | `GET /v2/voices?page_size=1` | voice list |
| ElevenLabs | none | voice-over, sound effects, music: `unverified` (only a paid generation can tell) |
| Pexels | `GET /v1/search?query=test&per_page=1` | key, search |
| Unsplash | `GET /search/photos?query=test&per_page=1` | key, search |

Outcomes:
- `ok`: the request worked.
- `missing`: the key lacks the permission named in the result. With no permission name, on the key itself, the provider does not know the key; then every capability is `missing`. For ElevenLabs and OpenAI this needs the provider's own words for an unknown key (`invalid_api_key`, "Invalid API key", "Incorrect API key"): any other 401 is `error` ("the service refused the request"), so a restricted key is never shown as invalid.
- `unverified`: no free request can tell. The first real use updates it: a 401/403 marks it `missing`, a success `ok` (`generate_image`, `tts`, `sound_effect`, `music`, `list_voices`, stock search and download, the Assets Generate jobs and the voice picker all report into the same cache). A later Test keeps what real use learned for these capabilities.
- `error`: network failure, deadline, 5xx or rate limit (429, or Unsplash's 403 "Rate Limit Exceeded"). Never `missing`.
- With no voice given, ElevenLabs voice-over first reads the account's voice list: that read is recorded under the voice list (`voices_read`), not under voice-over.

Tests never reach these hosts: `test-support/block-provider-network.ts` refuses real requests to the provider and Google Fonts hosts under vitest (a test that really means it calls `allowProviderNetwork()`, undone after every test; an inherited `MS_ALLOW_PROVIDER_NETWORK` is deleted and ignored).

A restricted ElevenLabs key (for example one with only `text_to_speech`) answers `401` with `missing_permissions` to the read requests: the key is shown as working, the read permissions as missing and generation as unverified, never as an invalid key.

Permissions per Motion Studio feature (Settings shows the same table when something is missing):

| Provider | Feature | Permission |
|---|---|---|
| ElevenLabs | Voice-over (`tts`) | `text_to_speech` |
| ElevenLabs | Sound effects (`sound_effect`) | `sound_generation` |
| ElevenLabs | Music (`music`) | `music_generation` |
| ElevenLabs | Voice list and picker (`list_voices`) | `voices_read` |
| ElevenLabs | Account check (key test only) | `user_read` |
| OpenAI | Key test (restricted keys) | Models: Read (`api.model.read`) |
| OpenAI | Images, voice-over | Model capabilities: Write (`model.request`); `gpt-image-2` may need organization verification (a 404 on the model marks images `missing` with the model name) |
| Pexels, Unsplash | Search, download | no permissions: a refused key is invalid |

The OpenAI permission names and the ElevenLabs `missing_permissions` wording follow the providers' public documentation; they have not been tried live.

## Adding a provider
1. **Module** in `packages/core/src/providers/<name>.ts`: pure functions that take `HttpDeps & { apiKey }` (`fetch`, `transport`, `lookup`) and use `requestJson`/`requestBytes` from `http.ts` with `secrets: [apiKey]` (errors scrubbed of keys, size limits). To download URLs returned by the service use `safeDownload`.
2. **Key**: add the id to `PROVIDER_IDS` (`packages/shared`) and the variable to `PROVIDER_ENV` (`secrets/vault.ts`); the variables in `PROVIDER_ENV` are automatically removed from the agent's environment. Add the entry in the web app's Settings.
3. **Bridge tool** in `packages/core/src/bridge/provider-tools.ts`: a handler in `providerTools` (validates the arguments, `allowed(c, '<tool>')`, `keyOf`, `confirmPaid` if it costs, `withKeyCheck(provider, capability, …)` around the provider call, `saveGeneratedFile` and `register` to save and record the asset) and a line in `availableTools`.
   **Key check**: the capabilities and permissions in `KEY_CAPABILITIES`/`KEY_PERMISSIONS` (`packages/shared/src/services.ts`), a free read-only probe in `providers/key-check.ts` (or `unverified`), the permissions table above and the Settings catalog texts.
4. **Authorization per job type**: add the name to `MCP_TOOLS` (`agent/launcher.ts`) for the jobs that may use it.
5. **MCP schema** in `packages/mcp-studio/src/server.mjs` (`TOOLS` list, with an English description: it is agent-facing text).
6. **Tests** with an injected `fetch` (see `openai-images.test.ts`, `stock.test.ts`, `provider-tools.test.ts`): never real network calls or real keys.
7. **Texts**: any message shown to the user goes in the language catalogs (`packages/shared/src/i18n`), not in the code; `pnpm check:i18n` flags Italian text left behind.
