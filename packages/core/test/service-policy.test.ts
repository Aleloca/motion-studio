import { SERVICE_CHOICES, SERVICE_KINDS, type BriefServices, type ProviderId, type ServiceKind } from '@motion-studio/shared';
import { describe, expect, it } from 'vitest';
import { resolveService, servicesLine, type ServiceDecision } from '../src/services/service-policy.ts';

const OFF = { ok: false, reason: 'disabled', messageKey: 'providers.serviceOff' } as const;
const STOCK_ONLY = { ok: false, reason: 'disabled', messageKey: 'providers.serviceStockOnly' } as const;
const NO_KEY = { ok: false, reason: 'noKey', messageKey: 'providers.serviceNoKey' } as const;
const ok = (provider: string) => ({ ok: true, provider }) as const;

/** Every subset of the given providers. */
const subsets = (ps: ProviderId[]): ProviderId[][] => ps.reduce<ProviderId[][]>((acc, p) => [...acc, ...acc.map((s) => [...s, p])], [[]]);
const ALL: ProviderId[] = ['openai', 'elevenlabs', 'pexels', 'unsplash'];
/** What a tool may ask for, per kind (undefined: the tool did not name a provider). */
const REQUESTED: Record<ServiceKind, Array<string | undefined>> = {
  images: [undefined, 'openai', 'stock'],
  voice: [undefined, 'openai', 'elevenlabs'],
  music: [undefined, 'elevenlabs'],
  sfx: [undefined, 'elevenlabs'],
};

/**
 * The rules written out by hand, one choice at a time (the spec's table): `none` refuses; a named provider wins over the
 * request and needs its key; `auto` keeps today's behaviour; images `stock` refuses generation but not the stock tools,
 * which every choice except `none` allows.
 */
function expected(kind: ServiceKind, choice: string, requested: string | undefined, has: Set<ProviderId>): ServiceDecision {
  if (choice === 'none') return OFF;
  if (kind === 'images' && requested === 'stock') return ok('stock');
  if (kind === 'images' && choice === 'stock') return STOCK_ONLY;
  if (choice === 'auto') {
    if (requested) return ok(requested);
    if (kind === 'images') return ok('openai');
    if (kind === 'voice') return ok(has.has('openai') ? 'openai' : has.has('elevenlabs') ? 'elevenlabs' : 'openai');
    return ok('elevenlabs');
  }
  return has.has(choice as ProviderId) ? ok(choice) : NO_KEY;
}

/** F5: the table again, with every subset of OpenAI and ElevenLabs known to lack the kind's capability. */
const missingDecision = (provider: ProviderId, permission?: string): ServiceDecision =>
  ({ ok: false, reason: 'missingPermission', messageKey: 'providers.serviceMissingPermission', provider, ...(permission ? { permission } : {}) });
function expectedWithMissing(kind: ServiceKind, choice: string, requested: string | undefined, has: Set<ProviderId>, missing: Set<ProviderId>): ServiceDecision {
  const blocked = (p: string) => has.has(p as ProviderId) && missing.has(p as ProviderId);
  const base = expected(kind, choice, requested, has);
  if (!base.ok || base.provider === 'stock') return base;
  if (choice === 'auto' && !requested) {
    const order: ProviderId[] = kind === 'images' ? ['openai'] : kind === 'voice' ? ['openai', 'elevenlabs'] : ['elevenlabs'];
    const usable = order.find((p) => has.has(p) && !missing.has(p));
    if (usable) return ok(usable);
    const first = order.find((p) => has.has(p));
    return first ? missingDecision(first, `perm-${first}`) : ok(order[0]!);
  }
  return blocked(base.provider) ? missingDecision(base.provider as ProviderId, `perm-${base.provider}`) : base;
}

