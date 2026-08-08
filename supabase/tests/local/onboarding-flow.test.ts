/**
 * ONBOARDING + INVITE FLOW TEST  (phases.md Phase 1 DoD)
 *
 * Walks both onboarding paths end to end and asserts every documented error code
 * in docs/contracts/auth-tenancy.md is actually reachable. If a code is listed in
 * the contract but has no assertion here, Prince would be writing UI for an error
 * that may not exist — so this file doubles as the contract's proof.
 *
 * Run:  npm run verify:auth:local
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

async function rpc(sql: Sql, fn: string, args: string, params: unknown[]): Promise<Row> {
  const rows = await sql(`select public.${fn}(${args}) as r`, params);
  return rows[0].r as Row;
}

const h: Harness = await createHarness();

/* ========================================================================== */
section('1. Signup trigger — auth.users insert creates a pending profile');

const founderId = await h.signUp({ email: 'founder@clinic.test', fullName: 'Dr Asha Rao' });

let prof = await h.asOwner(`select id, tenant_id, role, full_name from public.profiles where id = $1`, [
  founderId,
]);
checkEqual('profile row auto-created', prof.length, 1);
checkEqual('tenant_id starts NULL', prof[0]?.tenant_id, null);
checkEqual("role starts 'pending'", prof[0]?.role, 'pending');
checkEqual('full_name lifted from user metadata', prof[0]?.full_name, 'Dr Asha Rao');

const noNameId = await h.signUp({ email: 'noname@clinic.test' });
prof = await h.asOwner(`select full_name from public.profiles where id = $1`, [noNameId]);
checkEqual('missing metadata name normalises to NULL', prof[0]?.full_name, null);

/* ========================================================================== */
section('2. create_tenant_and_assign_admin — validation');

await h.asUser({ id: founderId, email: 'founder@clinic.test' }, async (sql) => {
  const blank = await rpc(sql, 'create_tenant_and_assign_admin', '$1', ['   ']);
  checkEqual('blank name -> VALIDATION_ERROR', blank.code, 'VALIDATION_ERROR');
  checkEqual('...names the offending field', blank.fields, ['p_tenant_name']);

  const nullName = await rpc(sql, 'create_tenant_and_assign_admin', '$1', [null]);
  checkEqual('null name -> VALIDATION_ERROR', nullName.code, 'VALIDATION_ERROR');

  const tooLong = await rpc(sql, 'create_tenant_and_assign_admin', '$1', ['x'.repeat(121)]);
  checkEqual('121-char name -> VALIDATION_ERROR', tooLong.code, 'VALIDATION_ERROR');

  // Nothing should have been created by any of the rejected calls.
  const stillPending = await sql(`select role, tenant_id from public.profiles where id = $1`, [founderId]);
  checkEqual('caller still pending after failures', stillPending[0]?.role, 'pending');
});

const tenantCount = await h.asOwner(`select count(*)::int as n from public.tenants`);
checkEqual('no tenant rows left behind by rejected calls', tenantCount[0]?.n, 0);

/* ========================================================================== */
section('3. create_tenant_and_assign_admin — happy path');

const created = await h.asUser({ id: founderId, email: 'founder@clinic.test' }, (sql) =>
  rpc(sql, 'create_tenant_and_assign_admin', '$1', ['  Sunrise Clinic  ']),
);
check('returns ok', created.ok === true, JSON.stringify(created));
checkEqual('name is trimmed', created.tenant_name, 'Sunrise Clinic');
checkEqual('caller becomes admin', created.role, 'admin');
const tenantId = created.tenant_id as string;

prof = await h.asOwner(`select tenant_id, role from public.profiles where id = $1`, [founderId]);
checkEqual('profile.tenant_id persisted', prof[0]?.tenant_id, tenantId);
checkEqual('profile.role persisted as admin', prof[0]?.role, 'admin');

const tenantRow = await h.asOwner(`select tier from public.tenants where id = $1`, [tenantId]);
checkEqual('new tenant defaults to tier 1', Number(tenantRow[0]?.tier), 1);

await h.asUser({ id: founderId, email: 'founder@clinic.test' }, async (sql) => {
  const second = await rpc(sql, 'create_tenant_and_assign_admin', '$1', ['Another Clinic']);
  checkEqual('second call -> ALREADY_IN_TENANT', second.code, 'ALREADY_IN_TENANT');
});
checkEqual(
  'still exactly 1 tenant',
  (await h.asOwner(`select count(*)::int as n from public.tenants`))[0]?.n,
  1,
);

