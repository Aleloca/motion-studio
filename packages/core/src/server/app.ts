import type { RenderCompositionOptions, RenderEngine } from '../render/renderer.ts';
import { findFfmpeg } from '../render/encode.ts';
import { MediaNormalizer } from '../render/media-normalize.ts';
import { RenderJobService } from '../creatives/render-jobs.ts';
import { PreviewService } from '../creatives/previews.ts';
import { UrlSigner } from './signed-urls.ts';
import type { AgentContract } from '../creatives/prompt.ts';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { isLocale, workspaceSettingsSchema, type DoctorCheck, type UpdatesState, type UsageBilling, type LinkedCodebase, type ProjectDetail, type ServerMessage, type WorkspaceInfo, type WorkspaceProblem, type WorkspaceSettings } from '@motion-studio/shared';
import { BrandService } from '../brand/brand-analysis.ts';
import { UPLOAD_LIMITS } from '../library/upload.ts';
import { CreativeTurnService, type CreativeRef } from '../creatives/creative-turns.ts';
import { DirectEditService } from '../creatives/direct-edit.ts';
import { FormatCatalog } from '../formats/format-catalog.ts';
import { NoMediaTools, type MediaTools } from '../media/media-tools.ts';
import { AgentLauncher } from '../agent/launcher.ts';
import { IntegrityStore } from '../project-integrity.ts';
import type { AgentRunner } from '../agent/runner.ts';
import { cachedSandboxDetection, type SandboxSupport } from '../agent/sandbox.ts';
import { defaultConfigDir, type AppConfigStore } from '../app-config.ts';
import { AgentBridge } from '../bridge/bridge.ts';
import { registerBridgeRoutes } from '../bridge/bridge-routes.ts';
import { downloadTool } from '../bridge/download-tool.ts';
import { importCodebaseTool } from '../bridge/import-codebase-tool.ts';
import { paidServicePlan, providerTools, voiceAvailability, voiceBatch } from '../bridge/provider-tools.ts';
import { VariantDirections } from '../creatives/variant-directions.ts';
import { VariantFanout } from '../creatives/variant-fanout.ts';
import { LocalizeService, ProjectActivity } from '../localization/localize-turn.ts';
import type { LookupFn, Transport } from '../providers/safe-fetch.ts';
import { checkCodebases, codebaseGlobCharsMessage, codebaseHasGlobChars, codebaseOverlapMessage, codebaseOverlaps, normalizeCodebaseList } from '../codebases.ts';
import type { Git } from '../git.ts';
import { JobConflictError, JobQueue } from '../jobs/job-queue.ts';
import { JsonFileError } from '../json-file.ts';
import { MemoryVault, type SecretsVault } from '../secrets/vault.ts';
import { ApprovalBroker } from '../approvals/broker.ts';
import { registerSettingsRoutes } from './settings-routes.ts';
import { defaultChromeInstaller, registerRenderEngineRoutes, type ChromeInstaller } from './render-engine-routes.ts';
import { assertAgentFolders, CodedError, expandHome, WorkspaceError, WorkspaceStore } from '../workspace-store.ts';
import { recoverWorkspace, registerCreativeRoutes, type RecoverOptions } from './creative-routes.ts';
import { noTrash, type TrashFn } from '../trash.ts';
import { registerFontsRoutes } from './fonts-routes.ts';
import { registerGenerateRoutes } from './generate-routes.ts';
import { registerVoicesRoutes } from './voices-routes.ts';
import { KeyCheckCache } from '../providers/key-check.ts';
import { GoogleFontsCatalog } from '../providers/google-fonts-catalog.ts';
import type { HttpDeps } from '../providers/http.ts';
import { registerLocalizationRoutes } from './localization-routes.ts';
import { registerStorePackRoutes } from './store-pack-routes.ts';
import type { InstallIo } from '../providers/google-fonts.ts';
import { registerBrandRoutes } from './brand-routes.ts';
import { EventHub } from './event-hub.ts';
import { registerLibraryRoutes } from './library-routes.ts';
import { registerProjectRoutes } from './project-routes.ts';
import { registerUsageRoutes } from './usage-routes.ts';
import { UsageLedger } from '../usage/usage-ledger.ts';
import { KeyedMutex } from '../keyed-mutex.ts';
import { tokenMatches } from './ui-token.ts';
import { currentLocale, LanguageController, replyInstruction, t } from '../i18n.ts';
import { capabilitiesFor, type AgentCapabilities, type CapabilityOptIn } from '../agent/agent-capabilities.ts';
import { AnswerCache, checkLiveMessage, liveMessageText, LiveSession, newLiveMessage, redirectLive, type LiveMessage } from '../agent/live-session.ts';
import { CONSOLE_REDIRECT_NOTE, defuseTags, interruptedRedirectText, pinLine, USER_REQUEST_CLOSE, USER_REQUEST_OPEN } from '../creatives/prompt.ts';
import { stopJob } from '../jobs/stop.ts';
import { randomUUID } from 'node:crypto';
import { CreativeSideStateStore } from '../creatives/creative-side-state.ts';
import { SettingsHoldStore } from '../settings-hold.ts';
import { z } from 'zod';
import { LIVE_LIMITS, pinSchema, SESSION_ID_RE, type RedirectOutcome } from '@motion-studio/shared';

