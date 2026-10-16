// "Partenza" of the identity formats (Phase 14, spec §4.3, decisions 730–732): from the brand's logo (the default when the
// brand has one) or from scratch (a name or initials, style keywords, brand or free colours and, for a logo, how many variants).
// A controlled form: the parent keeps the choice and sends it as `brief.identity`.
import { type BrandKit, type IdentityBrief } from '@motion-studio/shared';
import { useEffect, useId, useState } from 'react';
import { api } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { Icon, Input, Segmented } from '../../ui/index.ts';
import './identity.css';

export const DEFAULT_CONCEPTS = 3;

/** The choice with its defaults: "from the brand" when the brand has a logo, else "from scratch". */
export function resolveIdentity(value: IdentityBrief | undefined, hasBrandLogo: boolean): IdentityBrief {
  return { start: hasBrandLogo ? 'brand' : 'scratch', colors: 'brand', concepts: DEFAULT_CONCEPTS, ...value };
}

/** The brief's `identity`, trimmed: a field left empty is not sent, the variants only matter for a start from scratch. */
export function identityForBrief(value: IdentityBrief | undefined, hasBrandLogo: boolean): IdentityBrief {
  const v = resolveIdentity(value, hasBrandLogo);
  const name = v.name?.trim();
  const keywords = v.keywords?.trim();
  return {
    start: v.start,
    ...(v.start === 'scratch' && name ? { name } : {}),
    ...(v.start === 'scratch' && keywords ? { keywords } : {}),
    colors: v.colors ?? 'brand',
    concepts: v.concepts ?? DEFAULT_CONCEPTS,
  };
}

/** The brand's logo a creative starts from: the primary one, else the first (final wave M9). */
export const primaryLogoOf = (logos: BrandKit['logos']): BrandKit['logos'][number] | undefined => logos.find((l) => l.variant === 'primary') ?? logos[0];

/** Whether the project's brand kit has a logo, and whether its primary one comes from a codebase. Unknown until it loads. */
export function useBrandLogo(slug: string, enabled = true): { loaded: boolean; hasLogo: boolean; fromCodebase: boolean } {
  const [kit, setKit] = useState<BrandKit | null | 'failed'>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    Promise.resolve().then(() => api.getBrand(slug)).then((b) => { if (alive) setKit(b.kit); }).catch(() => { if (alive) setKit('failed'); });
    return () => { alive = false; };
  }, [slug, enabled]);
  const logos = kit && kit !== 'failed' ? kit.logos : [];
  return { loaded: kit !== null, hasLogo: logos.length > 0, fromCodebase: primaryLogoOf(logos)?.source.kind === 'codebase' };
}

export interface IdentityStartProps {
  value: IdentityBrief;
  onChange(next: IdentityBrief): void;
  hasBrandLogo: boolean;
  /** The primary brand logo (else the first) comes from a codebase: said next to "from the brand's logo". */
  fromCodebase?: boolean;
  /** The number of variants of the whole creative is asked (from scratch only; phase 15: the old logo "proposals"). */
  withConcepts: boolean;
  disabled?: boolean;
}

export function IdentityStart({ value, onChange, hasBrandLogo, fromCodebase, withConcepts, disabled }: IdentityStartProps) {
  const t = useT().web;
  const i = t.identity;
  const vg = t.variantGroup;
  const id = useId();
  const set = (patch: Partial<IdentityBrief>) => onChange({ ...value, ...patch });
  const scratch = value.start === 'scratch';
  const concepts = value.concepts ?? DEFAULT_CONCEPTS;
  return (
    <div className="ms-idstart" role="group" aria-labelledby={`${id}-t`}>
      <span className="ms-idstart-lbl" id={`${id}-t`}>{i.start}</span>
      <Segmented<'brand' | 'scratch'> label={i.start} value={value.start} disabled={disabled} onChange={(start) => set({ start })}
        options={[
          { value: 'brand', label: fromCodebase && hasBrandLogo ? `${i.fromBrand} · ${i.sourceCodebase}` : i.fromBrand },
          { value: 'scratch', label: i.fromScratch },
        ]} />
      {!scratch ? (
        <p className="ms-idstart-note"><Icon name={hasBrandLogo ? 'check' : 'drop'} size={13} />{hasBrandLogo ? i.fromBrandHint : i.noBrandLogo}</p>
      ) : (
        <div className="ms-idstart-fields">
          <label className="ms-idstart-lbl" htmlFor={`${id}-name`}>{i.name}</label>
          <Input id={`${id}-name`} value={value.name ?? ''} maxLength={80} placeholder={i.namePlaceholder} disabled={disabled} onChange={(e) => set({ name: e.target.value })} />
          <label className="ms-idstart-lbl" htmlFor={`${id}-kw`}>{i.keywords}</label>
          <Input id={`${id}-kw`} value={value.keywords ?? ''} maxLength={300} placeholder={i.keywordsPlaceholder} disabled={disabled} onChange={(e) => set({ keywords: e.target.value })} />
          <span className="ms-idstart-lbl">{i.colors}</span>
          <Segmented<'brand' | 'free'> label={i.colors} value={value.colors ?? 'brand'} disabled={disabled} onChange={(colors) => set({ colors })}
            options={[{ value: 'brand', label: i.colorsBrand }, { value: 'free', label: i.colorsFree }]} />
          {withConcepts ? (
            <>
              <span className="ms-idstart-lbl">{vg.variants}</span>
              <Segmented<'1' | '2' | '3' | '4' | '5'> label={vg.variants} value={String(concepts) as '1' | '2' | '3' | '4' | '5'} disabled={disabled}
                onChange={(n) => set({ concepts: Number(n) })}
                options={(['1', '2', '3', '4', '5'] as const).map((n) => ({ value: n, label: n }))} />
              <p className="ms-idstart-note">{vg.identityVariantsHint}</p>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
