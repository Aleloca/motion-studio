import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandLogo } from '../src/components/BrandLogo.tsx';
import { applyTheme } from '../src/theme.ts';

function systemPrefers(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: dark && query.includes('dark'), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('BrandLogo', () => {
  it('keeps the accessible name Motion Studio', () => {
    render(<BrandLogo />);
    expect(screen.getByRole('img', { name: 'Motion Studio' })).toBeTruthy();
  });

  it('renders the light-background logo on the light theme and the light-ink one on the dark theme', async () => {
    systemPrefers(false);
    render(<BrandLogo />);
    const logo = screen.getByRole('img', { name: 'Motion Studio' });
    expect(logo.getAttribute('data-variant')).toBe('light');
    expect(logo.getAttribute('src')).toMatch(/logo\.svg$/);
    await act(async () => { applyTheme('dark'); });
    expect(logo.getAttribute('data-variant')).toBe('dark');
    expect(logo.getAttribute('src')).toMatch(/logo-dark\.svg$/);
    await act(async () => { applyTheme('light'); });
    expect(logo.getAttribute('src')).toMatch(/logo\.svg$/);
  });

  it('follows the OS preference on the system theme, and a forced light theme wins over a dark OS', () => {
    systemPrefers(true);
    const { unmount } = render(<BrandLogo />);
    expect(screen.getByRole('img', { name: 'Motion Studio' }).getAttribute('data-variant')).toBe('dark');
    unmount();
    applyTheme('light');
    render(<BrandLogo />);
    expect(screen.getByRole('img', { name: 'Motion Studio' }).getAttribute('data-variant')).toBe('light');
  });
});

describe('BrandLogo shapes', () => {
  it('the horizontal and mark shapes follow the theme and size their width from the viewBox', async () => {
    systemPrefers(false);
    const { rerender } = render(<BrandLogo variant="horizontal" height={22} />);
    const logo = screen.getByRole('img', { name: 'Motion Studio' });
    expect(logo.getAttribute('src')).toMatch(/logo-horizontal\.svg$|1720/);
    expect(logo.getAttribute('width')).toBe('118'); // 22 * 1720 / 322
    await act(async () => { applyTheme('dark'); });
    expect(logo.getAttribute('src')).toMatch(/logo-horizontal-dark\.svg$|1720/);
    rerender(<BrandLogo variant="mark" height={24} />);
    expect(screen.getByRole('img', { name: 'Motion Studio' }).getAttribute('width')).toBe('27'); // 24 * 362 / 322
  });
  it('decorative has no name', () => {
    render(<BrandLogo variant="mark" decorative />);
    expect(screen.queryByRole('img', { name: 'Motion Studio' })).toBeNull();
  });
});
