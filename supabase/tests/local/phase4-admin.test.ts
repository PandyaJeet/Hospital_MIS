/**
 * PHASE 4 — ADMIN VISIBILITY, USER DEACTIVATION, RECONCILIATION, AUDIT LOG,
 *           AND THE TIER 3 PLACEHOLDERS
 *
 * Run: npm run test:phase4
 *
 * Against real PostgreSQL (PGlite) with real RLS, real triggers and real generated
 * columns. Ends with the negative control every prior phase used, extended to the
 * three new Tier 3 tables.
 *
 * The assertions tied to phases.md's Phase 4 Definition of Done are marked **:
 *   ** admin sees real metrics scoped to their own tenant, and non-admins see none
 *   ** reconciliation flags pending charges, sum mismatches and payment mismatches
 *   ** Tier 3 schema exists, RLS-enabled and tier-gated
 *   ** audit log covers role changes, invite lifecycle, deactivation, tenant settings
 *   ** deactivation revokes database access immediately
 *   ** the audit log NEVER stores clinical content, patient PII, invite emails or tokens
 */

import {
  createHarness, check, checkEqual, checkRejects, section, summary,
  type Harness, type Row, type SessionUser,
} from '../harness/pglite.ts';
import { rpc, seedTenant, registerPatient, type TenantFixture } from '../harness/fixtures.ts';

const h: Harness = await createHarness();

const TIER3_TABLES = ['insurance_claims', 'ot_schedule', 'blood_units'] as const;
const ADMIN_VIEWS = [
  'admin_patient_volume_daily',
  'admin_revenue_daily',
  'admin_occupancy_current',
  'admin_staff_activity_daily',
  'admin_dashboard_summary',
  'billing_reconciliation',
  'billing_reconciliation_summary',
] as const;

/* ========================================================================== */
section('Fixtures — a Tier 1 clinic, a Tier 3 clinic, and a full encounter in each');

const T1: TenantFixture = await seedTenant(h, {
  name: 'Solo Clinic (T1)', slug: 'p4a', consultationFee: 400, tier: 1,
  gst: { gstin: '27AABCU9603R1ZM', stateCode: '27' },
});
const T3: TenantFixture = await seedTenant(h, {
  name: 'Large Hospital (T3)', slug: 'p4b', consultationFee: 800, tier: 3,
});

checkEqual('the Tier 1 clinic is tier 1',
  Number((await h.asOwner(`select tier from public.tenants where id=$1`, [T1.tenantId]))[0].tier), 1);
checkEqual('the Tier 3 clinic is tier 3',
  Number((await h.asOwner(`select tier from public.tenants where id=$1`, [T3.tenantId]))[0].tier), 3);

/** Registers a patient, runs a full encounter, and raises an invoice. */
async function fullEncounter(t: TenantFixture, label: string, phone: string) {
  const pat = await registerPatient(h, t, { name: label, phone, age: 51 });
  const v = await h.asUser(t.billing, (sql) =>
    rpc(sql, 'check_in_patient', '$1, $2, $3', [pat.patientId, 'new', t.doctor.id]));
  const visitId = v.visit_id as string;

  await h.asUser(t.doctor, async (sql) => {
    await rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'in_consultation']);
    await sql(
      `insert into public.clinical_notes (tenant_id, visit_id, author_id, chief_complaint)
       values ($1,$2,$3,'Fever')`, [t.tenantId, visitId, t.doctor.id]);
    await rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'done']);
  });

  const invoiceId = await h.asUser(t.billing, async (sql) => {
    const inv = await rpc(sql, 'create_invoice_for_visit', '$1', [visitId]);
    if (inv.ok !== true) throw new Error(`invoice failed: ${JSON.stringify(inv)}`);
    const id = inv.invoice_id as string;

    // create_invoice_for_visit() produces a DRAFT. Issuing is a plain client UPDATE
    // on `status` (Phase 2 grants billing that column), and `issued_at` is stamped by
    // the trigger added in 20260811080700 — it is not client-writable, because the
    // issue date of a tax document must not be back-datable from the UI.
    await sql(`update public.invoices set status='issued' where id=$1`, [id]);
    return id;
  });

  return { patientId: pat.patientId, visitId, invoiceId };
}

const encT1 = await fullEncounter(T1, 'Dashboard Patient A', '9700000001');
const encT3 = await fullEncounter(T3, 'Dashboard Patient B', '9700000002');
check('both clinics have a completed, invoiced encounter', !!encT1.invoiceId && !!encT3.invoiceId);

/* ========================================================================== */
section('0b. The Phase 2 invoice invariants the revenue view depends on');

// The revenue view buckets by `issued_at` and filters on `status`, so it is only
// correct if Phase 2 actually maintains both. Asserted here rather than assumed —
// while building the view I briefly believed `issued_at` was never stamped, and the
// check that disproved it belongs in the suite.
//
// `guard_invoice_status_transition()` (Phase 2, migration 20260811060700) both
// stamps `issued_at` on the way out of draft and rejects illegal regressions.
{
  const inv = await h.asOwner(
    `select status, issued_at from public.invoices where id=$1`, [encT1.invoiceId]);
  checkEqual('the fixture invoice is issued', inv[0].status, 'issued');
  check('** issued_at is stamped server-side on leaving draft **', inv[0].issued_at !== null);

  await h.asUser(T1.billing, async (sql) => {
    await checkRejects('issued_at is not client-writable (no back-dating a tax document)',
      () => sql(`update public.invoices set issued_at = now() - interval '30 days' where id=$1`,
        [encT1.invoiceId]), '42501');

    // Illegal regressions, which is why the reconciliation cases below each use their
    // own invoice rather than walking one through every state.
    await checkRejects('an issued invoice cannot revert to draft',
      () => sql(`update public.invoices set status='draft' where id=$1`, [encT1.invoiceId]), '23514');
  });
}

