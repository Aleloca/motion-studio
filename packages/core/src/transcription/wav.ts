import { open, writeFile } from 'node:fs/promises';

/** 16 kHz mono 16-bit PCM: the audio every analysis extracts (spec §5.2) and every engine takes. */
export const WAV_RATE = 16_000;
const BYTES_PER_SEC = WAV_RATE * 2;

/** The 44-byte header of a PCM WAV of `dataBytes` bytes (mono, 16-bit, 16 kHz). */
export function wavHeader(dataBytes: number, rate = WAV_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** `seconds` of silence as a WAV (the test-run of a Whisper, spec §7): no ffmpeg needed. */
export async function writeSilentWav(path: string, seconds: number): Promise<void> {
  const bytes = Math.round(seconds * WAV_RATE) * 2;
  await writeFile(path, Buffer.concat([wavHeader(bytes), Buffer.alloc(bytes)]), { mode: 0o600 });
}

/**
 * Where the PCM data of a WAV is (its `data` chunk, after any `LIST` chunk ffmpeg writes), and its duration. Only the
 * 16 kHz mono 16-bit PCM the analysis extracts is accepted.
 */
export async function wavData(path: string): Promise<{ offset: number; bytes: number; durationSec: number }> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
    let pos = 12;
    let fmtOk = false;
    while (pos + 8 <= size) {
      const ch = Buffer.alloc(8);
      await fh.read(ch, 0, 8, pos);
      const id = ch.toString('ascii', 0, 4), len = ch.readUInt32LE(4);
      if (id === 'fmt ') {
        const f = Buffer.alloc(16);
        await fh.read(f, 0, 16, pos + 8);
        fmtOk = f.readUInt16LE(0) === 1 && f.readUInt16LE(2) === 1 && f.readUInt32LE(4) === WAV_RATE && f.readUInt16LE(14) === 16;
      } else if (id === 'data') {
        if (!fmtOk) throw new Error('the WAV is not 16 kHz mono 16-bit PCM');
        const bytes = Math.min(len, size - pos - 8) & ~1;
        return { offset: pos + 8, bytes, durationSec: bytes / BYTES_PER_SEC };
      }
      pos += 8 + len + (len & 1);
    }
    throw new Error('the WAV has no data');
  } finally {
    await fh.close();
  }
}

/** Report 76: 20 ms windows; one is speech above -40 dBFS RMS, and a pause is at least 0.25 s of windows below it. */
const SPAN_WINDOW = WAV_RATE / 50;
const SPAN_LOUD_RMS = 32768 * 10 ** (-40 / 20);
const SPAN_PAUSE_SEC = 0.25;

/**
 * Where the speech of a 16 kHz mono WAV ends (`endSec`, the last loud window) and how long its pauses before that are in all
 * (`quietSec`, the leading silence included), read from its samples (report 76: what a VAD would cut out). Null when it is
 * silent throughout or is not that WAV.
 */
export async function speechSpan(path: string): Promise<{ endSec: number; quietSec: number } | null> {
  const where = await wavData(path).catch(() => null);
  if (!where) return null;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(SPAN_WINDOW * 2 * 1600);
    let win = 0, lastLoud = -1, run = 0, quiet = 0;
    for (let pos = 0; pos < where.bytes; pos += buf.length) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, where.bytes - pos), where.offset + pos);
      for (let w = 0; w + 1 < bytesRead; w += SPAN_WINDOW * 2, win++) {
        let sum = 0, n = 0;
        for (let i = w; i + 1 < Math.min(bytesRead, w + SPAN_WINDOW * 2); i += 2, n++) { const v = buf.readInt16LE(i); sum += v * v; }
        if (Math.sqrt(sum / n) < SPAN_LOUD_RMS) { run++; continue; }
        if (run * (SPAN_WINDOW / WAV_RATE) >= SPAN_PAUSE_SEC) quiet += run * (SPAN_WINDOW / WAV_RATE);
        run = 0;
        lastLoud = win;
      }
      if (bytesRead === 0) break;
    }
    return lastLoud < 0 ? null : { endSec: Number((((lastLoud + 1) * SPAN_WINDOW) / WAV_RATE).toFixed(3)), quietSec: Number(quiet.toFixed(3)) };
  } finally {
    await fh.close();
  }
}
