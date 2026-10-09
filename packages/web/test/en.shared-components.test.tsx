import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

vi.mock('../src/api.ts', () => ({ api: {}, ApiError: class extends Error {} }));
const { CodebaseList } = await import('../src/components/CodebaseList.tsx');
const en = (node: React.ReactNode) => render(<I18nProvider locale="en">{node}</I18nProvider>);

describe('shared components in English', () => {
  it('explains codebase errors', async () => {
    en(<CodebaseList value={[{ path: '/a' }]} checks={[{ path: '/a', exists: false }]} onChange={() => {}} />);
    expect(screen.getByText('Not found')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Absolute folder path'), 'rel');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter an absolute path');
  });
});
