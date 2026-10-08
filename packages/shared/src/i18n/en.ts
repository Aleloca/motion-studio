/** A catalog leaf is a string or a function of named parameters; groups nest. */
export type Catalog = { readonly [key: string]: string | ((p: never) => string) | Catalog };

/** English is the source of truth: `Messages` is derived from it. */
export const en = {
  common: {
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
    loading: 'Loading…',
    items: (p: { count: number }) => (p.count === 1 ? '1 item' : `${p.count} items`),
  },
} as const satisfies Catalog;
