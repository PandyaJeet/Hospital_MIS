/**
 * CROSS-TENANT ISOLATION — against the REAL linked Supabase project.
 *
 *   npm run db:seed:reset      # must run first: creates 2 tenants x 4 roles
 *   npm run test:rls:remote
 *   # or both:  npm run verify:remote
 *
 * This is the companion to supabase/tests/local/rls-isolation.test.ts. The local
 * suite proves the SQL and the policy logic are correct against a real Postgres
 * engine, with zero credentials required. This one closes the gaps the local
 * harness cannot reach, because it goes through the actual stack:
 *
 *   - real GoTrue sessions (signInWithPassword), not simulated JWT claims
 *   - real PostgREST, so grant/policy denials are observed as HTTP 401/403/404
 *     and PostgrestError codes — the exact shapes Prince has to map in the UI
 *   - the project's real auth schema and its real default privileges
 *
 * Both suites assert the same security properties on purpose. If they ever
 * disagree, the local harness's fidelity assumptions (documented in
 * supabase/tests/harness/supabase-preamble.sql) are what to suspect first.
 *
 * Uses only the publishable/anon key. No service-role key anywhere in this file —
 * the point is to observe what a genuine end-user session can and cannot do.
 */

import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { anonKey, requireEnv, supabaseUrl } from '../../scripts/env.ts';
import { SEED_TENANTS, tenantAdmin } from '../../scripts/fixtures.ts';
import { check, checkEqual, section, summary } from '../harness/assert.ts';

const URL = supabaseUrl();
const ANON = anonKey();
const PASSWORD = requireEnv('SEED_USER_PASSWORD');

const [tenantAFixture, tenantBFixture] = SEED_TENANTS;

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) {
    console.error(`\nCould not sign in as ${email}: ${error.message}`);
    console.error('Run `npm run db:seed:reset` first, and confirm SEED_USER_PASSWORD matches.\n');
    process.exit(1);
  }
  return client;
}

/** True when the error is a permission/RLS style denial rather than a bug. */
function isDenial(error: PostgrestError | null): boolean {
  if (!error) return false;
  return error.code === '42501' || error.code === 'PGRST301' || /permission denied|row-level security/i.test(error.message);
}

section('Setup — sign in as one admin and one doctor from each tenant');

const adminA = await signIn(tenantAdmin(tenantAFixture).email);
const adminB = await signIn(tenantAdmin(tenantBFixture).email);
const doctorAEmail = tenantAFixture.users.find((u) => u.role === 'doctor')!.email;
const doctorBEmail = tenantBFixture.users.find((u) => u.role === 'doctor')!.email;
const doctorA = await signIn(doctorAEmail);
const doctorB = await signIn(doctorBEmail);
check('four real sessions established', true);

// Discover each tenant's id through its own admin's session.
const { data: profA, error: profAErr } = await adminA.from('profiles').select('id, tenant_id, role').eq('role', 'admin').maybeSingle();
const { data: profB, error: profBErr } = await adminB.from('profiles').select('id, tenant_id, role').eq('role', 'admin').maybeSingle();
check('admin A can read own profile', !profAErr && !!profA?.tenant_id, profAErr?.message);
check('admin B can read own profile', !profBErr && !!profB?.tenant_id, profBErr?.message);

const tenantAId = profA!.tenant_id as string;
const tenantBId = profB!.tenant_id as string;
const adminAId = profA!.id as string;
check('the two tenants are distinct', tenantAId !== tenantBId);

const { data: docBProf } = await doctorB.from('profiles').select('id').maybeSingle();
const doctorBId = docBProf?.id as string;
check('doctor B id resolved from their own session', typeof doctorBId === 'string');

/* ========================================================================== */
section('tenants — only your own row is visible');

