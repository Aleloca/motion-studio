import type { LocaleTag, Localization, LocalizationIssue, LocalizationRow, BrandFont, EditOp, EditorCompositionView, StagedAsset, StageRequest, ChromeDownloadOffer, OutputIssue, ExportPrepareResult, PinFramesView, PreviewSessionInfo, RenderEngineStatus, StoryboardView, ApprovalDecision, ApprovalRequest, ProposalActivity, LanguageSetting, Locale, AssetEntry, BrandKit, BrandOverview, BrandProposal, BrandSource, Brief, LinkedCodebase, ReferenceEntry, ConversationEntry, CreativeDetail, CreativeFile, CreativeListItem, RecentCreative, DoctorCheck, FormatPreset, JobSummary, Pin, ProjectDetail, ProjectFile, ProjectIntegrity, PermissionsFile, ProjectListItem, SecretStatus, KeyCheckResult, ProviderId, UsageReport, VersionEntry, WorkspaceInfo, WorkspaceSettings, StorePack } from '@motion-studio/shared';
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
/** What a pack export did (Phase 12 §4.3): paths relative to the pack folder; `rendered` lists what was rendered first. */
export interface StorePackExportResult { folder: string; written: string[]; failed: Array<{ file: string; reason: string }>; rendered?: Array<{ version: number; formats: string[]; locale?: string }> }
/** "Render anyway" and the languages of a render or an export (Phase 12 §3.5). */
export interface LocaleOptions { locales?: string[]; force?: boolean }

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

export const api = {
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
  getPermissions: (slug: string) => request<PermissionsFile['allow']>('GET', `${p(slug)}/permissions`),
  deletePermission: (slug: string, rule: string) => request<{ ok: true }>('DELETE', `${p(slug)}/permissions`, { rule }),
  listProjects: () => request<ProjectListItem[]>('GET', '/api/projects'),
  createProject: (name: string, description?: string) =>
    request<{ slug: string; project: ProjectFile }>('POST', '/api/projects', { name, description }),
  getProject: (slug: string) => request<ProjectDetail>('GET', `/api/projects/${encodeURIComponent(slug)}`),
  getIntegrity: (slug: string) => request<ProjectIntegrity>('GET', `${p(slug)}/integrity`),
  acceptIntegrity: (slug: string, token: string) => request<ProjectIntegrity>('POST', `${p(slug)}/integrity/accept`, { token }),
  updateProject: (slug: string, body: { name?: string; description?: string; linkedCodebases?: LinkedCodebase[] }) => request<ProjectDetail>('PUT', p(slug), body),
  getCodebases: (slug: string) => request<CodebaseCheck[]>('GET', `${p(slug)}/codebases`),
  getBrand: (slug: string) => request<BrandOverview>('GET', `${p(slug)}/brand`),
  saveBrandKit: (slug: string, kit: BrandKit) => request<BrandKit>('PUT', `${p(slug)}/brand/kit`, { kit }),
  saveGuidelines: (slug: string, text: string) => request<{ ok: true }>('PUT', `${p(slug)}/brand/guidelines`, { text }),
  addBrandSource: (slug: string, body: { kind: 'website'; url: string } | { kind: 'image'; file: string }) => request<BrandSource>('POST', `${p(slug)}/brand/sources`, body),
  removeBrandSource: (slug: string, id: string, opts?: RequestOptions) => request<{ ok: true }>('DELETE', `${p(slug)}/brand/sources/${encodeURIComponent(id)}`, undefined, opts),
  analyzeBrand: (slug: string, sourceIds?: string[]) => request<JobSummary>('POST', `${p(slug)}/brand/analyze`, { sourceIds }),
  applyProposal: (slug: string, id: string, acceptedIds: string[], applyGuidelines: boolean) =>
    request<{ kit: BrandKit; proposal: BrandProposal }>('POST', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/apply`, { acceptedIds, applyGuidelines }),
  discardProposal: (slug: string, id: string) => request<BrandProposal>('POST', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/discard`),
  listAssets: (slug: string) => request<{ assets: AssetEntry[]; error: string | null; unregistered: string[] }>('GET', `${p(slug)}/assets`),
  uploadFiles: (slug: string, kind: 'assets' | 'references', files: File[]) => upload<unknown>(`${p(slug)}/${kind}`, files),
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
  getFormats: () => request<CatalogState>('GET', '/api/formats'),
  recentCreatives: (limit?: number) => request<RecentCreative[]>('GET', `/api/recent-creatives${limit === undefined ? '' : `?limit=${limit}`}`),
  listCreatives: (slug: string) => request<CreativeListItem[]>('GET', `${p(slug)}/creatives`),
  createCreative: (slug: string, body: { title: string; brief: Brief; generate: boolean; linkedCodebases?: LinkedCodebase[] }) =>
    request<{ slug: string; creative: CreativeFile; job: JobSummary | null }>('POST', `${p(slug)}/creatives`, body),
  /** Creates an App store pack creative (Phase 12 §4.1): the core builds the brief from the choices and checks every app screen. */
  createStorePack: (slug: string, body: { title: string; storePack: StorePack; generate?: boolean }) =>
    request<{ slug: string; creative: CreativeFile; job: JobSummary | null }>('POST', `${p(slug)}/creatives/store-pack`, body),
  /** Exports the pack of version n (§4.3): written and failed files are relative to the pack folder. */
  exportStorePack: (slug: string, creative: string, n: number, body: { destination: string; locales?: string[] }) =>
    request<StorePackExportResult>('POST', `${c(slug, creative)}/versions/${n}/store-pack/export`, body),
  getCreative: (slug: string, creative: string) => request<CreativeDetail>('GET', c(slug, creative)),
  updateCreative: (slug: string, creative: string, body: {
    title?: string; brief?: Brief; services?: Brief['services']; linkedCodebases?: LinkedCodebase[];
    /** Alone, each merges into the stored brief under the creative's lock: labels per key (`''` or null clears one), order and removal of formats. */
    formatLabels?: Record<string, string | null>; formats?: string[];
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
  sendCreativeTurn: (slug: string, creative: string, body: { text?: string; pins?: Pin[]; formats?: string[] }) => request<JobSummary>('POST', `${c(slug, creative)}/turns`, body),
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
   * What a ★ export renders first (Task 8): the same picks and followers as `exportPicks`; the jobs are started (or joined)
   * at once and the export, called next, waits for them.
   */
  prepareExport: (slug: string, creative: string, body: { picks: Record<string, number>; follow?: Record<string, number> } & LocaleOptions) =>
    request<ExportPrepareResult>('POST', `${c(slug, creative)}/export/prepare`, body),
  /** Renders a v2 version's compositions (all its primaries, or `formats`; a follower stands for its primary). 202 with the job. */
  renderVersion: (slug: string, creative: string, n: number, formats?: string[], opts: LocaleOptions = {}) =>
    request<JobSummary>('POST', `${c(slug, creative)}/versions/${n}/render`, { ...(formats ? { formats } : {}), ...(opts.locales?.length ? { locales: opts.locales } : {}), ...(opts.force ? { force: true } : {}) }),
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
  fileUrl: (slug: string, creative: string, rel: string) => `${c(slug, creative)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`,
};
