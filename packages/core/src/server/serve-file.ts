import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { FastifyReply } from 'fastify';
import { t } from '../i18n.ts';

export async function sendConfinedFile(reply: FastifyReply, base: string, relRaw: string, prefixes: string[]): Promise<FastifyReply> {
  const rel = normalize(relRaw || '.');
  const allowed = prefixes.map((p) => p.split('/').join(sep));
  const notFound = () => reply.status(404).send({ error: t().errors.fileNotFoundShort });
  if (isAbsolute(rel) || rel.split(sep).includes('..') || !allowed.some((p) => rel.startsWith(p))) return notFound();
  const info = await lstat(join(base, rel)).catch(() => null);
  if (!info?.isFile()) return notFound();
  const real = await realpath(join(base, rel)).catch(() => null);
  const realBase = await realpath(base).catch(() => base);
  // Exact match: rejects a symlink at any level below base (it would bypass the allowed prefixes).
  if (!real || real !== join(realBase, rel)) return notFound();
  // Agent-written HTML/SVG is served same-origin: sandbox it so scripts cannot reach the loopback API.
  reply.header('Content-Security-Policy', 'sandbox').header('X-Content-Type-Options', 'nosniff');
  return reply.sendFile(rel, base);
}
