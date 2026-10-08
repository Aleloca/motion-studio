import type { AssetKind, BrandColor, BrandFont, BrandLogo, JobSummary } from '@motion-studio/shared';

export const COLOR_ROLES: Record<BrandColor['role'], string> = { primary: 'Primario', secondary: 'Secondario', accent: 'Accento', background: 'Sfondo', text: 'Testo', other: 'Altro' };
export const FONT_ROLES: Record<BrandFont['role'], string> = { heading: 'Titoli', body: 'Testo', accent: 'Accento', other: 'Altro' };
export const LOGO_VARIANTS: Record<BrandLogo['variant'], string> = { primary: 'Principale', secondary: 'Secondario', mono: 'Monocromatico', icon: 'Icona', other: 'Altro' };
export const LOGO_BACKGROUNDS: Record<BrandLogo['background'], string> = { light: 'Chiaro', dark: 'Scuro', any: 'Qualsiasi' };
export const ASSET_KINDS: Record<AssetKind, string> = { image: 'Immagine', svg: 'SVG', video: 'Video', font: 'Font', audio: 'Audio', other: 'Altro' };

/** Brand jobs share one key per project: the job kind tells an analysis from an asset description. */
export const isDescribeJob = (job: JobSummary) => job.kind === 'asset-description';
export const brandJobRunningText = (job: JobSummary) => (isDescribeJob(job) ? 'Descrizione in corso…' : 'Analisi in corso…');
export const brandJobFailedText = (job: JobSummary) => `${isDescribeJob(job) ? 'Descrizione non riuscita' : 'Analisi non riuscita'}: ${job.error ?? 'errore sconosciuto'}`;
export const isActiveJob = (job: JobSummary | undefined) => Boolean(job && (job.state === 'queued' || job.state === 'running'));
