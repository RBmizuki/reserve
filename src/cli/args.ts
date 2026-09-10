/** Very small argument parser — enough for this CLI, no dependency needed. */
export interface ParsedArgs {
  command: string;
  flags: Set<string>;
  options: Map<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const name = token.replace(/^-+/, '');
    const eq = name.indexOf('=');
    if (eq !== -1) {
      options.set(name.slice(0, eq), name.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      options.set(name, next);
      i++;
    } else {
      flags.add(name);
    }
  }
  return { command, flags, options, positional };
}

/**
 * True when the user asked for a dry run.
 *
 * Accepts several spellings because `npm run check -- --dry-run` is easy to
 * mistype, and DRY_RUN=1 works when npm swallows the flag.
 */
export function isDryRun(args: ParsedArgs): boolean {
  if ((process.env.DRY_RUN ?? '').trim() === '1') return true;
  return ['dry-run', 'dryrun', 'dry', 'n'].some((f) => args.flags.has(f));
}
