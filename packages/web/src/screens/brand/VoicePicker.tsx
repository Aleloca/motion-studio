// Brand voice picker: the voices and their previews come from the core (GET /api/voices); the web never loads a
// provider URL. A preview is an <audio> fed with the short-lived signed core URL of the voice.
import type { BrandSound } from '@motion-studio/shared';
import { useEffect, useRef, useState } from 'react';
import { api, type VoiceList } from '../../api.ts';
import { useT } from '../../i18n.tsx';
import { href } from '../../routes.ts';
import { Button, cx, Icon, Input, Modal, Segmented, Spinner, toast } from '../../ui/index.ts';
import { message } from '../common.tsx';

type Voice = NonNullable<BrandSound['voice']>;
type Provider = Voice['provider'];
/** Quiet time after typing before the voices are asked. */
export const VOICE_SEARCH_MS = 300;
const PROVIDERS: Provider[] = ['elevenlabs', 'openai'];

export function VoicePicker({ open, value, onClose, onPick }: { open: boolean; value: BrandSound['voice']; onClose(): void; onPick(voice: Voice): void }) {
  const t = useT();
  const p = t.web.brand.sound.picker;
  const [provider, setProvider] = useState<Provider>(value?.provider ?? 'elevenlabs');
  const [text, setText] = useState('');
  const [list, setList] = useState<VoiceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const seq = useRef(0);

  const stop = () => {
    const a = audio.current;
    audio.current = null;
    if (a) { a.pause(); a.removeAttribute('src'); }
    setPlaying(null);
  };
  useEffect(() => { if (!open) stop(); return stop; }, [open]);

  // Debounced search: only the answer to the latest query counts.
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      Promise.resolve().then(() => api.listVoices({ provider, q: text.trim() })).then(
        (r) => { if (seq.current === mine) { setList(r); setError(null); setLoading(false); } },
        (e: unknown) => { if (seq.current === mine) { setList(null); setError(message(e)); setLoading(false); } },
      );
    }, text ? VOICE_SEARCH_MS : 0);
    return () => clearTimeout(timer);
  }, [open, provider, text]);

  const play = (id: string, url: string) => {
    if (playing === id) { stop(); return; }
    stop();
    const a = new Audio(url);
    audio.current = a;
    setPlaying(id);
    const failed = () => { if (audio.current === a) { stop(); toast.show(p.previewFailed); } };
    a.addEventListener('ended', () => { if (audio.current === a) stop(); });
    a.addEventListener('error', failed);
    Promise.resolve(a.play()).catch(failed);
  };
  const switchProvider = (next: Provider) => { stop(); setList(null); setProvider(next); };
  const disabled = list !== null && !list.configured;

  return (
    <Modal open={open} onClose={onClose} label={p.title} width={620}>
      <div className="ms-gf ms-vp">
        <h2 className="ms-gf-title">{p.title}</h2>
        <div className="ms-vp-bar">
          <Segmented value={provider} label={p.provider} onChange={switchProvider} options={PROVIDERS.map((v) => ({ value: v, label: p.providers[v] }))} />
          <Input value={text} aria-label={p.search} placeholder={p.searchHint} disabled={disabled} onChange={(e) => setText(e.target.value)} autoFocus />
        </div>
        {disabled ? (
          <p className="ms-bnote ms-vp-nokey" role="status">
            {p.noKey({ provider: p.providers[provider] })} <a href={href.settings('paid')} onClick={onClose}>{p.openSettings}</a>
          </p>
        ) : null}
        {provider === 'openai' && list && !disabled ? <p className="ms-bnote">{p.openaiNote}</p> : null}
        {error ? <p className="ms-bwarn" role="alert">{p.failed({ error })}</p> : null}
        <div className="ms-vp-list" role="group" aria-label={p.results} aria-busy={loading}>
          {loading && !list ? <Spinner size={16} /> : null}
          {list && !disabled && !list.voices.length && !loading ? <p className="ms-bempty-line">{p.empty}</p> : null}
          {!disabled ? list?.voices.map((v) => {
            const on = value?.provider === provider && value.id === v.id;
            const labels = Object.values(v.labels).filter(Boolean).slice(0, 4).join(' · ');
            return (
              <div key={v.id} className={cx('ms-vp-row', on && 'ms-on')}>
                <button type="button" className="ms-vp-pick" aria-pressed={on} aria-label={p.use({ name: v.name })} onClick={() => onPick({ provider, id: v.id, name: v.name })}>
                  <b className="ms-ell">{v.name}</b>
                  {labels ? <span className="ms-muted ms-ell">{labels}</span> : null}
                  {on ? <span className="ms-bok">{p.selected}</span> : null}
                </button>
                {v.previewUrl ? (
                  <Button variant="ghost" size="sm" icon aria-label={playing === v.id ? p.stop({ name: v.name }) : p.play({ name: v.name })} onClick={() => play(v.id, v.previewUrl!)}>
                    <Icon name={playing === v.id ? 'pause' : 'play'} size={13} />
                  </Button>
                ) : <span className="ms-faint ms-vp-nop">{p.noPreview}</span>}
              </div>
            );
          }) : null}
        </div>
        <div className="ms-gf-foot"><Button variant="ghost" onClick={onClose}>{p.close}</Button></div>
      </div>
    </Modal>
  );
}
