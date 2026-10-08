import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CodebaseList } from '../src/components/CodebaseList.tsx';

describe('CodebaseList', () => {
  it('adds absolute paths, rejects relative ones and flags missing folders', async () => {
    const onChange = vi.fn();
    render(<CodebaseList value={[{ path: '/Users/me/app', note: 'iOS' }]} checks={[{ path: '/Users/me/app', note: 'iOS', exists: false }]} onChange={onChange} />);
    expect(screen.getByText('Non trovata')).toBeTruthy();
    expect(screen.getByText(/L'agente può leggerle; gli strumenti di modifica sono bloccati e le modifiche nei repository git vengono segnalate\./)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Percorso assoluto della cartella'), 'dev/app');
    await userEvent.click(screen.getByRole('button', { name: 'Collega' }));
    expect(screen.getByRole('alert').textContent).toBe('Indica un percorso assoluto');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Percorso assoluto della cartella'));
    await userEvent.type(screen.getByLabelText('Percorso assoluto della cartella'), '~/dev/web');
    await userEvent.type(screen.getByLabelText('Nota (facoltativa)'), 'sito');
    await userEvent.click(screen.getByRole('button', { name: 'Collega' }));
    expect(onChange).toHaveBeenLastCalledWith([{ path: '/Users/me/app', note: 'iOS' }, { path: '~/dev/web', note: 'sito' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Rimuovi /Users/me/app' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
  it('rejects duplicates and handles Enter without submitting the parent form', async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(<form onSubmit={onSubmit}><CodebaseList value={[{ path: '/a' }]} onChange={onChange} /></form>);
    await userEvent.type(screen.getByLabelText('Percorso assoluto della cartella'), '/a{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Cartella già collegata');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Percorso assoluto della cartella'));
    await userEvent.type(screen.getByLabelText('Percorso assoluto della cartella'), '/b{Enter}');
    expect(onChange).toHaveBeenLastCalledWith([{ path: '/a' }, { path: '/b' }]);
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('fills the path from the native folder picker in the app', async () => {
    (window as unknown as { motionStudio: unknown }).motionStudio = { isDesktop: true, platform: 'darwin', pickFolder: async () => '/Users/me/picked', revealPath: async () => {} };
    try {
      render(<CodebaseList value={[]} onChange={() => {}} />);
      await userEvent.click(screen.getByRole('button', { name: 'Scegli cartella…' }));
      expect((screen.getByLabelText('Percorso assoluto della cartella') as HTMLInputElement).value).toBe('/Users/me/picked');
    } finally { delete (window as unknown as { motionStudio?: unknown }).motionStudio; }
  });
});
