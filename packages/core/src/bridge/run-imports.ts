/**
 * Brand analysis: the files each run's own tools (download_file, import_codebase_file) registered, by job id. Cleanup after
 * a discarded run touches only these, never a file another job (a creative turn, the console) registered meanwhile.
 */
const byJob = new Map<string, Set<string>>();

/** `file` is relative to assets/. */
export function recordRunImport(jobId: string, file: string): void {
  let set = byJob.get(jobId);
  if (!set) byJob.set(jobId, (set = new Set()));
  set.add(file);
}
export const runImportsOf = (jobId: string): string[] => [...(byJob.get(jobId) ?? [])];
export const forgetRunImports = (jobId: string): void => { byJob.delete(jobId); };
