import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '@motion-studio/core';
import { parseCliArgs } from '../src/args.ts';

describe('parseCliArgs', () => {
  it('uses defaults', () => {
    expect(parseCliArgs([])).toEqual({ port: 4317, open: true, help: false, printUrl: false });
  });
  it('parses --port, --no-open and --help', () => {
    expect(parseCliArgs(['--port', '5000', '--no-open'])).toEqual({ port: 5000, open: false, help: false, printUrl: false });
    expect(parseCliArgs(['--print-url']).printUrl).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
  });
  it('rejects an invalid port', () => {
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow('Porta non valida');
    expect(() => parseCliArgs(['--port', '70000'])).toThrow('Porta non valida');
    for (const p of ['0x10', '1e3', '0', ' 80', '80.0', '']) expect(() => parseCliArgs(['--port', p]), p).toThrow('Porta non valida');
  });
  describe('rejects unknown options and arguments with a catalog message', () => {
    afterEach(() => setLocale('it'));
    it('in Italian', () => {
      expect(() => parseCliArgs(['--foo'])).toThrow(/^Opzione sconosciuta: --foo$/);
      expect(() => parseCliArgs(['-z'])).toThrow(/^Opzione sconosciuta: -z$/);
      expect(() => parseCliArgs(['--port'])).toThrow(/^Valore non valido per --port$/);
      expect(() => parseCliArgs(['--help=yes'])).toThrow(/^Valore non valido per --help$/);
      expect(() => parseCliArgs(['extra'])).toThrow(/^Argomento inatteso: extra$/);
    });
    it('in English', () => {
      setLocale('en');
      expect(() => parseCliArgs(['--foo'])).toThrow(/^Unknown option: --foo$/);
      expect(() => parseCliArgs(['--no-open=1'])).toThrow(/^Invalid value for --no-open$/);
      expect(() => parseCliArgs(['extra'])).toThrow(/^Unexpected argument: extra$/);
    });
  });
});
