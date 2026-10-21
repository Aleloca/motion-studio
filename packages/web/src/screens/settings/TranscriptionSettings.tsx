import type { TranscriptionMethod, TranscriptionModelId, TranscriptionStatus, WhisperEngine, WhisperFound } from '@motion-studio/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { desktop } from '../../desktop.ts';
import { formatNumber, useLocale, useT } from '../../i18n.tsx';
import { costText } from '../../shell/Tokens.tsx';
import { Button, Card, Icon, Input, ProgressBar, Segmented, Select, Spinner, cx, toast } from '../../ui/index.ts';
import { formatBytes } from '../assets/model.ts';
import { Alert, Head, Row, message } from '../common.tsx';
import './transcription-settings.css';

const METHODS: readonly TranscriptionMethod[] = ['ask', 'whisper', 'openai', 'elevenlabs', 'never'];
const MODELS: readonly TranscriptionModelId[] = ['small', 'large-v3-turbo'];
const ENGINES: readonly WhisperEngine[] = ['whisper.cpp', 'openai-whisper', 'faster-whisper'];
/** While a model downloads or the detection runs, the status is read again this often. */
export const STATUS_POLL_MS = 1000;
const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

/**
 * Settings → Trascrizione video (spec §6–§7): the method, the Whisper model (installed state, size, Installa with its size as
 * the consent, the download's progress, Rimuovi), what transcription is for, and "Usa un Whisper già installato": the Whisper in
 * use, the ones found on the Mac (with their problem when one does not work; "Cerca di nuovo"), and a program (and for
 * whisper.cpp a model file) chosen with "Scegli…" — the desktop file dialog, a path field in a browser — test-run before saving.
 */
