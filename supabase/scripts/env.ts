/**
 * Shared environment loader for the backend scripts and remote tests.
 *
 * Reads the gitignored .env at the repo root. Deliberately dependency-free —
 * Node 24 has process.loadEnvFile(), and hand-rolling the fallback is a few
 * lines, which is cheaper than adding `dotenv` for this (rules.md §2: check
 * whether something already installed can do it first).
 *
 * Nothing in here ever prints a secret value. Missing-variable errors name the
 * variable and say where to get it, never echo what was found.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_PATH = join(REPO_ROOT, '.env');

let loaded = false;

function loadEnvFile(): void {
  if (loaded) return;
  loaded = true;

  if (!existsSync(ENV_PATH)) return;

  // Minimal KEY=VALUE parser: skips comments/blanks, strips optional quotes,
  // and never overwrites a variable already set in the real environment (so CI
  // secrets win over a local file).
  for (const rawLine of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key !== '' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const WHERE_TO_FIND: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'Supabase dashboard > Project Settings > API > Project URL',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    'Supabase dashboard > Project Settings > API Keys > publishable key (sb_publishable_...)',
  SUPABASE_SERVICE_ROLE_KEY:
    'Supabase dashboard > Project Settings > API Keys > secret key (sb_secret_...). SERVER ONLY.',
  SUPABASE_PROJECT_REF: 'the subdomain of your project URL',
  SEED_USER_PASSWORD:
    'any throwaway password you choose — used only for the dummy dev accounts created by the seed script',
};

/** Returns a required variable or exits with an actionable message. */
export function requireEnv(name: string): string {
  loadEnvFile();
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    console.error(`\nMissing required environment variable: ${name}`);
    const hint = WHERE_TO_FIND[name];
    if (hint) console.error(`  Where to find it: ${hint}`);
    console.error(`  Add it to ${ENV_PATH} (gitignored) and re-run.\n`);
    process.exit(1);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  loadEnvFile();
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** Base project URL with any trailing /rest/v1 or slash removed. */
export function supabaseUrl(): string {
  return requireEnv('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}

export function anonKey(): string {
  return requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
}

export function serviceRoleKey(): string {
  return requireEnv('SUPABASE_SERVICE_ROLE_KEY');
}

export { REPO_ROOT, ENV_PATH };
