import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/args.ts';

describe('parseCliArgs', () => {
  it('uses defaults', () => {
    expect(parseCliArgs([])).toEqual({ port: 4317, open: true, help: false });
  });
  it('parses --port, --no-open and --help', () => {
    expect(parseCliArgs(['--port', '5000', '--no-open'])).toEqual({ port: 5000, open: false, help: false });
    expect(parseCliArgs(['--help']).help).toBe(true);
  });
  it('rejects an invalid port', () => {
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow('Porta non valida');
    expect(() => parseCliArgs(['--port', '70000'])).toThrow('Porta non valida');
  });
});