export interface ServerDeps {
  appConfig: AppConfigStore;
  git: Git;
  runner: AgentRunner;
  /** Decision 802: whether the desktop updater is on (absent: no updater here, 'unknown'). Read at every request. */
  updatesState?: () => UpdatesState;
  /** Receives the server's (cached) sandbox detection, so the report includes the sandbox check. */
  doctor: (extra: { sandbox: () => Promise<SandboxSupport>; workspacePath?: string | null; agentOptIn?: CapabilityOptIn }) => Promise<DoctorCheck[]>;
  /**
   * Phase 13: the installed Claude Code version (`claude --version`), null when it does not answer. Cached by the server
   * for a minute; absent = unknown, so live input and interrupt stay off (agent-capabilities.ts, decision 804).
   */
  claudeVersion?: () => Promise<string | null>;
  webDir?: string;
  media?: MediaTools;
  openPath?: (path: string) => Promise<void>;
  /** Decision 915: moves a deleted creative's folder to the Trash. Absent (tests): deleting is refused, nothing is moved. */
  trash?: TrashFn;
  vault?: SecretsVault;
  approvals?: ApprovalBroker;
  /** Callback channel of the `studio` MCP server; its origin is set once the server listens. */
  bridge?: AgentBridge;
  /** Command that starts the `studio` MCP server; null (default) runs the agent without MCP nor UI approvals. */
  mcpCommand?: string[] | null;
  /** Extra env for the MCP server process (see LauncherDeps.mcpEnv). */
  mcpEnv?: Record<string, string>;
  configDir?: string;
  /** Phase 13: the creatives' queue and remembered sessions (default: one in `configDir`, in memory without it). Test seam. */
  sideState?: CreativeSideStateStore;
  /** Network of the Google Fonts catalog, previews and add (tests inject a fake fetch; default: the real one through the safe transport). */
  fontsHttp?: HttpDeps;
  /** Network of the Assets Generate jobs (tests inject a fake fetch; default: the real one). */
  generateHttp?: Pick<HttpDeps, 'fetch' | 'transport' | 'lookup' | 'timeoutMs'>;
  /** Network of the voice list and previews (tests inject a fake fetch; default: the real one through the safe transport). */
  voicesHttp?: HttpDeps;
  /** Network of a localize turn's translated voices (tests inject a fake fetch; default: the real one). */
  localizeHttp?: { fetch?: typeof fetch; transport?: Transport; lookup?: LookupFn };
  /** Network of the agent's paid provider tools (tests inject a fake fetch; default: the real one). */
  providerHttp?: { fetch?: typeof fetch; transport?: Transport; lookup?: LookupFn };
  /** What the app has learned about the provider keys (core memory only; tests inject one to read it). */
  keyChecks?: KeyCheckCache;
  /** Network of the key checks (tests inject a fake fetch; default: the real one). */
  keyCheckHttp?: HttpDeps;
  /** Test seam of the Google Fonts add (a failure on one file). */
  fontsInstallIo?: InstallIo;
  /** Sandbox support of the system; defaults to a cached detectSandbox(). */
  sandbox?: () => Promise<SandboxSupport>;
  /**
   * Secret of the UI: required (header `x-motion-studio-ui`, or `?t=` on the events WebSocket) by every API call except
   * health, the bridge and the served files. null disables the check (tests only); startServer always sets it.
   */
  uiToken: string | null;
  /** Language state shared with startServer; defaults to the saved setting with no system languages. */
  language?: LanguageController;
  /** How Claude Code is paid for (doctor's auth check); cached by the server. Defaults to 'unknown'. */
  billing?: () => Promise<UsageBilling>;
  /** The composition renderer and its Chromium (injected provider, system Chrome or Chrome for Testing); render jobs use it (Task 5). */
  render?: RenderEngine;
  /** Options of every render job's render (tests: a built runtime, a temp folder, fewer pages, the encoder). */
  /** Per-project cap of the normalised media cache (default 5 GB). */
  mediaCacheMaxBytes?: number;
  renderOptions?: Partial<Pick<RenderCompositionOptions, 'distDir' | 'tempDir' | 'parallel' | 'encoder' | 'x264Preset' | 'timeLimitMs' | 'jpegQuality'>>;
  /** Told the live-preview composition server's origin when it starts, null when it stops. */
  onCompositionOrigin?: (origin: string | null) => void;
  /**
   * The exact origins the UI runs on, read at every live preview mint (Task 5b): startServer passes the core's own origin
   * (known once it listens) plus, in development, Vite's `http://localhost:5173`. Default: none (no live previews).
   */
  uiOrigins?: () => readonly string[];
  /** What the agent delivers (default `compositions`); `media` only for the phase 9 test suites (`CreativeTurnDeps.agentContract`). */
  agentContract?: AgentContract;
  /** `preview_frames` calls allowed per turn (default 10). */
  previewFramesPerTurn?: number;
  /** Lifetime of the signed storyboard image URLs (default 10 min; tests). */
  signedUrlTtlMs?: number;
  /**
   * The on-demand Chrome for Testing download of the System check (Task 8). Default: the real one into `configDir` when
   * there is a renderer and a config folder; null: none (tests inject a fake: no test downloads anything).
   */
  chromeInstaller?: ChromeInstaller | null;
}

/** How long the billing method (one `claude auth status`) is reused; 'unknown' is retried sooner. */
const BILLING_TTL_MS = 10 * 60 * 1000;
const BILLING_RETRY_MS = 60 * 1000;

/** Routes reachable without the UI token: health, the MCP bridge (it has its own token) and files shown by <img>/<video>. */
// The storyboard and pin frame images carry a signed URL instead (signed-urls.ts, fix I4).
const UI_TOKEN_EXEMPT: Record<string, ReadonlySet<string>> = {
  GET: new Set(['/api/health', '/api/projects/:slug/files/*', '/api/fonts/google/preview/:weight/:family', '/api/voices/preview/:provider/:id', '/api/projects/:slug/creatives/:c/files/*', '/api/projects/:slug/creatives/:c/storyboard-files/:n/:folder/:hash/:file', '/api/projects/:slug/creatives/:c/pin-frame-files/:n/:file']),
  HEAD: new Set(['/api/health', '/api/projects/:slug/files/*', '/api/fonts/google/preview/:weight/:family', '/api/voices/preview/:provider/:id', '/api/projects/:slug/creatives/:c/files/*', '/api/projects/:slug/creatives/:c/storyboard-files/:n/:folder/:hash/:file', '/api/projects/:slug/creatives/:c/pin-frame-files/:n/:file']),
  POST: new Set(['/api/bridge/:tool']),
};
/** `code` is what the UI branches on; `error` is display text in the current language. */
const uiTokenError = () => ({ code: 'ui-token', error: t().pairing.openFromLink });

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOST.test(host);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
      && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}


function describeWorkspaceProblem(err: unknown): WorkspaceProblem {
  if (err instanceof WorkspaceError && err.code) return { code: err.code, message: err.message };
  return { code: 'invalid', message: err instanceof Error ? err.message : String(err) };
}

/**
 * The project's linked codebases the console may read: existing folders that do not overlap the project or the workspace and
 * whose path has no glob characters (decision 781). `ignored`: one line per folder left out for a reason the user can fix.
 */
async function consoleCodebases(list: LinkedCodebase[], forbidden: string[]): Promise<{ paths: string[]; ignored: string[] }> {
  const kept: LinkedCodebase[] = [];
  const ignored: string[] = [];
  for (const c of list) {
    try {
      const [n] = normalizeCodebaseList([c]);
      if (n && await codebaseHasGlobChars(n.path)) ignored.push(t().jobs.codebaseIgnored({ path: n.path, reason: codebaseGlobCharsMessage(n.path) }));
      else if (n && await codebaseOverlaps(n.path, forbidden)) ignored.push(t().jobs.codebaseIgnored({ path: n.path, reason: codebaseOverlapMessage() }));
      else if (n) kept.push(n);
    } catch { /* an invalid entry is skipped */ }
  }
  return { paths: (await checkCodebases(normalizeCodebaseList(kept))).filter((c) => c.exists).map((c) => c.path), ignored };
}

