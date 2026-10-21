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
- `auto`: the provider the agent asked for, else the first one with a key;
- a provider whose key is known to lack the capability (a key check or a real call said `missing`) is unavailable: under `auto` with no provider asked the next configured one is used; when none is left, or the provider was named (by the agent or the brief), the tool is refused with the missing permission before any confirmation. `unverified` and `error` stay usable.

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
- A voice names its provider: OpenAI's voices are a fixed list (`alloy`, `ash`, … `marin`, `cedar`), any other id is an ElevenLabs one. If the provider is not given and a voice is, the voice's provider is used (an ElevenLabs id from `list_voices` never goes to OpenAI). If neither is given, it uses the provider of the brand kit voice (`sound.voice`) when its key is present, else OpenAI when the key is present, otherwise ElevenLabs. If no voice is given, the brand kit voice is used when it belongs to the chosen provider.
- A voice of the other provider (the brief or the agent named the provider) is dropped before the confirmation, and the result says so in `note`; the brand voice of that provider, or its default voice, is used instead. ElevenLabs' default voice (a free read of the account's list) is resolved before the confirmation, so a key that cannot list voices is refused without an approval card. Generate refuses a voice of the other provider when the request is sent, and the dialog clears the voice when the provider changes (unless it is the brand voice of the new provider).
- Formats `mp3` (default) and `wav`; files in `assets/audio/`, with the attribution "AI-generated voice (<Provider>)" (in the language set in Settings).