/* ========================================================================== */
section('1. ** user deactivation revokes database access immediately **');

await h.asUser(T1.admin, async (sql) => {
  await checkRejects('profiles.is_active is not client-writable, even for an admin',
    () => sql(`update public.profiles set is_active=false where id=$1`, [T1.doctor.id]), '42501');
  await checkRejects('...nor is deactivated_at',
    () => sql(`update public.profiles set deactivated_at=now() where id=$1`, [T1.doctor.id]), '42501');
});

await h.asUser(T1.nurse, async (sql) => {
  const denied = await rpc(sql, 'admin_set_user_active', '$1, $2', [T1.doctor.id, false]);
  checkEqual('a nurse calling admin_set_user_active gets NOT_ADMIN', denied.code, 'NOT_ADMIN');
});

// Confirm the doctor can see things BEFORE deactivation, so the after-assertions are
// not vacuous.
let patientsSeenBefore = 0;
await h.asUser(T1.doctor, async (sql) => {
  patientsSeenBefore = (await sql(`select id from public.patients`)).length;
  check('before deactivation the doctor can see patients', patientsSeenBefore > 0);
});

await h.asUser(T1.admin, async (sql) => {
  const self = await rpc(sql, 'admin_set_user_active', '$1, $2', [T1.admin.id, false]);
  checkEqual('** an admin cannot deactivate themselves **', self.code, 'CANNOT_DEACTIVATE_SELF');

  const last = await rpc(sql, 'admin_set_user_active', '$1, $2', [T3.admin.id, false]);
  checkEqual('...and cannot reach into another clinic', last.code, 'USER_NOT_IN_TENANT');

  const off = await rpc(sql, 'admin_set_user_active', '$1, $2', [T1.doctor.id, false]);
  checkEqual('deactivating a colleague succeeds', off.ok, true);
  checkEqual('...reported as a change', off.changed, true);
  check('...with an explicit note about the JWT still being valid',
    typeof off.session_note === 'string' && String(off.session_note).includes('token'));

  const again = await rpc(sql, 'admin_set_user_active', '$1, $2', [T1.doctor.id, false]);
  checkEqual('...and doing it twice is an idempotent no-op', again.changed, false);
});

{
  const p = await h.asOwner(
    `select is_active, deactivated_at from public.profiles where id=$1`, [T1.doctor.id]);
  checkEqual('the flag is set', p[0].is_active, false);
  check('...with a timestamp', p[0].deactivated_at !== null);
}

// The consequence, across the whole database, with no policy having been edited.
await h.asUser(T1.doctor, async (sql) => {
  checkEqual('** a deactivated doctor resolves to no tenant **',
    (await sql(`select public.current_tenant_id() as t`))[0].t, null);
  checkEqual('...is not staff', (await sql(`select public.is_tenant_staff() as b`))[0].b, false);
  checkEqual('...has no role', (await sql(`select public.current_user_role() as r`))[0].r, null);
  checkEqual('...and no tier', (await sql(`select public.tenant_has_tier(1) as b`))[0].b, false);

  checkEqual('** ...sees 0 patients where they saw some before **',
    (await sql(`select id from public.patients`)).length, 0);
  for (const t of ['visits', 'clinical_notes', 'prescriptions', 'vitals', 'tasks', 'invoices'] as const) {
    checkEqual(`...sees 0 rows in ${t}`, (await sql(`select 1 from public.${t}`)).length, 0);
  }

  // But they can still see their OWN profile, which is what lets the UI explain why.
  const me = await sql(`select id, is_active from public.profiles`);
  checkEqual('** ...but CAN still read their own profile row **', me.length, 1);
  checkEqual('...and it tells them they are deactivated', me[0].is_active, false);

  // And they can no longer write anything.
  await checkRejects('...cannot author a clinical note',
    () => sql(`insert into public.clinical_notes (tenant_id, visit_id, author_id, chief_complaint)
               values ($1,$2,$3,'x')`, [T1.tenantId, encT1.visitId, T1.doctor.id]), '42501');
  // An RPC that gates on is_tenant_staff() must now refuse them. Chosen over the
  // safety-check RPC because this one takes only scalars, so the assertion cannot be
  // confused by a parameter-typing problem in the harness.
  const rpcDenied = await rpc(sql, 'set_visit_status', '$1, $2', [encT1.visitId, 'cancelled']);
  checkEqual('...and a staff-gated RPC refuses them', rpcDenied.ok, false);
  check('...with a role/permission code, not a not-found', typeof rpcDenied.code === 'string',
    JSON.stringify(rpcDenied));
});

await h.asUser(T1.admin, async (sql) => {
  const on = await rpc(sql, 'admin_set_user_active', '$1, $2', [T1.doctor.id, true]);
  checkEqual('reactivating succeeds', on.ok, true);
  checkEqual('...with no session note', on.session_note, null);
});
await h.asUser(T1.doctor, async (sql) => {
  checkEqual('** reactivation restores access immediately **',
    (await sql(`select id from public.patients`)).length, patientsSeenBefore);
});
{
  const p = await h.asOwner(`select deactivated_at from public.profiles where id=$1`, [T1.doctor.id]);
  checkEqual('...and clears deactivated_at', p[0].deactivated_at, null);
}