describe('resolveService with capabilities known as missing (F5)', () => {
  it('follows the table: auto skips a provider known to lack the capability, a named or forced one is refused, none left is refused', () => {
    let cases = 0;
    for (const kind of SERVICE_KINDS) {
      for (const choice of SERVICE_CHOICES[kind]) {
        for (const requested of REQUESTED[kind]) {
          for (const keys of subsets(ALL)) {
            for (const miss of subsets(['openai', 'elevenlabs'])) {
              const has = new Set(keys);
              const missing = new Map(miss.map((p) => [p, { permission: `perm-${p}` }] as const));
              const got = resolveService({ [kind]: choice } as BriefServices, kind, requested, has, missing);
              expect(got, `${kind}=${choice} requested=${requested} keys=${keys.join('+')} missing=${miss.join('+')}`).toEqual(expectedWithMissing(kind, choice, requested, has, new Set(miss)));
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBe(36 * 16 * 4);
  });
  it('a missing capability on a provider without a key changes nothing (that is "no key"), and a refused key has no permission', () => {
    const missing = new Map([['openai', {}], ['elevenlabs', { permission: 'text_to_speech' }]] as const);
    expect(resolveService(undefined, 'voice', undefined, new Set(['elevenlabs']), new Map([['openai', {}]]))).toEqual(ok('elevenlabs'));
    expect(resolveService(undefined, 'voice', undefined, new Set(['openai', 'elevenlabs']), missing)).toEqual(missingDecision('openai'));
    expect(resolveService({ voice: 'elevenlabs' }, 'voice', undefined, new Set(['elevenlabs']), missing)).toEqual(missingDecision('elevenlabs', 'text_to_speech'));
  });
});

describe('resolveService', () => {
  it('follows the table for every kind × choice × requested provider × configured keys', () => {
    let cases = 0;
    for (const kind of SERVICE_KINDS) {
      for (const choice of SERVICE_CHOICES[kind]) {
        for (const requested of REQUESTED[kind]) {
          for (const keys of subsets(ALL)) {
            const has = new Set(keys);
            const services = { [kind]: choice } as BriefServices;
            expect(resolveService(services, kind, requested, has), `${kind}=${choice} requested=${requested} keys=${keys.join('+')}`).toEqual(expected(kind, choice, requested, has));
            cases++;
          }
        }
      }
    }
    // 4 images choices × 3 requests + 4 voice × 3 + 3 music × 2 + 3 sfx × 2 = 36, each with 16 key sets.
    expect(cases).toBe(36 * 16);
  });

  it('spot checks the rules that matter for money', () => {
    const none = new Set<ProviderId>();
    const openai = new Set<ProviderId>(['openai']);
    const eleven = new Set<ProviderId>(['elevenlabs']);
    // Voice off: refused whatever the agent asks and whatever keys exist.
    expect(resolveService({ voice: 'none' }, 'voice', 'openai', new Set(ALL))).toEqual(OFF);
    // OpenAI chosen: an ElevenLabs request uses OpenAI...
    expect(resolveService({ voice: 'openai' }, 'voice', 'elevenlabs', openai)).toEqual(ok('openai'));
    // ...or is refused when OpenAI has no key, never silently switched to ElevenLabs.
    expect(resolveService({ voice: 'openai' }, 'voice', 'elevenlabs', eleven)).toEqual(NO_KEY);
    expect(resolveService({ images: 'stock' }, 'images', undefined, openai)).toEqual(STOCK_ONLY);
    expect(resolveService({ images: 'openai' }, 'images', undefined, none)).toEqual(NO_KEY);
    expect(resolveService({ music: 'elevenlabs' }, 'music', undefined, openai)).toEqual(NO_KEY);
  });

  it('treats an old brief (no services) and absent kinds as auto', () => {
    const keys = new Set<ProviderId>(['elevenlabs']);
    for (const kind of SERVICE_KINDS) {
      for (const requested of REQUESTED[kind]) {
        expect(resolveService(undefined, kind, requested, keys)).toEqual(expected(kind, 'auto', requested, keys));
        expect(resolveService({}, kind, requested, keys)).toEqual(expected(kind, 'auto', requested, keys));
      }
    }
  });

  it('never lets an unknown requested provider through', () => {
    const keys = new Set<ProviderId>(ALL);
    expect(resolveService({ voice: 'auto' }, 'voice', 'pexels', keys)).toEqual(ok('openai'));
    expect(resolveService({ voice: 'elevenlabs' }, 'voice', 'pexels', keys)).toEqual(ok('elevenlabs'));
    expect(resolveService({ music: 'auto' }, 'music', 'openai', keys)).toEqual(ok('elevenlabs'));
    expect(resolveService({ images: 'auto' }, 'images', 'unsplash', keys)).toEqual(ok('openai'));
  });
});

describe('servicesLine', () => {
  it('lists every kind in agent English', () => {
    expect(servicesLine({ images: 'stock', voice: 'elevenlabs', music: 'none', sfx: 'auto' }))
      .toBe('Services for this creative: images stock only; voice ElevenLabs; music none; sound effects auto.');
    expect(servicesLine({ images: 'openai', voice: 'openai' })).toBe('Services for this creative: images OpenAI; voice OpenAI; music auto; sound effects auto.');
    expect(servicesLine(undefined)).toBe('Services for this creative: images auto; voice auto; music auto; sound effects auto.');
  });
});
