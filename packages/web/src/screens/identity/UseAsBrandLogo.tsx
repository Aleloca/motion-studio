// "Use as brand logo" (Phase 14, decision 733): asks first, then the core copies the checked SVG into assets/brand and adds
// it to the brand kit (no proposal to approve: the user chose it). The button sits with the identity bar, not in the format view's bar.
import { useState } from 'react';
import { api } from '../../api.ts';
import { message } from '../../errors.ts';
import { useT } from '../../i18n.tsx';
import { href } from '../../routes.ts';
import { go } from '../../shell/ShellContext.tsx';
import { Button, Icon, Modal, Segmented, toast } from '../../ui/index.ts';
import type { IdentityKind } from './IdentitySizes.tsx';
import '../../components/brief.css';

export interface UseAsBrandLogoProps {
  slug: string; creative: string; n: number; format: string; label: string; kind: IdentityKind; disabled?: boolean;
}

export function UseAsBrandLogo({ slug, creative, n, format, label, kind, disabled }: UseAsBrandLogoProps) {
  const t = useT();
  const i = t.web.identity;
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<'primary' | 'icon'>(kind === 'logo' ? 'primary' : 'icon');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await api.useAsBrandLogo(slug, creative, n, format, variant);
      setOpen(false);
      toast.show(done.committed === false ? i.useAsLogoNotCommitted : i.useAsLogoDone, { tone: 'ok', action: { label: i.useAsLogoOpen, run: () => go(href.project(slug, 'brand')) } });
    } catch (e) { setError(i.useAsLogoFailed({ detail: message(e) })); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Button size="sm" variant="outline" disabled={disabled} aria-label={i.useAsLogoOf({ label })} onClick={() => { setError(null); setOpen(true); }}>
        <Icon name="star" size={13} />{i.useAsLogo}
      </Button>
      <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} label={i.useAsLogoTitle} width={440} dismissible={!busy}>
        <div className="ms-brief-confirm">
          <h3>{i.useAsLogoTitle}</h3>
          <p>{i.useAsLogoBody}</p>
          <Segmented<'primary' | 'icon'> label={i.useAsLogoAs} value={variant} onChange={setVariant} disabled={busy}
            options={[{ value: 'primary', label: i.variantPrimary }, { value: 'icon', label: i.variantIcon }]} />
          {error ? <p role="alert" className="ms-brief-error">{error}</p> : null}
          <div className="ms-brief-actions">
            <Button variant="ink" loading={busy} onClick={() => void confirm()}>{i.useAsLogoConfirm}</Button>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t.common.cancel}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