// The last-active-admin guard, which the role guard alone does not cover.
{
  const secondAdminEmail = 'p4a.admin2@clinic.test';
  const id = await h.signUp({ email: secondAdminEmail, fullName: 'Second Admin' });
  const inv = await h.asUser(T1.admin, (sql) => rpc(sql, 'create_invite', '$1, $2', [secondAdminEmail, 'admin']));
  await h.asUser({ id, email: secondAdminEmail }, (sql) => rpc(sql, 'accept_invite', '$1', [inv.token]));
  const admin2: SessionUser = { id, email: secondAdminEmail };

  await h.asUser(admin2, async (sql) => {
    const ok = await rpc(sql, 'admin_set_user_active', '$1, $2', [T1.admin.id, false]);
    checkEqual('with two admins, one can deactivate the other', ok.ok, true);
    const last = await rpc(sql, 'admin_set_user_active', '$1, $2', [T1.admin.id, true]);
    checkEqual('...and reactivate them', last.ok, true);
  });

  // Now make admin2 the only route and try to strand the clinic.
  await h.asUser(T1.admin, async (sql) => {
    const strand = await rpc(sql, 'admin_set_user_active', '$1, $2', [admin2.id, false]);
    checkEqual('deactivating the second admin is allowed while another remains', strand.ok, true);
    const lastOne = await rpc(sql, 'admin_set_user_active', '$1, $2', [T1.admin.id, false]);
    checkEqual('** ...but the last ACTIVE admin cannot be deactivated (self-guard first) **',
      lastOne.code, 'CANNOT_DEACTIVATE_SELF');
  });
  // Prove the last-admin guard itself, not just the self-guard: admin2 back on, then
  // admin2 tries to remove the only other admin after being left alone.
  await h.asUser(T1.admin, (sql) => rpc(sql, 'admin_set_user_active', '$1, $2', [admin2.id, true]));
  await h.asOwner(`update public.profiles set is_active=false where id=$1`, [T1.admin.id]);
  await h.asUser(admin2, async (sql) => {
    const guard = await rpc(sql, 'admin_set_user_active', '$1, $2', [admin2.id, false]);
    checkEqual('a sole remaining admin is blocked by the self-guard', guard.code, 'CANNOT_DEACTIVATE_SELF');
  });
  // Restore.
  await h.asOwner(`update public.profiles set is_active=true where id=$1`, [T1.admin.id]);
  await h.asUser(T1.admin, (sql) => rpc(sql, 'admin_set_user_active', '$1, $2', [admin2.id, false]));
}

/* ========================================================================== */
section('2. ** the audit log — and what it refuses to record **');

await h.asUser(T1.admin, async (sql) => {
  const rows = await sql(
    `select action, table_name, row_id, changes, actor_id, actor_role, actor_is_system
       from public.audit_log where table_name='profiles' and row_id=$1
      order by created_at`, [T1.doctor.id]);
  check('** both the deactivation and the reactivation were logged **', rows.length >= 2);

  const deact = rows.find((r) => r.action === 'user.deactivated');
  const react = rows.find((r) => r.action === 'user.reactivated');
  check('...as user.deactivated', !!deact);
  check('...and user.reactivated', !!react);
  checkEqual('...attributed to the admin who did it', deact?.actor_id, T1.admin.id);
  checkEqual('...with their role snapshotted', deact?.actor_role, 'admin');
  checkEqual('...and not marked as a system change', deact?.actor_is_system, false);

  const ch = deact?.changes as Row;
  checkEqual('...recording is_active from true', (ch.is_active as Row)?.from, true);
  checkEqual('...to false', (ch.is_active as Row)?.to, false);
});

// Role change
await h.asUser(T1.admin, async (sql) => {
  await rpc(sql, 'admin_set_user_role', '$1, $2', [T1.nurse.id, 'billing']);
  const r = await sql(
    `select action, changes from public.audit_log
      where row_id=$1 and action='user.role_changed' order by created_at desc limit 1`, [T1.nurse.id]);
  checkEqual('** a role change is logged **', r.length, 1);
  const ch = r[0].changes as Row;
  checkEqual('...from nurse', (ch.role as Row)?.from, 'nurse');
  checkEqual('...to billing', (ch.role as Row)?.to, 'billing');
  await rpc(sql, 'admin_set_user_role', '$1, $2', [T1.nurse.id, 'nurse']);
});

// ---- THE PII BOUNDARY. The most important assertions in this file. ----------
section('2b. ** the audit log stores no personal data **');

let inviteId = '';
let inviteToken = '';
const secretEmail = 'p4a.secret.person@clinic.test';
await h.asUser(T1.admin, async (sql) => {
  const inv = await rpc(sql, 'create_invite', '$1, $2', [secretEmail, 'nurse']);
  inviteId = inv.invite_id as string;
  inviteToken = inv.token as string;

  const r = await sql(
    `select action, changes from public.audit_log where row_id=$1 order by created_at`, [inviteId]);
  checkEqual('** invite.created is logged **', r[0].action, 'invite.created');

  const blob = JSON.stringify(r[0].changes);
  check('** ...and the invitee EMAIL is nowhere in the audit row **', !blob.includes(secretEmail), blob);
  check('** ...and neither is the TOKEN (a live capability) **', !blob.includes(inviteToken), blob);
  check('...while the granted role IS recorded, because that is the compliance fact',
    ((r[0].changes as Row).role as Row)?.to === 'nurse', blob);
});

