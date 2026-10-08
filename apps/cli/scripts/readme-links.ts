const BLOB = 'https://github.com/Aleloca/motion-studio/blob/main/';

/** Relative Markdown link targets (`CONTRIBUTING.md`, `docs/…`, `./LICENSE`) made absolute: on npm they would point nowhere. */
export function absoluteLinks(md: string): string {
  return md.replace(/\]\(([^)\s]+)\)/g, (link, target: string) =>
    /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target) ? link : `](${BLOB}${target.replace(/^\.\//, '')})`);
}
