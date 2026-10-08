import type { Messages } from './index.ts';

export const it: Messages = {
  common: {
    cancel: 'Annulla',
    save: 'Salva',
    close: 'Chiudi',
    loading: 'Caricamento…',
    items: (p) => (p.count === 1 ? '1 elemento' : `${p.count} elementi`),
  },
};
