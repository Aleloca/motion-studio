import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';

/** CPU architectures: of an executable (from its header) and of the machine (Apple Silicon even under Rosetta). */

export type BinaryArch = 'arm64' | 'x86_64' | 'universal' | 'unknown';

/** The CPU architecture of an executable from its header: Mach-O (thin or universal) and ELF. */
export async function binaryArch(path: string): Promise<BinaryArch> {
  let head: Buffer;
  try {
    const fh = await open(path, 'r');
    try {
      head = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(head, 0, 4096, 0);
      head = head.subarray(0, bytesRead);
    } finally { await fh.close(); }
  } catch { return 'unknown'; }
  if (head.length < 20) return 'unknown';
  const cpu = (t: number): BinaryArch => (t === 0x01000007 ? 'x86_64' : t === 0x0100000c ? 'arm64' : 'unknown');
  if (head.readUInt32LE(0) === 0xfeedfacf) return cpu(head.readUInt32LE(4));
  if (head.readUInt32BE(0) === 0xcafebabe) {
    const n = head.readUInt32BE(4);
    const archs = new Set<BinaryArch>();
    for (let i = 0; i < n && 8 + i * 20 + 4 <= head.length; i++) archs.add(cpu(head.readUInt32BE(8 + i * 20)));
    return archs.has('arm64') && archs.has('x86_64') ? 'universal' : archs.size === 1 ? [...archs][0]! : 'unknown';
  }
  if (head.readUInt32BE(0) === 0x7f454c46) {
    const machine = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18);
    return machine === 62 ? 'x86_64' : machine === 183 ? 'arm64' : 'unknown';
  }
  return 'unknown';
}

/** The machine's CPU architecture (`arm64` for Apple Silicon even under Rosetta). */
let hostArchCache: Promise<string> | null = null;
export function hostArch(): Promise<string> {
  hostArchCache ??= (async () => {
    if (process.platform === 'darwin') {
      const out = await new Promise<string>((resolve) => {
        execFile('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { timeout: 10_000, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : stdout));
      });
      return out.trim() === '1' ? 'arm64' : 'x86_64';
    }
    return process.arch === 'x64' ? 'x86_64' : process.arch;
  })();
  return hostArchCache;
}

/** Whether `exe` must be started through `arch -arm64` (macOS on Apple Silicon, an arm64 or universal binary). */
export async function nativeLauncher(exe: string): Promise<boolean> {
  if (process.platform !== 'darwin' || (await hostArch()) !== 'arm64') return false;
  const a = await binaryArch(exe);
  return (a === 'universal' || a === 'arm64') && existsSync('/usr/bin/arch');
}
