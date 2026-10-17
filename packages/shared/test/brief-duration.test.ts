import { describe, expect, it } from 'vitest';
import { statedDurationSec } from '../src/brief-duration.ts';

describe('statedDurationSec (user note 6)', () => {
  it('reads seconds written the English way', () => {
    expect(statedDurationSec('A 60-second launch video for the app')).toBe(60);
    expect(statedDurationSec('Make it 60 seconds long')).toBe(60);
    expect(statedDurationSec('about 15 s, punchy')).toBe(15);
    expect(statedDurationSec('A 30s teaser')).toBe(30);
    expect(statedDurationSec('45 sec cut')).toBe(45);
    expect(statedDurationSec('20-sec spot')).toBe(20);
  });

  it('reads seconds written the Italian way', () => {
    expect(statedDurationSec('Video di 30 secondi per il lancio')).toBe(30);
    expect(statedDurationSec('uno spot da 20 sec')).toBe(20);
    expect(statedDurationSec('durata: 45 s')).toBe(45);
  });

  it('reads minutes, also mixed with seconds', () => {
    expect(statedDurationSec('A 1-minute explainer')).toBe(60);
    expect(statedDurationSec('two minutes')).toBe(120);
    expect(statedDurationSec('a minute long')).toBe(60);
    expect(statedDurationSec('1 min 30 s')).toBe(90);
    expect(statedDurationSec('1 minute and 30 seconds')).toBe(90);
    expect(statedDurationSec('un minuto')).toBe(60);
    expect(statedDurationSec('2 minuti')).toBe(120);
    expect(statedDurationSec('1 minuto e 30 secondi')).toBe(90);
    expect(statedDurationSec('mezzo minuto')).toBe(30);
    expect(statedDurationSec('half a minute')).toBe(30);
  });

  it('is null with no duration, with different durations, or out of range', () => {
    expect(statedDurationSec('')).toBeNull();
    expect(statedDurationSec('A launch video for the new app, bright colours')).toBeNull();
    expect(statedDurationSec('Make a 15 s cut and a 30 s cut')).toBeNull();
    expect(statedDurationSec('a 2000 seconds film')).toBeNull();
    expect(statedDurationSec('0 seconds')).toBeNull();
    // Words that only look like units.
    expect(statedDurationSec('Version 2 of the 3 secrets of success')).toBeNull();
    expect(statedDurationSec('the 5 steps')).toBeNull();
  });

  it('counts the same duration said twice once', () => {
    expect(statedDurationSec('A 60-second video. Keep it to 60 seconds.')).toBe(60);
    expect(statedDurationSec('1 minute (60 s) video')).toBe(60);
  });
});