## Sound effects, music and voices: ElevenLabs (`sound_effect`, `music`, `list_voices`)
- Key: `ELEVENLABS_API_KEY`, sent in the `xi-api-key` header. API shapes checked against the public ElevenLabs documentation on 2026-10-13 (not tried live).
- `sound_effect`: `POST /v1/sound-generation?output_format=mp3_44100_128`, body `{ text, duration_seconds?, prompt_influence?, loop?, model_id: "eleven_text_to_sound_v2" }`. Parameters: `prompt` (up to 1000 characters), `durationSec` (0.5 to 30; left out, the service infers it), `loop`, `promptInfluence` (0 to 1), `name`.
- `music`: `POST /v1/music?output_format=mp3_44100_128`, body `{ prompt, music_length_ms, force_instrumental?, model_id: "music_v1" }`. Parameters: `prompt` (up to 1000 characters), `durationSec` (10 to 300; the API itself allows 3 to 600 s), `instrumental`, `name`.
- `list_voices`: `GET /v2/voices?page_size=&search=` (free, no confirmation): `id`, `name`, `labels`, `previewUrl`; up to 100 voices per call. Previews are fetched by the core only from `*.elevenlabs.io` or from exactly `storage.googleapis.com/eleven-public-prod/…` (the bucket of ElevenLabs' documented example; not verified live), checked at every redirect hop.
- Both generators are paid and ask for confirmation (rules `provider:sfx-elevenlabs`, `provider:music-elevenlabs`; the request shows provider, duration and prompt). Files (mp3, 50 MB maximum) go in `assets/audio/`, registered with the prompt as description, `provider`, `model`, the probed `durationSec`, `loop` and the attribution "AI-generated (ElevenLabs)".
- A 401 or 403 from these calls that reads as a missing permission is recorded in the in-memory key-check cache (`providers/key-check.ts`, never persisted) as `missing` for that capability, with the permission name `sound_generation`, `music_generation` or `voices_read`; a success records it as `ok` (see [Key checks](#key-checks)).

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

## Video transcription: Whisper, OpenAI and ElevenLabs (video analysis)
The video analysis (spec `docs/superpowers/specs/2026-10-21-video-analysis-design.md` §6–§7) transcribes the speech of a video with the method of **Settings → Video transcription** (app-wide, in `config.json`): *Ask every time* (default), *Whisper on the Mac*, *OpenAI*, *ElevenLabs*, *Never*. A video whose audio is at least 95 % silence is never transcribed and never asks. With *Ask every time*, or a saved method that no longer works (Whisper removed, key deleted), the analysis waits (`transcription-choice`) for the user's answer; it never holds a creative's turn. Before that, the audio is checked for speech in the background (`transcription-check`, at most 60 s plus 0.2 s per second of video); a creative's first turn waits for it with the usual line and *Salta*.
- **Whisper on the Mac** (free, the audio never leaves the machine). Lookup order: the program set in Settings → the bundled `whisper-cli` (desktop app) with a model in `<appData>/whisper/` → one detected on the login-shell PATH or in `/opt/homebrew/bin`, `/usr/local/bin` (`whisper-cli`, `whisper-cpp`, `main` for whisper.cpp; `whisper` for openai-whisper; `whisper-ctranslate2`, `faster-whisper` for faster-whisper). Detection runs in the background at server start and on *Search again* (`POST /api/transcription/detect`) and on *Check again* in the transcription dialog (`POST /api/projects/:slug/video-analyses/transcription-recheck`, which also asks the held question anew with the new offer); reading the settings runs no program. A whisper.cpp (found or set in Settings) is test-run once per binary on one second of generated silence, with the flags its `--help` lists (`-np`, `-sns`); one that fails is listed with its problem and never used. VAD (Silero) only with the bundled binary. The Python engines are only asked `--help` (a test-run could download a model); they take the model by name (`small`, `large-v3-turbo`) and download it into their own cache on first use, which the dialog and Settings say; a detected one whose model is not in its cache runs only after the user picks it. A Whisper never inherits the provider keys or the bridge token from the core's environment.
- **The bundled `whisper-cli`** (macOS app only): whisper.cpp v1.9.5 built by `scripts/build-whisper.sh` (Metal embedded, static, system libraries only) with the Silero VAD model, in the release workflow's macOS leg for arm64 and x64, shipped as `Contents/Resources/whisper/` and passed to the core as `whisperDir`. The development app uses `apps/desktop/vendor/whisper/<arch>` when the script was run there, else an installed Whisper (`brew install whisper-cpp`). Licences in `apps/desktop/THIRD_PARTY_NOTICES.md`.
- **Models** (`ggml-small.bin` 487,601,967 B, `ggml-large-v3-turbo.bin` 1,624,555,275 B, VAD `ggml-silero-v6.2.0.bin` 885,098 B) come from Hugging Face, URLs pinned to a commit (`ggerganov/whisper.cpp@5359861c…`, `ggml-org/whisper-vad@9ffd54a1…`), only after a click that showed the size: exact `Content-Length`, streaming sha256 checked before the file is renamed into place, redirects only to Hugging Face hosts (`huggingface.co`, `cdn-lfs*.hf.co`, `cas-bridge.xethub.hf.co`, `us|eu.aws.cdn.hf.co`), at most 3, https only.
- **OpenAI**: `POST https://api.openai.com/v1/audio/transcriptions`, multipart `model=whisper-1`, `response_format=verbose_json`, `timestamp_granularities[]=segment` (whisper-1 is the model with segment timestamps). Audio over 600 s goes in 600 s pieces of 16 kHz mono WAV (≈ 19.2 MB, under the 25 MB upload limit; a last piece under 1 s joins the previous one), segment times offset by each piece's start; each piece is billed in `usage.jsonl` as soon as it is answered. List price $0.006 per minute.
- **ElevenLabs**: `POST https://api.elevenlabs.io/v1/speech-to-text`, header `xi-api-key`, multipart `model_id=scribe_v2`, `file`, `timestamps_granularity=word`, `tag_audio_events=false`; words are grouped into segments at a sentence end or a pause of 0.8 s or more. List price $0.22 per hour. API shape checked against the public documentation on 2026-10-21 (not tried live).
- **What leaves the Mac**: with a provider, the 16 kHz mono WAV of the video's audio (nothing else: frames go only to Claude Code). Only the providers with a saved key are offered; the dialog shows the cost estimated at list price on whole minutes, in USD. A paid transcription runs only after that click or a method saved in Settings (no approval card), and writes one `usage.jsonl` line of kind `transcription` with the estimated cost.
- **Language**: auto-detected; the app language when the engine reports none.
- Tests never run a real Whisper, download a model or call a provider: fake engine scripts with recorded output (`packages/core/test/fixtures/whisper/`), a loopback server and a fake `fetch`.

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
- `unverified`: no free request can tell. The first real use updates it: a refusal that reads as a missing permission (the same classification as the check: the permission words, or a 403 without quota, payment or account words) marks it `missing`, a success `ok`; a quota, account, rate-limit or unrecognised refusal records nothing (`generate_image`, `tts`, `sound_effect`, `music`, `list_voices`, stock search and download, the Assets Generate jobs and the voice picker all report into the same cache). A Test (Settings, or the check after saving a key) replaces everything real use learned with its fresh result, so a learned `missing` never outlives it, also for a key from the environment.
- `error`: network failure, deadline, 5xx or rate limit (429, or Unsplash's 403 "Rate Limit Exceeded"). Never `missing`.
- With no voice given, ElevenLabs voice-over first reads the account's voice list: that read is recorded under the voice list (`voices_read`), not under voice-over.
- What a real call learns is recorded only while the key it used is still the saved one (compared by a salted fingerprint, never the key): a call that waited for its confirmation, or a queued Generate job, says nothing about a key saved meanwhile.
- A capability known as `missing` makes its provider unavailable: the Services selector disables it with the reason (the permission to enable, or "does not accept the saved key"), and the agent's tool list says `(missing permission: …)`. `unverified` and `error` stay available.

Tests never reach these hosts: `test-support/block-provider-network.ts` refuses real requests to the provider hosts and to every Google Fonts host the product contacts (`fonts.google.com`, `fonts.googleapis.com`, `fonts.gstatic.com`) under vitest (a test that really means it calls `allowProviderNetwork()`, undone after every test; an inherited `MS_ALLOW_PROVIDER_NETWORK` is deleted and ignored).

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
