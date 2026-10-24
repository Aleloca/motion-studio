// Builds the static site into site/_site: page sources, the compositions, the runtime files and one runtime page per
// composition. Needs the runtime built first: pnpm --filter @motion-studio/composition-runtime build.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCompositions, runtimePageFor, sharedFonts, validateAll } from './lib/compositions.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME_DIST = join(HERE, '..', 'packages', 'composition-runtime', 'dist');
const RUNTIME_FILES = ['runtime.js', 'preview.js', 'layer.js'];

const skipJunk = (src) => basename(src) !== '.DS_Store';

export async function build({ root = HERE, out = join(HERE, '_site') } = {}) {
  const items = await loadCompositions(join(root, 'compositions'));
  const fontsDir = join(root, 'src', 'assets', 'fonts');
  const failed = (await validateAll(items, { fontsDir })).filter((r) => r.problems.length > 0);
  if (failed.length > 0) {
    const lines = failed.map((r) => `${r.id}: ${r.problems.map((p) => `${p.key} ${JSON.stringify(p.params ?? {})}`).join('; ')}`);
    throw new Error(`invalid compositions:\n${lines.join('\n')}`);
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'runtime'), { recursive: true });
  await cp(join(root, 'src'), out, { recursive: true, filter: skipJunk });
  for (const f of RUNTIME_FILES) await cp(join(RUNTIME_DIST, f), join(out, 'runtime', f));
  const indexHtml = await readFile(join(RUNTIME_DIST, 'index.html'), 'utf8');

  for (const item of items) {
    await cp(item.dir, join(out, 'compositions', item.id), {
      recursive: true,
      filter: (src) => skipJunk(src) && !['meta.json', 'subtitles.json'].includes(basename(src)),
    });
    for (const [rel, { src }] of await sharedFonts(fontsDir)) await cp(src, join(out, 'compositions', item.id, rel));
    await writeFile(join(out, 'runtime', `${item.id}.html`), runtimePageFor(item, indexHtml));
  }
  const list = items.map(({ id, composition: c, meta }) => ({ id, width: c.width, height: c.height, duration: c.duration, posterTime: meta.posterTime, label: meta.label }));
  await writeFile(join(out, 'compositions.json'), `${JSON.stringify(list, null, 2)}\n`);
  return { compositions: items.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build().then(({ compositions }) => console.log(`site/_site built (${compositions} compositions)`), (e) => { console.error(e.message); process.exit(1); });
}
