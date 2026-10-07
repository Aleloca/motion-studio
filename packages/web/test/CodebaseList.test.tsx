import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CodebaseList } from '../src/components/CodebaseList.tsx';

describe('CodebaseList', () => {
  it('adds absolute paths, rejects relative ones and flags missing folders', async () => {
    const onChange = vi.fn();
    render(<CodebaseList value={[{ path: '/Users/me/app', note: 'iOS' }]} checks={[{ path: '/Users/me/app', note: 'iOS', exists: false }]} onChange={onChange} />);
    expect(screen.getByText('Non trovata')).toBeTruthy();
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
});