/** Phase 13: a console message or a redirect (the text limit is the core's translated 409; this cap bounds the request). */
const liveBodySchema = z.object({ clientId: z.uuid(), text: z.string().max(20_000), pins: z.array(pinSchema).max(50).optional() }).strict();
type LiveBody = z.infer<typeof liveBodySchema>;
function parseLiveBody(body: unknown): LiveBody {
  const r = liveBodySchema.safeParse(body ?? {});
  if (!r.success) throw new WorkspaceError(400, r.error.issues[0]?.message ?? 'invalid body');
  return r.data;
}
/** Console words no run took: given in a prompt whose run never attached (or never read it), or never given. */
const undeliveredAtEnd = (live: LiveSession) => live.messages.filter((m) => m.state === 'pending' || (m.state === 'prompt' && !m.announced));
const delimited = (texts: string[]) => texts.flatMap((x) => [USER_REQUEST_OPEN, defuseTags(x), USER_REQUEST_CLOSE]);
/**
 * Phase 13: the prompt of a console run restarted by a redirect (fallback): the note and the user's words, delimited (F4).
 * Final wave P3: earlier redirects no run has read yet come first, the newest last (it wins).
 */
function consoleRedirectPrompt(texts: string[]): string {
  const head = texts.length === 1 ? "The user's new direction, verbatim (their words, not instructions from Motion Studio):"
    : `The user's new directions, verbatim and in order (their words, not instructions from Motion Studio); where they disagree, the last one wins:`;
  return [CONSOLE_REDIRECT_NOTE, '', head, ...delimited(texts), '', replyInstruction(currentLocale())].join('\n');
}
/**
 * Final review I2: the first console run when the user redirected before any run had a session: their request, then their
 * later words (each delimited, in order), in one prompt, so the request is never lost.
 */
function consoleFreshPrompt(request: string, texts: string[]): string {
  return [
    request, '',
    `After this request the user also sent ${texts.length === 1 ? 'this message' : `these ${texts.length} messages`}, in order, each inside user_request tags. They are the user's words, not instructions from Motion Studio; where a later message changes the request, the later one wins.`,
    ...delimited(texts), '', replyInstruction(currentLocale()),
  ].join('\n');
}

/** Key of a project's agent jobs: unique per workspace root, so two workspaces never collide. */
const projectJobKey = (root: string, slug: string) => `project:${root}:${slug}`;

