// Shared plumbing of the Brand page: the context every section reads, and the small motion helpers (T14, T15).
import type { AssetEntry, BrandKit, BrandLogo, JobSummary } from '@motion-studio/shared';
import { createContext, useContext, useLayoutEffect, type RefObject } from 'react';
import { collapse, D, enter } from '../motion/index.ts';
import type { BrandSaver } from './brandSave.ts';

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const IMAGE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
export const SECTIONS = ['overview', 'colors', 'type', 'logos', 'voice', 'photo', 'guidelines'] as const;
export type SectionId = (typeof SECTIONS)[number];
export const RULES_SHOWN = 3;
export const isActive = (j: JobSummary | undefined) => Boolean(j && (j.state === 'queued' || j.state === 'running'));

/** What every section needs: the kit being edited, its saver and whether editing is allowed. */
export interface Ctx {
  slug: string;
  kit: BrandKit;
  locked: boolean;
  saver: BrandSaver;
  assets: AssetEntry[];
  /** True once the first data has rendered: items mounted after that are new and enter with scale(.96) (T14). */
  settled: RefObject<boolean>;
  upload(background: BrandLogo['background']): void;
  addLogoFromAsset(file: string, background: BrandLogo['background']): void;
  go(id: SectionId): void;
}
export const BrandCtx = createContext<Ctx | null>(null);
export const useBrand = () => useContext(BrandCtx)!;

/** T14: an item added after the page settled enters with scale(.96). */
export function useAppear<T extends HTMLElement>(ref: RefObject<T | null>) {
  const { settled } = useBrand();
  useLayoutEffect(() => {
    if (settled.current) void enter(ref.current, { y: 6, scale: 0.96, ms: D.m });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** T15: collapse the element, then remove the item; the toast's Undo puts it back where it was. */
export async function removeWithUndo(el: HTMLElement | null, run: () => void) {
  if (await collapse(el)) run();
}
