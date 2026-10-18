import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '@motion-studio/shared';
import { channelOf, retryTurn } from '../src/screens/creativeState.ts';
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
});
