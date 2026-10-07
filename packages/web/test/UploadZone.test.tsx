import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UploadZone } from '../src/components/UploadZone.tsx';

describe('UploadZone', () => {
  it('passes dropped and picked files and shows errors', async () => {
    const onFiles = vi.fn(async () => {});
    render(<UploadZone label="Carica asset" onFiles={onFiles} />);
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    fireEvent.drop(screen.getByRole('button', { name: 'Carica asset' }), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]));
    onFiles.mockRejectedValueOnce(new Error('File troppo grande'));
    fireEvent.change(screen.getByLabelText('Carica asset', { selector: 'input' }), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('File troppo grande'));
  });
});
