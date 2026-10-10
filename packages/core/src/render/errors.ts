/** The renderer's error type (its own module, so every render module can import it without cycles). */

export type RenderFailureCode = 'memoryLimit' | 'timeLimit' | 'crashed' | 'isolation';
export interface RenderFailure { code: RenderFailureCode; message: string }

export type RenderErrorCode =
  | 'cancelled' | 'noBrowser' | 'noFfmpeg' | 'loadFailed' | 'runtimeErrors' | 'frameTimeout' | 'badFrame' | 'ffmpegFailed'
  | 'unsupportedOutput' | 'compositionMismatch' | RenderFailureCode;

export class RenderError extends Error {
  constructor(readonly code: RenderErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'RenderError';
  }
}
