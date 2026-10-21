import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A FAKE Whisper engine (decision 1506: no real Whisper binary or model is ever run in a test): a `#!/usr/bin/env node`
 * script named like the engine. It answers `--version` / `--help`, records its argv next to itself (`<name>.args.json`),
 * prints `stderr`, and writes the recorded `fixture` where the engine would (`-of <x>` → `<x>.json`; `--output_dir <d>` →
 * `<d>/<audio name>.json`). `sleep`: it writes its PID to `<name>.pid` and hangs. `exit`: its exit code.
 */
export async function fakeWhisper(dir: string, name: string, o: { fixture?: string; version?: string; help?: string; stderr?: string; exit?: number; sleep?: boolean } = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  const program = join(dir, name);
  const script = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(`${program}.args.json`)}, JSON.stringify(args));
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(o.version ?? '')} + '\\n'); process.exit(0); }
if (args.includes('--help') || args.includes('-h')) { process.stdout.write(${JSON.stringify(o.help ?? 'usage: whisper')} + '\\n'); process.exit(0); }
if (${JSON.stringify(o.sleep === true)}) { fs.writeFileSync(${JSON.stringify(`${program}.pid`)}, String(process.pid)); setInterval(() => {}, 1000); return; }
process.stderr.write(${JSON.stringify(o.stderr ?? '')});
const exit = ${JSON.stringify(o.exit ?? 0)};
if (exit !== 0) process.exit(exit);
const fixture = ${JSON.stringify(o.fixture ?? null)};
if (fixture) {
  const of = args.indexOf('-of'), od = args.indexOf('--output_dir');
  const out = of >= 0 ? args[of + 1] + '.json' : od >= 0 ? path.join(args[od + 1], path.basename(args[0]).replace(/\\.[^.]+$/, '') + '.json') : null;
  if (out) fs.copyFileSync(fixture, out);
}
`;
  await writeFile(program, script);
  await chmod(program, 0o755);
  return program;
}

export const fixturePath = (name: string) => join(import.meta.dirname, '..', 'fixtures', 'whisper', name);
