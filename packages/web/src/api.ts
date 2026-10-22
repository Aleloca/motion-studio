import type { CustomFormatInput, LocaleTag, Localization, LocalizationIssue, LocalizationRow, BrandFont, EditOp, EditorCompositionView, StagedAsset, StagedSvgEdit, StageRequest, ChromeDownloadOffer, OutputIssue, ExportPrepareResult, ExportFps, ExportQuality, PinFramesView, PreviewSessionInfo, RenderEngineStatus, StoryboardView, AgentCapabilities, ApprovalDecision, ApprovalRequest, QuestionAnswers, LiveMessageOutcome, RedirectOutcome, ProposalActivity, LanguageSetting, Locale, AssetEntry, CreativeReferenceEntry, BrandKit, BrandOverview, BrandProposal, BrandSource, Brief, LinkedCodebase, ReferenceEntry, ConversationEntry, CreativeDetail, CreativeFile, CreativeListItem, CreativeRemovalInfo, RecentCreative, DoctorCheck, UpdatesState, FormatPreset, JobSummary, Pin, ProjectDetail, ProjectFile, ProjectIcon, ProjectIntegrity, PermissionsFile, ProjectListItem, SecretStatus, KeyCheckResult, ProviderId, UsageReport, VersionEntry, WorkspaceInfo, WorkspaceSettings, StorePack, VariantId, VariantPick, BriefContext, BriefField, BriefForm, BriefFormSave, BriefFormSaved, BriefMessageInput, BriefSendResult, BriefSessionRef, BriefSessionView, SubtitleCue, SubtitleSet, SubtitlesSummary, TranscriptionChoice, TranscriptionModelId, TranscriptionPending, TranscriptionSettingsPatch, TranscriptionStatus, VideoAnalysisView, WhisperEngine, WhisperFound } from '@motion-studio/shared';
import { currentMessages } from './i18n.tsx';
import { markPairingNeeded, renewUiToken, uiToken } from './uiToken.ts';

/**
 * `code`: the stable machine-readable reason some routes add (e.g. `link-chain`, `pick-file-missing`); `retryAfterSec`: the
 * response's `Retry-After` in seconds, when it has one (e.g. `hashes-pending`).
 */
export class ApiError extends Error {
  /** `problems`: every translated problem behind a 422 (a draft that does not validate). */
  constructor(public readonly status: number, message: string, public readonly code?: string, public readonly retryAfterSec?: number, public readonly problems?: string[]) { super(message); this.name = 'ApiError'; }
}

/** `Retry-After` as seconds (the delay form only; a date or a bad value is ignored). */
function retryAfter(res: Response): number | undefined {
  const raw = res.headers?.get?.('retry-after');
  if (!raw || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/** Headers of every API call: the UI token (the server refuses calls without it). */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = uiToken();
  return token ? { ...extra, 'x-motion-studio-ui': token } : extra;
}

/** A 401 for the UI token: refused before the server did anything, so the call may be sent again with a renewed token. */
const tokenRefused = async (res: Response): Promise<boolean> => {
  if (res.status !== 401) return false;
  const copy = typeof res.clone === 'function' ? res.clone() : res;
  return ((await copy.json().catch(() => ({}))) as { code?: string }).code === 'ui-token';
};

/**
 * Sends `send()` with the current token; when the server refuses that token and a newer one is known (desktop: the main
 * process's; browser: another tab's), sends it once more with it (final wave B3). Else the pairing page is asked for.
 */
async function withToken(send: () => Promise<Response>): Promise<Response> {
  const used = uiToken();
  const res = await send();
  if (!(await tokenRefused(res))) return res;
  if (renewUiToken(used)) {
    const again = await send();
    if (!(await tokenRefused(again))) return again;
    markPairingNeeded();
    return again;
  }
  markPairingNeeded();
  return res;
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = (data as { code?: unknown }).code;
    const problems = (data as { problems?: unknown }).problems;
    throw new ApiError(res.status, (data as { error?: string }).error ?? currentMessages().web.api.httpError({ status: res.status }), typeof code === 'string' ? code : undefined, retryAfter(res),
      Array.isArray(problems) ? problems.filter((x): x is string => typeof x === 'string') : undefined);
  }
  return data as T;
}

/** Per-call fetch options. `keepalive` lets a delete sent while the page closes reach the server. */
export interface RequestOptions { keepalive?: boolean }

async function request<T>(method: string, url: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await withToken(() => fetch(url, {
    method,
    headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(opts.keepalive ? { keepalive: true } : {}),
  }));
  return parse<T>(res);
}

/** A file of an API route as a Blob: the route needs the UI token, so a plain link to it would be refused (401). */
async function fetchBlob(url: string): Promise<Blob> {
  const res = await withToken(() => fetch(url, { headers: headers() }));
  if (!res.ok) await parse(res);
  return res.blob();
}

/** What the editor stages for an SVG it edited (SVG inner editor): the clip, the `src` it started from, the whole new text. */
export type SvgEditFrom = Extract<StageRequest['from'], { kind: 'svgEdit' }>;

/** The body of a direct save (Task 4): `format` is the PRIMARY edited; `staged` the staged paths the draft uses; `token` the session that owns them. */
export interface SaveEditsBody { baseVersion: number; format: string; baseHash: string; composition: unknown; staged: string[]; ops: EditOp[]; token: string }

/** A render made during an export that had problems, so not copied (final wave P2): said in the summary. */
export interface ExportExcluded { format: string; version: number; problems: string[]; issues: OutputIssue[]; /** A translation that was excluded (Phase 12). */ locale?: string }

