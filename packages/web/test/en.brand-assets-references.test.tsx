import { EMPTY_BRAND_KIT, type BrandOverview } from '@motion-studio/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, formatWhen } from '../src/i18n.tsx';

const site = { kind: 'website' as const, ref: 'https://acme.example' };
const overview: BrandOverview = {
  kit: { ...EMPTY_BRAND_KIT, colors: [{ id: 'blu', name: 'Blu', hex: '#1E3A5F', role: 'primary', source: site }] },
  kitError: null, guidelines: '', sources: [{ id: 's-1', kind: 'website', url: 'https://acme.example', file: null, addedAt: '2026-10-07T10:00:00.000Z', lastAnalyzedAt: '2026-10-07T10:00:00.000Z' }],
  sourcesError: null, proposals: [], jobKey: 'brand:k',
};
const asset = { file: 'logo.svg', kind: 'svg', origin: 'generated', description: '', tags: [], addedAt: '2026-10-07T10:00:00.000Z', width: 10, height: 10, attribution: 'Jane', sourceUrl: null };
const api = {
  getBrand: vi.fn(async () => structuredClone(overview)),
  listAssets: vi.fn(async () => ({ assets: [asset], error: null, unregistered: ['a.png', 'b.png'] })),
  listReferences: vi.fn(async () => ({ references: [{ file: 'mood.jpg', note: '', useForBrand: true, addedAt: '2026-10-07T10:00:00.000Z' }], error: null })),
  updateAsset: vi.fn(), deleteAsset: vi.fn(), uploadFiles: vi.fn(), registerAssets: vi.fn(), describeAssets: vi.fn(), deleteReference: vi.fn(), updateReference: vi.fn(),
  applyProposal: vi.fn(), discardProposal: vi.fn(), cancelJob: vi.fn(), getProject: vi.fn(async () => ({ slug: 'acme', project: { name: 'Acme' }, jobKey: 'k' })),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { Brand } = await import('../src/screens/Brand.tsx');
const { Assets } = await import('../src/screens/Assets.tsx');
const { References } = await import('../src/screens/References.tsx');
const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('brand, assets and references in English', () => {
  it('shows the brand sections, roles and sources', async () => {
    en(<Brand slug="acme" live={live} />);
    expect(await screen.findByRole('button', { name: 'Edit color Blu' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Brand sections' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Colors' })).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(screen.getByText('acme.example')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Analyze again/ })).toBeTruthy();
  });
  it('lists assets with English kinds and counts', async () => {
    en(<Assets slug="acme" live={live} />);
    expect(await screen.findByText('2 files in the assets folder are not in the library yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open logo.svg' }));
    const panel = screen.getByRole('complementary', { name: 'Asset details' });
    expect(within(panel).getByText(`Generated · ${formatWhen('en', asset.addedAt)}`)).toBeTruthy();
    expect(within(panel).getByText('Jane')).toBeTruthy();
    expect(within(panel).getByText('10×10')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Describe it' })).toBeTruthy();
  });
  it('labels the references actions', async () => {
    en(<References slug="acme" live={live} />);
    expect(await screen.findByRole('button', { name: 'Note for mood.jpg' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Use mood.jpg for brand analysis' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove mood.jpg' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze brand with these' })).toBeTruthy();
  });
});
