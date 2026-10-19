import { join } from 'node:path';
import { assetsFileSchema, projectIconCandidates, brandKitSchema, EMPTY_BRAND_KIT, type AssetEntry, type BrandKit, type ProjectFile, type ProjectIcon } from '@motion-studio/shared';
import { probeConfinedFile } from './brand/agent-guard.ts';
import { t } from './i18n.ts';
import { readJsonFile } from './json-file.ts';
import { CodedError } from './workspace-store.ts';

/**
 * Report 44: the project's icon as the UI shows it: a path relative to the project, served by the project's files route
 * (`assets/` only, confined), or null for the initials. A chosen image is used while its file is there; without a choice
 * the brand and the library pick the first usable candidate (`projectIconCandidates`). A missing, unreadable or unconfined file gives the initials.
 */
export async function resolveProjectIcon(projectDir: string, project: Pick<ProjectFile, 'icon'>): Promise<string | null> {
  try {
    if (project.icon === 'initials') return null;
    const candidates = project.icon ? [`assets/${project.icon.asset}`] : projectIconCandidates(await readKit(projectDir), await readAssets(projectDir));
    // The first usable one (review 4): under assets/, there, and a real file inside the project (no link).
    for (const rel of candidates) if (rel.startsWith('assets/') && (await probeConfinedFile(projectDir, rel)) === true) return rel;
    return null;
  } catch {
    return null;
  }
}

/** A chosen icon must be an image (or SVG) of the library whose file is there (400 `project-icon` otherwise). */
export async function checkProjectIcon(projectDir: string, icon: ProjectIcon): Promise<void> {
  if (icon === 'initials') return;
  const a = (await readAssets(projectDir).catch(() => [])).find((x) => x.file === icon.asset);
  if (!a || (a.kind !== 'image' && a.kind !== 'svg') || (await probeConfinedFile(projectDir, `assets/${a.file}`)) !== true) {
    throw new CodedError(400, t().errors.projectIconInvalid, 'project-icon');
  }
}

async function readKit(projectDir: string): Promise<BrandKit> {
  return readJsonFile(join(projectDir, 'brand', 'brand-kit.json'), brandKitSchema).catch(() => EMPTY_BRAND_KIT);
}
async function readAssets(projectDir: string): Promise<AssetEntry[]> {
  return (await readJsonFile(join(projectDir, 'assets', 'assets.json'), assetsFileSchema).catch(() => ({ assets: [] as AssetEntry[] }))).assets;
}
