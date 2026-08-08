/**
 * Seeds the linked Supabase project with 2 tenants x 4 roles.
 *
 *   npm run db:seed          # create anything missing, leave existing rows alone
 *   npm run db:seed:reset    # delete the seed dataset first, then recreate
 *
 * WHY THIS IS TYPESCRIPT AND NOT seed.sql
 * Supabase Auth (GoTrue) owns auth.users: password hashing, the auth.identities
 * row that must accompany every user, and the confirmation bookkeeping. Inserting
 * into auth.users from SQL produces rows that look right but cannot actually log
 * in, which makes them useless for RLS testing — the whole point of this dataset
 * is that each fixture user can hold a real session. So users are created through
 * the Auth Admin API, which is the path the prompt sanctions for exactly this
 * reason. supabase/seed.sql documents the split.
 *
 * WHY IT DRIVES THE REAL RPCs
 * Rather than INSERTing tenants and profiles directly with the service role, the
 * script signs in as each user and calls create_tenant_and_assign_admin,
 * create_invite and accept_invite. That means running the seed is itself an
 * end-to-end exercise of the onboarding and invite flows against the real
 * project — if either RPC is broken, seeding fails loudly instead of quietly
 * producing data that the app could never have produced.
 *
 * SERVICE ROLE USE (rules.md §1.1): the secret key is used here for exactly two
 * things that genuinely require bypassing RLS — creating/deleting auth users, and
 * deleting seed tenant rows during --reset. This is a local developer script, it
 * never ships to a client, and the key is read from the gitignored .env.
 *
 * PII (rules.md §1.3): fixture names/emails are fabricated, and the script still
 * only ever prints emails, never anything resembling patient data.
 */

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { anonKey, requireEnv, serviceRoleKey, supabaseUrl } from './env.ts';
import {
  ALL_SEED_EMAILS,
  SEED_TENANTS,
  SEED_TENANT_NAMES,
  tenantAdmin,
  tenantStaff,
  type SeedUser,
} from './fixtures.ts';

const RESET = process.argv.includes('--reset');

const URL = supabaseUrl();
const ANON = anonKey();
const SECRET = serviceRoleKey();
const PASSWORD = requireEnv('SEED_USER_PASSWORD');

/** Service-role client. Bypasses RLS. Never leaves this process. */
const admin: SupabaseClient = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Envelope = { ok: boolean; code?: string; message?: string; [k: string]: unknown };

function fail(context: string, detail: unknown): never {
  console.error(`\nFAILED: ${context}`);
  console.error(typeof detail === 'string' ? `  ${detail}` : `  ${JSON.stringify(detail)}`);
  process.exit(1);
}

/** Verifies the migrations are actually applied before doing anything else. */
async function assertSchemaPresent(): Promise<void> {
  const { error } = await admin.from('tenants').select('id').limit(1);
  if (error) {
    if (error.code === 'PGRST205' || /schema cache/i.test(error.message)) {
      fail(
        'the database schema is not present',
        'Table public.tenants was not found. Apply the migrations first:\n' +
          '    npm run db:link   (needs SUPABASE_ACCESS_TOKEN)\n' +
          '    npm run db:push\n' +
          '  or paste supabase/migrations/*.sql into the dashboard SQL editor in filename order.',
      );
    }
    fail('could not reach the database', error.message);
  }
}

async function listSeedUsers(): Promise<User[]> {
  const found: User[] = [];
  // The admin API paginates; walk it rather than assuming one page.
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail('listing auth users', error.message);
    const users = data?.users ?? [];
    for (const u of users) {
      if (u.email && ALL_SEED_EMAILS.includes(u.email.toLowerCase())) found.push(u);
    }
    if (users.length < 200) break;
  }
  return found;
}

async function resetSeed(): Promise<void> {
  console.log('Resetting seed dataset...');

  const existing = await listSeedUsers();
  for (const u of existing) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) fail(`deleting seed user ${u.email}`, error.message);
  }
  console.log(`  removed ${existing.length} seed auth user(s) (profiles cascade)`);

  // Tenants do not cascade from profiles (profiles.tenant_id is ON DELETE
  // RESTRICT to protect real data), so they are removed explicitly. Safe now
  // that no profile references them. Invites cascade with the tenant.
  const { data, error } = await admin
    .from('tenants')
    .delete()
    .in('name', SEED_TENANT_NAMES)
    .select('id');
  if (error) fail('deleting seed tenants', error.message);
  console.log(`  removed ${data?.length ?? 0} seed tenant(s)`);
}

