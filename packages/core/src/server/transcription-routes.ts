import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { transcriptionModelIdSchema, transcriptionSettingsPatchSchema, whisperEngineSchema, type TranscriptionStatus } from '@motion-studio/shared';
import type { TranscriptionService } from '../transcription/transcriber.ts';
import { CodedError, WorkspaceError } from '../workspace-store.ts';

const absolute = z.string().min(2).max(4096).refine((p) => /^(\/|[A-Za-z]:[\\/])/.test(p), { message: 'must be an absolute path' });
const probeSchema = z.object({ program: absolute, engine: whisperEngineSchema.optional(), modelFile: absolute.optional() }).strict();
const downloadSchema = z.object({ consent: z.literal(true), sizeBytes: z.number().int().positive() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw new WorkspaceError(400, i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'invalid body');
  }
  return r.data;
}

/**
 * Settings → Trascrizione video (spec §6–§7), app-wide: the status (settings, models, the Whisper in use and the ones
 * detected, the download, the providers with a key, list prices; it runs no program), a new detection, a change of the
 * settings (a program is checked first), the check alone, and a model's download (consent and the size shown: 409 `download-size-changed`) or removal.
 */
export function registerTranscriptionRoutes(app: FastifyInstance, ctx: { transcription: TranscriptionService }) {
  app.get('/api/transcription', async (): Promise<TranscriptionStatus> => ctx.transcription.status());
  app.put('/api/transcription', async (req): Promise<TranscriptionStatus> => {
    await ctx.transcription.update(parse(transcriptionSettingsPatchSchema, req.body));
    return ctx.transcription.status();
  });
  // Decision 1553: "Cerca di nuovo": the only route that looks for Whispers (reading the status runs no program).
  app.post('/api/transcription/detect', async (): Promise<TranscriptionStatus> => {
    await ctx.transcription.detect();
    return ctx.transcription.status();
  });
  app.post('/api/transcription/probe', async (req) => ctx.transcription.probe(parse(probeSchema, req.body)));
  type M = { Params: { id: string } };
  const modelOf = (id: string) => {
    const r = transcriptionModelIdSchema.safeParse(id);
    if (!r.success) throw new CodedError(404, `unknown model ${id.slice(0, 40)}`, 'model-not-found');
    return r.data;
  };
  app.post<M>('/api/transcription/models/:id/download', async (req, reply) => {
    const model = modelOf(req.params.id);
    const body = parse(downloadSchema, req.body);
    void ctx.transcription.startDownload(model, body.sizeBytes).catch(() => { /* the status says it failed */ });
    return reply.status(202).send((await ctx.transcription.status()).download);
  });
  app.delete<M>('/api/transcription/models/:id', async (req, reply) => {
    await ctx.transcription.removeModel(modelOf(req.params.id));
    return reply.status(204).send();
  });
}