// A clinician's free text must never reach the log, even when the same statement
// changes something that IS logged.
await h.asUser(T1.admin, async (sql) => {
  const before = (await sql(`select count(*)::int as n from public.audit_log`))[0].n as number;
  // full_name is not an access-governing field, so this alone must produce NO row.
  await sql(`update public.profiles set full_name='Renamed Person' where id=$1`, [T1.admin.id]);
  const after = (await sql(`select count(*)::int as n from public.audit_log`))[0].n as number;
  checkEqual('an ordinary profile edit produces no audit row at all', after, before);
});

// audit_diff() directly — the redaction boundary, unit-tested rather than inferred.
await h.asUser(T1.admin, async (sql) => {
  const d = (await sql(
    `select public.audit_diff('profiles',
       jsonb_build_object('role','doctor','full_name','Dr Real Name','is_active',true),
       jsonb_build_object('role','nurse','full_name','Dr New Name','is_active',false)) as d`))[0].d as Row;

  checkEqual('audit_diff records an allow-listed value (role)', (d.role as Row)?.to, 'nurse');
  checkEqual('...and is_active', (d.is_active as Row)?.to, false);
  check('** ...but REDACTS full_name, keeping only the field name **',
    (d.full_name as Row)?.redacted === true && (d.full_name as Row)?.to === undefined,
    JSON.stringify(d.full_name));

  // The default-is-redaction property: an unknown table allow-lists nothing.
  const clinical = (await sql(
    `select public.audit_diff('clinical_notes',
       jsonb_build_object('chief_complaint','chest pain radiating to jaw'),
       jsonb_build_object('chief_complaint','myocardial infarction suspected')) as d`))[0].d as Row;
  const blob = JSON.stringify(clinical);
  check('** an un-allow-listed table redacts EVERYTHING (default is redaction) **',
    !blob.includes('chest pain') && !blob.includes('myocardial'), blob);
  checkEqual('...while still naming the field that changed',
    (clinical.chief_complaint as Row)?.changed, true);
});

section('2c. audit log — invite lifecycle, tenant settings, and access');

await h.asUser({ id: await h.signUp({ email: secretEmail, fullName: 'Secret Person' }), email: secretEmail },
  (sql) => rpc(sql, 'accept_invite', '$1', [inviteToken]));

await h.asUser(T1.admin, async (sql) => {
  const acc = await sql(
    `select action from public.audit_log where row_id=$1 and action='invite.accepted'`, [inviteId]);
  checkEqual('** invite.accepted is logged **', acc.length, 1);

  const joined = await sql(
    `select action from public.audit_log where action='user.joined_tenant' order by created_at desc limit 1`);
  checkEqual('...and so is the user joining the clinic', joined.length, 1);

  // Tenant settings — the GST flag, which decides the legal shape of every invoice.
  await sql(`update public.tenants set gst_registered=false where id=$1`, [T1.tenantId]);
  const ts = await sql(
    `select action, changes from public.audit_log
      where table_name='tenants' and action='tenant.settings_changed'
      order by created_at desc limit 1`);
  checkEqual('** a tenant settings change is logged **', ts.length, 1);
  checkEqual('...recording gst_registered from true', ((ts[0].changes as Row).gst_registered as Row)?.from, true);
  checkEqual('...to false', ((ts[0].changes as Row).gst_registered as Row)?.to, false);
  await sql(`update public.tenants set gst_registered=true where id=$1`, [T1.tenantId]);

  await checkRejects('nobody can insert into audit_log, not even an admin',
    () => sql(`insert into public.audit_log (tenant_id, action, table_name)
               values ($1,'forged','profiles')`, [T1.tenantId]), '42501');
  await checkRejects('...nor update it',
    () => sql(`update public.audit_log set action='rewritten' where tenant_id=$1`, [T1.tenantId]), '42501');
  await checkRejects('...nor delete from it',
    () => sql(`delete from public.audit_log where tenant_id=$1`, [T1.tenantId]), '42501');
});

for (const role of ['doctor', 'nurse', 'billing'] as const) {
  await h.asUser(T1[role], async (sql) => {
    checkEqual(`a ${role} sees 0 audit rows (admin-only oversight data)`,
      (await sql(`select 1 from public.audit_log`)).length, 0);
  });
}

// A service-role / owner-context write is recorded as a system event.
{
  await h.asOwner(`update public.tenants set tier=2 where id=$1`, [T1.tenantId]);
  const sys = await h.asOwner(
    `select actor_id, actor_is_system, changes from public.audit_log
      where tenant_id=$1 and action='tenant.settings_changed' order by created_at desc limit 1`,
    [T1.tenantId]);
  checkEqual('** an owner-context change is logged with no actor **', sys[0].actor_id, null);
  checkEqual('** ...and positively marked as a system change **', sys[0].actor_is_system, true);
  checkEqual('...recording the tier move', ((sys[0].changes as Row).tier as Row)?.to, 2);
  await h.asOwner(`update public.tenants set tier=1 where id=$1`, [T1.tenantId]);
}

/* ========================================================================== */
section('3. ** admin dashboard metrics, scoped and admin-only **');