/** Creates the user if absent; returns their id either way. */
async function ensureUser(user: SeedUser, existing: User[]): Promise<string> {
  const match = existing.find((u) => u.email?.toLowerCase() === user.email);
  if (match) {
    console.log(`  exists  ${user.email}`);
    return match.id;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: user.email,
    password: PASSWORD,
    email_confirm: true, // pre-confirmed: accept_invite requires a confirmed email
    user_metadata: { full_name: user.fullName },
  });
  if (error || !data?.user) fail(`creating auth user ${user.email}`, error?.message ?? 'no user returned');
  console.log(`  created ${user.email}`);
  return data.user.id;
}

/** Signs in as a fixture user and returns a client bound to their session. */
async function sessionFor(email: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) {
    fail(
      `signing in as ${email}`,
      `${error.message}\n  If this says "Invalid login credentials", the account may exist with a ` +
        `different password. Re-run with --reset, or check SEED_USER_PASSWORD.`,
    );
  }
  return client;
}

async function callRpc(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<Envelope> {
  const { data, error } = await client.rpc(fn, args);
  if (error) fail(`calling ${fn}()`, error.message);
  return data as Envelope;
}

async function main(): Promise<void> {
  console.log(`Seeding ${URL}`);
  await assertSchemaPresent();

  if (RESET) await resetSeed();

  const existing = await listSeedUsers();

  for (const tenant of SEED_TENANTS) {
    console.log(`\n${tenant.name}`);

    // --- 1. auth users -----------------------------------------------------
    const ids = new Map<string, string>();
    for (const u of tenant.users) {
      ids.set(u.email, await ensureUser(u, existing));
    }

    // --- 2. the admin founds the tenant ------------------------------------
    const adminUser = tenantAdmin(tenant);
    const adminClient = await sessionFor(adminUser.email);

    let tenantId: string;
    const create = await callRpc(adminClient, 'create_tenant_and_assign_admin', {
      p_tenant_name: tenant.name,
    });

    if (create.ok) {
      tenantId = create.tenant_id as string;
      console.log(`  tenant created -> ${tenantId}`);
    } else if (create.code === 'ALREADY_IN_TENANT') {
      // Idempotent re-run: the admin already founded it on a previous pass.
      const { data, error } = await adminClient.from('profiles').select('tenant_id').maybeSingle();
      if (error || !data?.tenant_id) fail('reading existing tenant for admin', error?.message ?? 'not found');
      tenantId = data.tenant_id as string;
      console.log(`  tenant already exists -> ${tenantId}`);
    } else {
      return fail('create_tenant_and_assign_admin', create);
    }

    // --- 3. staff join via the real invite flow ----------------------------
    for (const staff of tenantStaff(tenant)) {
      const invite = await callRpc(adminClient, 'create_invite', {
        p_email: staff.email,
        p_role: staff.role,
      });

      if (invite.code === 'ALREADY_MEMBER') {
        console.log(`  ${staff.role.padEnd(7)} ${staff.email} already a member`);
        continue;
      }
      if (!invite.ok) return fail(`create_invite for ${staff.email}`, invite);

      const staffClient = await sessionFor(staff.email);
      const accepted = await callRpc(staffClient, 'accept_invite', { p_token: invite.token });
      await staffClient.auth.signOut();

      if (!accepted.ok) return fail(`accept_invite for ${staff.email}`, accepted);
      console.log(`  ${staff.role.padEnd(7)} ${staff.email} joined`);
    }

    await adminClient.auth.signOut();
  }

  // --- 4. verify the shape we promised -------------------------------------
  console.log('\nVerifying seeded dataset...');
  const { data: tenants, error: tErr } = await admin
    .from('tenants')
    .select('id, name, tier')
    .in('name', SEED_TENANT_NAMES);
  if (tErr) fail('verifying tenants', tErr.message);

  let allGood = tenants?.length === 2;
  console.log(`  tenants: ${tenants?.length ?? 0}/2`);

  for (const t of tenants ?? []) {
    const { data: members, error: mErr } = await admin
      .from('profiles')
      .select('role')
      .eq('tenant_id', t.id);
    if (mErr) fail('verifying members', mErr.message);

    const roles = (members ?? []).map((m) => m.role as string).sort();
    const expected = ['admin', 'billing', 'doctor', 'nurse'];
    const ok = JSON.stringify(roles) === JSON.stringify(expected);
    if (!ok) allGood = false;
    console.log(`  ${t.name}: [${roles.join(', ')}] ${ok ? 'OK' : `EXPECTED [${expected.join(', ')}]`}`);
  }

  if (!allGood) {
    console.error('\nSeed finished but the dataset is not the expected 2 tenants x 4 roles.');
    process.exit(1);
  }

  console.log('\nSeed complete: 2 tenants x 4 roles (admin, doctor, nurse, billing).');
}

await main();
