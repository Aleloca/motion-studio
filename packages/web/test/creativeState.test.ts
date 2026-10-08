import { describe, expect, it } from 'vitest';
import { channelOf } from '../src/screens/creativeState.ts';
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
