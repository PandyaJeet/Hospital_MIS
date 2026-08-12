/**
 * ERROR-CODE DRIFT AUDIT  (rules.md §3.3 / Phase 4 §3.6.3)
 *
 *   npm run audit:codes
 *
 * Cross-checks two lists that are maintained by hand and therefore drift:
 *
 *   1. Every business-rule error code RETURNED by SQL in supabase/migrations/
 *      — i.e. every `'code', 'SOMETHING'` inside a jsonb envelope.
 *   2. Every error code DOCUMENTED in docs/contracts/*.md.
 *
 * and reports both directions:
 *
 *   UNDOCUMENTED — a code the backend can return that no contract mentions. This is
 *                  the dangerous direction: Prince cannot handle a failure he has
 *                  never been told about, so it surfaces as a generic "something went
 *                  wrong" on a screen that had a specific thing to say.
 *   PHANTOM      — a code a contract promises that no SQL returns. Usually a rename
 *                  that updated one side, or a copy-paste. Harmless at runtime but it
 *                  means the contract is lying, and a frontend may carry dead
 *                  branches for it.
 *
 * WHY A SCRIPT AND NOT A ONE-OFF READ-THROUGH: there are ~30 RPCs and 9 contract
 * files by Phase 4. Doing this by eye is exactly the kind of check that passes on the
 * day it is performed and silently rots afterwards. As a script it can be re-run in
 * Phase 5 and beyond, and it is cheap enough to put in CI.
 *
 * Exits non-zero when anything is undocumented, so it can gate a build. Phantoms are
 * reported but do not fail the run — a contract documenting a code that was removed is
 * a docs bug, not a runtime hazard, and failing on it would discourage running this at
 * all.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = 'supabase/migrations';
const CONTRACTS = 'docs/contracts';
const FUNCTIONS = 'supabase/functions';

/**
 * Codes that legitimately appear in SQL but are not part of any client-facing
 * contract. Each needs a stated reason — this list is a place to justify an
 * exception, not to silence the audit.
 */
const NOT_CLIENT_FACING = new Map<string, string>([
  // Emitted by tests/tooling only, never by an RPC a client calls.
]);

/** SQLSTATE-style codes are Postgres's, not ours; contracts document them separately. */
const isSqlState = (c: string) => /^[0-9A-Z]{5}$/.test(c) && /^[0-9]/.test(c);

/**
 * Upper-case tokens that appear in contracts but are not error codes. Without this
 * the contract-side scan reports SQL keywords, HTTP verbs and env var names as
 * "documented codes", and a report full of obvious noise is a report nobody reads.
 */
const NOT_A_CODE = new Set([
  // SQL / HTTP / JS vocabulary that legitimately appears in prose and code blocks
  'INSERT', 'UPDATE', 'DELETE', 'SELECT', 'NULL', 'TRUE', 'FALSE',
  'POST', 'GET', 'PATCH', 'PUT', 'HEAD', 'OPTIONS', 'JSON', 'JSONB', 'UUID',
  'AND', 'NOT', 'FOR', 'ALL', 'ANY', 'STOP',
  // Environment variables documented for Prince
  'USE_MOCK', 'SEED_USER_PASSWORD', 'NEXT_PUBLIC_USE_MOCK',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRITICAL_LAB_ALERT_SECRET',
  // Domain vocabulary that is upper-cased for emphasis, not a code
  'UHID', 'GST', 'GSTIN', 'IPD', 'OPD', 'TDS', 'RLS', 'PHI', 'PII', 'DPDP',
  'URGENT', 'STAT',
]);

/** PostgREST's own codes (PGRST…) are documented but not returned by our SQL. */
const isPostgrest = (c: string) => c.startsWith('PGRST');

function readAll(dir: string, ext: string): { file: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
}

// ---- 1. codes returned by SQL ------------------------------------------------
// Matches the established envelope shape: 'code', 'SOMETHING'
const sqlCodes = new Map<string, Set<string>>();
for (const { file, text } of readAll(MIGRATIONS, '.sql')) {
  for (const m of text.matchAll(/'code'\s*,\s*'([A-Z][A-Z0-9_]{2,})'/g)) {
    const code = m[1];
    if (!sqlCodes.has(code)) sqlCodes.set(code, new Set());
    sqlCodes.get(code)!.add(file);
  }
}

// ---- 2. codes returned by Edge Functions ------------------------------------
// errorResponse('CODE', ...) or code: 'CODE'
const edgeCodes = new Map<string, Set<string>>();
for (const dir of readdirSync(FUNCTIONS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const path = join(FUNCTIONS, dir.name, 'index.ts');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  for (const m of text.matchAll(/errorResponse\(\s*'([A-Z][A-Z0-9_]{2,})'/g)) {
    const code = m[1];
    if (!edgeCodes.has(code)) edgeCodes.set(code, new Set());
    edgeCodes.get(code)!.add(`${dir.name}/index.ts`);
  }
}

// ---- 3. codes documented in contracts ---------------------------------------
// Contracts write codes as `CODE` in backticks, in tables and TS unions.
const docCodes = new Map<string, Set<string>>();
for (const { file, text } of readAll(CONTRACTS, '.md')) {
  for (const m of text.matchAll(/[`'"]([A-Z][A-Z0-9_]{3,})[`'"]/g)) {
    const code = m[1];
    if (isSqlState(code) || isPostgrest(code) || NOT_A_CODE.has(code)) continue;
    if (!docCodes.has(code)) docCodes.set(code, new Set());
    docCodes.get(code)!.add(file);
  }
}

// ---- report -----------------------------------------------------------------
const allReturned = new Map<string, Set<string>>();
for (const [c, f] of sqlCodes) allReturned.set(c, new Set(f));
for (const [c, f] of edgeCodes) {
  if (!allReturned.has(c)) allReturned.set(c, new Set());
  for (const x of f) allReturned.get(c)!.add(x);
}

const undocumented = [...allReturned.keys()]
  .filter((c) => !docCodes.has(c) && !NOT_CLIENT_FACING.has(c))
  .sort();
const phantom = [...docCodes.keys()].filter((c) => !allReturned.has(c)).sort();

const line = '='.repeat(72);
console.log(`\n${line}\nERROR-CODE DRIFT AUDIT\n${line}`);
console.log(`  codes returned by SQL migrations : ${sqlCodes.size}`);
console.log(`  codes returned by Edge Functions : ${edgeCodes.size}`);
console.log(`  distinct codes returned overall  : ${allReturned.size}`);
console.log(`  code-like tokens in contracts     : ${docCodes.size}`);

if (undocumented.length === 0) {
  console.log('\n  OK  every returned code appears in at least one contract file');
} else {
  console.log(`\n  UNDOCUMENTED (${undocumented.length}) — returned by code, absent from every contract:`);
  for (const c of undocumented) {
    console.log(`    >>>> ${c}   [${[...allReturned.get(c)!].join(', ')}]`);
  }
}

if (phantom.length > 0) {
  // Informational: the contract-side regex also catches non-code tokens
  // (TIER_NOT_ENABLED vs NEXT_PUBLIC_USE_MOCK), so this list needs human reading
  // rather than being treated as a failure.
  console.log(`\n  REVIEW (${phantom.length}) — code-like tokens documented but not returned by any SQL/Edge path:`);
  for (const c of phantom) console.log(`    ---- ${c}   [${[...docCodes.get(c)!].join(', ')}]`);
}

console.log(`\n${line}\n`);
process.exit(undocumented.length > 0 ? 1 : 0);