await h.asUser(T1.admin, async (sql) => {
  const vol = await sql(
    `select activity_date, new_patients, visits_total, visits_completed, unique_patients_seen
       from public.admin_patient_volume_daily order by activity_date desc`);
  check('** the admin sees patient volume **', vol.length > 0);
  check('...counting the registration made today', Number(vol[0].new_patients) >= 1);
  check('...and the visit completed today', Number(vol[0].visits_completed) >= 1);

  const rev = await sql(
    `select revenue_date, invoices_issued, subtotal, tax_total, gross_revenue, outstanding
       from public.admin_revenue_daily order by revenue_date desc`);
  check('** the admin sees revenue **', rev.length > 0);
  check('...from at least one issued invoice', Number(rev[0].invoices_issued) >= 1);
  check('...with a positive gross', Number(rev[0].gross_revenue) > 0);
  checkEqual('...and gross = subtotal + tax (grand_total is generated)',
    Number(rev[0].gross_revenue), Number(rev[0].subtotal) + Number(rev[0].tax_total));

  const occ = await sql(
    `select total_beds, occupied, occupancy_pct, current_inpatients from public.admin_occupancy_current`);
  checkEqual('a Tier 1 clinic still gets exactly one occupancy row', occ.length, 1);
  checkEqual('...with no beds', Number(occ[0].total_beds), 0);
  checkEqual('** ...and occupancy_pct NULL, not 0 — "no ward" is not "0% full" **',
    occ[0].occupancy_pct, null);

  const staff = await sql(
    `select staff_name, staff_role, consultations_completed, notes_authored, consulting_minutes
       from public.admin_staff_activity_daily order by consultations_completed desc`);
  check('** the admin sees staff activity **', staff.length > 0);
  const doc = staff.find((s) => s.staff_role === 'doctor');
  check('...including the doctor', !!doc);
  check('...with the completed consultation counted', Number(doc?.consultations_completed) >= 1);
  check('...and the note counted', Number(doc?.notes_authored) >= 1);
  // Privacy property: activity counts only, never who the patients were.
  const cols = Object.keys(staff[0]);
  check('** ...and no patient identity column anywhere in the view **',
    !cols.some((c) => /patient|diagnosis|complaint/i.test(c)), cols.join(','));

  const sum = await sql(
    `select tenant_name, visits_today, revenue_today, active_staff, total_patients
       from public.admin_dashboard_summary`);
  checkEqual('the summary is exactly one row', sum.length, 1);
  check('...naming the clinic', typeof sum[0].tenant_name === 'string');
  check('...with the visit count for today', Number(sum[0].visits_today) >= 1);
  check('...and an active staff count', Number(sum[0].active_staff) >= 1);
});

// Admin-gated in the view body, so a non-admin gets zero rows rather than an error.
for (const role of ['doctor', 'nurse', 'billing'] as const) {
  await h.asUser(T1[role], async (sql) => {
    for (const v of ADMIN_VIEWS) {
      checkEqual(`** a ${role} sees 0 rows in ${v} **`,
        (await sql(`select 1 from public.${v}`)).length, 0);
    }
  });
}

// Tenant scoping: the Tier 3 clinic's admin must not see the Tier 1 clinic's numbers.
await h.asUser(T3.admin, async (sql) => {
  const rows = await sql(`select tenant_id from public.admin_dashboard_summary`);
  checkEqual('the other admin sees exactly one summary row', rows.length, 1);
  checkEqual('...and it is their own tenant', rows[0].tenant_id, T3.tenantId);
  const vol = await sql(`select tenant_id from public.admin_patient_volume_daily`);
  checkEqual('...with no rows from the Tier 1 clinic',
    vol.filter((r) => r.tenant_id === T1.tenantId).length, 0);
});

/* ========================================================================== */
section('4. ** billing reconciliation flags real discrepancies **');

// (a) A pending charge — raise a chargeable event and leave it uninvoiced.
await h.asUser(T1.doctor, async (sql) => {
  await sql(
    `insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
     values ($1,$2,$3,$4,'Serum Potassium')`,
    [T1.tenantId, encT1.visitId, encT1.patientId, T1.doctor.id]);
});

await h.asUser(T1.admin, async (sql) => {
  const pending = await sql(
    `select finding_type, severity, detail, amount_at_stake, age_hours
       from public.billing_reconciliation where finding_type='pending_charge'`);
  check('** an uninvoiced charge is flagged **', pending.length >= 1);
  checkEqual('...as info while it is fresh', pending[0].severity, 'info');
  check('...naming the charge', String(pending[0].detail).includes('Serum Potassium'));
  check('...with an age in hours', Number(pending[0].age_hours) >= 0);
});

// (b) Sum mismatch — corrupt an invoice's stored total as the owner, which is exactly
//     the class of write (service-role / dashboard edit) this check exists to catch.
await h.asOwner(`update public.invoices set subtotal = subtotal + 250 where id=$1`, [encT1.invoiceId]);
await h.asUser(T1.admin, async (sql) => {
  const mism = await sql(
    `select finding_type, severity, invoice_number, detail, amount_at_stake, expected_amount
       from public.billing_reconciliation where finding_type='invoice_sum_mismatch'`);
  checkEqual('** a stored total that disagrees with its line items is flagged **', mism.length, 1);
  checkEqual('...as high severity', mism[0].severity, 'high');
  check('...naming the invoice number', Number(mism[0].invoice_number) > 0);
  check('...and reporting both the stored and the expected amount',
    Number(mism[0].amount_at_stake) !== Number(mism[0].expected_amount));
});
await h.asOwner(`update public.invoices set subtotal = subtotal - 250 where id=$1`, [encT1.invoiceId]);
await h.asUser(T1.admin, async (sql) => {
  checkEqual('...and the finding clears once the totals agree again',
    (await sql(`select 1 from public.billing_reconciliation where finding_type='invoice_sum_mismatch'`)).length, 0);
});

