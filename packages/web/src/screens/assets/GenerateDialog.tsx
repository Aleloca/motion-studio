import { useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY_BRAND_SOUND, type BrandSound, type SecretStatus } from '@motion-studio/shared';
import { api, type GenerateRequest } from '../../api.ts';
import type { EventsState } from '../../eventsReducer.ts';
import { useT } from '../../i18n.tsx';
import { isActiveJob } from '../../labels.ts';
import { href } from '../../routes.ts';
import { Button, Icon, Input, Modal, NumberField, Segmented, Select, Spinner, Tabs, Textarea, Toggle, toast, type IconName } from '../../ui/index.ts';
import { ApprovalCard } from '../../components/ApprovalCard.tsx';
import { Alert, message } from '../common.tsx';

type Kind = 'image' | 'voice' | 'sfx' | 'music';
type Provider = 'openai' | 'elevenlabs';
const KINDS: Kind[] = ['image', 'voice', 'sfx', 'music'];
const ICONS: Record<Kind, IconName> = { image: 'image', voice: 'volume', sfx: 'volume', music: 'music' };
/** Which provider keys each kind can use (the first one is the default). */
const PROVIDERS: Record<Kind, Provider[]> = { image: ['openai'], voice: ['openai', 'elevenlabs'], sfx: ['elevenlabs'], music: ['elevenlabs'] };
/** Models the core records for each result (shown to the user so the cost source is clear). */
const MODELS: Record<string, string> = { 'image/openai': 'gpt-image-2', 'voice/openai': 'gpt-4o-mini-tts', 'voice/elevenlabs': 'eleven_multilingual_v2', 'sfx/elevenlabs': 'eleven_text_to_sound_v2', 'music/elevenlabs': 'music_v1' };
/** The providers' documented duration limits (the core enforces them too). */
export const SFX_SECONDS = { min: 0.5, max: 30 };
export const MUSIC_SECONDS = { min: 10, max: 300 };

/** The brand's sound style as a starting prompt (empty when the brand has none). */
export function soundStylePrompt(s: BrandSound | undefined): string {
  if (!s) return '';
  const parts = [s.genre.trim(), s.energy ? `${s.energy} energy` : '', s.instruments.length ? `instruments: ${s.instruments.join(', ')}` : '', s.avoid.length ? `avoid: ${s.avoid.join(', ')}` : ''].filter(Boolean);
  return parts.join(', ');
}

/**
 * The Voice field after the voice-over provider changes: the brand voice when it belongs to the new provider, else empty. An
 * id of one provider never goes to the other (the core refuses it too, before any confirmation).
 */
export function voiceOnProviderChange(next: Provider, sound: BrandSound): string {
  return sound.voice && sound.voice.provider === next ? sound.voice.id : '';
}

export interface GenerateDialogProps { open: boolean; onClose(): void; slug: string; live: EventsState }

/**
 * Assets · Generate: a tabbed form (one tab per kind) that starts a core job (`asset-generation`). The core asks for the paid
 * confirmation (the approval card in the activity center), and registers the result in the library. A tab is disabled when
 * its provider has no key.
 */
export function GenerateDialog(p: GenerateDialogProps) {
  const g = useT().web.library.generate;
  return <Modal open={p.open} onClose={p.onClose} label={g.title} width={640}>{p.open ? <Body {...p} /> : null}</Modal>;
}

