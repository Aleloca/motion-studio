// What the launch film says and plays, and the picture it generates: the voice-over lines (one per beat), the music
// brief, the sound effects and the image prompt. build.mjs turns them into files with the product's own providers;
// the launch generator and the home read the results (media.json and the files next to the film).

/** The voice-over, one line per beat of the film (the home's steps 1-11 play lines 01-11, the final cut all of them). */
export const VO_LINES = [
  'Type a brief. One sentence is enough.',
  'Motion Studio gives you three directions. Pick the one you like.',
  'Ask for a change, in plain words.',
  'Or fix it by hand. No agent, no tokens.',
  'Paste your website, and your brand follows: colours, fonts, logo.',
  'Need an image, a voice, music or a sound effect? Generate it, with your own keys.',
  'Every format is recomposed for its own frame.',
  'Every language keeps the layout.',
  'Subtitles stay in sync with the voice.',
  'Your logo becomes a favicon, an app icon and a social preview.',
  'Export every file, for every channel.',
  'Motion Studio. Brief in. Motion out. Free and open source.',
];

export const voFile = (i) => `vo-${String(i + 1).padStart(2, '0')}.mp3`;

export const MUSIC_PROMPT = 'Modern, confident tech product launch underscore, 110 BPM, warm synth bass, light electronic percussion, builds gently, clean ending, no vocals';

/** The sound effects: file id, prompt, seconds asked of the provider. */
export const SFX = [
  ['click', 'Soft UI click, a single gentle mouse click on a modern app interface', 0.5],
  ['whoosh', 'Quick airy whoosh transition, soft and short', 1],
  ['typing', 'Short burst of soft laptop keyboard typing, a few quick keystrokes', 1.5],
  ['pop', 'Light soft pop of a user interface element appearing, subtle', 0.5],
  ['chime', 'Gentle bright success chime, a short pleasant two-note notification', 1.5],
  ['files', 'Paper files sliding quickly into folders, soft paper swish', 1.5],
];
export const sfxFile = (id) => `sfx-${id}.mp3`;

/** The title card's backdrop: the film's Generate beat makes it and puts it behind "Brief in. Motion out.". */
export const IMAGE_PROMPT = 'Dark studio backdrop, warm orange light beams through haze, floating translucent frames like motion-graphics boards, cinematic, no text, 16:9';
export const IMAGE_FILE = 'generated-backdrop.jpg';
export const IMAGE_SMALL = 'generated-backdrop-960.jpg';

/** Loudness targets (integrated LUFS, true peak dBTP): the voice at about -16; music and effects lower, set by volume. */
export const LOUDNESS = { voice: [-16, -1.5], music: [-18, -1.5], sfx: [-20, -3] };
