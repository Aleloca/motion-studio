import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/keyed-mutex.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes calls on the same key', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      m.run('a', async () => { log.push('1-start'); await sleep(20); log.push('1-end'); }),
      m.run('a', async () => { log.push('2-start'); log.push('2-end'); }),
    ]);
    expect(log).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });
  it('runs different keys concurrently', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    await Promise.all([
      m.run('a', async () => { log.push('a-start'); await sleep(20); log.push('a-end'); }),
      m.run('b', async () => { log.push('b-start'); log.push('b-end'); }),
    ]);
    expect(log.indexOf('b-end')).toBeLessThan(log.indexOf('a-end'));
  });
  it('keeps going after a rejected task', async () => {
    const m = new KeyedMutex();
    await expect(m.run('a', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(m.run('a', async () => 42)).resolves.toBe(42);
  });
});