/** A translation as the core answers GET and PUT of one language and format (Phase 12). `warnings`: PUT only, advisory. */
export interface LocalizationView { overlay: Localization; problems: string[]; /** The problems with their code and clip; absent on rows written before. */ issues?: LocalizationIssue[]; stale: string[]; voice: LocalizationRow['voice']; origin: LocalizationRow['origin']; hash: string; warnings?: string[] }
/** The edit PUT takes: `null` removes an entry; `voice`: keep the original voice or mute it. */
export interface LocalizationEdit { texts?: Record<string, string | null>; params?: Record<string, string | null>; fit?: Record<string, number | null>; voice?: 'original' | 'muted' }
/** The body of a localize turn (`POST …/versions/:n/localize`): `voice` per language. */
export interface LocalizeRequest { locales: string[]; formats?: string[]; voice?: Record<string, 'translate' | 'original' | 'muted'>; text?: string }
/** The localized composition of a format (preview): the editor view with the overlay applied, plus the language's state. */
export type LocalizedCompositionView = EditorCompositionView & { localization: { locale: LocaleTag; stale: string[]; problems: string[]; issues?: LocalizationIssue[]; voice: LocalizationRow['voice'] } };
/** One format of the group export (phase 15, spec §6): where its file comes from, and whether it can be copied now. */
export interface GroupExportPlanItem {
  format: string; slug: string; letter: VariantId; version: number; source: 'pick' | 'default';
  /** The version the name's `{v}` shows when it is not `version` (a follower is named after its primary's). */
  v?: number; file: string; width: number; height: number; state: 'ready' | 'needs-render' | 'missing';
  /** A composition (decision 974: the export's resolution and quality apply to it). */
  composed?: true;
  /** Report 47: the composition's hash, for its still when it has no current render. */
  hash?: string;
}
export interface GroupExportResult {
  destination: string; files: Array<{ from: string; to: string }>; skipped: string[];
  /** The formats that were left out (a missing file, a render without a current result), each with a translated message. */
  unavailable: Array<{ format: string; slug: string; letter: VariantId; version: number; locale?: string; message: string }>;
}
/** What a pack export did (Phase 12 §4.3): paths relative to the pack folder; `rendered` lists what was rendered first. */
export interface StorePackExportResult { folder: string; written: string[]; failed: Array<{ file: string; reason: string }>; notInPack?: string[]; rendered?: Array<{ version: number; formats: string[]; locale?: string }> }
/** "Render anyway" and the languages of a render or an export (Phase 12 §3.5). */
export interface LocaleOptions { locales?: string[]; force?: boolean }
/** The subtitles of an export (spec §6.6): the languages written as `.srt`/`.vtt` files next to each video. */
/** The subtitles of an export (spec §6.6, Tasks 7 and 21): drawn into a video per language, `.srt`/`.vtt` files, soft MP4 tracks. */
export interface ExportSubtitles { subtitles?: { drawn?: string[]; files?: string[]; soft?: string[] } }

/** What `POST …/variants/run` answers (202): by variant letter; see the core's `FanoutResult`. */
export interface VariantRunResult {
  jobs: Partial<Record<VariantId, string>>; queued: VariantId[]; skipped: VariantId[]; failed: Partial<Record<VariantId, string>>;
  directionsJobId?: string; batchId?: string;
}

export interface CodebaseCheck { path: string; note?: string; exists: boolean }
const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');

async function upload<T>(url: string, files: File[]): Promise<T> {
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  const res = await withToken(() => fetch(url, { method: 'POST', body: form, headers: headers() }));
  return parse<T>(res);
}

/** One family of the Google Fonts catalog as the core serves it (the web never talks to Google). */
export interface GoogleFamily { family: string; category: string; weights: number[]; italic: boolean; variable: boolean; /** Signed, short-lived core URL of the preview subset (FontFace cannot send the UI token). */ previewUrl: string }
export interface GoogleFontSearch { stale: boolean; fallback: boolean; families: GoogleFamily[]; /** When the signed preview URLs stop working (epoch ms). */ previewExpiresAt?: number }
/** One voice as the core lists it: the preview is a short-lived signed core URL, never a provider URL. */
export interface VoiceInfo { id: string; name: string; labels: Record<string, string>; previewUrl: string | null }
export interface VoiceList { provider: 'elevenlabs' | 'openai'; configured: boolean; voices: VoiceInfo[]; previewExpiresAt: number }
/** POST /api/projects/:slug/generate: one request per kind; the core validates every field and answers with the job to follow. */
export type GenerateRequest =
  | { kind: 'image'; provider: 'openai'; prompt: string; options: { width: number; height: number; quality?: 'low' | 'medium' | 'high' | 'auto'; background?: 'transparent' | 'opaque' | 'auto'; name?: string } }
  | { kind: 'voice'; provider: 'openai' | 'elevenlabs'; text: string; options: { voice?: string; instructions?: string; format?: 'mp3' | 'wav'; name?: string } }
  | { kind: 'sfx'; provider: 'elevenlabs'; prompt: string; options: { durationSec?: number; loop?: boolean; name?: string } }
  | { kind: 'music'; provider: 'elevenlabs'; prompt: string; options: { durationSec: number; instrumental?: boolean; name?: string } };
export interface CatalogState { presets: FormatPreset[]; error: string | null; path: string }
const p = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;
const c = (slug: string, creative: string) => `${p(slug)}/creatives/${encodeURIComponent(creative)}`;
const subs = (slug: string, creative: string) => `${c(slug, creative)}/subtitles`;
/** A subtitle set's file (decision 1702): its cues as `.srt` or `.vtt`, cut at the latest version's video duration. */
export const subtitleFileUrl = (slug: string, creative: string, lang: LocaleTag, ext: 'srt' | 'vtt') => `${subs(slug, creative)}/${encodeURIComponent(lang)}/file.${ext}`;
/** The subtitles job and its transcription question, as the subtitle routes answer them. */
export interface SubtitlesJobState { job: JobSummary | null; pending: TranscriptionPending | null }

/** Decision 974: the quality and resolution (short side) of an export's videos; report 39: their frame rate (absent: the format's own). */
export interface ExportProfileBody { quality: ExportQuality; resolution?: number; fps?: ExportFps }