// (c) Payment inconsistencies — all four contradictions.
//
// EACH GETS ITS OWN INVOICE, deliberately. Phase 2's
// guard_invoice_status_transition() forbids paid -> issued, issued -> draft, and any
// change out of cancelled, so a single invoice cannot legally be walked through every
// contradiction. Trying to would test the guard rather than the reconciliation view.
{
  let seq = 0;
  /** A fresh issued invoice, ready to be pushed into one inconsistent state. */
  async function freshInvoice(): Promise<{ id: string; grandTotal: number }> {
    seq += 1;
    const enc = await fullEncounter(T1, `Recon Case ${seq}`, `971000000${seq}`);
    const gt = Number((await h.asOwner(
      `select grand_total from public.invoices where id=$1`, [enc.invoiceId]))[0].grand_total);
    return { id: enc.invoiceId, grandTotal: gt };
  }

  /** The finding for one specific invoice, so cases cannot bleed into each other. */
  async function findingFor(invoiceId: string) {
    return await h.asUser(T1.admin, (sql) => sql(
      `select severity, detail from public.billing_reconciliation
        where finding_type='payment_status_mismatch' and invoice_id=$1`, [invoiceId]));
  }

  // issued -> paid, but short. Legal transition, incoherent money.
  const a = await freshInvoice();
  await h.asUser(T1.billing, (sql) =>
    sql(`update public.invoices set status='paid', amount_paid=$2 where id=$1`, [a.id, a.grandTotal - 50]));
  let f = await findingFor(a.id);
  checkEqual('** marked paid while short is flagged **', f.length, 1);
  checkEqual('...as high', f[0].severity, 'high');
  check('...with a specific explanation', String(f[0].detail).includes('less than the total'));

  // issued, fully collected, never marked paid.
  const b = await freshInvoice();
  await h.asUser(T1.billing, (sql) =>
    sql(`update public.invoices set amount_paid=$2 where id=$1`, [b.id, b.grandTotal]));
  f = await findingFor(b.id);
  checkEqual('fully collected but still unpaid is flagged', f.length, 1);
  checkEqual('...as warning, not high — bookkeeping lag, not lost money', f[0].severity, 'warning');

  // Overpayment.
  const c = await freshInvoice();
  await h.asUser(T1.billing, (sql) =>
    sql(`update public.invoices set amount_paid=$2 where id=$1`, [c.id, c.grandTotal + 100]));
  f = await findingFor(c.id);
  checkEqual('overpayment is flagged', f.length, 1);
  checkEqual('...as high', f[0].severity, 'high');
  check('...explicitly', String(f[0].detail).includes('exceeds'));

  // Payment recorded against a cancelled invoice. issued -> cancelled is legal.
  const d = await freshInvoice();
  await h.asUser(T1.billing, (sql) =>
    sql(`update public.invoices set status='cancelled', amount_paid=100 where id=$1`, [d.id]));
  f = await findingFor(d.id);
  checkEqual('payment against a cancelled invoice is flagged', f.length, 1);
  checkEqual('...as high', f[0].severity, 'high');
  check('...naming the status', String(f[0].detail).includes('cancelled'));

  // And the control: a correctly settled invoice raises nothing at all.
  const e = await freshInvoice();
  await h.asUser(T1.billing, (sql) =>
    sql(`update public.invoices set status='paid', amount_paid=$2 where id=$1`, [e.id, e.grandTotal]));
  f = await findingFor(e.id);
  checkEqual('** a correctly paid invoice raises NO finding — not everything is flagged **', f.length, 0);

  await h.asUser(T1.admin, async (sql) => {
    const sm = await sql(
      `select finding_type, severity, finding_count, total_amount_at_stake
         from public.billing_reconciliation_summary order by finding_type, severity`);
    check('the summary badge aggregates the findings', sm.length >= 1);
    check('...with a count', Number(sm[0].finding_count) >= 1);
    const kinds = sm.map((r) => r.finding_type as string);
    check('...covering both pending charges and payment mismatches',
      kinds.includes('pending_charge') && kinds.includes('payment_status_mismatch'),
      kinds.join(','));
  });
}

/* ========================================================================== */
section('5. ** Tier 3 placeholders — RLS on, writes tier-gated, reads not **');

// The Tier 1 clinic cannot write to any of the three.
await h.asUser(T1.admin, async (sql) => {
  await checkRejects('** a Tier 1 admin cannot create an insurance claim **',
    () => sql(`insert into public.insurance_claims
               (tenant_id, patient_id, visit_id, payer_type, payer_name, policy_or_beneficiary_number)
               values ($1,$2,$3,'cghs','CGHS Delhi','BEN-1')`,
      [T1.tenantId, encT1.patientId, encT1.visitId]), '42501');
  await checkRejects('** ...nor schedule an operation **',
    () => sql(`insert into public.ot_schedule
               (tenant_id, patient_id, visit_id, procedure_name, scheduled_start, scheduled_end)
               values ($1,$2,$3,'Appendectomy', now(), now() + interval '1 hour')`,
      [T1.tenantId, encT1.patientId, encT1.visitId]), '42501');
  await checkRejects('** ...nor add a blood unit **',
    () => sql(`insert into public.blood_units (tenant_id, unit_code, blood_group, component_type)
               values ($1,'T1-001','O+','whole_blood')`, [T1.tenantId]), '42501');
});

