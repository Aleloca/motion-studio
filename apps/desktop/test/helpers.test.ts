import { describe, expect, it } from 'vitest';
import { absolutePathArg, pickFolderArgs, tokenFromAppUrl } from '../src/helpers.ts';

describe('desktop helpers', () => {
  it('reads the UI token from the URL fragment only', () => {
    expect(tokenFromAppUrl('http://127.0.0.1:4318/#t=abc123')).toBe('abc123');
    expect(tokenFromAppUrl('http://127.0.0.1:4318/')).toBeNull();
    expect(tokenFromAppUrl('http://127.0.0.1:4318/?t=zzz')).toBeNull();
  });
  it('validates the pick-folder payload', () => {
    expect(pickFolderArgs({ title: 'Scegli', defaultPath: '/tmp' })).toEqual({ title: 'Scegli', defaultPath: '/tmp' });
    expect(pickFolderArgs({ title: 'Scegli' })).toEqual({ title: 'Scegli' });
    expect(pickFolderArgs({ title: 5 })).toBeNull();
    expect(pickFolderArgs({ title: 'x', defaultPath: 3 })).toBeNull();
    expect(pickFolderArgs(null)).toBeNull();
    expect(pickFolderArgs('x')).toBeNull();
  });
  it('accepts only absolute paths for reveal', () => {
    expect(absolutePathArg('/Users/a/out')).toBe('/Users/a/out');
    expect(absolutePathArg('out/video.mp4')).toBeNull();
    expect(absolutePathArg('')).toBeNull();
    expect(absolutePathArg(42)).toBeNull();
    expect(absolutePathArg('/a\0b')).toBeNull();
  });
});
