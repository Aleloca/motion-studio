import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed URLs (Task 5b fix I4: every core route is authenticated). Images shown by `<img>` cannot send the UI
 * token header, so a token-gated route hands out their URLs with `?s=<expiry>.<mac>`: an HMAC-SHA256 of the expiry and the
 * exact path, keyed by a secret of this process (a restart invalidates every URL). The image route checks it in constant
 * time. The UI refreshes them by asking the token-gated route again before `expiresAt`.
 */
export class UrlSigner {
  private readonly key = randomBytes(32);
  constructor(private readonly ttlMs = 10 * 60_000, private readonly now: () => number = Date.now) {}

  private mac(path: string, exp: number): string {
    return createHmac('sha256', this.key).update(`${exp}\n${path}`).digest('base64url');
  }

  /** `path` (no query) signed until now + ttl. */
  sign(path: string): { url: string; expiresAt: number } {
    const exp = this.now() + this.ttlMs;
    return { url: `${path}?s=${exp}.${this.mac(path, exp)}`, expiresAt: exp };
  }

  /** Whether `token` (`<expiry>.<mac>`) signs exactly `path` and has not expired. */
  verify(path: string, token: unknown): boolean {
    if (typeof token !== 'string' || token.length > 200) return false;
    const m = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) return false;
    const exp = Number(m[1]);
    if (!(exp > this.now())) return false;
    const want = Buffer.from(this.mac(path, exp));
    const got = Buffer.from(m[2]!);
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