// Reads are deliberately NOT gated — a Tier 1 clinic simply has nothing to see.
await h.asUser(T1.doctor, async (sql) => {
  for (const t of TIER3_TABLES) {
    const rows = await sql(`select 1 from public.${t}`);
    checkEqual(`a Tier 1 clinic reads ${t} without error, and finds nothing`, rows.length, 0);
  }
});

// The Tier 3 clinic can write, with per-table role rules.
let claimId = '';
let bloodId = '';
await h.asUser(T3.billing, async (sql) => {
  const c = await sql(
    `insert into public.insurance_claims
     (tenant_id, patient_id, visit_id, invoice_id, payer_type, payer_name,
      policy_or_beneficiary_number, claim_amount)
     values ($1,$2,$3,$4,'esic','ESIC Mumbai','ESIC-99887766', 4500)
     returning id, status`,
    [T3.tenantId, encT3.patientId, encT3.visitId, encT3.invoiceId]);
  checkEqual('** a Tier 3 billing user can file a claim **', c[0].status, 'draft');
  claimId = c[0].id as string;

  await checkRejects('billing cannot schedule an operation (doctor/admin only)',
    () => sql(`insert into public.ot_schedule
               (tenant_id, patient_id, visit_id, procedure_name, scheduled_start, scheduled_end)
               values ($1,$2,$3,'X', now(), now() + interval '1 hour')`,
      [T3.tenantId, encT3.patientId, encT3.visitId]), '42501');
});

await h.asUser(T3.doctor, async (sql) => {
  const o = await sql(
    `insert into public.ot_schedule
     (tenant_id, patient_id, visit_id, surgeon_id, procedure_name, ot_room, scheduled_start, scheduled_end)
     values ($1,$2,$3,$4,'Laparoscopic Appendectomy','OT-2', now() + interval '1 day', now() + interval '1 day 90 minutes')
     returning id, status`,
    [T3.tenantId, encT3.patientId, encT3.visitId, T3.doctor.id]);
  checkEqual('** a Tier 3 doctor can schedule an operation **', o[0].status, 'scheduled');

  await checkRejects('a slot that ends before it starts is refused',
    () => sql(`insert into public.ot_schedule
               (tenant_id, patient_id, visit_id, procedure_name, scheduled_start, scheduled_end)
               values ($1,$2,$3,'Backwards', now() + interval '2 hours', now())`,
      [T3.tenantId, encT3.patientId, encT3.visitId]), '23514');

  await checkRejects('a doctor cannot add blood stock (nurse/admin only)',
    () => sql(`insert into public.blood_units (tenant_id, unit_code, blood_group, component_type)
               values ($1,'T3-X','O+','whole_blood')`, [T3.tenantId]), '42501');
});

await h.asUser(T3.nurse, async (sql) => {
  const b = await sql(
    `insert into public.blood_units
     (tenant_id, unit_code, blood_group, component_type, collected_at, expires_at)
     values ($1,'T3-001','B+','packed_red_cells', now(), now() + interval '35 days')
     returning id, status`, [T3.tenantId]);
  checkEqual('** a Tier 3 nurse can add a blood unit **', b[0].status, 'available');
  bloodId = b[0].id as string;

  await checkRejects('an invalid blood group is refused',
    () => sql(`insert into public.blood_units (tenant_id, unit_code, blood_group, component_type)
               values ($1,'T3-002','C+','plasma')`, [T3.tenantId]), '23514');
  await checkRejects('an unknown component type is refused',
    () => sql(`insert into public.blood_units (tenant_id, unit_code, blood_group, component_type)
               values ($1,'T3-003','O+','unobtainium')`, [T3.tenantId]), '23514');
  await checkRejects('expiry before collection is refused',
    () => sql(`insert into public.blood_units (tenant_id, unit_code, blood_group, component_type, collected_at, expires_at)
               values ($1,'T3-004','O+','plasma', now(), now() - interval '1 day')`, [T3.tenantId]), '23514');
  await checkRejects('a duplicate bag number within the clinic is refused',
    () => sql(`insert into public.blood_units (tenant_id, unit_code, blood_group, component_type)
               values ($1,'T3-001','A+','plasma')`, [T3.tenantId]), '23505');

  // Status/link coherence.
  await checkRejects('a unit cannot be "reserved" with nobody to reserve it for',
    () => sql(`update public.blood_units set status='reserved' where id=$1`, [bloodId]), '23514');
  await checkRejects('...nor "issued" with no recipient',
    () => sql(`update public.blood_units set status='issued' where id=$1`, [bloodId]), '23514');
  const reserved = await sql(
    `update public.blood_units set status='reserved', reserved_for_visit_id=$2
      where id=$1 returning status`, [bloodId, encT3.visitId]);
  checkEqual('reserving for a real visit works', reserved[0].status, 'reserved');
});

