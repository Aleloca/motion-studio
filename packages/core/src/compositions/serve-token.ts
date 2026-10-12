import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens of the composition server (spec §5.2). A token is the only thing that grants access to a composition
 * folder over HTTP, so:
 * - it carries 256 random bits (`randomBytes(32)`, base64url: 43 characters, never `/`, `%` or `.`);
 * - it is minted per preview or render session and expires after its TTL (`renew()` restarts it);
 * - lookups never compare the token itself with `===`: the table is keyed by the token's sha256 and the stored token is
 *   then checked with `timingSafeEqual`, so the time a lookup takes does not depend on how much of a guess was right.
 */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A fresh session token: 32 random bytes, base64url. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

const keyOf = (token: string) => createHash('sha256').update(token).digest('hex');

interface Entry<T> { token: Buffer; data: T; ttlMs: number; expiresAt: number }

/** Live sessions by token, each with its own TTL; `now` is injectable for tests. Expired entries are dropped on sight. */
export class SessionTokens<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(private now: () => number = Date.now) {}

  /** Stores `data` under a new token that expires `ttlMs` from now. */
  mint(data: T, ttlMs: number): { token: string; expiresAt: number } {
    if (!(ttlMs > 0)) throw new Error('SessionTokens: ttlMs must be positive');
    this.sweep();
    const token = mintToken();
    const expiresAt = this.now() + ttlMs;
    this.entries.set(keyOf(token), { token: Buffer.from(token), data, ttlMs, expiresAt });
    return { token, expiresAt };
  }

  /** The data of a live token, or null (unknown, malformed, revoked or expired). */
  get(token: string): T | null {
    return this.entry(token)?.data ?? null;
  }

  /** Restarts a live token's TTL; returns the new expiry, or null when the token is no longer live. */
  renew(token: string): number | null {
    const e = this.entry(token);
    if (!e) return null;
    e.expiresAt = this.now() + e.ttlMs;
    return e.expiresAt;
  }

  revoke(token: string): void {
    if (typeof token === 'string' && TOKEN_RE.test(token)) this.entries.delete(keyOf(token));
  }

  clear(): void { this.entries.clear(); }

  /** Live entries (expired ones are dropped first). */
  get size(): number { this.sweep(); return this.entries.size; }

  private entry(token: string): Entry<T> | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const key = keyOf(token);
    const e = this.entries.get(key);
    if (!e) return null;
    const given = Buffer.from(token);
    if (given.length !== e.token.length || !timingSafeEqual(given, e.token)) return null;
    if (this.now() >= e.expiresAt) { this.entries.delete(key); return null; }
    return e;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (now >= e.expiresAt) this.entries.delete(k);
  }
}