{
  const { data, error } = await adminA.from('tenants').select('id, name, tier');
  check('admin A can read tenants', !error, error?.message);
  checkEqual('admin A sees exactly 1 tenant', data?.length, 1);
  checkEqual('...and it is their own', data?.[0]?.id, tenantAId);

  const targeted = await adminA.from('tenants').select('id').eq('id', tenantBId);
  checkEqual('admin A querying tenant B by id gets 0 rows', targeted.data?.length, 0);

  const all = await doctorA.from('tenants').select('id');
  checkEqual('doctor A also sees only 1 tenant', all.data?.length, 1);
}

/* ========================================================================== */
section('profiles — admin sees their tenant, staff see only themselves');

{
  const { data, error } = await adminA.from('profiles').select('id, role, tenant_id');
  check('admin A can list profiles', !error, error?.message);
  checkEqual('admin A sees all 4 members of tenant A', data?.length, 4);
  check('every visible profile belongs to tenant A', (data ?? []).every((p) => p.tenant_id === tenantAId));
  check('no tenant B member is visible', !(data ?? []).some((p) => p.id === doctorBId));

  const targeted = await adminA.from('profiles').select('id').eq('id', doctorBId);
  checkEqual('admin A querying doctor B by id gets 0 rows', targeted.data?.length, 0);

  const byTenant = await adminA.from('profiles').select('id').eq('tenant_id', tenantBId);
  checkEqual('admin A filtering by tenant B gets 0 rows', byTenant.data?.length, 0);

  const self = await doctorA.from('profiles').select('id, role');
  checkEqual('doctor A (non-admin) sees only their own profile', self.data?.length, 1);
  checkEqual('...with role doctor', self.data?.[0]?.role, 'doctor');
}

/* ========================================================================== */
section('invites — admin-only, tenant-scoped');

{
  // Mint one in each tenant so there is something real to fail to see.
  const mkA = await adminA.rpc('create_invite', { p_email: 'probe-a@hmis-seed.example.com', p_role: 'nurse' });
  const mkB = await adminB.rpc('create_invite', { p_email: 'probe-b@hmis-seed.example.com', p_role: 'nurse' });
  const inviteA = mkA.data as { ok: boolean; token?: string; code?: string };
  const inviteB = mkB.data as { ok: boolean; token?: string; code?: string };
  check('admin A minted an invite', inviteA?.ok === true || inviteA?.code === 'INVITE_ALREADY_EXISTS', JSON.stringify(inviteA));
  check('admin B minted an invite', inviteB?.ok === true || inviteB?.code === 'INVITE_ALREADY_EXISTS', JSON.stringify(inviteB));

  const { data, error } = await adminA.from('invites').select('id, tenant_id, email');
  check('admin A can list invites', !error, error?.message);
  check('all visible invites belong to tenant A', (data ?? []).every((i) => i.tenant_id === tenantAId));
  check('admin A sees at least one invite', (data?.length ?? 0) > 0);

  if (inviteB?.token) {
    const byToken = await adminA.from('invites').select('id').eq('token', inviteB.token);
    checkEqual("admin A looking up tenant B's token gets 0 rows", byToken.data?.length, 0);
  }

  const byTenant = await adminA.from('invites').select('id').eq('tenant_id', tenantBId);
  checkEqual('admin A filtering invites by tenant B gets 0 rows', byTenant.data?.length, 0);

  const docView = await doctorA.from('invites').select('id');
  checkEqual('doctor A sees 0 invites even in own tenant', docView.data?.length, 0);

  // Clean up the probe invites so repeated runs stay idempotent.
  await adminA.from('invites').delete().eq('email', 'probe-a@hmis-seed.example.com');
  await adminB.from('invites').delete().eq('email', 'probe-b@hmis-seed.example.com');
}

/* ========================================================================== */
section('anon — no tenancy surface');