/* ========================================================================== */
section('4. create_invite — validation and duplicate handling');

await h.asUser({ id: founderId, email: 'founder@clinic.test' }, async (sql) => {
  const badEmail = await rpc(sql, 'create_invite', '$1, $2', ['not-an-email', 'nurse']);
  checkEqual('malformed email -> VALIDATION_ERROR', badEmail.code, 'VALIDATION_ERROR');

  const badRole = await rpc(sql, 'create_invite', '$1, $2', ['x@clinic.test', 'surgeon']);
  checkEqual('unknown role -> VALIDATION_ERROR', badRole.code, 'VALIDATION_ERROR');

  const pendingRole = await rpc(sql, 'create_invite', '$1, $2', ['x@clinic.test', 'pending']);
  checkEqual("role 'pending' -> VALIDATION_ERROR", pendingRole.code, 'VALIDATION_ERROR');

  const badTtl = await rpc(sql, 'create_invite', '$1, $2, $3', ['x@clinic.test', 'nurse', 0]);
  checkEqual('zero validity -> VALIDATION_ERROR', badTtl.code, 'VALIDATION_ERROR');

  const tooLongTtl = await rpc(sql, 'create_invite', '$1, $2, $3', ['x@clinic.test', 'nurse', 1000]);
  checkEqual('over-30-day validity -> VALIDATION_ERROR', tooLongTtl.code, 'VALIDATION_ERROR');
});

/* ========================================================================== */
section('5. Invite happy path — mixed-case email normalises');

