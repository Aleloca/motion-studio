import type { ApprovalDecision, ApprovalRequest, LanguageSetting, Locale, AssetEntry, BrandKit, BrandOverview, BrandProposal, BrandSource, Brief, LinkedCodebase, ReferenceEntry, ConversationEntry, CreativeDetail, CreativeFile, CreativeListItem, RecentCreative, DoctorCheck, FormatPreset, JobSummary, Pin, ProjectDetail, ProjectFile, PermissionsFile, ProjectListItem, SecretStatus, ProviderId, UsageReport, WorkspaceInfo, WorkspaceSettings } from '@motion-studio/shared';
import { currentMessages } from './i18n.tsx';
import { markPairingNeeded, uiToken } from './uiToken.ts';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

/** Headers of every API call: the UI token (the server refuses calls without it). */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = uiToken();
  return token ? { ...extra, 'x-motion-studio-ui': token } : extra;
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && (data as { code?: string }).code === 'ui-token') markPairingNeeded();
    throw new ApiError(res.status, (data as { error?: string }).error ?? currentMessages().web.api.httpError({ status: res.status }));
  }
  return data as T;
}

/** Per-call fetch options. `keepalive` lets a delete sent while the page closes reach the server. */
export interface RequestOptions { keepalive?: boolean }

async function request<T>(method: string, url: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(opts.keepalive ? { keepalive: true } : {}),
  });
  return parse<T>(res);
}

export interface CodebaseCheck { path: string; note?: string; exists: boolean }
const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');

async function upload<T>(url: string, files: File[]): Promise<T> {
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  const res = await fetch(url, { method: 'POST', body: form, headers: headers() });
  return parse<T>(res);
}

export interface CatalogState { presets: FormatPreset[]; error: string | null; path: string }
const p = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;
const c = (slug: string, creative: string) => `${p(slug)}/creatives/${encodeURIComponent(creative)}`;

export const api = {
  getDoctor: () => request<DoctorCheck[]>('GET', '/api/doctor'),
  /** Token and cost usage from the projects' ledgers; defaults to the last 7 local days of the core. */
  getUsage: (q: { from?: string; to?: string; project?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')).toString();
    return request<UsageReport>('GET', `/api/usage${qs ? `?${qs}` : ''}`);
  },
  /** Shown tokens of each creative's first generation in the last `days` days (New creative estimate). */
  getFirstGenerations: (days = 90) => request<{ tokens: number[] }>('GET', `/api/usage/first-generations?days=${days}`),
  getWorkspace: () => request<WorkspaceInfo>('GET', '/api/workspace'),
  setWorkspace: (path: string) => request<{ path: string; settings: WorkspaceSettings }>('PUT', '/api/workspace', { path }),
  updateSettings: (patch: Partial<WorkspaceSettings>) => request<WorkspaceSettings>('PUT', '/api/settings', patch),
  setLanguage: (language: LanguageSetting) => request<{ locale: Locale; languageSetting: LanguageSetting; systemLocale: Locale }>('PUT', '/api/settings/language', { language }),
  getSecrets: () => request<SecretStatus[]>('GET', '/api/secrets'),
  setSecret: (provider: ProviderId, value: string) => request<SecretStatus>('PUT', `/api/secrets/${provider}`, { value }),
  deleteSecret: (provider: ProviderId) => request<SecretStatus>('DELETE', `/api/secrets/${provider}`),
  getApprovals: () => request<ApprovalRequest[]>('GET', '/api/approvals'),
  decideApproval: (id: string, decision: ApprovalDecision) => request<unknown>('POST', `/api/approvals/${encodeURIComponent(id)}`, { decision }),
  getPermissions: (slug: string) => request<PermissionsFile['allow']>('GET', `${p(slug)}/permissions`),
  deletePermission: (slug: string, rule: string) => request<{ ok: true }>('DELETE', `${p(slug)}/permissions`, { rule }),
  listProjects: () => request<ProjectListItem[]>('GET', '/api/projects'),
  createProject: (name: string, description?: string) =>
    request<{ slug: string; project: ProjectFile }>('POST', '/api/projects', { name, description }),
  getProject: (slug: string) => request<ProjectDetail>('GET', `/api/projects/${encodeURIComponent(slug)}`),
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
  updateAsset: (slug: string, file: string, patch: { description?: string; tags?: string[] }) => request<AssetEntry>('PATCH', `${p(slug)}/assets/item/${enc(file)}`, patch),
  deleteAsset: (slug: string, file: string, opts?: RequestOptions) => request<{ ok: true }>('DELETE', `${p(slug)}/assets/item/${enc(file)}`, undefined, opts),
  listReferences: (slug: string) => request<{ references: ReferenceEntry[]; error: string | null }>('GET', `${p(slug)}/references`),
  updateReference: (slug: string, file: string, patch: { note?: string; useForBrand?: boolean }) => request<ReferenceEntry>('PATCH', `${p(slug)}/references/item/${enc(file)}`, patch),
  deleteReference: (slug: string, file: string, opts?: RequestOptions) => request<{ ok: true }>('DELETE', `${p(slug)}/references/item/${enc(file)}`, undefined, opts),
  projectFileUrl: (slug: string, rel: string) => `${p(slug)}/files/${enc(rel)}`,
  cancelJob: (id: string) => request<{ cancelled: boolean }>('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
  getFormats: () => request<CatalogState>('GET', '/api/formats'),
  recentCreatives: (limit?: number) => request<RecentCreative[]>('GET', `/api/recent-creatives${limit === undefined ? '' : `?limit=${limit}`}`),
  listCreatives: (slug: string) => request<CreativeListItem[]>('GET', `${p(slug)}/creatives`),
  createCreative: (slug: string, body: { title: string; brief: Brief; generate: boolean; linkedCodebases?: LinkedCodebase[] }) =>
    request<{ slug: string; creative: CreativeFile; job: JobSummary | null }>('POST', `${p(slug)}/creatives`, body),
  getCreative: (slug: string, creative: string) => request<CreativeDetail>('GET', c(slug, creative)),
  updateCreative: (slug: string, creative: string, body: { title?: string; brief?: Brief; linkedCodebases?: LinkedCodebase[] }) => request<CreativeFile>('PUT', c(slug, creative), body),
  getConversation: (slug: string, creative: string) => request<ConversationEntry[]>('GET', `${c(slug, creative)}/conversation`),
  sendCreativeTurn: (slug: string, creative: string, body: { text?: string; pins?: Pin[] }) => request<JobSummary>('POST', `${c(slug, creative)}/turns`, body),
  restoreVersion: (slug: string, creative: string, n: number) => request<CreativeFile>('POST', `${c(slug, creative)}/versions/${n}/restore`),
  revealVersion: (slug: string, creative: string, n: number) => request<{ ok: true }>('POST', `${c(slug, creative)}/versions/${n}/reveal`),
  exportVersion: (slug: string, creative: string, n: number, destination: string, formats?: string[]) =>
    request<{ destination: string; files: Array<{ from: string; to: string }>; skipped: string[] }>('POST', `${c(slug, creative)}/versions/${n}/export`, { destination, ...(formats ? { formats } : {}) }),
  fileUrl: (slug: string, creative: string, rel: string) => `${c(slug, creative)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`,
};
