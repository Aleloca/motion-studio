import type { DoctorCheck, JobSummary, ProjectFile, ProjectListItem, WorkspaceSettings } from '@motion-studio/shared';

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

export const api = {
  getDoctor: () => request<DoctorCheck[]>('GET', '/api/doctor'),
  getWorkspace: () => request<{ path: string | null; settings: WorkspaceSettings | null }>('GET', '/api/workspace'),
  setWorkspace: (path: string) => request<{ path: string; settings: WorkspaceSettings }>('PUT', '/api/workspace', { path }),
  updateSettings: (patch: Partial<WorkspaceSettings>) => request<WorkspaceSettings>('PUT', '/api/settings', patch),
  listProjects: () => request<ProjectListItem[]>('GET', '/api/projects'),
  createProject: (name: string, description?: string) =>
    request<{ slug: string; project: ProjectFile }>('POST', '/api/projects', { name, description }),
  getProject: (slug: string) => request<{ slug: string; project: ProjectFile }>('GET', `/api/projects/${encodeURIComponent(slug)}`),
  startTurn: (slug: string, prompt: string, resumeSessionId?: string) =>
    request<JobSummary>('POST', `/api/projects/${encodeURIComponent(slug)}/turns`, { prompt, resumeSessionId }),
  cancelJob: (id: string) => request<{ cancelled: boolean }>('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
};
