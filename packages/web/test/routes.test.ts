import { describe, expect, it } from 'vitest';
import { depthOf, href, parseRoute, redirectOf, routeKey, type Route } from '../src/routes.ts';

describe('parseRoute', () => {
  it.each([
    ['', { name: 'projects' }],
    ['#/', { name: 'projects' }],
    ['#/settings', { name: 'settings', section: 'general' }],
    ['#/p/acme', { name: 'project', slug: 'acme', tab: 'creatives' }],
    // The old Agent console tab: its events live in the conversation's Activity details now.
    ['#/p/acme/console', { name: 'project', slug: 'acme', tab: 'creatives' }],
    ['#/p/acme/new', { name: 'new-creative', slug: 'acme' }],
    ['#/p/acme/c/2026-10-07-lancio', { name: 'creative', slug: 'acme', creative: '2026-10-07-lancio' }],
    ['#/p/ACME/../x', { name: 'projects' }],
  ])('%s', (hash, route) => { expect(parseRoute(hash)).toEqual(route); });
  it('round-trips href', () => {
    expect(parseRoute(href.creative('acme', 'c-1'))).toEqual({ name: 'creative', slug: 'acme', creative: 'c-1' });
    expect(parseRoute(href.project('acme', 'brand'))).toEqual({ name: 'project', slug: 'acme', tab: 'brand' });
  });
});

describe('project tabs', () => {
  it.each(['brand', 'assets', 'references', 'settings'] as const)('%s', (tab) => {
    expect(parseRoute(href.project('acme', tab))).toEqual({ name: 'project', slug: 'acme', tab });
  });
  it('redirects the old console link to the project creatives', () => {
    expect(redirectOf('#/p/acme/console')).toBe('#/p/acme');
    expect(redirectOf('#/p/acme')).toBeNull();
    expect(redirectOf('#/p/acme/brand')).toBeNull();
  });
  it('unknown tabs fall back to projects', () => {
    expect(parseRoute('#/p/acme/nope')).toEqual({ name: 'projects' });
  });
});

describe('Phase 7 routes', () => {
  it.each([
    ['#/welcome', { name: 'welcome' }],
    ['#/welcome/2', { name: 'welcome', step: 2 }],
    ['#/welcome/4', { name: 'projects' }],
    ['#/settings/general', { name: 'settings', section: 'general' }],
    ['#/settings/system', { name: 'settings', section: 'system' }],
    ['#/settings/paid', { name: 'settings', section: 'paid' }],
    ['#/settings/notifications', { name: 'settings', section: 'notifications' }],
    ['#/settings/updates', { name: 'settings', section: 'updates' }],
    ['#/settings/usage', { name: 'projects' }],
    ['#/p/acme/c/lancio/f/instagram-reel-9x16', { name: 'format', slug: 'acme', creative: 'lancio', format: 'instagram-reel-9x16' }],
    ['#/p/acme/c/lancio/f/', { name: 'projects' }],
    ['#/p/acme/c/lancio/f/../x', { name: 'projects' }],
  ])('%s', (hash, route) => { expect(parseRoute(hash)).toEqual(route); });

  it('round-trips href for the new routes', () => {
    expect(href.welcome()).toBe('#/welcome');
    expect(parseRoute(href.welcome(3))).toEqual({ name: 'welcome', step: 3 });
    for (const section of ['general', 'system', 'paid', 'notifications', 'updates'] as const) {
      expect(parseRoute(href.settings(section))).toEqual({ name: 'settings', section });
    }
    expect(href.settings()).toBe('#/settings/general');
    expect(href.format('acme', 'c-1', 'tiktok-9x16')).toBe('#/p/acme/c/c-1/f/tiktok-9x16');
    expect(parseRoute(href.format('acme', 'c-1', 'tiktok-9x16'))).toEqual({ name: 'format', slug: 'acme', creative: 'c-1', format: 'tiktok-9x16' });
  });

  it('orders pages by depth (drives the T1 direction)', () => {
    const r = (h: string) => depthOf(parseRoute(h));
    expect(r('#/welcome')).toBe(0);
    expect(r('#/')).toBe(1);
    expect(r('#/settings/system')).toBe(2);
    expect(r('#/p/acme/brand')).toBe(2);
    expect(r('#/p/acme/new')).toBe(3);
    expect(r('#/p/acme/c/x')).toBe(3);
    expect(r('#/p/acme/c/x/f/y')).toBe(4);
  });

  it('keys pages so project tabs and settings sections stay on the same page', () => {
    const k = (h: string) => routeKey(parseRoute(h));
    expect(k('#/p/acme')).toBe(k('#/p/acme/brand'));
    expect(k('#/p/acme')).not.toBe(k('#/p/other'));
    expect(k('#/settings/general')).toBe(k('#/settings/system'));
    expect(k('#/p/acme/c/x')).not.toBe(k('#/p/acme/c/x/f/y'));
    const all: Route[] = [parseRoute('#/'), parseRoute('#/welcome'), parseRoute('#/p/a/new'), parseRoute('#/p/a/c/b')];
    expect(new Set(all.map(routeKey)).size).toBe(all.length);
  });
});
