import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, ConversationEntry, CreativeSummary, JobSummary } from '@motion-studio/shared';
import { initialEventsState } from '../src/eventsReducer.ts';
import { channelOf, liveCreative, retryTurn } from '../src/screens/creativeState.ts';
import { CHANNELS } from '../src/ui/ChannelMark.tsx';

describe('channelOf', () => {
  it('maps the catalog channels to their marks', () => {
    expect(CHANNELS).toContain('googleplay');
    expect(channelOf('Play Store')).toBe('googleplay');
    expect(channelOf('App Store')).toBe('appstore');
    expect(channelOf('Instagram')).toBe('instagram');
    expect(channelOf('Something else')).toBe('web');
  });
});

describe('retryTurn', () => {
  const at = '2026-10-18T10:00:00.000Z';
  it('a turn that ended without a version (decision 1060) is a boundary like a version', () => {
    const entries: ConversationEntry[] = [
      { type: 'user', at, text: 'Porta il brief a 60 s', pins: [], attachments: [] },
      { type: 'system', at, level: 'info', text: 'Nessun video o immagine è cambiato', keptVersion: 1 },
      { type: 'system', at, level: 'error', text: 'boom' },
    ];
    expect(retryTurn(entries)).toEqual({});
    expect(retryTurn(entries.filter((e) => e.type !== 'system' || e.keptVersion === undefined))).toEqual({ text: 'Porta il brief a 60 s' });
  });
  it('in a group\'s one chat (decision 980) it reads one variant\'s entries only', () => {
    const entries: ConversationEntry[] = [
      { type: 'user', at, text: 'Per B', pins: [], attachments: [], variant: 'b' },
      { type: 'system', at, level: 'error', text: 'boom', variant: 'b' },
      { type: 'user', at, text: 'Per A', pins: [], attachments: [], variant: 'a' },
      { type: 'version', at, n: 3, status: 'complete', variant: 'a' },
    ];
    expect(retryTurn(entries, 'b')).toEqual({ text: 'Per B' });
    expect(retryTurn(entries, 'a')).toEqual({});
  });
});

describe('liveCreative (decision 978)', () => {
  const at = '2026-10-18T10:00:00.000Z';
  const job = (id: string, creative: string, state: JobSummary['state'] = 'running') =>
    ({ id, key: `creative:/w:acme:${creative}`, kind: 'creative', state, createdAt: at }) as unknown as JobSummary;
  const row = { slug: 'lancio', status: 'ready', variants: { count: 27, active: 27, missing: [] } } as unknown as CreativeSummary;
  it('counts the jobs and approvals of any sister id (~f, ~aa) on the group row, the host\'s first, then in id order', () => {
    const live = { ...initialEventsState, jobs: { x: job('x', 'lancio~aa'), y: job('y', 'lancio~f'), z: job('z', 'altro~b') } };
    expect(liveCreative(row, 'acme', live)).toMatchObject({ state: 'running', job: { id: 'y' } });
    expect(liveCreative(row, 'acme', { ...live, jobs: { ...live.jobs, h: job('h', 'lancio') } }).job?.id).toBe('h');
    const approval = { id: 'p', projectSlug: 'acme', creativeSlug: 'lancio~ab', createdAt: at } as unknown as ApprovalRequest;
    expect(liveCreative(row, 'acme', { ...initialEventsState, approvals: { p: approval } })).toMatchObject({ state: 'needs', approval: { id: 'p' } });
    // A single creative never takes a lookalike's work; another project's job is not this one's.
    expect(liveCreative({ ...row, variants: undefined } as CreativeSummary, 'acme', live).state).toBe('ready');
    expect(liveCreative(row, 'other', live).state).toBe('ready');
  });
});