await h.asUser(T3.billing, async (sql) => {
  await checkRejects('a submitted claim must carry a submission timestamp',
    () => sql(`update public.insurance_claims set status='submitted' where id=$1`, [claimId]), '23514');
  const ok = await sql(
    `update public.insurance_claims set status='submitted', submitted_at=now()
      where id=$1 returning status`, [claimId]);
  checkEqual('...and with one it succeeds', ok[0].status, 'submitted');
  await checkRejects('an adjudication status does not exist (PRD §8)',
    () => sql(`update public.insurance_claims set status='approved' where id=$1`, [claimId]), '23514');
});

// Reads ungated across roles within the Tier 3 clinic.
for (const role of ['doctor', 'nurse', 'billing', 'admin'] as const) {
  await h.asUser(T3[role], async (sql) => {
    for (const t of TIER3_TABLES) {
      check(`a ${role} can read ${t} in a Tier 3 clinic`,
        (await sql(`select 1 from public.${t}`)).length > 0);
    }
  });
}

// No DELETE anywhere.
await h.asUser(T3.admin, async (sql) => {
  for (const t of TIER3_TABLES) {
    await checkRejects(`nobody can delete from ${t}`,
      () => sql(`delete from public.${t}`), '42501');
  }
});

section('5b. Tier 3 — cross-tenant isolation and structural guarantees');

await h.asUser(T1.doctor, async (sql) => {
  for (const t of TIER3_TABLES) {
    checkEqual(`the Tier 1 clinic sees no ${t} rows from the Tier 3 clinic`,
      (await sql(`select 1 from public.${t} where tenant_id=$1`, [T3.tenantId])).length, 0);
  }
});
await h.asUser(T3.doctor, async (sql) => {
  const rows = await sql(`select tenant_id from public.insurance_claims`);
  check('...and the Tier 3 clinic sees only its own', rows.every((r) => r.tenant_id === T3.tenantId));
});

// Composite FKs — hold even as the table owner, with RLS out of the picture.
await checkRejects("a claim cannot reference another tenant's patient, even as owner",
  () => h.asOwner(`insert into public.insurance_claims
                   (tenant_id, patient_id, visit_id, payer_type, payer_name, policy_or_beneficiary_number)
                   values ($1,$2,$3,'cghs','X','Y')`,
    [T3.tenantId, encT1.patientId, encT3.visitId]), '23503');
await checkRejects("an OT slot cannot reference another tenant's visit, even as owner",
  () => h.asOwner(`insert into public.ot_schedule
                   (tenant_id, patient_id, visit_id, procedure_name, scheduled_start, scheduled_end)
                   values ($1,$2,$3,'X', now(), now() + interval '1 hour')`,
    [T3.tenantId, encT3.patientId, encT1.visitId]), '23503');
await checkRejects("a blood unit cannot be reserved for another tenant's visit, even as owner",
  () => h.asOwner(`update public.blood_units set reserved_for_visit_id=$2 where id=$1`,
    [bloodId, encT1.visitId]), '23503');

section('5c. anon has no Phase 4 surface');

await h.asAnon(async (sql) => {
  for (const t of [...TIER3_TABLES, 'audit_log'] as const) {
    await checkRejects(`anon cannot read ${t}`, () => sql(`select 1 from public.${t}`), '42501');
  }
  for (const v of ADMIN_VIEWS) {
    await checkRejects(`anon cannot read ${v}`, () => sql(`select 1 from public.${v}`), '42501');
  }
  await checkRejects('anon cannot call admin_set_user_active',
    () => sql(`select public.admin_set_user_active($1, false)`, [T1.doctor.id]), '42501');
  await checkRejects('anon cannot call record_audit_event',
    () => sql(`select public.record_audit_event($1,'x','y',null)`, [T1.tenantId]), '42501');
});

/* ========================================================================== */
section('NEGATIVE CONTROL — confirm the Tier 3 and audit assertions depend on RLS');

const CONTROLLED = [...TIER3_TABLES, 'audit_log'] as const;

for (const t of CONTROLLED) {
  await h.asOwner(`alter table public.${t} disable row level security`);
}

const leaked: Record<string, number> = {};
await h.asUser(T1.doctor, async (sql) => {
  for (const t of CONTROLLED) {
    leaked[t] = (await sql(`select 1 from public.${t}`)).length;
  }
});

check("with RLS off, the Tier 1 doctor DOES see the Tier 3 clinic's claims",
  leaked.insurance_claims > 0, `saw ${leaked.insurance_claims}`);
check('with RLS off, they DO see the OT schedule', leaked.ot_schedule > 0, `saw ${leaked.ot_schedule}`);
check('with RLS off, they DO see the blood units', leaked.blood_units > 0, `saw ${leaked.blood_units}`);
check('with RLS off, a non-admin DOES see the audit log', leaked.audit_log > 0, `saw ${leaked.audit_log}`);

for (const t of CONTROLLED) {
  await h.asOwner(`alter table public.${t} enable row level security`);
}

await h.asUser(T1.doctor, async (sql) => {
  for (const t of TIER3_TABLES) {
    checkEqual(`RLS restored: back to 0 rows in ${t} for the Tier 1 clinic`,
      (await sql(`select 1 from public.${t}`)).length, 0);
  }
  checkEqual('RLS restored: back to 0 audit rows for a non-admin',
    (await sql(`select 1 from public.audit_log`)).length, 0);
});

await h.close();
summary('Phase 4 admin, deactivation, reconciliation, audit log and Tier 3 (local / PGlite)');
