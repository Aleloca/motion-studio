import { EMPTY_BRAND_KIT, messages, type BrandOverview, type BrandProposal } from '@motion-studio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

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
  applyProposal: vi.fn(), discardProposal: vi.fn(), cancelJob: vi.fn(),
  projectFileUrl: (s: string, r: string) => `/f/${s}/${r}`,
};
vi.mock('../src/api.ts', () => ({ api, ApiError: class extends Error {} }));
const { BrandPage } = await import('../src/screens/BrandPage.tsx');
const { AssetsPage } = await import('../src/screens/AssetsPage.tsx');
const { ReferencesPage } = await import('../src/screens/ReferencesPage.tsx');
const { ProposalReview, describeChange } = await import('../src/components/ProposalReview.tsx');
const live = { approvals: {}, jobs: {}, events: {}, creativeTicks: {}, projectTicks: {} };
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('brand, assets and references in English', () => {
  it('shows the brand kit sections, roles and sources', async () => {
    en(<BrandPage slug="acme" live={live} />);
    await waitFor(() => screen.getByDisplayValue('Blu'));
    expect(screen.getByRole('heading', { name: 'Tone and style' })).toBeTruthy();
    expect(screen.getByText('Website: acme.example')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Primary' })).toBeTruthy();
    expect(screen.getByLabelText('Color hex 1')).toBeTruthy();
    expect(screen.getByText('Analyzed on 10/7/2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze brand' })).toBeTruthy();
  });
  it('lists assets with English kinds and counts', async () => {
    en(<AssetsPage slug="acme" live={live} />);
    expect(await screen.findByText('2 files in the assets/ folder are not registered')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open logo.svg' }));
    expect(screen.getByText(/Generated · added 10\/7\/2026/)).toBeTruthy();
    expect(screen.getByText('Credit: Jane')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Describe with the agent' })).toBeTruthy();
  });
  it('labels the references actions', async () => {
    en(<ReferencesPage slug="acme" live={live} />);
    expect(await screen.findByLabelText('Note for mood.jpg')).toBeTruthy();
    expect(screen.getByLabelText('Use for brand analysis')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Delete mood.jpg' }));
    expect(screen.getByRole('button', { name: 'Confirm deleting mood.jpg' })).toBeTruthy();
  });
  it('describes a proposal in English', () => {
    const proposal: BrandProposal = {
      schemaVersion: 1, id: 'p-1', createdAt: '2026-10-07T10:00:00.000Z', sourceIds: [], status: 'open', summary: '', assetsAdded: ['x'], guidelines: null,
      changes: [{ id: 'c1', field: 'colors', op: 'add', itemId: 'o', before: null, after: { id: 'o', name: 'Orange', hex: '#FF7A45', role: 'accent', source: site } }],
    };
    expect(describeChange(proposal.changes[0]!, messages('en'))).toBe('Add color Orange #FF7A45');
    en(<ProposalReview slug="acme" proposal={proposal} onDone={() => {}} />);
    expect(screen.getByText('1 asset downloaded and added to the library')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply selected' })).toBeTruthy();
  });
});
