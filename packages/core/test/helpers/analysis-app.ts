import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { JobSummary, ServerMessage, TranscriptionMethod, WhisperFound } from '@motion-studio/shared';
import type { WhisperModelManifest } from '../../src/transcription/models.ts';
import { AppConfigStore } from '../../src/app-config.ts';
import { ApprovalBroker } from '../../src/approvals/broker.ts';
import { AgentBridge } from '../../src/bridge/bridge.ts';
import { execCommand, type CommandExec } from '../../src/exec.ts';
import { Git } from '../../src/git.ts';
import { createFfmpegTools, type MediaTools } from '../../src/media/media-tools.ts';
import { MemoryVault } from '../../src/secrets/vault.ts';
import { buildServer } from '../../src/server/app.ts';
import type { VideoAnalysisService } from '../../src/analysis/video-analysis.ts';
import { ControlledRunner, type ControlledRun } from './controlled-runner.ts';

/**
 * Decision 1468: a server on a temp workspace with the controlled runner (no `claude`), the `studio` bridge active (an origin
 * and an MCP command that is never started: the test calls the bridge routes with the run's token, as the MCP server would),
 * real ffmpeg media tools (or `media` / `ffExec` stubs) and a project `acme`.
 */
export interface AnalysisApp {
  app: FastifyInstance; runner: ControlledRunner; base: string; projectDir: string; sent: ServerMessage[]; analyses: VideoAnalysisService;
  vault: MemoryVault; configDir: string;
  ref: { root: string; projectSlug: string; projectDir: string };
}

/**
 * `transcription`: the method saved before the server starts (default `never`: the Phase 1 tests never meet the dialog) and
 * the transcription seams (a fake fetch, the detected Whispers: none by default, a bundled folder, a test model manifest).
 */
export async function analysisApp(o: {
  media?: (real: MediaTools) => MediaTools; ffExec?: CommandExec; mcp?: boolean;
  /** The audio check's base time limit (default the service's). */
  precheckMaxMs?: number;
  transcription?: { method?: TranscriptionMethod; fetch?: typeof fetch; detect?: () => Promise<WhisperFound[]>; whisperDir?: string; models?: WhisperModelManifest; redirectHosts?: string[] };
} = {}): Promise<AnalysisApp> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ms-analysis-')));
  const runner = new ControlledRunner();
  const bridge = new AgentBridge();
  bridge.setOrigin('http://127.0.0.1:9');
  const sent: ServerMessage[] = [];
  const real = await createFfmpegTools(execCommand);
  let analyses: VideoAnalysisService | null = null;
  const tr = o.transcription ?? {};
  await new AppConfigStore(join(base, 'config')).setTranscription({ method: tr.method ?? 'never' });
  const vault = new MemoryVault({});
  const app = await buildServer({
    uiToken: null, sandbox: async () => ({ available: false, reason: 'test' }),
    appConfig: new AppConfigStore(join(base, 'config')), configDir: join(base, 'config'), git: new Git(), runner,
    doctor: async () => [], claudeVersion: async () => '2.1.0', bridge, approvals: new ApprovalBroker({ broadcast: () => {} }),
    onBroadcast: (m) => sent.push(m), media: o.media ? o.media(real) : real,
    mcpCommand: o.mcp === false ? null : [process.execPath, join(base, 'never-started-mcp.mjs')], vault, agentContract: 'media',
    whisperDetect: tr.detect ?? (async () => []),
    ...(tr.fetch ? { transcriptionHttp: { fetch: tr.fetch } } : {}), ...(tr.whisperDir ? { whisperDir: tr.whisperDir } : {}),
    ...(tr.models ? { whisperModels: tr.models } : {}), ...(tr.redirectHosts ? { whisperRedirectHosts: tr.redirectHosts } : {}),
    ...(o.ffExec ? { analysisFfExec: o.ffExec } : {}), ...(o.precheckMaxMs !== undefined ? { analysisPrecheckMaxMs: o.precheckMaxMs } : {}),
    onVideoAnalyses: (s) => { analyses = s; },
  });
  await app.inject({ method: 'PUT', url: '/api/workspace', payload: { path: join(base, 'ws') } });
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Acme' } });
  const projectDir = join(base, 'ws', 'acme');
  await mkdir(join(projectDir, 'assets'), { recursive: true });
  return { app, runner, base, projectDir, sent, analyses: analyses!, vault, configDir: join(base, 'config'), ref: { root: join(base, 'ws'), projectSlug: 'acme', projectDir } };
}

export function analysisHelpers(t: AnalysisApp) {
  const tokenOf = async (run: ControlledRun) => {
    const config = JSON.parse(await readFile(run.req.mcpConfigPath!, 'utf8')) as { mcpServers: { studio: { env: Record<string, string> } } };
    return (await readFile(config.mcpServers.studio.env.MOTION_STUDIO_BRIDGE_TOKEN_FILE!, 'utf8')).trim();
  };
  const jobs = async () => (await t.app.inject('/api/jobs')).json() as JobSummary[];
  return {
    jobs,
    analysisJobs: async () => (await jobs()).filter((j) => j.kind === 'video-analysis'),
    tool: async (run: ControlledRun, name: string, args: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      t.app.inject({ method: 'POST', url: `/api/bridge/${name}`, headers: { 'x-motion-studio-bridge': await tokenOf(run) }, payload: args }),
    views: () => t.sent.filter((m): m is Extract<ServerMessage, { type: 'video-analysis' }> => m.type === 'video-analysis'),
    put: async (name: string, data: string | Buffer) => { await writeFile(join(t.projectDir, 'assets', name), data); return `assets/${name}`; },
  };
}

/** A full write for a `whole` run over [0, to]: every field. */
export const wholeWrite = (to: number, frame = 'f-00000000.jpg') => ({
  summary: 'A short demo.', timeline: [{ from: 0, to, onScreen: 'Logo on white', onScreenText: ['ACME'], frame }],
  usableMoments: [{ from: 0, to: Math.min(2, to), why: 'Logo reveal' }],
  look: { colours: ['#ffffff'], typography: 'Bold sans', framing: 'Product b-roll', audio: 'Music' }, tags: ['demo'],
});
