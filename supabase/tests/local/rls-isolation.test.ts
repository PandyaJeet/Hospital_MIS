/**
 * CROSS-TENANT ISOLATION TEST  (phases.md Phase 1 DoD, rules.md §4.2)
 *
 * Proves that a user in tenant A cannot see, modify, or infer anything about
 * tenant B — and that they cannot escalate their own privileges within their own
 * tenant either.
 *
 * Run:  npm run test:rls:local
 *
 * Fixtures are built through the REAL code paths (auth.users insert fires the
 * signup trigger; tenants are created via create_tenant_and_assign_admin; staff
 * join via create_invite + accept_invite). Nothing is hand-inserted with the
 * owner role, so the test exercises the same functions the frontend will call.
 *
 * NEGATIVE CONTROL: the final section disables RLS and re-runs the core
 * cross-tenant reads to confirm they then LEAK. Without that step this file
 * could pass for the wrong reason — e.g. if a fixture were silently empty,
 * "tenant A sees 0 rows of tenant B" would be vacuously true. The negative
 * control is what makes the positive result meaningful.
 */

import {
  createHarness,
  check,
  checkEqual,
  checkRejects,
  section,
  summary,
  type Harness,
  type Row,
  type Sql,
} from '../harness/pglite.ts';

/** Calls an RPC and returns the parsed jsonb envelope. */
async function rpc(sql: Sql, fn: string, args: string, params: unknown[]): Promise<Row> {
  const rows = await sql(`select public.${fn}(${args}) as r`, params);
  return rows[0].r as Row;
}

const h: Harness = await createHarness();

/* ========================================================================== */
/* Fixtures: two independent tenants, each with an admin and a doctor.         */
/* ========================================================================== */
section('Fixtures — building two tenants through the real onboarding RPCs');

const adminAId = await h.signUp({ email: 'admin-a@clinic-a.test', fullName: 'Admin A' });
const doctorAId = await h.signUp({ email: 'doctor-a@clinic-a.test', fullName: 'Doctor A' });
const adminBId = await h.signUp({ email: 'admin-b@clinic-b.test', fullName: 'Admin B' });
const doctorBId = await h.signUp({ email: 'doctor-b@clinic-b.test', fullName: 'Doctor B' });
const pendingId = await h.signUp({ email: 'nobody@nowhere.test', fullName: 'Unaffiliated' });

const createA = await h.asUser({ id: adminAId, email: 'admin-a@clinic-a.test' }, (sql) =>
  rpc(sql, 'create_tenant_and_assign_admin', '$1', ['Clinic A']),
);
check('tenant A created', createA.ok === true, JSON.stringify(createA));
const tenantAId = createA.tenant_id as string;

const createB = await h.asUser({ id: adminBId, email: 'admin-b@clinic-b.test' }, (sql) =>
  rpc(sql, 'create_tenant_and_assign_admin', '$1', ['Clinic B']),
);
check('tenant B created', createB.ok === true, JSON.stringify(createB));
const tenantBId = createB.tenant_id as string;

check('tenants are distinct', tenantAId !== tenantBId);

