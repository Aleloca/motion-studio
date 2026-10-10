/** A character that continues a file name or a format id: a word character, `.` or `-`. */
const isNameChar = (c: string | undefined) => c !== undefined && /^[\w.-]$/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /^\w$/.test(c);

/**
 * Whether `text` names `name` as a whole token: the occurrence is not preceded by a name character (`[\w.-]`) and not
 * followed by one, except a `.` that ends a sentence (followed by the end or a non-word character). So `reel` does not match
 * inside `reel-x.mp4`, `x-reel` or `reel.mp4`, while `reel.mp4.` (a sentence) still matches `reel.mp4`. Linear in the
 * length of `text` for each occurrence check (an `indexOf` scan, no regex over the text).
 */
export function mentionsName(text: string, name: string): boolean {
  if (name === '') return false;
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    const before = text[i - 1];
    const end = i + name.length;
    const after = text[end];
    if (isNameChar(before)) continue;
    if (after === '.' ? isWordChar(text[end + 1]) : isNameChar(after)) continue;
    return true;
  }
  return false;
}

/**
 * The problems of an old version (no per-file problems) that belong to format `id`, whose file there is `file` and whose
 * label is `label`: the ones naming the file, the label or the id as whole tokens (`mentionsName`). The bare id is dropped
 * when the file name covers it (`<id>.<ext>`): every problem that names a format's file by its id names the file.
 * Labels contain spaces, so a label that starts another label's text ("Story 9:16" / "Story 9:16 Long") can still
 * over-match: the safe direction (a spurious inherited problem, never a lost one).
 */
export function legacyProblemsOf(problems: string[], id: string, file: string, label: string): string[] {
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const names = stem === id ? [file, label] : [file, id, label];
  return problems.filter((p) => names.some((n) => mentionsName(p, n)));
}
