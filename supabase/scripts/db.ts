/**
 * Supabase CLI wrapper that builds the connection URL from .env.
 *
 *   npm run db:push          # apply pending migrations
 *   npm run db:push -- --dry-run
 *   npm run db:migrations    # list local vs remote
 *   npm run db:types         # regenerate database.types.ts
 *
 * WHY THIS EXISTS
 * `supabase link` needs a personal access token (`sbp_…`), which is not available
 * on this machine — only a database password. The CLI's `--db-url` path works with
 * a password alone, so every command routes through here.
 *
 * It also handles two environment specifics that are easy to get wrong:
 *   * The direct host `db.<ref>.supabase.co` is IPv6-ONLY on this project and is
 *     unreachable from WSL (ENETUNREACH). The regional pooler is the IPv4 path.
 *   * The pooler is region-specific and only accepts tenants it actually hosts,
 *     so the region below is not cosmetic. This project is ap-south-1 (Mumbai).
 *
 * Secret handling: the password is read from the gitignored .env and interpolated
 * here rather than typed on a command line, so it stays out of shell history. It
 * is still visible in this process's argv while the CLI runs, which is inherent to
 * `--db-url`; acceptable for a local developer machine, and the reason this script
 * scrubs it from all captured output before printing.
 */

import { spawnSync } from 'node:child_process';
import { optionalEnv, requireEnv } from './env.ts';

const REGION = optionalEnv('SUPABASE_DB_REGION') ?? 'ap-south-1';
const POOLER_PREFIX = optionalEnv('SUPABASE_POOLER_PREFIX') ?? 'aws-0';

const ref = requireEnv('SUPABASE_PROJECT_REF');
const password = requireEnv('SUPABASE_DB_PASSWORD');

const host = `${POOLER_PREFIX}-${REGION}.pooler.supabase.com`;
// Session mode (5432), not transaction mode (6543): DDL and advisory locks need a
// dedicated session.
const dbUrl = `postgresql://postgres.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres`;

const [subcommand, ...rest] = process.argv.slice(2);

if (!subcommand) {
  console.error('Usage: tsx supabase/scripts/db.ts <push|migrations|diff|types> [...args]');
  process.exit(1);
}

/** Never let the password reach stdout, even inside a CLI error message. */
function scrub(text: string): string {
  return text
    .split(password).join('***REDACTED***')
    .split(encodeURIComponent(password)).join('***REDACTED***');
}

/**
 * Runs the CLI and returns stdout and stderr SEPARATELY.
 *
 * Keeping them apart matters for `gen types`: the schema goes to stdout while
 * progress chatter ("Connecting to remote database...") goes to stderr. Merging
 * them appends that chatter to the generated file and produces a .ts that does
 * not parse — which is exactly what happened the first time this ran.
 */
function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync('npx', ['--yes', 'supabase', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: scrub(res.stdout ?? ''),
    stderr: scrub(res.stderr ?? ''),
    status: res.status ?? 1,
  };
}

/** For the commands whose output is meant for a human. */
function runAndPrint(args: string[]): void {
  const { stdout, stderr, status } = run(args);
  if (stdout.trim()) console.log(stdout);
  if (stderr.trim()) console.log(stderr);
  if (status !== 0) process.exit(status);
}

switch (subcommand) {
  case 'push':
    console.log(`Pushing migrations to ${host} (project ${ref}, region ${REGION})`);
    runAndPrint(['db', 'push', '--db-url', dbUrl, ...rest]);
    break;

  case 'migrations':
    runAndPrint(['migration', 'list', '--db-url', dbUrl, ...rest]);
    break;

  case 'diff':
    runAndPrint(['db', 'diff', '--db-url', dbUrl, ...rest]);
    break;

  case 'types': {
    const { stdout, stderr, status } = run([
      'gen', 'types', 'typescript', '--db-url', dbUrl, '--schema', 'public',
    ]);
    if (status !== 0) {
      console.error('gen types failed:');
      console.error(stderr || stdout);
      process.exit(status);
    }

    // stdout only — see the note on run(). Trim to the first real declaration in
    // case the CLI ever prefixes anything.
    const marker = stdout.indexOf('export type Json');
    if (marker === -1) {
      console.error('Could not find the generated types in CLI stdout.');
      console.error(stdout.slice(0, 2000));
      process.exit(1);
    }

    const contents = `${stdout.slice(marker).trimEnd()}\n`;

    // Cheap structural sanity check: a truncated or polluted file would leave
    // braces unbalanced, and writing a broken .ts is worse than failing here.
    const opens = (contents.match(/\{/g) ?? []).length;
    const closes = (contents.match(/\}/g) ?? []).length;
    if (opens !== closes) {
      console.error(`Generated types look malformed (${opens} '{' vs ${closes} '}'). Not writing.`);
      process.exit(1);
    }

    const { writeFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const target = fileURLToPath(new URL('../types/database.types.ts', import.meta.url));
    writeFileSync(target, contents, 'utf8');
    console.log(`Wrote ${target} (${contents.split('\n').length} lines)`);
    break;
  }

  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
}
