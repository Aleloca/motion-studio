import { parseArgs } from 'node:util';

export function parseCliArgs(argv: string[]): { port: number; open: boolean; help: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', default: '4317' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  // Decimal digits only: Number() would also accept '0x10', '1e3' or ' 80'.
  const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Porta non valida: ${values.port}`);
  return { port, open: !values['no-open'], help: values.help ?? false };
}