function Body({ onClose, slug, live }: GenerateDialogProps) {
  const t = useT();
  const g = t.web.library.generate;
  const [secrets, setSecrets] = useState<SecretStatus[] | null>(null);
  const [sound, setSound] = useState<BrandSound>(EMPTY_BRAND_SOUND);
  const [kind, setKind] = useState<Kind>('image');
  const [provider, setProvider] = useState<Record<Kind, Provider>>({ image: 'openai', voice: 'openai', sfx: 'elevenlabs', music: 'elevenlabs' });
  const [prompt, setPrompt] = useState({ image: '', sfx: '', music: '' });
  const [text, setText] = useState('');
  const [size, setSize] = useState({ width: 1024 as number | null, height: 1024 as number | null });
  const [quality, setQuality] = useState<'auto' | 'low' | 'medium' | 'high'>('auto');
  const [voice, setVoice] = useState('');
  const [instructions, setInstructions] = useState('');
  const [format, setFormat] = useState<'mp3' | 'wav'>('mp3');
  const [sfxSec, setSfxSec] = useState<number | null>(null);
  const [musicSec, setMusicSec] = useState<number | null>(30);
  const [loop, setLoop] = useState(false);
  const [instrumental, setInstrumental] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.getSecrets()).then((s) => { if (alive) setSecrets(s); }).catch(() => { if (alive) setSecrets([]); });
    // The brand prefills the voice and the music/sound prompt; a brand that cannot be read just means nothing is prefilled.
    Promise.resolve().then(() => api.getBrand(slug)).then((b) => {
      if (!alive) return;
      const s = b.kit.sound ?? EMPTY_BRAND_SOUND;
      setSound(s);
      const style = soundStylePrompt(s);
      setPrompt((c) => ({ ...c, music: c.music || style, sfx: c.sfx }));
      if (s.voice) { setProvider((c) => ({ ...c, voice: s.voice!.provider })); setVoice(s.voice.id); }
    }).catch(() => { /* nothing to prefill */ });
    return () => { alive = false; };
  }, [slug]);

  // Whatever changes the voice-over provider (the Select, the brand prefill, a provider without its key), the voice follows.
  const voiceProvider = useRef(provider.voice);
  useEffect(() => {
    if (voiceProvider.current === provider.voice) return;
    voiceProvider.current = provider.voice;
    setVoice(voiceOnProviderChange(provider.voice, sound));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a provider change resets the voice
  }, [provider.voice]);

  const has = (pr: Provider) => Boolean(secrets?.find((s) => s.provider === pr)?.configured);
  const usable = (k: Kind) => PROVIDERS[k].some(has);
  const tabs = KINDS.map((k) => ({ value: k, label: g.kinds[k], disabled: secrets !== null && !usable(k) }));
  // The first usable tab is shown once the keys are known.
  useEffect(() => {
    if (secrets === null) return;
    if (!usable(kind)) { const first = KINDS.find(usable); if (first) setKind(first); }
    setProvider((c) => ({ ...c, voice: has(c.voice) ? c.voice : has('openai') ? 'openai' : 'elevenlabs' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-evaluated when the keys arrive
  }, [secrets]);

  const job = jobId ? live.jobs[jobId] : undefined;
  // The paid confirmation of this job is answered here: the dialog's scrim hides the activity center, and closing the dialog
  // to approve would lose the result (Q3).
  const pendingApprovals = jobId ? Object.values(live.approvals).filter((a) => a.jobId === jobId) : [];
  const running = sending || Boolean(jobId && (!job || isActiveJob(job)));
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => {
    if (!job || isActiveJob(job) || seen === job.id) return;
    setSeen(job.id);
    if (job.state === 'succeeded') { toast.show(g.done, { tone: 'ok' }); onClose(); }
    else if (job.state === 'failed') { setProblem(g.failed({ error: job.error ?? '—' })); setJobId(null); }
    else { setProblem(g.cancelled); setJobId(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the job reaching its end
  }, [job]);

  const providerNames = g.providerNames;
  const current = provider[kind];
  const keyless = secrets !== null && !secrets.some((s) => s.configured);
  const missing = useMemo(() => [...new Set(KINDS.filter((k) => secrets !== null && !usable(k)).flatMap((k) => PROVIDERS[k]))].map((x) => providerNames[x]).join(', '),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secrets]);

  const build = (): GenerateRequest | string => {
    const n = name.trim() || undefined;
    if (kind === 'image') {
      if (!prompt.image.trim()) return g.errors.promptRequired;
      if (!size.width || !size.height) return g.errors.size;
      return { kind, provider: 'openai', prompt: prompt.image, options: { width: size.width, height: size.height, quality, ...(n ? { name: n } : {}) } };
    }
    if (kind === 'voice') {
      if (!text.trim()) return g.errors.textRequired;
      const v = voice.trim();
      return { kind, provider: provider.voice, text, options: { ...(v ? { voice: v } : {}), ...(instructions.trim() && provider.voice === 'openai' ? { instructions: instructions.trim() } : {}), format, ...(n ? { name: n } : {}) } };
    }
    if (kind === 'sfx') {
      if (!prompt.sfx.trim()) return g.errors.promptRequired;
      if (sfxSec !== null && (sfxSec < SFX_SECONDS.min || sfxSec > SFX_SECONDS.max)) return g.errors.duration(SFX_SECONDS);
      return { kind, provider: 'elevenlabs', prompt: prompt.sfx, options: { ...(sfxSec !== null ? { durationSec: sfxSec } : {}), ...(loop ? { loop } : {}), ...(n ? { name: n } : {}) } };
    }
    if (!prompt.music.trim()) return g.errors.promptRequired;
    if (musicSec === null || musicSec < MUSIC_SECONDS.min || musicSec > MUSIC_SECONDS.max) return g.errors.duration(MUSIC_SECONDS);
    return { kind, provider: 'elevenlabs', prompt: prompt.music, options: { durationSec: musicSec, ...(instrumental ? { instrumental } : {}), ...(n ? { name: n } : {}) } };
  };

  const submit = async () => {
    const req = build();
    if (typeof req === 'string') { setProblem(req); return; }
    setProblem(null);
    setSending(true);
    try { setJobId((await api.generateAsset(slug, req)).jobId); }
    catch (e) { setProblem(message(e)); }
    finally { setSending(false); }
  };
  const stop = () => { if (jobId) void api.cancelJob(jobId).catch(() => {}); };

  const panel = `ms-gen-panel-${kind}`;
  const disabledTab = secrets !== null && !usable(kind);
  return (
    <div className="ms-gen">
      <header className="ms-gen-head">
        <h2>{g.title}</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>{g.close}</Button>
      </header>
      <Tabs label={g.tabs} tabs={tabs.map((x) => ({ ...x, controls: `ms-gen-panel-${x.value}` }))} value={kind} onChange={(k) => { if (!running) { setKind(k); setProblem(null); } }} />
      {secrets !== null && missing ? (
        <p className="ms-gen-note" role="status">
          {keyless ? g.noKeysAtAll : g.noKeyTitle({ providers: missing })} <a href={href.settings('paid')} onClick={onClose}>{g.openSettings}</a>
        </p>
      ) : null}
      <div id={panel} role="tabpanel" className="ms-gen-body" aria-busy={running}>
        {disabledTab ? null : (
          <fieldset className="ms-gen-fields" disabled={running}>
            {PROVIDERS[kind].length > 1 ? (
              <div className="ms-gen-row">
                <span className="ms-gen-label">{g.providerLabel}</span>
                <Select label={g.providerLabel} value={current} onChange={(v) => setProvider((c) => ({ ...c, [kind]: v }))}
                  options={PROVIDERS[kind].map((x) => ({ value: x, label: providerNames[x], disabled: !has(x) }))} />
              </div>
            ) : null}
            <p className="ms-gen-note">{g.providerLine({ provider: providerNames[current], model: MODELS[`${kind}/${current}`]! })}</p>

            {kind === 'voice' ? (
              <>
                <label className="ms-gen-label" htmlFor="ms-gen-text">{g.text}</label>
                <Textarea id="ms-gen-text" rows={4} value={text} placeholder={g.textPlaceholder} maxLength={current === 'openai' ? 4096 : 5000} onChange={(e) => setText(e.target.value)} />
                <label className="ms-gen-label" htmlFor="ms-gen-voice">{g.voiceId}</label>
                <Input id="ms-gen-voice" value={voice} placeholder={g.voicePlaceholder} maxLength={64} onChange={(e) => setVoice(e.target.value)} />
                {sound.voice && sound.voice.provider === current ? <p className="ms-gen-note">{g.brandVoice({ name: sound.voice.name ?? sound.voice.id })}</p> : null}
                {current === 'openai' ? (
                  <>
                    <label className="ms-gen-label" htmlFor="ms-gen-instr">{g.instructions}</label>
                    <Input id="ms-gen-instr" value={instructions} placeholder={g.instructionsPlaceholder} maxLength={1000} onChange={(e) => setInstructions(e.target.value)} />
                  </>
                ) : null}
                <div className="ms-gen-row">
                  <span className="ms-gen-label">{g.format}</span>
                  <Segmented label={g.format} value={format} onChange={setFormat} options={[{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }]} />
                </div>
              </>
            ) : (
              <>
                <label className="ms-gen-label" htmlFor="ms-gen-prompt">{g.prompt}</label>
                <Textarea id="ms-gen-prompt" rows={4} value={prompt[kind]} maxLength={kind === 'image' ? 32_000 : 1000}
                  placeholder={kind === 'image' ? g.imagePlaceholder : kind === 'sfx' ? g.soundPlaceholder : g.musicPlaceholder}
                  onChange={(e) => setPrompt((c) => ({ ...c, [kind]: e.target.value }))} />
                {kind === 'music' && soundStylePrompt(sound) ? <p className="ms-gen-note">{g.brandStyle}</p> : null}
              </>
            )}

            {kind === 'image' ? (
              <>
                <div className="ms-gen-row">
                  <NumberField label={g.width} prefix="W" unit="px" min={64} max={3840} step={64} decimals={0} value={size.width} onChange={(v) => setSize((c) => ({ ...c, width: v }))} />
                  <NumberField label={g.height} prefix="H" unit="px" min={64} max={3840} step={64} decimals={0} value={size.height} onChange={(v) => setSize((c) => ({ ...c, height: v }))} />
                </div>
                <p className="ms-gen-note">{g.sizeNote}</p>
                <div className="ms-gen-row">
                  <span className="ms-gen-label">{g.quality}</span>
                  <Segmented label={g.quality} value={quality} onChange={setQuality} options={(['auto', 'low', 'medium', 'high'] as const).map((q) => ({ value: q, label: g.qualities[q] }))} />
                </div>
              </>
            ) : null}
            {kind === 'sfx' ? (
              <>
                <div className="ms-gen-row">
                  <NumberField label={g.duration} prefix="DUR" unit={g.seconds} min={SFX_SECONDS.min} max={SFX_SECONDS.max} step={0.5} decimals={1} value={sfxSec} startAt={2} onChange={setSfxSec} />
                  <span className="ms-gen-inline"><Toggle size="sm" on={loop} onChange={setLoop} label={g.loop} /> {g.loop}</span>
                </div>
                <p className="ms-gen-note">{g.sfxLimits}</p>
              </>
            ) : null}
            {kind === 'music' ? (
              <>
                <div className="ms-gen-row">
                  <NumberField label={g.duration} prefix="DUR" unit={g.seconds} min={MUSIC_SECONDS.min} max={MUSIC_SECONDS.max} step={5} decimals={0} value={musicSec} startAt={30} onChange={setMusicSec} />
                  <span className="ms-gen-inline"><Toggle size="sm" on={instrumental} onChange={setInstrumental} label={g.instrumental} /> {g.instrumental}</span>
                </div>
                <p className="ms-gen-note">{g.musicLimits}</p>
              </>
            ) : null}

            <label className="ms-gen-label" htmlFor="ms-gen-name">{g.name}</label>
            <Input id="ms-gen-name" value={name} placeholder={g.namePlaceholder} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </fieldset>
        )}
      </div>
      <p className="ms-gen-note"><Icon name={ICONS[kind]} size={12} /> {g.paidNote}</p>
      {pendingApprovals.map((a) => <div key={a.id} className="ms-gen-approval"><ApprovalCard approval={a} /></div>)}
      {problem ? <Alert>{problem}</Alert> : null}
      <footer className="ms-gen-foot">
        {running ? <span className="ms-gen-running" role="status"><Spinner size={14} /> {jobId ? g.running : g.starting}</span> : null}
        <div className="ms-grow" />
        {jobId && running ? <Button variant="outline" onClick={stop}>{g.stop}</Button> : <Button variant="outline" onClick={onClose}>{g.cancel}</Button>}
        <Button variant="ink" loading={sending} disabled={running || disabledTab || secrets === null} onClick={() => void submit()}>{g.submit}</Button>
      </footer>
    </div>
  );
}