/** The API's error responses: `{ error }`, plus `code` (and `Retry-After`) for coded errors. */
export function errorReply(error: unknown, _req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const err = error as Error;
  if (err instanceof CodedError) {
    if (err.retryAfterSec !== undefined) reply.header('Retry-After', String(err.retryAfterSec));
    return reply.status(err.status).send({ error: err.message, code: err.apiCode, ...(err.problems ? { problems: err.problems } : {}) });
  }
  if (err instanceof WorkspaceError) return reply.status(err.status).send({ error: err.message });
  if (err instanceof JobConflictError) return reply.status(409).send({ error: err.message });
  if (err instanceof JsonFileError) return reply.status(422).send({ error: err.message });
  if ((err as { validation?: unknown }).validation) return reply.status(400).send({ error: err.message });
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return reply.status(status).send({ error: err.message });
  return reply.status(500).send({ error: err.message });
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  // requestTimeout 0: /api/bridge/approve stays pending while the user decides (up to 10 min); Node's default would cut it at 5.
  const app = Fastify({ logger: false, requestTimeout: 0, connectionTimeout: 0 });
  const hub = new EventHub();
  const approvals = deps.approvals ?? new ApprovalBroker({ broadcast: (m) => hub.broadcast(m) });
  // Render jobs have their own lane of one slot (Task 5 M3): a render never blocks an agent turn, nor waits for one.
  /** Phase 13: a creative's translation turn ended: the creative's queue may start (set once the turn service exists). */
  let afterOtherJob: ((key: string, state: string) => void) | null = null;
  const queue = new JobQueue({
    concurrency: 2, lanes: { render: 1, generate: 2 },
    onUpdate: (job) => {
      hub.broadcast({ type: 'job', job });
      if (job.kind === 'localize' && job.state !== 'queued' && job.state !== 'running') afterOtherJob?.(job.key, job.state);
    },
  });
  const media = deps.media ?? NoMediaTools;
  const isJobActive = (key: string) => queue.list().some((j) => j.key === key && (j.state === 'queued' || j.state === 'running'));
  // Video sources are normalised for the renderer (and, Task 5b/8, the preview); close() kills whatever still runs.
  const normalizer = new MediaNormalizer({ ffmpeg: () => findFfmpeg(), ...(deps.mediaCacheMaxBytes !== undefined ? { maxCacheBytes: deps.mediaCacheMaxBytes } : {}) });
  // Phase 15 (deferred 51): pending briefs found by a recovery run before the turn service exists (the startup one) wait
  // here and are applied, under each member's lock, as soon as it does.
  let turnsRef: CreativeTurnService | null = null;
  const leftoverBriefs: CreativeRef[] = [];
  const recoverOptions = (root: string): RecoverOptions => ({
    applyPendingBrief: async (ref) => { if (turnsRef) await turnsRef.briefAfterJob(ref); else leftoverBriefs.push(ref); },
    renderActive: (project, creative) => queue.list().some((j) => (j.state === 'queued' || j.state === 'running') && j.key.startsWith(`render:${root}:${project}:${creative}:`)),
    mediaInUse: normalizer.inUse,
    stagingInUse: (dir) => previewsRef?.stagingInUse(dir) ?? false,
    git: deps.git, sideState,
    ...(deps.mediaCacheMaxBytes !== undefined ? { mediaCacheMaxBytes: deps.mediaCacheMaxBytes } : {}),
  });
  let workspace: WorkspaceStore | null = null;
  /** The live previews (set once made): the startup recovery runs before, when no session can be live. */
  let previewsRef: PreviewService | null = null;
  // Why the configured workspace could not be opened at startup (shown by the onboarding).
  let workspaceProblem: { path: string; error: WorkspaceProblem } | null = null;

  const appConfig = await deps.appConfig.read();
  const language = deps.language ?? new LanguageController(appConfig.language, []);
  // Without startServer, an explicit saved language is applied here ('system' keeps the current locale: no system languages known).
  if (!deps.language && appConfig.language !== 'system') language.apply();
  const languageLock = new KeyedMutex();
  // One integrity store (quarantine and last-good state, decisions log 141) for git and the launcher, active before the
  // workspace recovery so the core's own maintenance writes already update it. Persisted only in an explicit config folder
  // (startServer always passes one): a buildServer without it (tests, tools) keeps the records in memory and never writes
  // into the user's real config folder.
  const configDir = deps.configDir ?? defaultConfigDir();
  const integrity = new IntegrityStore(deps.configDir ?? null).activate();
  // Phase 13 (final review I1): each creative's queue and remembered session, in the config folder the agent is denied
  // (in memory without an explicit one, like the integrity records). Made before the workspace recovery, which uses it.
  const sideState = deps.sideState ?? new CreativeSideStateStore(deps.configDir ?? null);
  // Fix round 1 (I-A): a workspace settings change an unsandboxed agent made and the core could not undo stays held across
  // restarts (config folder; in memory without an explicit one).
  const settingsHold = new SettingsHoldStore(deps.configDir ?? null);
  const configured = appConfig.workspacePath;
  if (configured) {
    try {
      // Never recreate a vanished workspace folder nor rewrite corrupt settings: report them instead.
      const ws = await WorkspaceStore.open(configured, deps.git, { create: false });
      await ws.attachSettingsHold(settingsHold);
      queue.setConcurrency((await ws.readSettings()).maxConcurrentJobs);
      workspace = ws;
      await recoverWorkspace(ws, isJobActive, recoverOptions(ws.root));
    } catch (err) {
      workspaceProblem = { path: configured, error: describeWorkspaceProblem(err) };
    }
  }

  const requireWorkspace = () => {
    if (!workspace) throw new WorkspaceError(409, t().errors.noWorkspace);
    return workspace;
  };

  const sandbox = deps.sandbox ?? cachedSandboxDetection();
  const bridge = deps.bridge ?? new AgentBridge();
  const currentSettings = async () => (workspace ? workspace.readSettings() : workspaceSettingsSchema.parse({ schemaVersion: 1 }));
  // Phase 13: the workspace settings (default on; unreadable settings = off, decision 804) and the CLI version, cached for a minute.
  const agentOptIn = async (): Promise<CapabilityOptIn> => currentSettings().then(
    (s) => ({ liveInput: s.agentLiveInput, interrupt: s.agentInterrupt }), () => ({}));
  let versionCache: { at: number; value: Promise<string | null> } | null = null;
  const claudeVersion = (): Promise<string | null> => {
    if (!deps.claudeVersion) return Promise.resolve(null);
    if (!versionCache || Date.now() - versionCache.at > 60_000) {
      versionCache = { at: Date.now(), value: deps.claudeVersion().catch(() => null) };
    }
    return versionCache.value;
  };
  // What the Doctor reports is what the agent gets: the workspace setting wins over the system support.
  const effectiveSandbox = async (): Promise<SandboxSupport> => {
    const mode = await currentSettings().then((s) => s.sandboxMode, () => 'auto' as const);
    return mode === 'off' ? { available: false, disabled: true, reason: t().doctor.sandboxOff } : sandbox();
  };
  // One ledger for the launcher (writes) and the usage report (cached reads).
  const usageLedger = new UsageLedger();
  const launcher = new AgentLauncher({
    runner: deps.runner, bridge, approvals, sandbox, usageLedger,
    settings: currentSettings,
    configDir, integrity,
    mcpCommand: deps.mcpCommand ?? null,
    ...(deps.mcpEnv ? { mcpEnv: deps.mcpEnv } : {}),
    claudeVersion,
    // Final wave P9: the workspace settings are held while an agent runs without the sandbox.
    guardSettings: async () => (workspace ? workspace.guardSettings() : null),
  });

  const vault = deps.vault ?? new MemoryVault();
  // Storyboards, the agent's preview_frames and the live preview sessions (Task 5b), in their own small lane.
  const previews = new PreviewService({
    engine: deps.render, normalizer, media,
    presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets,
    uiOrigins: deps.uiOrigins ?? (() => []),
    ...(deps.renderOptions?.distDir ? { distDir: deps.renderOptions.distDir } : {}),
    ...(deps.onCompositionOrigin ? { onServerOrigin: deps.onCompositionOrigin } : {}),
  });
  previewsRef = previews;
  // One cache of what is known about the keys: the prompt's tool list, the provider tools, voices, Generate and Settings.
  const keyChecks = deps.keyChecks ?? new KeyCheckCache();
  const turns = new CreativeTurnService({
    queue, launcher, git: deps.git, media, vault, keyChecks, previews,
    // Phase 13: a redirect cancels the job's open approvals first; the queue and remembered sessions live in the config
    // folder, out of the agent's reach (final review I1).
    cancelApprovals: (jobId) => approvals.cancelJob(jobId), sideState,
    presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets,
    model: async () => (await requireWorkspace().readSettings()).model,
    broadcast: (msg) => hub.broadcast(msg),
    ...(deps.agentContract ? { agentContract: deps.agentContract } : {}),
    ...(deps.previewFramesPerTurn !== undefined ? { previewFramesPerTurn: deps.previewFramesPerTurn } : {}),
  });

  afterOtherJob = (key, state) => { void turns.otherJobEndedByKey(key, state); };
  turnsRef = turns;
  for (const ref of leftoverBriefs.splice(0)) await turns.briefAfterJob(ref);

  // Phase 13: the console turns' live side, by job id, while they run (the same live module as creative turns, I3).
  const consoleLive = new Map<string, LiveSession>();
  /** Answers by job and clientId (idempotency); a pending one is shared by a double click. */
  const consoleAnswers = new AnswerCache();
  const toInput = (b: LiveBody) => checkLiveMessage({ clientId: b.clientId, text: b.text, pins: b.pins ?? [] });
  const consoleMessage = (jobId: string, b: LiveBody): Promise<{ outcome: 'delivered-pending' }> => {
    const m = toInput(b);
    return consoleAnswers.once(`m\0${jobId}\0${m.clientId}`, async () => {
      const live = consoleLive.get(jobId);
      if (!live) throw new CodedError(409, t().live.consoleTurnOver, 'not-running');
      // The phase is checked inside the chain: a run that just ended never takes a message it cannot read.
      return live.serial(async () => {
        if (!live.caps.liveInput) throw new CodedError(409, t().live.consoleLiveOff, 'live-off');
        if (live.messages.length >= LIVE_LIMITS.perTurn) throw new CodedError(409, t().live.tooManyLive({ max: LIVE_LIMITS.perTurn }), 'limit');
        const run = live.phase === 'agent' ? live.run : null;
        const sent = run ? await run.send?.({ text: liveMessageText(m.text, m.pins, pinLine), clientId: m.clientId }) : 'closed';
        if (sent !== 'written') throw new CodedError(409, t().live.consoleTurnOver, 'not-running');
        const msg = newLiveMessage(m, 'live');
        live.messages.push(msg);
        live.given(msg, 'sent');
        queue.patch(jobId, { liveMessages: live.messages.length });
        return { outcome: 'delivered-pending' as const };
      });
    });
  };
  const consoleRedirect = (jobId: string, b: LiveBody): Promise<{ outcome: RedirectOutcome }> => {
    const m = toInput(b);
    return consoleAnswers.once(`r\0${jobId}\0${m.clientId}`, async () => {
      const live = consoleLive.get(jobId);
      if (!live) throw new CodedError(409, t().live.notRunning, 'not-running');
      const outcome = await redirectLive(live, m, {
        cancelApprovals: () => approvals.cancelJob(jobId),
        // The console has no queue: a redirect after the turn is refused and the UI keeps the words.
        late: async () => { throw new CodedError(409, t().live.notRunning, 'not-running'); },
        record: async (_msg, count) => { queue.patch(jobId, { liveMessages: count }); },
        interrupted: () => hub.broadcast({ type: 'agent', jobId, event: { kind: 'interrupted' } }),
        text: (msg) => interruptedRedirectText(CONSOLE_REDIRECT_NOTE, msg.text, msg.pins),
        // Ruling W for the console too (final review I2): before the first run the answer is at once `pending-start`, and the
        // words join the request in that run's prompt; nothing is spawned only to be stopped.
        answerBeforeStart: true,
      });
      return { outcome };
    });
  };

  // Direct edits (Phase 10b): a draft saved as a version under the creative's lock, with no agent.
  const edits = new DirectEditService({
    turns, queue, git: deps.git, previews,
    presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets,
  });

  const renders = new RenderJobService({
    queue, engine: deps.render, media, normalizer,
    // The browser's text measure of a source composition (fix round 2, N1): the localized render judges translations against it.
    measureText: (o) => previews.measureTextOverflow(o),
    presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets,
    broadcast: (msg) => hub.broadcast(msg),
    ...(deps.renderOptions ? { renderOptions: deps.renderOptions } : {}),
  });

  const brandService = new BrandService({
    queue, launcher, git: deps.git, media,
    model: async () => (await requireWorkspace().readSettings()).model,
    broadcast: (msg) => hub.broadcast(msg), configDir,
  });

  app.setErrorHandler(errorReply);

  // Loopback-only by design: blocks DNS rebinding (Host) and cross-site requests/WebSockets (Origin).
  // In phase 5 Electron loads the UI from http://127.0.0.1:<port>, so this check stays valid.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!isLoopbackHost(req.headers.host) || (origin !== undefined && !isLoopbackOrigin(origin))) {
      // A rejected WebSocket upgrade leaves the raw socket open (nobody owns it any more): close it once the 403 is flushed.
      if (req.raw.headers.upgrade) reply.raw.once('finish', () => req.raw.socket.destroy());
      return reply.status(403).send({ error: t().errors.nonLocalOrigin });
    }
    // Defence against stray local requests (other sites' scripts cannot read it, and agents without sandbox do not know it).
    const token = deps.uiToken;
    const path = req.url.split('?')[0]!;
    const route = req.routeOptions.url;
    if (token === null || !(path.startsWith('/api/') || route?.startsWith('/api/'))) return;
    if (route && UI_TOKEN_EXEMPT[req.method]?.has(route)) return;
    const presented = route === '/api/events'
      ? new URLSearchParams(req.url.slice(path.length + 1)).get('t')
      : req.headers['x-motion-studio-ui'];
    if (!tokenMatches(presented, token)) {
      if (req.raw.headers.upgrade) reply.raw.once('finish', () => req.raw.socket.destroy());
      return reply.status(401).send(uiTokenError());
    }
  });

  // preClose, registered before the websocket plugin's own preClose, so clients still
  // receive the final 'cancelled' job updates before their sockets are closed.
  app.addHook('preClose', async () => {
    approvals.cancelAll();
    // Render jobs too: each kills its browser and ffmpeg groups and removes its temp files before it settles.
    for (const j of queue.list()) queue.cancel(j.id);
    await previews.close();
    await normalizer.close();
    await queue.whenIdle();
  });

  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, { limits: UPLOAD_LIMITS });

  // pid: lets a second launch check that the recorded server.json pid is really this server (pids get reused).
  app.get('/api/health', async () => ({ ok: true, pid: process.pid }));
  app.get('/api/updates', async (): Promise<{ state: UpdatesState }> => ({ state: deps.updatesState?.() ?? 'unknown' }));
  app.get('/api/doctor', async () => {
    const checks = await deps.doctor({ sandbox: effectiveSandbox, workspacePath: workspace?.root ?? null, agentOptIn: await agentOptIn() });
    // Fix round 1 (I-A): an agent change to the workspace settings the core could not undo, held across restarts.
    // Fix round 3: the fields held or made stricter are named, and a record path to remove by hand is given.
    const notice = await workspace?.settingsNotice();
    if (notice) {
      const j = t().jobs;
      const head = notice.kind === 'broken' ? j.settingsHoldBroken : notice.kind === 'held' ? j.workspaceSettingsNotReverted : j.settingsAdjusted;
      const parts = [head, ...(notice.fields.length ? [j.settingsHeldFields({ fields: notice.fields.join(', ') })] : []), ...(notice.stuck ? [j.settingsHoldStuck({ path: notice.stuck })] : [])];
      checks.push({ id: 'workspace-settings', label: t().doctor.workspaceSettingsLabel, required: false, ok: false, message: parts.join(' ') });
    }
    return checks;
  });
  // Phase 13: the effective capabilities (the path the next creative or console turn takes).
  app.get('/api/agent/capabilities', async (): Promise<AgentCapabilities> => capabilitiesFor(await claudeVersion(), await agentOptIn()));

  app.get('/api/workspace', async (): Promise<WorkspaceInfo> => {
    if (!workspace) return { path: workspaceProblem?.path ?? null, settings: null, error: workspaceProblem?.error ?? null };
    try {
      return { path: workspace.root, settings: await workspace.readSettings(), error: null };
    } catch (err) {
      return { path: workspace.root, settings: null, error: describeWorkspaceProblem(err) };
    }
  });

  app.put<{ Body: { path?: unknown } }>('/api/workspace', async (req) => {
    const raw = req.body?.path;
    const path = typeof raw === 'string' ? expandHome(raw.trim()) : '';
    if (!isAbsolute(path)) throw new WorkspaceError(400, t().errors.workspacePathAbsolute);
    // Decision 790: a workspace whose path (or real path, also of a folder not made yet) has glob characters is refused
    // before anything is created in it: the agent's protected-file rules would not match under it.
    await assertAgentFolders(null, path);
    const ws = await WorkspaceStore.open(path, deps.git);
    await ws.attachSettingsHold(settingsHold);
    const settings = await ws.readSettings(); // corrupt settings → 422 before the choice is persisted
    await deps.appConfig.setWorkspacePath(path);
    // Re-selecting the workspace in use must not mark its running creatives as interrupted.
    if (workspace?.root !== ws.root) await recoverWorkspace(ws, isJobActive, recoverOptions(ws.root));
    workspace = ws;
    workspaceProblem = null;
    queue.setConcurrency(settings.maxConcurrentJobs);
    return { path, settings };
  });

  app.put<{ Body: Partial<WorkspaceSettings> }>('/api/settings', async (req) => {
    const { schemaVersion: _ignored, ...patch } = (req.body ?? {}) as Partial<WorkspaceSettings>;
    const settings = await requireWorkspace().updateSettings(patch);
    queue.setConcurrency(settings.maxConcurrentJobs);
    return settings;
  });

  const languageState = () => ({ locale: language.locale, languageSetting: language.setting, systemLocale: language.systemLocale });
  app.get('/api/settings/language', async () => languageState());
  app.put<{ Body: { language?: unknown } }>('/api/settings/language', async (req, reply) => {
    const value = req.body?.language;
    if (value !== 'system' && !isLocale(value)) return reply.status(400).send({ error: t().errors.invalidLanguage });
    // Serialized so the file and the in-memory setting end up with the same (last) value.
    return languageLock.run('language', async () => {
      await deps.appConfig.setLanguage(value);
      language.set(value);
      hub.broadcast({ type: 'locale', locale: language.locale, setting: value, systemLocale: language.systemLocale });
      return languageState();
    });
  });

  app.get('/api/projects', async () => requireWorkspace().listProjects());

  app.post<{ Body: { name?: unknown; description?: unknown } }>('/api/projects', async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const description = typeof req.body?.description === 'string' ? req.body.description : undefined;
    const created = await requireWorkspace().createProject({ name, description });
    return reply.status(201).send(created);
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug', async (req): Promise<ProjectDetail> => {
    const ws = requireWorkspace();
    const project = await ws.getProject(req.params.slug);
    return { slug: req.params.slug, project, jobKey: projectJobKey(ws.root, req.params.slug) };
  });

  app.post<{ Params: { slug: string }; Body: { prompt?: unknown; resumeSessionId?: unknown } }>(
    '/api/projects/:slug/turns',
    async (req, reply) => {
      const ws = requireWorkspace();
      const { slug } = req.params;
      const project = await ws.getProject(slug);
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) throw new WorkspaceError(400, t().errors.promptRequired);
      const rawSession = req.body?.resumeSessionId;
      if (rawSession != null && (typeof rawSession !== 'string' || !SESSION_ID_RE.test(rawSession))) {
        throw new WorkspaceError(400, t().errors.invalidSessionId);
      }
      const resumeSessionId = rawSession ?? undefined;
      const settings = await ws.readSettings();
      const projectDir = ws.projectDir(slug);
      // The reply language is the one set when the turn is sent; a later switch does not change a queued turn.
      const agentPrompt = `${prompt}\n\n${replyInstruction(currentLocale())}`;
      // The user's request as typed (a redirect before the first run joins it in one prompt, final review I2).
      const userPrompt = prompt;
      const jobId = randomUUID();
      // The live side exists from now, so a message or a redirect sent while the turn waits to start is kept.
      consoleLive.set(jobId, new LiveSession(jobId, await launcher.liveCapabilities('console')));
      let job: ReturnType<typeof queue.enqueue>;
      try {
        job = queue.enqueue({
        id: jobId,
        key: projectJobKey(ws.root, slug),
        kind: 'console',
        label: t().jobs.turnLabel({ name: project.name }),
        run: async (signal, id) => {
          // Phase 13: the console's live side (messages, redirect); no queue for the console.
          const live = consoleLive.get(id) ?? new LiveSession(id, await launcher.liveCapabilities('console'));
          consoleLive.set(id, live);
          try {
            let resume = resumeSessionId;
            /** Messages given to a run a redirect cut before it wrote anything as the agent: they go with the next prompt too. */
            let carry: LiveMessage[] = [];
            /** Ruling Z: the one fresh retry of a redirect whose resumed run failed before taking it (once per turn). */
            let freshRetryUsed = false;
            /** Codebase lines already said in this turn (decision 781). */
            const ignoredSaid = new Set<string>();
            /** A failure: when the user's words reached no run, the job's error says so first (fix round 1, M3 and Ruling Z). */
            const failure = (detail: string) => new Error(undeliveredAtEnd(live).length > 0 ? `${t().live.wordsNotDelivered} ${detail}` : detail);
            // Decision 790: a project or workspace folder with glob characters runs no agent (said as the console's error line).
            try { await assertAgentFolders(projectDir, ws.root); } catch (err) { throw failure(err instanceof Error ? err.message : String(err)); }
            for (;;) {
              // Final review I2: a redirect is taken BEFORE anything is spawned. With no session yet (no run took the request),
              // the request and the user's words go together in one prompt; otherwise the live session is resumed with them.
              const redirect = await live.serial(async () => { const r = live.redirect; live.redirect = null; return r; });
              if (signal.aborted) return 'cancelled';
              let prompt = agentPrompt;
              const given: LiveMessage[] = [];
              if (redirect) {
                const fresh = !live.sessionId;
                const words = fresh ? live.words() : [
                  ...live.messages.filter((m) => m !== redirect && m.mode === 'redirect' && (m.state === 'pending' || carry.includes(m))),
                  redirect,
                ];
                for (const m of words) { if (m.state !== 'sent') live.given(m, 'prompt'); given.push(m); }
                const texts = words.map((m) => liveMessageText(m.text, m.pins, pinLine));
                if (fresh) prompt = consoleFreshPrompt(userPrompt, texts);
                else { prompt = consoleRedirectPrompt(texts); resume = live.sessionId; }
              }
              const sessionBefore = live.sessionId;
              const resumedWith = resume;
              /** The run reported its session: it read its prompt (the session holds it). */
              let sawSession = false;
              let run: Awaited<ReturnType<typeof launcher.start>>;
              try {
                const codebases = await consoleCodebases(project.linkedCodebases, [projectDir, ws.root]);
                // Decision 781: a folder left out is said in the console, once per turn.
                for (const line of codebases.ignored) {
                  if (ignoredSaid.has(line)) continue;
                  ignoredSaid.add(line);
                  hub.broadcast({ type: 'agent', jobId: id, event: { kind: 'progress', text: line } });
                }
                run = await launcher.start({
                  kind: 'console', jobId: id, projectSlug: slug, projectDir,
                  codebases: codebases.paths,
                  request: { prompt, resumeSessionId: resume, model: settings.model ?? undefined },
                  onEvent: (event) => {
                    hub.broadcast({ type: 'agent', jobId: id, event });
                    const sessionId = event.kind === 'session' ? event.sessionId : event.kind === 'result' ? event.sessionId : undefined;
                    if (sessionId) { queue.patch(id, { sessionId }); live.sessionId = sessionId; sawSession = true; }
                  },
                });
              } catch (err) {
                // Fix round 1 (M3): the run never started, so its prompt's words were never delivered (said, never dropped silently).
                await live.serial(async () => { live.unconfirmPrompt(); });
                throw failure(err instanceof Error ? err.message : String(err));
              }
              const onAbort = () => run.cancel();
              signal.addEventListener('abort', onAbort, { once: true });
              if (signal.aborted) run.cancel(); // cancelled while the turn was being prepared
              await live.serial(async () => {
                live.run = run;
                live.phase = 'agent';
                live.lastAttempt = true;
                if (run.capabilities) live.caps = run.capabilities;
                // A newer redirect came while this run was being started: its prompt was never read (nothing delivered),
                // and the next run takes it all.
                if (live.redirect) { live.unconfirmPrompt(); run.cancel(); return; }
                for (const m of live.confirmPrompt()) hub.broadcast({ type: 'agent', jobId: id, event: { kind: 'user_message_delivered', clientId: m.clientId } });
              });
              const result = await run.done.finally(() => signal.removeEventListener('abort', onAbort));
              const again = await live.serial(async () => { live.run = null; live.phase = 'between'; return live.redirect !== null; });
              // Phase 13 fallback redirect: the run was stopped for it (or had just ended: the words still get a run); a new
              // run in the same job takes it (top of the loop). A run cut before it reported its session never read its prompt
              // (final wave P3): what that prompt carried goes with the next prompt, so no redirect is lost.
              // A failed resume is an ordinary failure (no loop: each redirect is bounded by LIVE_LIMITS.perTurn).
              if (again && !signal.aborted) {
                if (!sawSession) { live.sessionId = sessionBefore; carry = [...carry, ...given.filter((m) => !carry.includes(m))]; }
                else carry = [];
                continue;
              }
              // Ruling Z (console N5): a redirect's run that failed before reporting its session never took the words. Once per
              // turn, one fresh run carries the request and the words; if that fails too, the job fails and the words are
              // shown as not delivered.
              if (result.status === 'failed' && !sawSession && !signal.aborted && given.some((m) => m.mode === 'redirect')) {
                await live.serial(async () => { for (const m of given) if (m.state === 'prompt') m.state = 'pending'; });
                if (!freshRetryUsed) {
                  freshRetryUsed = true;
                  const lastRedirect = [...given].reverse().find((m) => m.mode === 'redirect')!;
                  await live.serial(async () => { live.sessionId = undefined; live.redirect ??= lastRedirect; });
                  // A gone session that was the turn's own starting point is not resumed again: a new session then.
                  resume = resumeSessionId === resumedWith ? undefined : resumeSessionId;
                  carry = [];
                  continue;
                }
              }
              if (result.status === 'failed') throw failure(result.error ?? t().errors.turnFailed);
              // A cancel that arrived after an ok result yields 'succeeded' from the runner: keep it.
              return result.status === 'cancelled' ? 'cancelled' : undefined;
            }
          } finally {
            // In the chain, so a redirect either was taken above or sees `ended`; whatever is left is answered as not
            // delivered (409, the UI keeps the words): the console has no queue (I1).
            await live.serial(async () => { live.phase = 'ended'; live.run = null; });
            // The words no run took are marked as such (the client may have seen them announced earlier, Ruling Z).
            for (const m of undeliveredAtEnd(live)) hub.broadcast({ type: 'agent', jobId: id, event: { kind: 'user_message_not_delivered', clientId: m.clientId } });
            for (const m of live.messages) m.settle('dropped');
            live.redirect?.settle('dropped');
            live.redirect = null;
          }
        },
      });
      } catch (err) {
        consoleLive.delete(jobId);
        throw err;
      }
      void queue.whenSettled(jobId).then(() => { const l = consoleLive.get(jobId); if (l) l.phase = 'ended'; consoleLive.delete(jobId); });
      return reply.status(202).send(job);
    },
  );

  app.get('/api/jobs', async () => queue.list());
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => ({ cancelled: queue.cancel(req.params.id) }));

  // Phase 13 (spec §3): Stop, for every job (brand analyses and asset descriptions have only this). The job's open
  // approvals are cancelled first: no spending after a stop. A creative turn remembers its session for the next turn.
  app.post<{ Params: { id: string } }>('/api/jobs/:id/stop', async (req) => {
    const out = stopJob({ queue, approvals }, req.params.id);
    if (!out) throw new CodedError(404, t().errors.notFound, 'job-not-found');
    return out;
  });

  // Phase 13 (spec §3): Stop and redirect, for creative and console turns.
  app.post<{ Params: { id: string } }>('/api/jobs/:id/redirect', async (req): Promise<{ outcome: RedirectOutcome }> => {
    const body = parseLiveBody(req.body);
    const job = queue.list().find((j) => j.id === req.params.id);
    if (!job) throw new CodedError(404, t().errors.notFound, 'job-not-found');
    if (job.kind === 'creative') return turns.redirect(job.id, { clientId: body.clientId, text: body.text, pins: body.pins ?? [] });
    if (job.kind === 'console') return consoleRedirect(job.id, body);
    throw new CodedError(409, t().live.redirectUnsupported, 'redirect-unsupported');
  });

  // Phase 13 (spec §2): a message to the running console turn (live input only: the console has no queue).
  app.post<{ Params: { job: string } }>('/api/console/:job/messages', async (req) => {
    const body = parseLiveBody(req.body);
    const job = queue.list().find((j) => j.id === req.params.job && j.kind === 'console');
    if (!job) throw new CodedError(404, t().errors.notFound, 'job-not-found');
    return consoleMessage(job.id, body);
  });

  app.get('/api/events', { websocket: true }, (socket) => {
    hub.add(socket);
    hub.send(socket, { type: 'snapshot', jobs: queue.list(), approvals: approvals.pending(), ...languageState() });
  });

  // The live preview's composition server origin (Task 8 frames it; started on first use).
  app.get('/api/preview/origin', async () => ({ origin: (await previews.compositionServer()).origin, uiOrigins: [...(deps.uiOrigins?.() ?? [])] }));

  // Phase 15: the directions turn and the fan-out of a variant group (`POST …/variants/run`).
  const variantDirections = new VariantDirections({
    queue, launcher, turns, broadcast: (msg) => hub.broadcast(msg),
    presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets,
    model: async () => (await requireWorkspace().readSettings()).model,
  });
  const variantRuns = new VariantFanout({
    turns, queue, approvals, directions: variantDirections, settings: () => requireWorkspace().readSettings(), paidPlan: paidServicePlan({ vault, keyChecks }),
  });
  registerCreativeRoutes(app, { requireWorkspace, turns, edits, renders, previews, signer: new UrlSigner(deps.signedUrlTtlMs), media, openPath: deps.openPath ?? (async () => {}), isJobActive, broadcast: (m) => hub.broadcast(m), git: deps.git, variantRuns, jobs: () => queue.list(), trash: deps.trash ?? noTrash });
  registerStorePackRoutes(app, { requireWorkspace, turns, renders, media });

  const routeCtx = { requireWorkspace, brand: brandService, media, git: deps.git, broadcast: (m: ServerMessage) => hub.broadcast(m), configDir };
  registerBrandRoutes(app, routeCtx);
  registerLibraryRoutes(app, routeCtx);
  const fontsHttp = deps.fontsHttp ?? { fetch: globalThis.fetch };
  registerFontsRoutes(app, { ...routeCtx, catalog: new GoogleFontsCatalog({ configDir, http: fontsHttp }), http: fontsHttp, signer: new UrlSigner(deps.signedUrlTtlMs), ...(deps.fontsInstallIo ? { installIo: deps.fontsInstallIo } : {}) });
  // Localize turns (Phase 12, Task 4): the agent translates through submit_localization; the core makes the voices.
  const voiceDeps = { vault, approvals, media, keyChecks, settings: () => requireWorkspace().readSettings(), broadcast: (m: ServerMessage) => hub.broadcast(m), ...deps.localizeHttp };
  const activity = new ProjectActivity();
  hub.listen((m) => activity.note(m));
  const localize = new LocalizeService({
    turns, queue, launcher, media, previews, activity,
    presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets,
    model: async () => (await requireWorkspace().readSettings()).model,
    broadcast: (msg) => hub.broadcast(msg),
    voices: { available: voiceAvailability(voiceDeps), batch: voiceBatch(voiceDeps) },
    fonts: { http: fontsHttp, ...(deps.fontsInstallIo ? { io: deps.fontsInstallIo } : {}) },
    ...(deps.previewFramesPerTurn !== undefined ? { previewFramesPerTurn: deps.previewFramesPerTurn } : {}),
  });
  registerLocalizationRoutes(app, { requireWorkspace, turns, media, presets: async () => (await new FormatCatalog(requireWorkspace().root).load()).presets, fontsHttp,
    ...(deps.fontsInstallIo ? { fontsIo: deps.fontsInstallIo } : {}), localize, previews });
  registerVoicesRoutes(app, { vault, http: deps.voicesHttp ?? { fetch: globalThis.fetch }, signer: new UrlSigner(deps.signedUrlTtlMs), keyChecks });
  registerGenerateRoutes(app, { requireWorkspace, vault, approvals, media, queue, keyChecks, http: deps.generateHttp ?? { fetch: globalThis.fetch }, broadcast: (m) => hub.broadcast(m) });
  registerProjectRoutes(app, { requireWorkspace, jobKeyOf: projectJobKey, broadcast: (m) => hub.broadcast(m) });

  registerBridgeRoutes(app, {
    bridge, approvals,
    // The config folder holds the UI token and the bridge tokens: no permission prompt may open it.
    protectedRoots: [configDir],
    // Read on every permission prompt: a setting changed mid-job applies to the next one.
    settings: () => requireWorkspace().readSettings(),
    extraTools: {
      ...providerTools({ vault, approvals, media, keyChecks, settings: () => requireWorkspace().readSettings(), broadcast: (m) => hub.broadcast(m), ...deps.providerHttp }),
      download_file: downloadTool({ media, broadcast: (m) => hub.broadcast(m) }),
      import_codebase_file: importCodebaseTool({ media, broadcast: (m) => hub.broadcast(m) }),
    },
  });
  registerSettingsRoutes(app, { vault, approvals, requireWorkspace, keyChecks, keyCheckHttp: deps.keyCheckHttp ?? { fetch: globalThis.fetch } });
  registerRenderEngineRoutes(app, {
    engine: deps.render,
    installer: deps.chromeInstaller !== undefined ? deps.chromeInstaller : deps.render && deps.configDir ? defaultChromeInstaller(deps.configDir) : null,
  });

  let billingCache: { value: Promise<UsageBilling>; until: number } | null = null;
  const billing = () => {
    const now = Date.now();
    if (!billingCache || billingCache.until <= now) {
      const value = (deps.billing ?? (async () => 'unknown' as const))().catch(() => 'unknown' as const);
      const entry = { value, until: now + BILLING_TTL_MS };
      billingCache = entry;
      void value.then((b) => { if (b === 'unknown') entry.until = Math.min(entry.until, Date.now() + BILLING_RETRY_MS); });
    }
    return billingCache.value;
  };
  registerUsageRoutes(app, { workspace: () => workspace, ledger: usageLedger, billing });

  const serveWeb = Boolean(deps.webDir && (await stat(deps.webDir).catch(() => null))?.isDirectory());
  // Always registered: it provides reply.sendFile to the creative file route; it serves the web build only when present.
  await app.register(fastifyStatic, { root: serveWeb ? deps.webDir! : tmpdir(), serve: serveWeb });
  // A single handler (Fastify allows one per context): unknown API routes always get a JSON 404,
  // other paths fall back to the SPA when the web build is available.
  app.setNotFoundHandler((req, reply) =>
    !serveWeb || req.url.startsWith('/api/') ? reply.status(404).send({ error: t().errors.notFound }) : reply.sendFile('index.html'),
  );

  return app;
}
