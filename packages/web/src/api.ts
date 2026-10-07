import type { AssetEntry, BrandKit, BrandOverview, BrandProposal, BrandSource, Brief, LinkedCodebase, ReferenceEntry, ConversationEntry, CreativeDetail, CreativeFile, CreativeListItem, DoctorCheck, FormatPreset, JobSummary, Pin, ProjectDetail, ProjectFile, ProjectListItem, WorkspaceInfo, WorkspaceSettings } from '@motion-studio/shared';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Errore ${res.status}`);
  return data as T;
}

export interface CodebaseCheck { path: string; note?: string; exists: boolean }
const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');

async function upload<T>(url: string, files: File[]): Promise<T> {
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  const res = await fetch(url, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Errore ${res.status}`);
  return data as T;
}

export interface CatalogState { presets: FormatPreset[]; error: string | null; path: string }
const p = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;
const c = (slug: string, creative: string) => `${p(slug)}/creatives/${encodeURIComponent(creative)}`;

export const api = {
  getDoctor: () => request<DoctorCheck[]>('GET', '/api/doctor'),
  getWorkspace: () => request<WorkspaceInfo>('GET', '/api/workspace'),
  setWorkspace: (path: string) => request<{ path: string; settings: WorkspaceSettings }>('PUT', '/api/workspace', { path }),
  updateSettings: (patch: Partial<WorkspaceSettings>) => request<WorkspaceSettings>('PUT', '/api/settings', patch),
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
  removeBrandSource: (slug: string, id: string) => request<{ ok: true }>('DELETE', `${p(slug)}/brand/sources/${encodeURIComponent(id)}`),
  analyzeBrand: (slug: string, sourceIds?: string[]) => request<JobSummary>('POST', `${p(slug)}/brand/analyze`, { sourceIds }),
  applyProposal: (slug: string, id: string, acceptedIds: string[], applyGuidelines: boolean) =>
    request<{ kit: BrandKit; proposal: BrandProposal }>('POST', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/apply`, { acceptedIds, applyGuidelines }),
  discardProposal: (slug: string, id: string) => request<BrandProposal>('POST', `${p(slug)}/brand/proposals/${encodeURIComponent(id)}/discard`),
  listAssets: (slug: string) => request<{ assets: AssetEntry[]; error: string | null; unregistered: string[] }>('GET', `${p(slug)}/assets`),
  uploadFiles: (slug: string, kind: 'assets' | 'references', files: File[]) => upload<unknown>(`${p(slug)}/${kind}`, files),
  registerAssets: (slug: string, files: string[]) => request<{ assets: AssetEntry[] }>('POST', `${p(slug)}/assets/register`, { files }),
  describeAssets: (slug: string, files?: string[]) => request<JobSummary>('POST', `${p(slug)}/assets/describe`, { files }),
  updateAsset: (slug: string, file: string, patch: { description?: string; tags?: string[] }) => request<AssetEntry>('PATCH', `${p(slug)}/assets/item/${enc(file)}`, patch),
  deleteAsset: (slug: string, file: string) => request<{ ok: true }>('DELETE', `${p(slug)}/assets/item/${enc(file)}`),
  listReferences: (slug: string) => request<{ references: ReferenceEntry[]; error: string | null }>('GET', `${p(slug)}/references`),
  updateReference: (slug: string, file: string, patch: { note?: string; useForBrand?: boolean }) => request<ReferenceEntry>('PATCH', `${p(slug)}/references/item/${enc(file)}`, patch),
  deleteReference: (slug: string, file: string) => request<{ ok: true }>('DELETE', `${p(slug)}/references/item/${enc(file)}`),
  projectFileUrl: (slug: string, rel: string) => `${p(slug)}/files/${enc(rel)}`,
  startTurn: (slug: string, prompt: string, resumeSessionId?: string) =>
    request<JobSummary>('POST', `/api/projects/${encodeURIComponent(slug)}/turns`, { prompt, resumeSessionId }),
  cancelJob: (id: string) => request<{ cancelled: boolean }>('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
  getFormats: () => request<CatalogState>('GET', '/api/formats'),
  listCreatives: (slug: string) => request<CreativeListItem[]>('GET', `${p(slug)}/creatives`),
  createCreative: (slug: string, body: { title: string; brief: Brief; generate: boolean; linkedCodebases?: LinkedCodebase[] }) =>
    request<{ slug: string; creative: CreativeFile; job: JobSummary | null }>('POST', `${p(slug)}/creatives`, body),
  getCreative: (slug: string, creative: string) => request<CreativeDetail>('GET', c(slug, creative)),
  updateCreative: (slug: string, creative: string, body: { title?: string; brief?: Brief; linkedCodebases?: LinkedCodebase[] }) => request<CreativeFile>('PUT', c(slug, creative), body),
  getConversation: (slug: string, creative: string) => request<ConversationEntry[]>('GET', `${c(slug, creative)}/conversation`),
  sendCreativeTurn: (slug: string, creative: string, body: { text?: string; pins?: Pin[] }) => request<JobSummary>('POST', `${c(slug, creative)}/turns`, body),
  restoreVersion: (slug: string, creative: string, n: number) => request<CreativeFile>('POST', `${c(slug, creative)}/versions/${n}/restore`),
  revealVersion: (slug: string, creative: string, n: number) => request<{ ok: true }>('POST', `${c(slug, creative)}/versions/${n}/reveal`),
  fileUrl: (slug: string, creative: string, rel: string) => `${c(slug, creative)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`,
};
