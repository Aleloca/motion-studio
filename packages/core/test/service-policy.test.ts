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
