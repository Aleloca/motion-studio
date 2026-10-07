import { describe, expect, it } from 'vitest';
import { href, parseRoute } from '../src/routes.ts';

describe('parseRoute', () => {
  it.each([
    ['', { name: 'projects' }],
    ['#/', { name: 'projects' }],
    ['#/p/acme', { name: 'project', slug: 'acme', tab: 'creatives' }],
    ['#/p/acme/console', { name: 'project', slug: 'acme', tab: 'console' }],
    ['#/p/acme/new', { name: 'new-creative', slug: 'acme' }],
    ['#/p/acme/c/2026-10-07-lancio', { name: 'creative', slug: 'acme', creative: '2026-10-07-lancio' }],
    ['#/p/ACME/../x', { name: 'projects' }],
  ])('%s', (hash, route) => { expect(parseRoute(hash)).toEqual(route); });
  it('round-trips href', () => {
    expect(parseRoute(href.creative('acme', 'c-1'))).toEqual({ name: 'creative', slug: 'acme', creative: 'c-1' });
    expect(parseRoute(href.project('acme', 'console'))).toEqual({ name: 'project', slug: 'acme', tab: 'console' });
  });
});