export const api = {
  getUpdatesState: () => request<{ state: UpdatesState }>('GET', '/api/updates'),
  getDoctor: () => request<DoctorCheck[]>('GET', '/api/doctor'),
  /**
   * Token and cost usage from the projects' ledgers; defaults to the last 7 local days of the core. With `creative`
   * (and its `project`) and no range: that creative's whole history.
   */
  getUsage: (q: { from?: string; to?: string; project?: string; creative?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')).toString();
    return request<UsageReport>('GET', `/api/usage${qs ? `?${qs}` : ''}`);
  },
  /** Shown tokens of each creative's first generation in the last `days` days (New creative estimate). */
  /** What ran during a brand analysis (Bash calls, outcomes, decisions, automatic approvals), from the proposal's log. */
  getProposalActivity: (slug: string, id: string) => request<ProposalActivity>('GET', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/activity`),
  getFirstGenerations: (days = 90) => request<{ tokens: number[] }>('GET', `/api/usage/first-generations?days=${days}`),
  getWorkspace: () => request<WorkspaceInfo>('GET', '/api/workspace'),
  setWorkspace: (path: string) => request<{ path: string; settings: WorkspaceSettings }>('PUT', '/api/workspace', { path }),
  updateSettings: (patch: Partial<WorkspaceSettings>) => request<WorkspaceSettings>('PUT', '/api/settings', patch),
  setLanguage: (language: LanguageSetting) => request<{ locale: Locale; languageSetting: LanguageSetting; systemLocale: Locale }>('PUT', '/api/settings/language', { language }),
  getSecrets: () => request<SecretStatus[]>('GET', '/api/secrets'),
  /** Saves only: the UI says "Saved · checking…" and then asks for the test with checkSecret. */
  setSecret: (provider: ProviderId, value: string) => request<SecretStatus>('PUT', `/api/secrets/${provider}`, { value, check: false }),
  checkSecret: (provider: ProviderId) => request<KeyCheckResult>('POST', `/api/secrets/${provider}/check`),
  getKeyChecks: () => request<Record<ProviderId, KeyCheckResult | null>>('GET', '/api/secrets/checks'),
  deleteSecret: (provider: ProviderId) => request<SecretStatus>('DELETE', `/api/secrets/${provider}`),
  getApprovals: () => request<ApprovalRequest[]>('GET', '/api/approvals'),
  decideApproval: (id: string, decision: ApprovalDecision) => request<unknown>('POST', `/api/approvals/${encodeURIComponent(id)}`, { decision }),
  /** User note 8: the answer to the agent's question, one item per question (option indexes and the "Other" text). */
  answerQuestion: (id: string, answers: QuestionAnswers) => request<unknown>('POST', `/api/approvals/${encodeURIComponent(id)}/answer`, { answers }),
  getPermissions: (slug: string) => request<PermissionsFile['allow']>('GET', `${p(slug)}/permissions`),
  deletePermission: (slug: string, rule: string) => request<{ ok: true }>('DELETE', `${p(slug)}/permissions`, { rule }),
  listProjects: () => request<ProjectListItem[]>('GET', '/api/projects'),
  createProject: (name: string, description?: string) =>
    request<{ slug: string; project: ProjectFile }>('POST', '/api/projects', { name, description }),
  getProject: (slug: string) => request<ProjectDetail>('GET', `/api/projects/${encodeURIComponent(slug)}`),
  getIntegrity: (slug: string) => request<ProjectIntegrity>('GET', `${p(slug)}/integrity`),
  acceptIntegrity: (slug: string, token: string) => request<ProjectIntegrity>('POST', `${p(slug)}/integrity/accept`, { token }),
  /** `icon` (report 44): an image of the library, the initials, or null for the automatic icon. */
  updateProject: (slug: string, body: { name?: string; description?: string; linkedCodebases?: LinkedCodebase[]; icon?: ProjectIcon | null }) => request<ProjectDetail>('PUT', p(slug), body),
  getCodebases: (slug: string) => request<CodebaseCheck[]>('GET', `${p(slug)}/codebases`),
  getBrand: (slug: string) => request<BrandOverview>('GET', `${p(slug)}/brand`),
  saveBrandKit: (slug: string, kit: BrandKit) => request<BrandKit>('PUT', `${p(slug)}/brand/kit`, { kit }),
  saveGuidelines: (slug: string, text: string) => request<{ ok: true }>('PUT', `${p(slug)}/brand/guidelines`, { text }),
  addBrandSource: (slug: string, body: { kind: 'website'; url: string } | { kind: 'image'; file: string } | { kind: 'codebase'; path: string; note?: string }) => request<BrandSource>('POST', `${p(slug)}/brand/sources`, body),
  removeBrandSource: (slug: string, id: string, opts?: RequestOptions) => request<{ ok: true }>('DELETE', `${p(slug)}/brand/sources/${encodeURIComponent(id)}`, undefined, opts),
  analyzeBrand: (slug: string, sourceIds?: string[]) => request<JobSummary>('POST', `${p(slug)}/brand/analyze`, { sourceIds }),
  applyProposal: (slug: string, id: string, acceptedIds: string[], applyGuidelines: boolean) =>
    request<{ kit: BrandKit; proposal: BrandProposal }>('POST', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/apply`, { acceptedIds, applyGuidelines }),
  discardProposal: (slug: string, id: string) => request<BrandProposal>('POST', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/discard`),
  /** Report 62: `assets` is the library; the creatives' own references (files added in a brief) come apart. */
  listAssets: (slug: string) => request<{ assets: AssetEntry[]; error: string | null; unregistered: string[]; creativeReferences?: CreativeReferenceEntry[] }>('GET', `${p(slug)}/assets`),
  /**
   * The route answers the new entries (201 `{ assets }` for the library; references answer their own list). `reference`
   * (report 62): files added in a brief, only for its creative until saved in Assets.
   */
  uploadFiles: (slug: string, kind: 'assets' | 'references', files: File[], opts: { reference?: boolean } = {}) =>
    upload<{ assets?: AssetEntry[] }>(`${p(slug)}/${kind}${kind === 'assets' && opts.reference ? '?scope=reference' : ''}`, files),
  /** Report 62: false saves a creative's reference in Assets; true makes it only for its brief again (while no creative uses it). */
  setAssetReference: (slug: string, file: string, reference: boolean) => request<AssetEntry>('PATCH', `${p(slug)}/assets/item/${enc(file)}`, { reference }),
  registerAssets: (slug: string, files: string[]) => request<{ assets: AssetEntry[] }>('POST', `${p(slug)}/assets/register`, { files }),
  describeAssets: (slug: string, files?: string[]) => request<JobSummary>('POST', `${p(slug)}/assets/describe`, { files }),
  updateAsset: (slug: string, file: string, patch: { name?: string; description?: string; tags?: string[] }) => request<AssetEntry>('PATCH', `${p(slug)}/assets/item/${enc(file)}`, patch),
  assetWaveform: (slug: string, file: string) => request<{ peaks: number[] }>('GET', `${p(slug)}/assets/item/${enc(file)}/waveform`),
  deleteAsset: (slug: string, file: string, opts?: RequestOptions) => request<{ ok: true }>('DELETE', `${p(slug)}/assets/item/${enc(file)}`, undefined, opts),
  listReferences: (slug: string) => request<{ references: ReferenceEntry[]; error: string | null }>('GET', `${p(slug)}/references`),
  updateReference: (slug: string, file: string, patch: { note?: string; useForBrand?: boolean }) => request<ReferenceEntry>('PATCH', `${p(slug)}/references/item/${enc(file)}`, patch),
  deleteReference: (slug: string, file: string, opts?: RequestOptions) => request<{ ok: true }>('DELETE', `${p(slug)}/references/item/${enc(file)}`, undefined, opts),
  searchGoogleFonts: (q: { q?: string; category?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (q.q) params.set('q', q.q);
    if (q.category) params.set('category', q.category);
    if (q.limit) params.set('limit', String(q.limit));
    return request<GoogleFontSearch>('GET', `/api/fonts/google?${params.toString()}`);
  },
  listVoices: (q: { provider: 'elevenlabs' | 'openai'; q?: string }) => {
    const params = new URLSearchParams({ provider: q.provider });
    if (q.q) params.set('q', q.q);
    return request<VoiceList>('GET', `/api/voices?${params.toString()}`);
  },
  addGoogleFont: (slug: string, body: { family: string; weights: number[]; italic: boolean; role: BrandFont['role'] }) =>
    request<{ font: BrandFont; files: string[]; updated: boolean }>('POST', `${p(slug)}/brand/fonts/google`, body),
  projectFileUrl: (slug: string, rel: string) => `${p(slug)}/files/${enc(rel)}`,
  generateAsset: (slug: string, body: GenerateRequest) => request<{ jobId: string }>('POST', `${p(slug)}/generate`, body),
  cancelJob: (id: string) => request<{ cancelled: boolean }>('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
  /** Phase 13: what the running Claude Code can do mid-turn. Both false by default (fallback-first). */
  getAgentCapabilities: () => request<AgentCapabilities>('GET', '/api/agent/capabilities'),
  /** Stop (no confirmation): the job's open approvals are cancelled first, a creative turn remembers its session. */
  stopJob: (id: string) => request<{ status: string }>('POST', `/api/jobs/${encodeURIComponent(id)}/stop`),
  /** Stop and redirect: creative and console turns. `clientId` makes a double click one redirect. */
  redirectJob: (id: string, body: { clientId: string; text: string; pins?: Pin[] }) => request<{ outcome: RedirectOutcome }>('POST', `/api/jobs/${encodeURIComponent(id)}/redirect`, body),
  /** A message to a turn console (live input only; the console has no queue). */
  sendConsoleMessage: (jobId: string, body: { clientId: string; text: string; pins?: Pin[] }) => request<{ outcome: LiveMessageOutcome }>('POST', `/api/console/${encodeURIComponent(jobId)}/messages`, body),
  // Decisions 1421–1423: the project's brief session (one open session; any id removes an unreadable one).
  getBriefSession: (slug: string) => request<BriefSessionView | null>('GET', `${p(slug)}/brief-session`),
  startBriefSession: (slug: string, body: { form: BriefForm; userEdited: BriefField[] }) => request<BriefSessionView>('POST', `${p(slug)}/brief-session`, body),
  getBriefConversation: (slug: string, id: string) => request<ConversationEntry[]>('GET', `${p(slug)}/brief-session/${encodeURIComponent(id)}/conversation`),
  sendBriefMessage: (slug: string, id: string, body: BriefMessageInput) => request<BriefSendResult>('POST', `${p(slug)}/brief-session/${encodeURIComponent(id)}/messages`, body),
  /** The merged form comes back: the client adopts its `revision` only together with `form` and `userEdited`. */
  saveBriefForm: (slug: string, id: string, body: BriefFormSave) => request<BriefFormSaved>('PUT', `${p(slug)}/brief-session/${encodeURIComponent(id)}/form`, body),
  setBriefContext: (slug: string, id: string, context: BriefContext) => request<BriefSessionView>('PUT', `${p(slug)}/brief-session/${encodeURIComponent(id)}/context`, context),
  removeBriefQueued: (slug: string, id: string, clientId: string) => request<BriefSessionView>('DELETE', `${p(slug)}/brief-session/${encodeURIComponent(id)}/queue/${encodeURIComponent(clientId)}`),
  discardBriefSession: (slug: string, id: string) => request<unknown>('DELETE', `${p(slug)}/brief-session/${encodeURIComponent(id)}`),
  getFormats: () => request<CatalogState>('GET', '/api/formats'),
  // Report 59: custom formats, one preset per call (the core changes the catalog under its lock).
  addCustomFormat: (body: CustomFormatInput) => request<{ preset: FormatPreset; catalog: CatalogState }>('POST', '/api/formats/custom', body),
  editCustomFormat: (id: string, body: CustomFormatInput) => request<{ preset: FormatPreset; catalog: CatalogState }>('PUT', `/api/formats/custom/${encodeURIComponent(id)}`, body),
  /** `hidden`: creatives use it, so it stays for them and is offered nowhere. */
  deleteCustomFormat: (id: string) => request<{ outcome: 'deleted' | 'hidden'; catalog: CatalogState }>('DELETE', `/api/formats/custom/${encodeURIComponent(id)}`),
  customFormatUsage: (id: string) => request<{ creatives: number; unreadable: number; longestSec: number }>('GET', `/api/formats/custom/${encodeURIComponent(id)}/usage`),
  recentCreatives: (limit?: number) => request<RecentCreative[]>('GET', `/api/recent-creatives${limit === undefined ? '' : `?limit=${limit}`}`),
  /** Decision 915: the archived creatives are left out (`listArchivedCreatives` lists only them). */
  listCreatives: (slug: string) => request<CreativeListItem[]>('GET', `${p(slug)}/creatives`),
  listArchivedCreatives: (slug: string) => request<CreativeListItem[]>('GET', `${p(slug)}/creatives?archived=1`),
  /** Decision 915: whether the creative can be archived or deleted now, and as what (single, group, variant). */
  creativeRemoval: (slug: string, creative: string) => request<CreativeRemovalInfo>('GET', `${c(slug, creative)}/removal`),
  /** `all`: the whole variant group, from its variant A (required there). */
  archiveCreative: (slug: string, creative: string, all = false) => request<{ archived: string[] }>('POST', `${c(slug, creative)}/archive${all ? '?all=1' : ''}`),
  unarchiveCreative: (slug: string, creative: string) => request<{ restored: string[] }>('POST', `${c(slug, creative)}/unarchive`),
  /** Moves the creative's folder (every variant's with `all`) to the Trash. */
  deleteCreative: (slug: string, creative: string, all = false) => request<{ deleted: string[] }>('DELETE', `${c(slug, creative)}${all ? '?all=1' : ''}`),
  /** `briefSession` (decision 1423): the brief session the creative takes over (its chat and its agent's memory). */
  createCreative: (slug: string, body: { title: string; brief: Brief; generate: boolean; linkedCodebases?: LinkedCodebase[]; briefSession?: BriefSessionRef }) =>
    request<{ slug: string; creative: CreativeFile; job: JobSummary | null; /** The creative exists but the brief session did not move into it entirely. */ briefError?: string; /** Phase 15: an identity creative with concepts > 1 starts its variants (no single job). */ variantRun?: VariantRunResult; /** The start failed after the group existed: the slug is still good. */ startError?: string; /** The group could not be made after the creative existed (nothing started): the slug is still good. */ groupError?: string }>('POST', `${p(slug)}/creatives`, body),
  /** Phase 15: creates sisters (no turn starts). With no group, `count` is the whole group size, A included (2..5), and `directions[0]` is A's. */
  addVariants: (slug: string, creative: string, body: { count?: number; directions?: Array<string | null>; baseFrom?: VariantPick }) =>
    request<CreativeDetail>('POST', `${c(slug, creative)}/variants`, body),
  /** Phase 15: starts the first generation (`request` null) or `request` in the target variants; answers at once (202). */
  /** `request.direct` (phase 3 of the single agent): a UI action naming its variants (a Retry): their own turns, not the group's. */
  runVariants: (slug: string, creative: string, body: { targets: VariantId[] | 'all-active'; request: { text?: string; pins?: Pin[]; formats?: string[]; direct?: true } | null }) =>
    request<VariantRunResult>('POST', `${c(slug, creative)}/variants/run`, body),
  discardVariant: (slug: string, creative: string, letter: VariantId) => request<CreativeDetail>('POST', `${c(slug, creative)}/variants/${letter}/discard`),
  restoreVariant: (slug: string, creative: string, letter: VariantId) => request<CreativeDetail>('POST', `${c(slug, creative)}/variants/${letter}/restore`),
  useVariantForAll: (slug: string, creative: string, letter: VariantId) => request<CreativeDetail>('POST', `${c(slug, creative)}/variants/${letter}/use-for-all`),
  /** The group's ★ of a format (`null` clears it). */
  setVariantPick: (slug: string, creative: string, formatId: string, pick: VariantPick | null) =>
    request<CreativeDetail>('PUT', `${c(slug, creative)}/variants/picks/${encodeURIComponent(formatId)}`, pick),
  setVariantLayout: (slug: string, creative: string, layout: 'variant' | 'format') => request<CreativeDetail>('PUT', `${c(slug, creative)}/variants/layout`, { layout }),
  setVariantDirection: (slug: string, creative: string, letter: VariantId, direction: string) =>
    request<CreativeDetail>('PUT', `${c(slug, creative)}/variants/${letter}/direction`, { direction }),
  /** Creates an App store pack creative (Phase 12 §4.1): the core builds the brief from the choices and checks every app screen. */
  createStorePack: (slug: string, body: { title: string; storePack: StorePack; generate?: boolean }) =>
    request<{ slug: string; creative: CreativeFile; job: JobSummary | null }>('POST', `${p(slug)}/creatives/store-pack`, body),
  /** Exports the pack of version n (§4.3): written and failed files are relative to the pack folder. */
  exportStorePack: (slug: string, creative: string, n: number, body: { destination: string; locales?: string[]; formats?: string[] }) =>
    request<StorePackExportResult>('POST', `${c(slug, creative)}/versions/${n}/store-pack/export`, body),
  getCreative: (slug: string, creative: string) => request<CreativeDetail>('GET', c(slug, creative)),
  updateCreative: (slug: string, creative: string, body: {
    title?: string; brief?: Brief; services?: Brief['services']; linkedCodebases?: LinkedCodebase[];
    /** Alone, each merges into the stored brief under the creative's lock: labels per key (`''` or null clears one), order and removal of formats. */
    formatLabels?: Record<string, string | null>; formats?: string[];
    /** Phase 14: sets or changes (a pack) or takes out (`null`) the store pack: the core recomputes only the pack's instances. Sent alone. */
    storePack?: StorePack | null;
  }) => request<CreativeFile>('PUT', c(slug, creative), body),
  /** Duplicates a format of version n as the next free instance and saves a new version; the new instance's id comes back. */
  duplicateFormat: (slug: string, creative: string, n: number, body: { instanceId: string; label?: string }) =>
    request<{ version: VersionEntry; instanceId: string }>('POST', `${c(slug, creative)}/versions/${n}/duplicate-format`, body),
  /** Manual ★ of a format (`null` clears it; the version the default rule gives also clears it). */
  setExportPick: (slug: string, creative: string, format: string, version: number | null) =>
    request<CreativeDetail>('PUT', `${c(slug, creative)}/export-picks`, { format, version }),
  /** Links `follower` to `primary`, or unlinks it with `null`. */
  setFormatLink: (slug: string, creative: string, follower: string, primary: string | null) =>
    request<CreativeDetail>('PUT', `${c(slug, creative)}/links`, { follower, primary }),
  getConversation: (slug: string, creative: string) => request<ConversationEntry[]>('GET', `${c(slug, creative)}/conversation`),
  /** `formats`: the formats the change applies to (spec §2.5); absent means all of them. */
  sendCreativeTurn: (slug: string, creative: string, body: { text?: string; pins?: Pin[]; formats?: string[]; direct?: true }) => request<JobSummary>('POST', `${c(slug, creative)}/turns`, body),
  /** Phase 13: a message while the agent works (`live`) or for after it (`queued`). Idempotent on `clientId`. */
  postLiveMessage: (slug: string, creative: string, body: { clientId: string; text: string; pins?: Pin[]; mode: 'live' | 'queued' }) =>
    request<{ entry: ConversationEntry; outcome: LiveMessageOutcome }>('POST', `${c(slug, creative)}/messages`, body),
  removeQueued: (slug: string, creative: string, clientId: string) => request<CreativeFile>('DELETE', `${c(slug, creative)}/queue/${encodeURIComponent(clientId)}`),
  editQueued: (slug: string, creative: string, clientId: string, body: { text: string; pins?: Pin[] }) => request<CreativeFile>('PUT', `${c(slug, creative)}/queue/${encodeURIComponent(clientId)}`, body),
  /** Saves the queue's order (a permutation of the current queue; 409 `queue-changed` otherwise). */
  reorderQueue: (slug: string, creative: string, order: string[]) => request<CreativeFile>('PUT', `${c(slug, creative)}/queue`, { order }),
  runNext: (slug: string, creative: string) => request<JobSummary>('POST', `${c(slug, creative)}/queue/run-next`),
  restoreVersion: (slug: string, creative: string, n: number) => request<CreativeFile>('POST', `${c(slug, creative)}/versions/${n}/restore`),
  revealVersion: (slug: string, creative: string, n: number) => request<{ ok: true }>('POST', `${c(slug, creative)}/versions/${n}/reveal`),
  /**
   * Exports the ★ versions (spec §3.3): `picks` format → vN, `follow` follower → the version shown (its primary's ★),
   * `pattern` the file name pattern (the workspace default when omitted), `date` the `{date}` previewed (YYYY-MM-DD).
   * Refusals carry an `export-*` code.
   */
  exportPicks: (slug: string, creative: string, body: { destination: string; picks: Record<string, number>; follow?: Record<string, number>; pattern?: string; date?: string } & LocaleOptions) =>
    request<{ destination: string; files: Array<{ from: string; to: string }>; skipped: string[]; excluded?: ExportExcluded[] }>('POST', `${c(slug, creative)}/export`, body),
  /**
   * Decision 974: the same export, in the background with a quality and a resolution (the short side; absent: the format's
   * own size). Answers at once with the export job (its refusals come at once, as `exportPicks`'s); the files come with the
   * job's `export` once it is done.
   */
  exportPicksJob: (slug: string, creative: string, body: { destination: string; picks: Record<string, number>; follow?: Record<string, number>; pattern?: string; date?: string } & LocaleOptions & ExportProfileBody & ExportSubtitles) =>
    request<{ job: JobSummary }>('POST', `${c(slug, creative)}/export`, { ...body, background: true }),
  /** Decision 974: the group export in the background (see `exportPicksJob`). */
  exportGroupJob: (slug: string, creative: string, body: { destination: string; formats?: string[]; pattern?: string; date?: string } & LocaleOptions & ExportProfileBody) =>
    request<{ job: JobSummary }>('POST', `${c(slug, creative)}/export-group`, { ...body, background: true }),
  /** Phase 15: the group export's plan (any member of the group answers the same): per format, the ★ or default member and version. */
  groupExportPlan: (slug: string, creative: string) => request<{ items: GroupExportPlanItem[]; /** The group's canonical formats (the host's pending brief, else its own). */ formats?: string[] }>('GET', `${c(slug, creative)}/export-group`),
  /** Phase 15: exports each (chosen) format from its group selection, with today's file names; `force`: "Render anyway" for translations. */
  exportGroup: (slug: string, creative: string, body: { destination: string; formats?: string[]; pattern?: string; date?: string } & LocaleOptions) =>
    request<GroupExportResult>('POST', `${c(slug, creative)}/export-group`, body),
  /** Phase 15: the store pack of a group, each format from the group selection. */
  /** Decision 1333: the files of a group's pack, from the host's brief (the one its pack export reads). */
  storePackGroupFiles: (slug: string, creative: string) =>
    request<{ formats: string[]; labels: Record<string, string> }>('GET', `${c(slug, creative)}/store-pack/group-files`),
  exportStorePackGroup: (slug: string, creative: string, body: { destination: string; locales?: string[]; formats?: string[] }) =>
    request<StorePackExportResult>('POST', `${c(slug, creative)}/store-pack/export-group`, body),
  /**
   * What a ★ export renders first (Task 8): the same picks and followers as `exportPicks`; the jobs are started (or joined)
   * at once and the export, called next, waits for them.
   */
  prepareExport: (slug: string, creative: string, body: { picks: Record<string, number>; follow?: Record<string, number> } & LocaleOptions) =>
    request<ExportPrepareResult>('POST', `${c(slug, creative)}/export/prepare`, body),
  /** Renders a v2 version's compositions (all its primaries, or `formats`; a follower stands for its primary). 202 with the job. */
  renderVersion: (slug: string, creative: string, n: number, formats?: string[], opts: LocaleOptions = {}) =>
    request<JobSummary>('POST', `${c(slug, creative)}/versions/${n}/render`, { ...(formats ? { formats } : {}), ...(opts.locales?.length ? { locales: opts.locales } : {}), ...(opts.force ? { force: true } : {}) }),
  /** "Use as brand logo" (Phase 14): the checked SVG of an identity format goes into the brand kit. Codes: `logo-not-checked`, `logo-no-svg`, `logo-missing`, `logo-refused`. */
  useAsBrandLogo: (slug: string, creative: string, n: number, format: string, variant: 'primary' | 'icon') =>
    request<{ file: string; dark?: string; variant: 'primary' | 'icon'; committed: boolean }>('POST', `${c(slug, creative)}/versions/${n}/formats/${encodeURIComponent(format)}/use-as-brand-logo`, { variant }),
  /** The translations of version n (rows) and the creative's extra languages. */
  getLocalizations: (slug: string, creative: string, n: number) =>
    request<{ entries: LocalizationRow[]; available: LocaleTag[] }>('GET', `${c(slug, creative)}/versions/${n}/localizations`),
  getLocalization: (slug: string, creative: string, n: number, locale: string, instanceId: string) =>
    request<LocalizationView>('GET', `${c(slug, creative)}/versions/${n}/localizations/${encodeURIComponent(locale)}/${encodeURIComponent(instanceId)}`),
  /** Saves a manual edit of a translation (origin `editor`); the checks run again. 409 `localization-busy` while the agent works. */
  saveLocalization: (slug: string, creative: string, n: number, locale: string, instanceId: string, edit: LocalizationEdit) =>
    request<LocalizationView>('PUT', `${c(slug, creative)}/versions/${n}/localizations/${encodeURIComponent(locale)}/${encodeURIComponent(instanceId)}`, edit),
  /** Starts a localize turn on version n (202, the job id). */
  localize: (slug: string, creative: string, n: number, body: LocalizeRequest) =>
    request<{ jobId: string }>('POST', `${c(slug, creative)}/versions/${n}/localize`, body),
  /** The composition of a format with a language's translation applied (the locale preview). */
  getLocalizedComposition: (slug: string, creative: string, n: number, format: string, locale: string) =>
    request<LocalizedCompositionView>('GET', `${c(slug, creative)}/versions/${n}/compositions/${encodeURIComponent(format)}?locale=${encodeURIComponent(locale)}`),
  /** Lets live preview session `token` serve the translation's fallback fonts and voices (hash-checked by the core). */
  attachLocalePreview: (slug: string, creative: string, n: number, locale: string, instanceId: string, token: string) =>
    request<{ files: string[] }>('POST', `${c(slug, creative)}/versions/${n}/localizations/${encodeURIComponent(locale)}/${encodeURIComponent(instanceId)}/preview-assets`, { token }),
  /**
   * A live preview session of one format of a saved v2 version, embeddable by `parentOrigin` (this page's origin). 404 for
   * a legacy version (no composition), 429 `preview-busy` when the previews are busy.
   */
  /** `renewFrom`: the session this one renews (the editor's staged files move to the new one, Phase 10b). */
  previewSession: (slug: string, creative: string, n: number, format: string, parentOrigin: string, renewFrom?: string) =>
    request<PreviewSessionInfo>('POST', `${c(slug, creative)}/versions/${n}/preview-session`, { format, parentOrigin, ...(renewFrom ? { renewFrom } : {}) }),
  /** The editor's view of one format of a saved v2 version (Phase 10b): the primary's composition, its files and the fonts offered. */
  getEditorComposition: (slug: string, creative: string, n: number, format: string) =>
    request<EditorCompositionView>('GET', `${c(slug, creative)}/versions/${n}/compositions/${encodeURIComponent(format)}`),
  /** Stages a library asset or a brand font for the draft of preview session `token`; a large video answers once it is normalised. */
  stageEditorAsset: (slug: string, creative: string, body: StageRequest) => request<StagedAsset>('POST', `${c(slug, creative)}/editor/stage`, body),
  /**
   * SVG inner editor: the text of the SVG `path` a draft clip shows in the preview session `token`, only when the core's SVG
   * check accepts it (400 `svg-edit-refused` with the reasons as `problems`, 400 `svg-edit-bad-base`).
   */
  getEditorSvg: (slug: string, creative: string, token: string, path: string) =>
    request<{ path: string; content: string; warnings: string[] }>('GET', `${c(slug, creative)}/editor/svg?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`),
  /** SVG inner editor: stages an edited SVG (checked by the core: 400 `svg-edit-refused` with `problems`). */
  stageSvgEdit: (slug: string, creative: string, body: { token: string; from: SvgEditFrom }) => request<StagedSvgEdit>('POST', `${c(slug, creative)}/editor/stage`, body),
  /** Saves a draft as a new version, with no agent. 409 `editor-busy` / `editor-base-changed` / `editor-carry-failed`, 422 with `problems`. */
  saveEdits: (slug: string, creative: string, body: SaveEditsBody) => request<{ version: number }>('POST', `${c(slug, creative)}/edits`, body),
  /** Ends a live preview session early (a hover preview no longer shown); sent with keepalive so it survives a page close. */
  revokePreview: (slug: string, creative: string, n: number, token: string) =>
    request<{ revoked: true }>('DELETE', `${c(slug, creative)}/versions/${n}/preview-session/${encodeURIComponent(token)}`, undefined, { keepalive: true }),
  /** The storyboard of a v2 version's format: scene frames and the poster, signed URLs valid until `expiresAt`. */
  getStoryboard: (slug: string, creative: string, n: number, format: string) =>
    request<StoryboardView>('GET', `${c(slug, creative)}/versions/${n}/storyboards/${encodeURIComponent(format)}`),
  /** The feedback frames cut for the comments sent with the turn that made version n (signed URLs). */
  getPinFrames: (slug: string, creative: string, n: number) => request<PinFramesView>('GET', `${c(slug, creative)}/pin-frames/${n}`),
  /** Which Chromium renders (System check) and the Chrome for Testing download's state. */
  getRenderEngine: () => request<RenderEngineStatus>('GET', '/api/render-engine'),
  /** The Chrome for Testing version and exact size, read before asking for consent (nothing is downloaded). */
  getChromeDownloadInfo: () => request<ChromeDownloadOffer>('GET', '/api/render-engine/download-info'),
  /** Starts the download the user agreed to: `sizeBytes` is the size shown to them. */
  downloadChrome: (sizeBytes: number) => request<RenderEngineStatus>('POST', '/api/render-engine/download', { consent: true, sizeBytes }),
  /** Decision 1468: every video of the library with its analysis (state, held question, sidecar). */
  listVideoAnalyses: (slug: string) => request<VideoAnalysisView[]>('GET', `${p(slug)}/video-analyses`),
  videoAnalysis: (slug: string, file: string) => request<VideoAnalysisView>('GET', `${p(slug)}/video-analyses/view?file=${encodeURIComponent(file)}`),
  /** Analizza / Rianalizza: an edited sidecar answers 409 `analysis-edited` unless `overwrite` (decision 1480). */
  analyzeVideo: (slug: string, file: string, overwrite?: boolean) =>
    request<VideoAnalysisView>('POST', `${p(slug)}/video-analyses`, overwrite ? { file, overwrite: true } : { file }),
  /** A video over 20 minutes: "Analizza tutto" (`full`) or "Analizza a densità ridotta" (`reduced`). */
  confirmLongVideo: (slug: string, file: string, density: 'full' | 'reduced') => request<VideoAnalysisView>('POST', `${p(slug)}/video-analyses/confirm-long`, { file, density }),
  /** Modifica: the body only (the header stays the core's); the sidecar is marked edited. */
  saveAnalysisBody: (slug: string, file: string, body: string) => request<VideoAnalysisView>('PUT', `${p(slug)}/video-analyses/body`, { file, body }),
  cancelVideoAnalysis: (slug: string, file: string) => request<{ cancelled: boolean }>('DELETE', `${p(slug)}/video-analyses?file=${encodeURIComponent(file)}`),
  /** The answer to the transcription dialog (spec §6); 409 with a code when it cannot be honoured. */
  transcriptionChoice: (slug: string, body: TranscriptionChoice) => request<VideoAnalysisView>('POST', `${p(slug)}/video-analyses/transcription-choice`, body),
  /** "Ricontrolla": the Whispers looked for again, the held question asked with the new offer (decision 1591). */
  recheckTranscription: (slug: string, file: string) => request<VideoAnalysisView>('POST', `${p(slug)}/video-analyses/transcription-recheck`, { file }),
  /** Decision 1478: the videos a creative's first turn is waiting for (empty: no wait), and Salta. */
  analysisWait: (slug: string, creative: string) => request<{ files: string[] }>('GET', `${c(slug, creative)}/analysis-wait`),
  skipAnalysisWait: (slug: string, creative: string) => request<void>('POST', `${c(slug, creative)}/analysis-wait/skip`),
  /** Settings → Trascrizione video. */
  getTranscription: () => request<TranscriptionStatus>('GET', '/api/transcription'),
  /** A partial change; a program is test-run first (400 `whisper-probe-failed`). */
  saveTranscription: (patch: TranscriptionSettingsPatch) => request<TranscriptionStatus>('PUT', '/api/transcription', patch),
  /** "Cerca di nuovo": runs the detection of installed Whispers again and answers the whole status. */
  detectWhisper: () => request<TranscriptionStatus>('POST', '/api/transcription/detect'),
  probeWhisper: (body: { program: string; engine?: WhisperEngine; modelFile?: string }) => request<WhisperFound | { problem: string }>('POST', '/api/transcription/probe', body),
  /** Starts a model's download the user agreed to: `sizeBytes` is the size shown to them (409 `download-size-changed`). */
  downloadWhisperModel: (id: TranscriptionModelId, sizeBytes: number) =>
    request<TranscriptionStatus['download']>('POST', `/api/transcription/models/${id}/download`, { consent: true, sizeBytes }),
  removeWhisperModel: (id: TranscriptionModelId) => request<void>('DELETE', `/api/transcription/models/${id}`),
  /** A creative's subtitles (decisions 1636-1640): its sets, the running job and the question it holds on. */
  subtitles: (slug: string, creative: string) => request<{ sets: SubtitlesSummary[] } & SubtitlesJobState>('GET', subs(slug, creative)),
  /** Fai i sottotitoli: `retime` keeps the edited cues' text on new timings; `lang` the set (absent: the spoken language). */
  startSubtitles: (slug: string, creative: string, body: { mode?: 'new' | 'retime'; lang?: LocaleTag } = {}) => request<{ job: JobSummary }>('POST', subs(slug, creative), body),
  /** The answer to the subtitles job's transcription question (409 `transcription-not-asked` when it asks nothing). */
  subtitlesChoice: (slug: string, creative: string, choice: Omit<TranscriptionChoice, 'file'>) => request<SubtitlesJobState>('POST', `${subs(slug, creative)}/transcription-choice`, choice),
  /** "Ricontrolla" in the subtitles job's transcription question: the Whispers looked for again, the question as it is now. */
  subtitlesRecheck: (slug: string, creative: string) => request<SubtitlesJobState>('POST', `${subs(slug, creative)}/transcription-recheck`),
  /** The subtitle timeline's waveform (Task 13): the main format's audio mix of version `n` as peaks over its duration. */
  subtitleWaveform: (slug: string, creative: string, n: number) => request<{ peaks: number[]; durationMs: number }>('GET', `${subs(slug, creative)}/waveform?version=${n}`),
  subtitleSet: (slug: string, creative: string, lang: LocaleTag) => request<{ set: SubtitleSet; hash: string }>('GET', `${subs(slug, creative)}/${encodeURIComponent(lang)}`),
  /**
   * The editor's save (decision 1654): the whole cue list over the set whose hash is `baseHash`; 409 `subtitles-conflict`
   * when the set changed since. `keepalive` when the page is closing.
   */
  saveSubtitleSet: (slug: string, creative: string, lang: LocaleTag, body: { baseHash: string; cues: SubtitleCue[] }, opts?: RequestOptions) =>
    request<{ hash: string }>('PUT', `${subs(slug, creative)}/${encodeURIComponent(lang)}`, body, opts),
  /**
   * "Tempi controllati" (final review, M3): the set's timing marked as checked on the latest version's audio, the cues
   * untouched; 409 `subtitles-conflict` when the set changed since `baseHash`.
   */
  subtitleTimingChecked: (slug: string, creative: string, lang: LocaleTag, body: { baseHash: string }) =>
    request<{ hash: string; timing: SubtitleSet['timing'] }>('POST', `${subs(slug, creative)}/${encodeURIComponent(lang)}/timing-checked`, body),
  /** A subtitle set's `.srt` / `.vtt`, fetched with the UI token (the caller saves it). */
  subtitleFile: (slug: string, creative: string, lang: LocaleTag, ext: 'srt' | 'vtt') => fetchBlob(subtitleFileUrl(slug, creative, lang, ext)),
  fileUrl: (slug: string, creative: string, rel: string) => `${c(slug, creative)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`,
  /** The size of a creative's file (a HEAD of its files URL: the record of a render has no size); null when unknown. */
  fileBytes: async (url: string): Promise<number | null> => {
    const res = await fetch(url, { method: 'HEAD' }).catch(() => null);
    const raw = res?.ok ? res.headers.get('content-length') : null;
    const n = raw === null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  },
};