export function TranscriptionSettings() {
  const t = useT();
  const tr = t.transcription;
  const locale = useLocale();
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [program, setProgram] = useState('');
  const [engine, setEngine] = useState<WhisperEngine>('whisper.cpp');
  const [modelFile, setModelFile] = useState('');
  const load = () => Promise.resolve().then(() => api.getTranscription());
  useEffect(() => {
    let alive = true;
    load().then((s) => {
      if (!alive) return;
      setStatus(s);
      if (s.settings.custom) { setProgram(s.settings.custom.program); setEngine(s.settings.custom.engine); setModelFile(s.settings.custom.modelFile ?? ''); }
    }, (e: unknown) => { if (alive) setLoadError(tr.loadFailed({ detail: message(e) })); });
    return () => { alive = false; };
  }, [tr]);
  const polling = status?.download.state === 'running' || status?.detection.state === 'running';
  useEffect(() => {
    if (!polling) return;
    let alive = true;
    const id = window.setInterval(() => { load().then((s) => { if (alive) setStatus(s); }, () => {}); }, STATUS_POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [polling]);

  const run = async (key: string, fn: () => Promise<TranscriptionStatus | void>, fail: (p: { detail: string }) => string = tr.saveFailed) => {
    setBusy(key);
    try { const s = await fn(); setStatus(s ?? await load()); return true; }
    catch (e) { toast.show(fail({ detail: message(e) })); return false; }
    finally { setBusy(null); }
  };
  const size = (bytes: number) => formatBytes(bytes, (n) => formatNumber(locale, n));
  if (!status) {
    return (
      <div className="ms-set-narrow">
        <Head title={tr.title} sub={tr.sub} />
        {loadError ? <Alert>{loadError}</Alert> : <Card className="ms-set-card ms-tset-loading" data-enter><Spinner decorative size={16} /></Card>}
      </div>
    );
  }
  const s = status.settings;
  const d = status.download;
  const methodOptions = METHODS.map((m) => {
    const noKey = (m === 'openai' && !status.providers.openai) || (m === 'elevenlabs' && !status.providers.elevenlabs);
    return { value: m, label: tr.methods[m], disabled: noKey && s.method !== m, ...(noKey ? { title: tr.noKey } : {}) };
  });
  const price = (usd: number) => tr.perMinute({ cost: costText(t, locale, usd) ?? '' });
  const methodNote = s.method === 'openai' ? `${tr.paidNote} ${price(status.prices.openai)}` : s.method === 'elevenlabs' ? `${tr.paidNote} ${price(status.prices.elevenlabs)}` : tr.methodSub;

  const saveProgram = async () => {
    setProblem(null);
    setBusy('program');
    try {
      const custom = { program: program.trim(), engine, ...(engine === 'whisper.cpp' && modelFile.trim() ? { modelFile: modelFile.trim() } : {}) };
      setStatus(await api.saveTranscription({ custom }));
      toast.show(tr.saved, { tone: 'ok' });
    } catch (e) { setProblem(message(e)); }
    finally { setBusy(null); }
  };
  const choose = async (what: 'program' | 'model') => {
    const bridge = desktop();
    if (!bridge?.pickFile) return;
    try {
      const picked = await bridge.pickFile(what === 'program' ? tr.program : tr.modelFile);
      if (!picked) return;
      if (what === 'program') {
        setProgram(picked);
        // The program's name tells its engine (the same names the detection looks for).
        const n = baseName(picked).toLowerCase();
        setEngine(n.startsWith('faster-whisper') || n.startsWith('whisper-ctranslate2') ? 'faster-whisper' : n === 'whisper' ? 'openai-whisper' : 'whisper.cpp');
      } else setModelFile(picked);
      setProblem(null);
    } catch (e) { setProblem(tr.pickFailed({ detail: message(e) })); }
  };
  const canPick = Boolean(desktop()?.pickFile);
  const useFound = (w: WhisperFound) => {
    setProgram(w.program); setEngine(w.engine); setModelFile('');
    void run(`use:${w.program}`, () => api.saveTranscription({ custom: { program: w.program, engine: w.engine } }));
  };

  return (
    <div className="ms-set-narrow">
      <Head title={tr.title} sub={tr.sub} />
      <Card className="ms-set-card" data-enter>
        <div className="ms-tset-block">
          <div className="ms-set-row-text"><b>{tr.method}</b><span>{methodNote}</span></div>
          <Segmented className="ms-tset-methods" label={tr.method} value={s.method} options={methodOptions}
            onChange={(m) => void run('method', () => api.saveTranscription({ method: m }))} />
        </div>
        <div className="ms-tset-block">
          <div className="ms-set-row-text"><b>{tr.model}</b><span>{tr.modelSub}</span></div>
          <Segmented className="ms-tset-seg" label={tr.model} value={s.model} options={MODELS.map((m) => ({ value: m, label: tr.models[m] }))}
            onChange={(m) => void run('model', () => api.saveTranscription({ model: m }))} />
          <ul className="ms-tset-models">
            {status.models.map((m) => {
              const downloading = d.state === 'running' && d.model === m.id;
              return (
                <li key={m.id} className="ms-tset-model">
                  <span className="ms-tset-model-text">
                    <b>{tr.models[m.id]}</b>
                    <span>{m.installed ? tr.installedSize({ size: size(m.bytesOnDisk || m.sizeBytes) }) : tr.notInstalled}</span>
                  </span>
                  {m.installed
                    ? <Button size="sm" variant="ghost" disabled={busy !== null || downloading} loading={busy === `rm:${m.id}`}
                      onClick={() => void run(`rm:${m.id}`, async () => { await api.removeWhisperModel(m.id); }, tr.removeFailed)}><Icon name="trash" size={12} />{tr.remove}</Button>
                    : !downloading ? <Button size="sm" variant="outline" disabled={busy !== null || d.state === 'running'} loading={busy === `dl:${m.id}`}
                      onClick={() => void run(`dl:${m.id}`, async () => { await api.downloadWhisperModel(m.id, m.sizeBytes); }, tr.installFailed)}><Icon name="download" size={12} />{tr.install({ size: size(m.sizeBytes) })}</Button> : null}
                  {downloading ? (
                    <span className="ms-tset-progress">
                      <ProgressBar value={d.total ? (d.bytes / d.total) * 100 : 0} label={tr.downloading({ percent: d.total ? Math.round((d.bytes / d.total) * 100) : 0 })} />
                      <span>{tr.downloading({ percent: d.total ? Math.round((d.bytes / d.total) * 100) : 0 })}</span>
                    </span>
                  ) : null}
                  {d.state === 'failed' && d.model === m.id ? <span className="ms-tset-error" role="alert">{tr.installFailed({ detail: d.error ?? '' })}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
        <Row title={tr.whyTitle} sub={tr.why} />
      </Card>

      <Card className="ms-set-card" data-enter>
        <div className="ms-tset-block">
          <div className="ms-tset-headrow">
            <div className="ms-set-row-text"><b>{tr.useInstalled}</b><span>{status.whisper ? tr.inUse({ engine: status.whisper.engine, source: tr.sources[status.whisper.source] }) : tr.noneInUse}</span></div>
            <Button size="sm" variant="ghost" disabled={status.detection.state === 'running'} loading={busy === 'detect'}
              onClick={() => void run('detect', () => api.detectWhisper())}><Icon name="refresh" size={12} />{tr.searchAgain}</Button>
          </div>
          {status.whisper ? <p className="ms-tset-found" role="status"><Icon name="check" size={12} />{foundLine(t, status.whisper)}</p> : null}
          <span className="ms-lib-label ms-tset-cap">{tr.detected}</span>
          {status.detection.state === 'running' ? <p className="ms-tset-note"><Spinner decorative size={12} />{tr.searching}</p>
            : status.detected.length === 0 ? <p className="ms-tset-note">{tr.noneDetected}</p> : (
              <ul className="ms-tset-found-list">
                {status.detected.map((w) => (
                  <li key={w.program} className={cx('ms-tset-detected', w.problem && 'ms-tset-bad')}>
                    <span className="ms-tset-model-text">
                      <b>{w.engine}{w.version ? ` · ${w.version}` : ''}</b>
                      <span className="ms-tset-mono">{w.program}</span>
                      {w.problem ? <span className="ms-tset-error">{tr.problem({ detail: w.problem })}</span>
                        : w.needsModel ? <span>{tr.needsModel}</span> : w.downloadsOwnModel ? <span>{tr.downloadsOwn}</span> : null}
                    </span>
                    {!w.problem && s.custom?.program !== w.program
                      ? <Button size="sm" variant="outline" disabled={busy !== null} loading={busy === `use:${w.program}`} onClick={() => useFound(w)}>{tr.useThis}</Button> : null}
                  </li>
                ))}
              </ul>
            )}
        </div>
        <div className="ms-tset-block">
          <span className="ms-lib-label ms-tset-cap">{tr.custom}</span>
          <div className="ms-tset-field">
            <label htmlFor="ms-tset-program">{tr.program}</label>
            <div className="ms-tset-pick">
              <Input id="ms-tset-program" className="ms-tset-mono" value={program} placeholder={tr.programPlaceholder} spellCheck={false}
                onChange={(e) => { setProgram(e.target.value); setProblem(null); }} />
              {canPick ? <Button size="sm" variant="outline" onClick={() => void choose('program')}>{tr.choose}</Button> : null}
            </div>
          </div>
          <div className="ms-tset-field">
            <span className="ms-tset-lbl" aria-hidden="true">{tr.engine}</span>
            <Select label={tr.engine} value={engine} options={ENGINES.map((x) => ({ value: x, label: x }))} onChange={(v) => { setEngine(v); setProblem(null); }} />
          </div>
          {engine === 'whisper.cpp' ? (
            <div className="ms-tset-field">
              <label htmlFor="ms-tset-modelfile">{tr.modelFile}</label>
              <div className="ms-tset-pick">
                <Input id="ms-tset-modelfile" className="ms-tset-mono" value={modelFile} placeholder={tr.modelFilePlaceholder} spellCheck={false}
                  onChange={(e) => { setModelFile(e.target.value); setProblem(null); }} />
                {canPick ? <Button size="sm" variant="outline" onClick={() => void choose('model')}>{tr.choose}</Button> : null}
              </div>
            </div>
          ) : <p className="ms-tset-note">{tr.pythonCache}</p>}
          {problem ? <p className="ms-tset-error" role="alert">{problem}</p> : null}
          <div className="ms-tset-actions">
            {s.custom ? <Button size="sm" variant="ghost" disabled={busy !== null} loading={busy === 'stop'}
              onClick={() => void run('stop', () => api.saveTranscription({ custom: null }))}>{tr.stopUsing}</Button> : null}
            <Button size="sm" variant="ink" disabled={!program.trim() || busy !== null} loading={busy === 'program'} onClick={() => void saveProgram()}>
              {busy === 'program' ? tr.testing : tr.testAndSave}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** "Whisper trovato: engine, version, model, Metal/GPU yes/no". */
export function foundLine(t: ReturnType<typeof useT>, w: WhisperFound): string {
  const tr = t.transcription;
  return tr.found({ engine: w.engine, version: w.version ?? tr.versionUnknown, model: baseName(w.model), gpu: w.gpu === null ? tr.gpu.unknown : w.gpu ? tr.gpu.yes : tr.gpu.no });
}
