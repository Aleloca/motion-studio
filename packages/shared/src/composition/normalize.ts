/**
 * Fills in the defaults a composition may leave out, so the file the core writes is explicit (decisions of the Task 1
 * review). The core applies it to the parsed JSON before `validateComposition` and before writing the file.
 * - A text clip without `fontFamily` gets `fonts[0].family`, when `fonts` is not empty (otherwise it stays a problem:
 *   `composition.fontMissing`).
 * - A video (`duration > 0`) with an empty `scenes` array gets one scene from 0 to `duration`, with the id
 *   `implicitSceneId` (`scene-1`, or the next free `scene-N`).
 *
 * Works on unknown input without throwing: anything not shaped as expected is left as it is, for the validator to report.
 * Never mutates its argument: changed objects are copied along the changed path, the rest is shared. Idempotent.
 */
export function normalizeComposition<T>(input: T): T {
  if (!isObject(input)) return input;
  let c: Record<string, unknown> = input;
  const copyRoot = () => { if (c === input) c = { ...input }; };

  const fonts = input.fonts;
  const defaultFamily = Array.isArray(fonts) && isObject(fonts[0]) && typeof fonts[0].family === 'string' ? fonts[0].family : undefined;
  if (defaultFamily !== undefined && Array.isArray(input.tracks)) {
    let tracksChanged = false;
    const tracks = input.tracks.map((track) => {
      if (!isObject(track) || !Array.isArray(track.clips)) return track;
      let clipsChanged = false;
      const clips = track.clips.map((clip) => {
        if (!isObject(clip) || clip.type !== 'text' || !isObject(clip.props) || clip.props.fontFamily !== undefined) return clip;
        clipsChanged = true;
        return { ...clip, props: { ...clip.props, fontFamily: defaultFamily } };
      });
      if (!clipsChanged) return track;
      tracksChanged = true;
      return { ...track, clips };
    });
    if (tracksChanged) { copyRoot(); c.tracks = tracks; }
  }

  if (typeof input.duration === 'number' && input.duration > 0 && Array.isArray(input.scenes) && input.scenes.length === 0) {
    copyRoot();
    c.scenes = [{ id: implicitSceneId(input), start: 0, duration: input.duration }];
  }
  return c as T;
}

/** The id of the implicit scene of a video without scenes: `scene-1`, or the first `scene-N` no track or clip uses. */
export function implicitSceneId(c: unknown): string {
  const used = new Set<string>();
  if (isObject(c) && Array.isArray(c.tracks)) {
    for (const t of c.tracks) {
      if (!isObject(t)) continue;
      if (typeof t.id === 'string') used.add(t.id);
      if (Array.isArray(t.clips)) for (const k of t.clips) if (isObject(k) && typeof k.id === 'string') used.add(k.id);
    }
  }
  let n = 1;
  while (used.has(`scene-${n}`)) n++;
  return `scene-${n}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
