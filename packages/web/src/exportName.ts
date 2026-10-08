// File names of an export, shown in the Export dialog before the copy. This mirrors the core's naming so the names
// on screen are the ones written to disk: keep it in sync with `slugify` (packages/core/src/workspace-store.ts) and
// `titleBase` / `safeSegment` / the extension rule of `exportVersion` (packages/core/src/creatives/export.ts).
// When the destination already holds a name, the core adds `-2`, `-3`… (never overwrites): that suffix is not known here.

function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'project';
}

/** A file-name segment: only [A-Za-z0-9._-], no leading dots. */
const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || '_';

/** File-name base from the creative title: slug cut to 40 characters, null when the title has no usable characters. */
function titleBase(title: string): string | null {
  if (!/[a-z0-9]/.test(title.normalize('NFKD').toLowerCase())) return null;
  const s = slugify(title).slice(0, 40).replace(/-+$/, '');
  return s || null;
}

/** `<slugify(title)≤40>-<format>-v<n>.<ext>`; the creative slug stands in for a title without letters or digits. */
export function exportFileName(o: { title: string; creative: string; format: string; n: number; file: string }): string {
  const base = safeSegment(titleBase(o.title) ?? o.creative);
  const dot = o.file.lastIndexOf('.');
  // extname(): a leading dot alone is not an extension.
  const rawExt = dot > 0 ? o.file.slice(dot + 1).toLowerCase() : '';
  const ext = rawExt ? `.${rawExt.replace(/[^a-z0-9]/g, '_')}` : '';
  return `${base}-${safeSegment(o.format)}-v${o.n}${ext}`;
}