const nurseInvite = await h.asUser({ id: founderId, email: 'founder@clinic.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['  NuRsE.Priya@Clinic.TEST  ', 'nurse']),
);
check('invite created', nurseInvite.ok === true, JSON.stringify(nurseInvite));
checkEqual('email lowercased and trimmed', nurseInvite.email, 'nurse.priya@clinic.test');
checkEqual('role recorded', nurseInvite.role, 'nurse');
check('token returned', typeof nurseInvite.token === 'string' && (nurseInvite.token as string).length === 36);
checkEqual('not flagged as a refresh', nurseInvite.refreshed, false);

await h.asUser({ id: founderId, email: 'founder@clinic.test' }, async (sql) => {
  const dup = await rpc(sql, 'create_invite', '$1, $2', ['nurse.priya@clinic.test', 'nurse']);
  checkEqual('duplicate outstanding invite -> INVITE_ALREADY_EXISTS', dup.code, 'INVITE_ALREADY_EXISTS');

  const dupDifferentCase = await rpc(sql, 'create_invite', '$1, $2', ['NURSE.PRIYA@CLINIC.TEST', 'doctor']);
  checkEqual(
    'duplicate detected across letter case -> INVITE_ALREADY_EXISTS',
    dupDifferentCase.code,
    'INVITE_ALREADY_EXISTS',
  );
});

/* ========================================================================== */
section('6. accept_invite — rejection paths');

// The nurse signs up. Note the *lowercase* address: the invite was created with
// mixed case, so this also proves normalisation makes the match work.
const nurseId = await h.signUp({ email: 'nurse.priya@clinic.test', fullName: 'Priya S' });
const strangerId = await h.signUp({ email: 'stranger@elsewhere.test' });
const unconfirmedId = await h.signUp({ email: 'unconfirmed@clinic.test', confirmed: false });

await h.asUser({ id: strangerId, email: 'stranger@elsewhere.test' }, async (sql) => {
  const unknown = await rpc(sql, 'accept_invite', '$1', ['00000000-0000-0000-0000-000000000000']);
  checkEqual('unknown token -> INVITE_NOT_FOUND', unknown.code, 'INVITE_NOT_FOUND');

  const nullToken = await rpc(sql, 'accept_invite', '$1', [null]);
  checkEqual('null token -> VALIDATION_ERROR', nullToken.code, 'VALIDATION_ERROR');

  const wrongPerson = await rpc(sql, 'accept_invite', '$1', [nurseInvite.token]);
  checkEqual('token used by wrong email -> INVITE_EMAIL_MISMATCH', wrongPerson.code, 'INVITE_EMAIL_MISMATCH');
  check(
    'mismatch message does not leak the invited address',
    !JSON.stringify(wrongPerson).includes('nurse.priya'),
  );
});

// Unconfirmed email must be refused even when the address matches.
const unconfInvite = await h.asUser({ id: founderId, email: 'founder@clinic.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['unconfirmed@clinic.test', 'billing']),
);
await h.asUser({ id: unconfirmedId, email: 'unconfirmed@clinic.test' }, async (sql) => {
  const res = await rpc(sql, 'accept_invite', '$1', [unconfInvite.token]);
  checkEqual('unconfirmed email -> EMAIL_NOT_CONFIRMED', res.code, 'EMAIL_NOT_CONFIRMED');
});

// Expiry: backdate the invite as owner (test setup, not a client-reachable path).
const expiringInvite = await h.asUser({ id: founderId, email: 'founder@clinic.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['late@clinic.test', 'doctor']),
);
const lateId = await h.signUp({ email: 'late@clinic.test' });
await h.asOwner(`update public.invites set expires_at = now() - interval '1 hour' where token = $1`, [
  expiringInvite.token,
]);
await h.asUser({ id: lateId, email: 'late@clinic.test' }, async (sql) => {
  const res = await rpc(sql, 'accept_invite', '$1', [expiringInvite.token]);
  checkEqual('expired token -> INVITE_EXPIRED', res.code, 'INVITE_EXPIRED');
});

/* ========================================================================== */
section('7. Stale-invite refresh rotates the token');

const refreshed = await h.asUser({ id: founderId, email: 'founder@clinic.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['late@clinic.test', 'doctor']),
);
check('re-inviting after expiry succeeds', refreshed.ok === true, JSON.stringify(refreshed));
checkEqual('flagged as a refresh', refreshed.refreshed, true);
check('token was rotated', refreshed.token !== expiringInvite.token);

await h.asUser({ id: lateId, email: 'late@clinic.test' }, async (sql) => {
  const old = await rpc(sql, 'accept_invite', '$1', [expiringInvite.token]);
  checkEqual('the OLD token is now dead -> INVITE_NOT_FOUND', old.code, 'INVITE_NOT_FOUND');

  const fresh = await rpc(sql, 'accept_invite', '$1', [refreshed.token]);
  check('the new token works', fresh.ok === true, JSON.stringify(fresh));
  checkEqual('joins the right tenant', fresh.tenant_id, tenantId);
  checkEqual('gets the invited role', fresh.role, 'doctor');
  checkEqual('tenant name returned for the welcome screen', fresh.tenant_name, 'Sunrise Clinic');
});

/* ========================================================================== */
section('8. accept_invite — happy path and single use');

await h.asUser({ id: nurseId, email: 'nurse.priya@clinic.test' }, async (sql) => {
  const res = await rpc(sql, 'accept_invite', '$1', [nurseInvite.token]);
  check('nurse accepts', res.ok === true, JSON.stringify(res));
  checkEqual('role applied', res.role, 'nurse');

  const again = await rpc(sql, 'accept_invite', '$1', [nurseInvite.token]);
  checkEqual('reusing a spent token -> INVITE_ALREADY_ACCEPTED', again.code, 'INVITE_ALREADY_ACCEPTED');
});

const stamped = await h.asOwner(
  `select accepted_at, accepted_by from public.invites where token = $1`,
  [nurseInvite.token],
);
check('accepted_at stamped', stamped[0]?.accepted_at !== null);
checkEqual('accepted_by records who spent it', stamped[0]?.accepted_by, nurseId);

await h.asUser({ id: founderId, email: 'founder@clinic.test' }, async (sql) => {
  const member = await rpc(sql, 'create_invite', '$1, $2', ['nurse.priya@clinic.test', 'doctor']);
  checkEqual('re-inviting someone already on staff -> ALREADY_MEMBER', member.code, 'ALREADY_MEMBER');
});

// A person already affiliated with one clinic cannot be absorbed into another,
// even holding a correctly-addressed, valid token. Realistic case: a doctor who
// works at two clinics gets invited to the second one. ALREADY_MEMBER (above) is
// scoped per tenant, so the second clinic CAN mint the invite — it is
// accept_invite that must refuse it. MVP scope is one tenant per user
// (Architecture.md §9: "no cross-tenant data sharing yet").
const otherAdminId = await h.signUp({ email: 'admin@other-clinic.test' });
const otherTenant = await h.asUser({ id: otherAdminId, email: 'admin@other-clinic.test' }, (sql) =>
  rpc(sql, 'create_tenant_and_assign_admin', '$1', ['Other Clinic']),
);
check('a second clinic exists', otherTenant.ok === true, JSON.stringify(otherTenant));

const crossInvite = await h.asUser({ id: otherAdminId, email: 'admin@other-clinic.test' }, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', ['nurse.priya@clinic.test', 'billing']),
);
check(
  'the second clinic can mint an invite for an already-affiliated person',
  crossInvite.ok === true,
  JSON.stringify(crossInvite),
);

await h.asUser({ id: nurseId, email: 'nurse.priya@clinic.test' }, async (sql) => {
  const res = await rpc(sql, 'accept_invite', '$1', [crossInvite.token]);
  checkEqual('...but redeeming it -> ALREADY_IN_TENANT', res.code, 'ALREADY_IN_TENANT');
  const unchanged = await sql(`select tenant_id from public.profiles where id = $1`, [nurseId]);
  checkEqual('...and their tenant is unchanged', unchanged[0]?.tenant_id, tenantId);
});

/* ========================================================================== */
section('9. admin_set_user_role');

await h.asUser({ id: founderId, email: 'founder@clinic.test' }, async (sql) => {
  const ok = await rpc(sql, 'admin_set_user_role', '$1, $2', [nurseId, 'billing']);
  check('admin changes a member role', ok.ok === true, JSON.stringify(ok));
  checkEqual('reports the change', ok.changed, true);

  const noop = await rpc(sql, 'admin_set_user_role', '$1, $2', [nurseId, 'billing']);
  checkEqual('setting the same role is a no-op success', noop.changed, false);

  const bad = await rpc(sql, 'admin_set_user_role', '$1, $2', [nurseId, 'pending']);
  checkEqual("cannot set 'pending' -> VALIDATION_ERROR", bad.code, 'VALIDATION_ERROR');

  const outsider = await rpc(sql, 'admin_set_user_role', '$1, $2', [strangerId, 'doctor']);
  checkEqual('non-member target -> USER_NOT_IN_TENANT', outsider.code, 'USER_NOT_IN_TENANT');

  const lastAdmin = await rpc(sql, 'admin_set_user_role', '$1, $2', [founderId, 'doctor']);
  checkEqual('sole admin cannot self-demote -> CANNOT_DEMOTE_LAST_ADMIN', lastAdmin.code, 'CANNOT_DEMOTE_LAST_ADMIN');

  // Promote a second admin, then the handover is allowed.
  const promote = await rpc(sql, 'admin_set_user_role', '$1, $2', [nurseId, 'admin']);
  check('second admin promoted', promote.ok === true);
  const handover = await rpc(sql, 'admin_set_user_role', '$1, $2', [founderId, 'doctor']);
  check('with two admins, handover succeeds', handover.ok === true, JSON.stringify(handover));
});

prof = await h.asOwner(`select role from public.profiles where id = $1`, [founderId]);
checkEqual('founder is now a doctor', prof[0]?.role, 'doctor');

await h.asUser({ id: founderId, email: 'founder@clinic.test' }, async (sql) => {
  const nowDemoted = await rpc(sql, 'create_invite', '$1, $2', ['someone@clinic.test', 'nurse']);
  checkEqual('demoted founder loses admin powers immediately', nowDemoted.code, 'NOT_ADMIN');
});

/* ========================================================================== */
section('10. Schema invariants — bad states are unrepresentable');

await checkRejects(
  'role without a tenant violates profiles_tenant_role_consistent',
  () => h.asOwner(`update public.profiles set role='doctor' where id=$1`, [noNameId]),
  '23514',
);
await checkRejects(
  'invalid role value violates profiles_role_valid',
  () => h.asOwner(`update public.profiles set role='surgeon' where id=$1`, [nurseId]),
  '23514',
);
await checkRejects(
  'blank tenant name violates tenants_name_not_blank',
  () => h.asOwner(`insert into public.tenants (name) values ('   ')`),
  '23514',
);
await checkRejects(
  'tier outside 1..3 violates tenants_tier_valid',
  () => h.asOwner(`insert into public.tenants (name, tier) values ('X', 9)`),
  '23514',
);
await checkRejects(
  'deleting a tenant that still has members is blocked',
  () => h.asOwner(`delete from public.tenants where id=$1`, [tenantId]),
  '23503',
);

// Cascade: removing the auth user removes the profile.
const throwawayId = await h.signUp({ email: 'throwaway@clinic.test' });
await h.asOwner(`delete from auth.users where id=$1`, [throwawayId]);
checkEqual(
  'deleting an auth user cascades to their profile',
  (await h.asOwner(`select count(*)::int as n from public.profiles where id=$1`, [throwawayId]))[0]?.n,
  0,
);

await h.close();
summary('Onboarding + invite flow (local / PGlite)');