// Staff join via the invite flow.
const inviteDocA = await h.asUser({ id: adminAId, email: 'admin-a@clinic-a.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['doctor-a@clinic-a.test', 'doctor']),
);
check('invite minted for doctor A', inviteDocA.ok === true, JSON.stringify(inviteDocA));

const acceptDocA = await h.asUser({ id: doctorAId, email: 'doctor-a@clinic-a.test' }, (sql) =>
  rpc(sql, 'accept_invite', '$1', [inviteDocA.token]),
);
check('doctor A joined tenant A', acceptDocA.ok === true && acceptDocA.role === 'doctor', JSON.stringify(acceptDocA));

const inviteDocB = await h.asUser({ id: adminBId, email: 'admin-b@clinic-b.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['doctor-b@clinic-b.test', 'doctor']),
);
const acceptDocB = await h.asUser({ id: doctorBId, email: 'doctor-b@clinic-b.test' }, (sql) =>
  rpc(sql, 'accept_invite', '$1', [inviteDocB.token]),
);
check('doctor B joined tenant B', acceptDocB.ok === true, JSON.stringify(acceptDocB));

// One outstanding (unaccepted) invite in each tenant, to test invite isolation.
const openInviteA = await h.asUser({ id: adminAId, email: 'admin-a@clinic-a.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['nurse-a@clinic-a.test', 'nurse']),
);
const openInviteB = await h.asUser({ id: adminBId, email: 'admin-b@clinic-b.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['nurse-b@clinic-b.test', 'nurse']),
);
check('outstanding invites exist in both tenants', openInviteA.ok === true && openInviteB.ok === true);

// Ground truth, read as owner (bypasses RLS) so the assertions below are known
// to be filtering real data rather than an empty table.
const totals = await h.asOwner(
  `select (select count(*) from public.tenants)  as tenants,
          (select count(*) from public.profiles) as profiles,
          (select count(*) from public.invites)  as invites`,
);
checkEqual('ground truth: 2 tenants exist', Number(totals[0].tenants), 2);
checkEqual('ground truth: 5 profiles exist', Number(totals[0].profiles), 5);
checkEqual('ground truth: 4 invites exist', Number(totals[0].invites), 4);

/* ========================================================================== */
section('tenants — a user sees only their own tenant row');

await h.asUser({ id: adminAId }, async (sql) => {
  const rows = await sql(`select id, name, tier from public.tenants`);
  checkEqual('admin A sees exactly 1 tenant', rows.length, 1);
  checkEqual('...and it is Clinic A', rows[0]?.name, 'Clinic A');

  const targeted = await sql(`select id from public.tenants where id = $1`, [tenantBId]);
  checkEqual('admin A querying tenant B by id gets 0 rows', targeted.length, 0);
});

await h.asUser({ id: doctorAId }, async (sql) => {
  const rows = await sql(`select name from public.tenants`);
  checkEqual('doctor A sees exactly 1 tenant', rows.length, 1);
  checkEqual('...and it is Clinic A', rows[0]?.name, 'Clinic A');
});

await h.asUser({ id: pendingId }, async (sql) => {
  const rows = await sql(`select id from public.tenants`);
  checkEqual('pending user sees 0 tenants', rows.length, 0);
});

/* ========================================================================== */
section('profiles — tenant-scoped, admin-scoped, and self-scoped reads');

await h.asUser({ id: adminAId }, async (sql) => {
  const rows = await sql(`select id, role from public.profiles order by role`);
  checkEqual('admin A sees exactly the 2 members of tenant A', rows.length, 2);
  check(
    'admin A sees no tenant B member',
    !rows.some((r) => r.id === adminBId || r.id === doctorBId),
  );

  const targeted = await sql(`select id from public.profiles where id = $1`, [doctorBId]);
  checkEqual('admin A querying doctor B by id gets 0 rows', targeted.length, 0);

  const byTenant = await sql(`select id from public.profiles where tenant_id = $1`, [tenantBId]);
  checkEqual('admin A filtering profiles by tenant B gets 0 rows', byTenant.length, 0);
});

await h.asUser({ id: doctorAId }, async (sql) => {
  const rows = await sql(`select id from public.profiles`);
  checkEqual('doctor A (non-admin) sees only their own profile', rows.length, 1);
  checkEqual('...and it is their own row', rows[0]?.id, doctorAId);
});

await h.asUser({ id: pendingId }, async (sql) => {
  const rows = await sql(`select id, role, tenant_id from public.profiles`);
  checkEqual('pending user sees only their own profile', rows.length, 1);
  checkEqual('...still role=pending', rows[0]?.role, 'pending');
  checkEqual('...still tenant_id=null', rows[0]?.tenant_id, null);
});

/* ========================================================================== */
section('invites — readable only by an admin of the owning tenant');

await h.asUser({ id: adminAId }, async (sql) => {
  const rows = await sql(`select tenant_id, email from public.invites`);
  check('admin A sees only tenant A invites', rows.every((r) => r.tenant_id === tenantAId));
  check('admin A sees at least one invite', rows.length > 0);

  const byToken = await sql(`select id from public.invites where token = $1`, [openInviteB.token]);
  checkEqual("admin A looking up tenant B's invite token gets 0 rows", byToken.length, 0);

  const byTenant = await sql(`select id from public.invites where tenant_id = $1`, [tenantBId]);
  checkEqual('admin A filtering invites by tenant B gets 0 rows', byTenant.length, 0);
});

await h.asUser({ id: doctorAId }, async (sql) => {
  const rows = await sql(`select id from public.invites`);
  checkEqual('doctor A (non-admin) sees 0 invites even in own tenant', rows.length, 0);
});

/* ========================================================================== */
section('anon — no tenancy surface at all');

await h.asAnon(async (sql) => {
  await checkRejects('anon cannot read tenants', () => sql(`select id from public.tenants`), '42501');
  await checkRejects('anon cannot read profiles', () => sql(`select id from public.profiles`), '42501');
  await checkRejects('anon cannot read invites', () => sql(`select id from public.invites`), '42501');
  await checkRejects(
    'anon cannot call create_tenant_and_assign_admin',
    () => sql(`select public.create_tenant_and_assign_admin('Hostile Clinic')`),
    '42501',
  );
  await checkRejects(
    'anon cannot call accept_invite',
    () => sql(`select public.accept_invite($1)`, [openInviteA.token]),
    '42501',
  );
});

/* ========================================================================== */
section('privilege escalation — the attacks column grants are there to stop');

await h.asUser({ id: doctorAId }, async (sql) => {
  await checkRejects(
    'doctor A cannot promote themselves to admin (no UPDATE on profiles.role)',
    () => sql(`update public.profiles set role = 'admin' where id = $1`, [doctorAId]),
    '42501',
  );
  await checkRejects(
    'doctor A cannot move themselves into tenant B (no UPDATE on profiles.tenant_id)',
    () => sql(`update public.profiles set tenant_id = $1 where id = $2`, [tenantBId, doctorAId]),
    '42501',
  );
  // The one write they DO have.
  const renamed = await sql(
    `update public.profiles set full_name = 'Dr A Renamed' where id = $1 returning full_name`,
    [doctorAId],
  );
  checkEqual('doctor A can rename themselves', renamed[0]?.full_name, 'Dr A Renamed');

  await checkRejects(
    'doctor A cannot insert an invite (not an admin)',
    () =>
      sql(`insert into public.invites (tenant_id, email, role, invited_by) values ($1,$2,$3,$4)`, [
        tenantAId,
        'sneak@clinic-a.test',
        'admin',
        doctorAId,
      ]),
    '42501',
  );

  const notAdmin = await rpc(sql, 'create_invite', '$1, $2', ['x@clinic-a.test', 'doctor']);
  checkEqual('doctor A calling create_invite returns NOT_ADMIN', notAdmin.code, 'NOT_ADMIN');

  const notAdmin2 = await rpc(sql, 'admin_set_user_role', '$1, $2', [doctorAId, 'admin']);
  checkEqual('doctor A calling admin_set_user_role returns NOT_ADMIN', notAdmin2.code, 'NOT_ADMIN');
});

await h.asUser({ id: adminAId }, async (sql) => {
  await checkRejects(
    'admin A cannot raise their own tenant tier (no UPDATE on tenants.tier)',
    () => sql(`update public.tenants set tier = 3 where id = $1`, [tenantAId]),
    '42501',
  );

  const renameB = await sql(`update public.tenants set name = 'Pwned' where id = $1 returning id`, [
    tenantBId,
  ]);
  checkEqual('admin A renaming tenant B affects 0 rows', renameB.length, 0);

  await checkRejects(
    'admin A cannot create an invite into tenant B (WITH CHECK)',
    () =>
      sql(`insert into public.invites (tenant_id, email, role, invited_by) values ($1,$2,$3,$4)`, [
        tenantBId,
        'infiltrator@clinic-b.test',
        'admin',
        adminAId,
      ]),
    '42501',
  );

  const delB = await sql(`delete from public.invites where tenant_id = $1 returning id`, [tenantBId]);
  checkEqual("admin A deleting tenant B's invites affects 0 rows", delB.length, 0);

  const crossRole = await rpc(sql, 'admin_set_user_role', '$1, $2', [doctorBId, 'billing']);
  checkEqual(
    'admin A changing doctor B\'s role returns USER_NOT_IN_TENANT',
    crossRole.code,
    'USER_NOT_IN_TENANT',
  );

  const already = await rpc(sql, 'create_tenant_and_assign_admin', '$1', ['Second Clinic']);
  checkEqual('admin A cannot found a second tenant', already.code, 'ALREADY_IN_TENANT');

  const lastAdmin = await rpc(sql, 'admin_set_user_role', '$1, $2', [adminAId, 'doctor']);
  checkEqual(
    'admin A cannot demote themselves as the only admin',
    lastAdmin.code,
    'CANNOT_DEMOTE_LAST_ADMIN',
  );
});

// A stolen token is useless to the wrong person.
await h.asUser({ id: pendingId, email: 'nobody@nowhere.test' }, async (sql) => {
  const stolen = await rpc(sql, 'accept_invite', '$1', [openInviteB.token]);
  checkEqual(
    'pending user redeeming a token addressed to someone else is rejected',
    stolen.code,
    'INVITE_EMAIL_MISMATCH',
  );
  const stillPending = await sql(`select role, tenant_id from public.profiles where id = $1`, [
    pendingId,
  ]);
  checkEqual('...and they remain pending', stillPending[0]?.role, 'pending');
  checkEqual('...with no tenant', stillPending[0]?.tenant_id, null);
});

/* ========================================================================== */
/* NEGATIVE CONTROL                                                           */
/* ========================================================================== */
section('NEGATIVE CONTROL — confirm these assertions actually depend on RLS');

// Turn RLS off exactly as a careless migration might, then re-run the two
// headline cross-tenant reads. They MUST leak now. If they still returned the
// isolated result, the assertions above would be worthless.
await h.asOwner(`alter table public.tenants  disable row level security`);
await h.asOwner(`alter table public.profiles disable row level security`);
await h.asOwner(`alter table public.invites  disable row level security`);

let leakedTenants = 0;
let leakedProfiles = 0;
let leakedInvites = 0;

await h.asUser({ id: doctorAId }, async (sql) => {
  leakedTenants = (await sql(`select id from public.tenants`)).length;
  leakedProfiles = (await sql(`select id from public.profiles`)).length;
  leakedInvites = (await sql(`select id from public.invites`)).length;
});

check(
  'with RLS disabled, doctor A DOES see both tenants (proves the test detects RLS)',
  leakedTenants === 2,
  `saw ${leakedTenants} tenants, expected 2`,
);
check(
  'with RLS disabled, doctor A DOES see all 5 profiles',
  leakedProfiles === 5,
  `saw ${leakedProfiles} profiles, expected 5`,
);
check(
  'with RLS disabled, doctor A DOES see all 4 invites',
  leakedInvites === 4,
  `saw ${leakedInvites} invites, expected 4`,
);

// Restore, and re-assert isolation to prove the control was reversible.
await h.asOwner(`alter table public.tenants  enable row level security`);
await h.asOwner(`alter table public.profiles enable row level security`);
await h.asOwner(`alter table public.invites  enable row level security`);

await h.asUser({ id: doctorAId }, async (sql) => {
  checkEqual('RLS re-enabled: doctor A back to 1 tenant', (await sql(`select id from public.tenants`)).length, 1);
  checkEqual('RLS re-enabled: doctor A back to 1 profile', (await sql(`select id from public.profiles`)).length, 1);
  checkEqual('RLS re-enabled: doctor A back to 0 invites', (await sql(`select id from public.invites`)).length, 0);
});

await h.close();
summary('Cross-tenant isolation (local / PGlite)');
