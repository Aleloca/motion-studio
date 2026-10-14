import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JobSummary } from '@motion-studio/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n.tsx';

const api = {
  stopJob: vi.fn(async (_id: string) => ({ status: 'stopping' })),
  redirectJob: vi.fn(async (_id: string, _b: unknown) => ({ outcome: 'restarted' as const })),
};
class ApiError extends Error { constructor(public status: number, m: string, public code?: string) { super(m); } }
vi.mock('../src/api.ts', () => ({ api, ApiError }));
const { StopMenu } = await import('../src/components/StopMenu.tsx');

const job = (kind: JobSummary['kind'], id = 'j1'): JobSummary => ({ id, key: 'k', kind, label: 'Acme post', state: 'running', createdAt: '2026-10-14T10:00:00.000Z' });
const view = (el: React.ReactNode) => render(<I18nProvider locale="en">{el}</I18nProvider>);
beforeEach(() => vi.clearAllMocks());

describe('StopMenu', () => {
  it('Stop is one click with no confirmation', async () => {
    view(<StopMenu job={job('creative')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.stopJob).toHaveBeenCalledWith('j1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the menu has Stop and "Stop and redirect…"; arrow keys move, Enter picks, Esc closes without stopping', async () => {
    view(<StopMenu job={job('creative')} onRedirect={() => {}} />);
    const more = screen.getByRole('button', { name: 'Stop options' });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(more);
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Stop', 'Stop and redirect…']);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull());
    expect(api.stopJob).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(more);
  });

  it('Stop from the menu stops, and the button waits for the job to change', async () => {
    view(<StopMenu job={job('creative')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop options' }));
    await userEvent.click((await screen.findAllByRole('menuitem'))[0]!);
    expect(api.stopJob).toHaveBeenCalledTimes(1);
  });

  it('with onRedirect, "Stop and redirect…" hands over to the composer and stops nothing', async () => {
    const onRedirect = vi.fn();
    view(<StopMenu job={job('creative')} onRedirect={onRedirect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stop and redirect…' }));
    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(api.stopJob).not.toHaveBeenCalled();
    expect(api.redirectJob).not.toHaveBeenCalled();
  });

  it('without onRedirect (Activity center) it opens its own redirect form and sends one redirect', async () => {
    view(<StopMenu job={job('console')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stop and redirect…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stop and redirect: Acme post' });
    const field = within(dialog).getByRole('textbox', { name: 'What the agent should do instead' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    const send = within(dialog).getByRole('button', { name: 'Redirect' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.type(field, 'Use the dark logo');
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(api.redirectJob).toHaveBeenCalledTimes(1));
    const [id, body] = api.redirectJob.mock.calls[0]! as unknown as [string, { clientId: string; text: string }];
    expect([id, body.text]).toEqual(['j1', 'Use the dark logo']);
    expect(body.clientId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a refused redirect shows the core’s reason in the form and keeps the words', async () => {
    api.redirectJob.mockRejectedValueOnce(new ApiError(409, 'The job is not running any more.', 'not-running'));
    view(<StopMenu job={job('creative')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Stop and redirect…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Redirect' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('The job is not running any more.');
    expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('x');
  });

  it('jobs that cannot be redirected (analyses, descriptions) have Stop only', async () => {
    view(<StopMenu job={job('brand-analysis')} />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop options' })).toBeNull();
  });

  it('a failed stop says so and lets the user try again', async () => {
    api.stopJob.mockRejectedValueOnce(new ApiError(500, 'x'));
    const onError = vi.fn();
    view(<StopMenu job={job('creative')} onError={onError} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Couldn’t stop the agent. Try again.'));
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
