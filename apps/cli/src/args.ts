import { parseArgs } from 'node:util';
import { t } from '@motion-studio/core';

const parse = (argv: string[]) => parseArgs({
  args: argv,
  options: {
    port: { type: 'string', default: '4317' },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    'print-url': { type: 'boolean', default: false },
  },
  strict: true,
});

/** Node's parseArgs errors carry the offending text only in their (English) message: `Unknown option '--foo'`. */
function localizedArgsError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  const quoted = /'([^']*)'/.exec(err instanceof Error ? err.message : '')?.[1] ?? '';
  // `-h, --help` and `--port <value>` name the option by its long form.
  const option = /--[\w-]+/.exec(quoted)?.[0] ?? quoted;
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return new Error(t().cli.unknownOption({ option }));
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return new Error(t().cli.invalidOptionValue({ option }));
  if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') return new Error(t().cli.unexpectedArgument({ arg: quoted }));
  return err;
}

export function parseCliArgs(argv: string[]): { port: number; open: boolean; help: boolean; printUrl: boolean } {
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(argv); } catch (err) { throw localizedArgsError(err); }
  const { values } = parsed;
  // Decimal digits only: Number() would also accept '0x10', '1e3' or ' 80'.
  const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t().cli.invalidPort({ value: values.port }));
  return { port, open: !values['no-open'], help: values.help ?? false, printUrl: values['print-url'] ?? false };
}
