/**
 * PGlite test harness.
 *
 * Boots a throwaway PostgreSQL 17 in-process (WebAssembly, no Docker, no
 * credentials), applies supabase-preamble.sql followed by every file in
 * supabase/migrations in filename order, and hands back helpers that simulate
 * a PostgREST request: `set local role authenticated` + `set local
 * request.jwt.claims`, which is exactly how Supabase surfaces a user session to
 * Postgres.
 *
 * WHY THIS EXISTS: Docker is unavailable on this machine, so `supabase start`
 * is not an option, and applying the migrations to the hosted project needs a
 * personal access token we don't have. Without this harness there would be zero
 * executed verification of ~700 lines of security-critical SQL. With it, the
 * RLS boundary, the plpgsql RPCs, and the constraint interactions are all
 * exercised against a real Postgres engine.
 *
 * WHAT IT DOES NOT COVER: the GoTrue signup HTTP path, PostgREST's error
 * serialisation, and Supabase's real auth schema. See supabase-preamble.sql for
 * the full list of seams. Confirmation against the hosted project is still
 * required and is tracked as such in the final report.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPABASE_DIR = resolve(HERE, '..', '..');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');
const PREAMBLE = join(HERE, 'supabase-preamble.sql');

export type Row = Record<string, unknown>;

/** Runs one statement. Each call is savepoint-wrapped so an expected failure
 *  doesn't poison the surrounding transaction. */
export type Sql = (text: string, params?: unknown[]) => Promise<Row[]>;

export interface SessionUser {
  id: string;
  email?: string;
}

export interface Harness {
  db: PGlite;
  /** Migration filenames applied, in order. */
  migrations: string[];
  /** Run as the table owner (postgres). Bypasses RLS — fixtures/inspection only. */
  asOwner: Sql;
  /** Run as service_role (BYPASSRLS), i.e. what the seed script does. */
  asService: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;
  /** Run as an authenticated end user with the given JWT identity. Commits. */
  asUser: <T>(user: SessionUser, fn: (sql: Sql) => Promise<T>) => Promise<T>;
  /** Run as anon (no JWT). Commits. */
  asAnon: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;
  /** Insert into auth.users, firing on_auth_user_created. Returns the new id. */
  signUp: (opts: { email: string; fullName?: string; confirmed?: boolean }) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Builds a statement runner.
 *
 * Inside a session (`transactional: true`) every statement is savepoint-wrapped
 * so that an *expected* failure — which is most of what an RLS test asserts —
 * aborts only that statement instead of poisoning the whole transaction with
 * "current transaction is aborted, commands ignored until end of transaction
 * block". Outside a transaction savepoints are illegal (25P01), so plain
 * statements are used there.
 */
function makeSql(db: PGlite, transactional: boolean): Sql {
  let counter = 0;
  return async (text: string, params: unknown[] = []): Promise<Row[]> => {
    if (!transactional) {
      const res = await db.query<Row>(text, params);
      return res.rows ?? [];
    }
    const sp = `sp_${counter++}`;
    await db.exec(`savepoint ${sp}`);
    try {
      const res = await db.query<Row>(text, params);
      await db.exec(`release savepoint ${sp}`);
      return res.rows ?? [];
    } catch (err) {
      await db.exec(`rollback to savepoint ${sp}`);
      throw err;
    }
  };
}

export async function createHarness(): Promise<Harness> {
  const db = await PGlite.create();

  // 1. Supabase-managed scaffolding (roles, auth schema, default privileges).
  await db.exec(readFileSync(PREAMBLE, 'utf8'));

  // 2. Our migrations, in the same order `supabase db push` would apply them.
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }

  for (const file of migrations) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration failed: ${file}\n  ${msg}`);
    }
  }

  const asOwner = makeSql(db, false);

  async function inSession<T>(
    setup: (sql: Sql) => Promise<void>,
    fn: (sql: Sql) => Promise<T>,
  ): Promise<T> {
    const sql = makeSql(db, true);
    await db.exec('begin');
    try {
      await setup(sql);
      const out = await fn(sql);
      await db.exec('commit');
      return out;
    } catch (err) {
      await db.exec('rollback');
      throw err;
    }
  }

  const asUser = <T>(user: SessionUser, fn: (sql: Sql) => Promise<T>): Promise<T> =>
    inSession(async (sql) => {
      const claims = JSON.stringify({
        sub: user.id,
        email: user.email ?? null,
        role: 'authenticated',
      });
      // set_config(..., is_local => true) is the parameterisable form of SET LOCAL.
      await sql(`select set_config('request.jwt.claims', $1, true)`, [claims]);
      await sql(`set local role authenticated`);
    }, fn);

  const asAnon = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
    inSession(async (sql) => {
      await sql(`select set_config('request.jwt.claims', '', true)`);
      await sql(`set local role anon`);
    }, fn);

  const asService = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
    inSession(async (sql) => {
      await sql(`select set_config('request.jwt.claims', '', true)`);
      await sql(`set local role service_role`);
    }, fn);

  const signUp = async ({
    email,
    fullName,
    confirmed = true,
  }: {
    email: string;
    fullName?: string;
    confirmed?: boolean;
  }): Promise<string> => {
    const rows = await asOwner(
      `insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
       values ($1, case when $2::boolean then now() else null end, $3::jsonb)
       returning id`,
      [email.toLowerCase().trim(), confirmed, JSON.stringify(fullName ? { full_name: fullName } : {})],
    );
    return rows[0].id as string;
  };

  return {
    db,
    migrations,
    asOwner,
    asService,
    asUser,
    asAnon,
    signUp,
    close: () => db.close(),
  };
}

/* Assertion helpers live in ./assert.ts and are re-exported here so a test file
 * only needs one import. */
export { check, checkEqual, checkRejects, section, summary } from './assert.ts';