{
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  for (const table of ['tenants', 'profiles', 'invites'] as const) {
    const { data, error } = await anon.from(table).select('id');
    check(
      `anon reading ${table} is denied or empty`,
      isDenial(error) || (data?.length ?? 0) === 0,
      error ? `code=${error.code} ${error.message}` : `returned ${data?.length} rows`,
    );
  }
  const { error: rpcErr } = await anon.rpc('create_tenant_and_assign_admin', { p_tenant_name: 'Hostile' });
  check('anon cannot call create_tenant_and_assign_admin', !!rpcErr, rpcErr ? undefined : 'call unexpectedly succeeded');
}

/* ========================================================================== */
section('privilege escalation — blocked at the database, not the UI');

{
  const selfPromote = await doctorA.from('profiles').update({ role: 'admin' }).eq('id', (await doctorA.from('profiles').select('id').maybeSingle()).data?.id as string);
  check(
    'doctor A cannot promote themselves to admin',
    isDenial(selfPromote.error) || selfPromote.error !== null,
    selfPromote.error ? `code=${selfPromote.error.code}` : 'update unexpectedly succeeded',
  );

  const moveTenant = await doctorA.from('profiles').update({ tenant_id: tenantBId }).eq('tenant_id', tenantAId);
  check(
    'doctor A cannot move themselves into tenant B',
    moveTenant.error !== null,
    moveTenant.error ? `code=${moveTenant.error.code}` : 'update unexpectedly succeeded',
  );

  const raiseTier = await adminA.from('tenants').update({ tier: 3 }).eq('id', tenantAId);
  check(
    'admin A cannot raise their own tenant tier',
    raiseTier.error !== null,
    raiseTier.error ? `code=${raiseTier.error.code}` : 'update unexpectedly succeeded',
  );

  const renameB = await adminA.from('tenants').update({ name: 'Pwned' }).eq('id', tenantBId).select('id');
  checkEqual('admin A renaming tenant B affects 0 rows', renameB.data?.length ?? 0, 0);

  const forgeInvite = await adminA
    .from('invites')
    .insert({ tenant_id: tenantBId, email: 'infiltrator@hmis-seed.example.com', role: 'admin', invited_by: adminAId })
    .select('id');
  check(
    'admin A cannot create an invite into tenant B',
    forgeInvite.error !== null,
    forgeInvite.error ? `code=${forgeInvite.error.code}` : 'insert unexpectedly succeeded',
  );

  const crossRole = await adminA.rpc('admin_set_user_role', { p_user_id: doctorBId, p_role: 'billing' });
  checkEqual(
    "admin A changing doctor B's role returns USER_NOT_IN_TENANT",
    (crossRole.data as { code?: string })?.code,
    'USER_NOT_IN_TENANT',
  );

  const secondTenant = await adminA.rpc('create_tenant_and_assign_admin', { p_tenant_name: 'Sneaky Second' });
  checkEqual(
    'admin A cannot found a second tenant',
    (secondTenant.data as { code?: string })?.code,
    'ALREADY_IN_TENANT',
  );

  const doctorInvite = await doctorA.rpc('create_invite', { p_email: 'x@hmis-seed.example.com', p_role: 'doctor' });
  checkEqual('doctor A calling create_invite returns NOT_ADMIN', (doctorInvite.data as { code?: string })?.code, 'NOT_ADMIN');
}

/* ========================================================================== */
section('the one write a staff member does have');

{
  const { data: me } = await doctorA.from('profiles').select('id, full_name').maybeSingle();
  const original = me?.full_name as string | null;
  const renamed = await doctorA.from('profiles').update({ full_name: 'Renamed By Self' }).eq('id', me?.id as string).select('full_name');
  check('doctor A can update their own full_name', !renamed.error && renamed.data?.[0]?.full_name === 'Renamed By Self', renamed.error?.message);
  // Restore so the seed dataset stays as documented.
  await doctorA.from('profiles').update({ full_name: original }).eq('id', me?.id as string);
}

for (const c of [adminA, adminB, doctorA, doctorB]) await c.auth.signOut();

summary('Cross-tenant isolation (remote / real Supabase project)');
