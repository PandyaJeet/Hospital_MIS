/**
 * PHASE 3 CROSS-TENANT ISOLATION + ROLE SCOPING  (rules.md §4.1–4.3)
 *
 * Run: npm run test:isolation3
 *
 * Every table and view Phase 3 adds gets the same treatment Phases 1 and 2 gave
 * theirs: prove a user in clinic A cannot see, modify or infer anything about
 * clinic B, and cannot widen their own reach inside their own clinic either.
 *
 * Four layers are checked, because they fail differently:
 *   1. RLS       — wrong-tenant rows are invisible (0 rows, no error)
 *   2. GRANTS    — ungranted columns are refused outright (42501)
 *   3. SCHEMA    — composite FKs make cross-tenant parenting impossible even with
 *                  RLS switched off; the guarantee that survives a policy mistake
 *   4. VIEWS     — security_invoker really is in force, so rounds_overview and
 *                  critical_lab_alerts inherit the policies rather than the
 *                  owner's privileges. This layer is new to Phase 3 and is the
 *                  one that would fail silently and catastrophically if the view
 *                  option were ever dropped.
 *
 * Ends with a NEGATIVE CONTROL across the whole Phase 3 table group: RLS is
 * disabled, the leak is confirmed to appear, then re-enabled and isolation
 * re-asserted. Without it, "A sees 0 rows of B" could be passing because a fixture
 * was empty.
 */

import {
  createHarness, check, checkEqual, checkRejects, section, summary,
  type Harness, type SessionUser,
} from '../harness/pglite.ts';
import { rpc, seedTenant, registerPatient, type TenantFixture } from '../harness/fixtures.ts';

const h: Harness = await createHarness();

const PHASE3_TABLES = [
  'vitals', 'tasks', 'beds',
  'medication_administrations',
  'lab_orders', 'lab_results',
] as const;

const PHASE3_VIEWS = ['rounds_overview', 'critical_lab_alerts'] as const;

/* ========================================================================== */
section('Fixtures — two fully-populated Tier 2 clinics');

// Both Tier 2, so the IPD surface exists on both sides and a cross-tenant bed
// assignment is a live possibility rather than something the tier gate blocks
// first. Isolation has to hold on its own merits.
const A: TenantFixture = await seedTenant(h, {
  name: 'Clinic A (IPD)', slug: 'ia', consultationFee: 500, tier: 2,
});
const B: TenantFixture = await seedTenant(h, {
  name: 'Clinic B (IPD)', slug: 'ib', consultationFee: 400, tier: 2,
});

interface Populated {
  patientId: string;
  patientNumber: number;
  visitId: string;
  bedId: string;
  vitalsId: string;
  taskId: string;
  itemId: string;
  administrationId: string;
  labOrderId: string;
  labResultId: string;
}

/** Runs a full inpatient episode so every Phase 3 table has rows in this tenant. */
async function populate(t: TenantFixture, label: string): Promise<Populated> {
  const pat = await registerPatient(h, t, {
    name: `${label} Inpatient`, phone: `9${label.charCodeAt(0)}10000001`, allergies: 'penicillin', age: 61,
  });

  const visit = await h.asUser(t.billing, (sql) =>
    rpc(sql, 'check_in_patient', '$1, $2, $3', [pat.patientId, 'new', t.doctor.id]));
  const visitId = visit.visit_id as string;
  await h.asUser(t.doctor, (sql) => rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'in_consultation']));

  // ward inventory
  const bedId = await h.asUser(t.admin, async (sql) => {
    const b = await sql(
      `insert into public.beds (tenant_id, ward_name, bed_number) values ($1,$2,'1') returning id`,
      [t.tenantId, `${label} Ward`]);
    return b[0].id as string;
  });

  // admission (creates the baseline vitals task), observations, a manual task
  const { vitalsId, taskId } = await h.asUser(t.nurse, async (sql) => {
    await rpc(sql, 'admit_patient_to_bed', '$1, $2', [visitId, bedId]);
    const v = await sql(
      `insert into public.vitals (tenant_id, visit_id, recorded_by, temperature_c, pulse_bpm, bp_systolic, bp_diastolic)
       values ($1,$2,$3, 39.1, 118, 90, 55) returning id`,
      [t.tenantId, visitId, t.nurse.id]);
    const k = await sql(
      `insert into public.tasks (tenant_id, visit_id, task_type, title, due_at)
       values ($1,$2,'custom',$3, now()) returning id`,
      [t.tenantId, visitId, `${label} confidential task note`]);
    return { vitalsId: v[0].id as string, taskId: k[0].id as string };
  });

  // an issued prescription with one item
  const itemId = await h.asUser(t.doctor, async (sql) => {
    const rx = await sql(
      `insert into public.prescriptions (tenant_id, visit_id, doctor_id) values ($1,$2,$3) returning id`,
      [t.tenantId, visitId, t.doctor.id]);
    const drug = await sql(`select id from public.drugs where brand_name='Dolo 650'`);
    const item = await sql(
      `insert into public.prescription_items (prescription_id, tenant_id, drug_id, drug_name, dose, frequency)
       values ($1,$2,$3,'Dolo 650','650 mg','TDS') returning id`,
      [rx[0].id, t.tenantId, drug[0].id]);
    await rpc(sql, 'issue_prescription', '$1', [rx[0].id]);
    return item[0].id as string;
  });

  // a scanned administration
  const administrationId = await h.asUser(t.nurse, async (sql) => {
    const res = await rpc(sql, 'record_medication_administration', '$1, $2',
      [itemId, pat.patientId]);
    if (res.ok !== true) throw new Error(`administration failed: ${JSON.stringify(res)}`);
    return res.administration_id as string;
  });

  // a lab order and a CRITICAL result — the most sensitive row in the phase
  const { labOrderId, labResultId } = await h.asUser(t.doctor, async (sql) => {
    const o = await sql(
      `insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name, priority)
       values ($1,$2,$3,$4,'Serum Potassium','stat') returning id`,
      [t.tenantId, visitId, pat.patientId, t.doctor.id]);
    const res = await rpc(sql, 'record_lab_result', '$1, $2, $3', [o[0].id, '7.1', 'mmol/L']);
    if (res.is_critical !== true) throw new Error(`expected a critical result: ${JSON.stringify(res)}`);
    return { labOrderId: o[0].id as string, labResultId: res.lab_result_id as string };
  });

  return {
    patientId: pat.patientId, patientNumber: pat.patientNumber, visitId, bedId,
    vitalsId, taskId, itemId, administrationId, labOrderId, labResultId,
  };
}

const dataA = await populate(A, 'A');
const dataB = await populate(B, 'B');
check('both clinics ran a full inpatient episode', !!dataA.labResultId && !!dataB.labResultId);

// Ground truth as owner, so the assertions below are known to be filtering real
// rows rather than querying empty tables.
{
  const g = (await h.asOwner(`
    select (select count(*) from public.vitals)                     as vitals,
           (select count(*) from public.tasks)                      as tasks,
           (select count(*) from public.beds)                       as beds,
           (select count(*) from public.medication_administrations) as admins,
           (select count(*) from public.lab_orders)                 as orders,
           (select count(*) from public.lab_results)                as results`))[0];
  checkEqual('ground truth: 2 vitals rows', Number(g.vitals), 2);
  // 2 admission tasks + 2 manual tasks + 2 lab sample tasks
  checkEqual('ground truth: 6 tasks', Number(g.tasks), 6);
  checkEqual('ground truth: 2 beds', Number(g.beds), 2);
  checkEqual('ground truth: 2 administrations', Number(g.admins), 2);
  checkEqual('ground truth: 2 lab orders', Number(g.orders), 2);
  checkEqual('ground truth: 2 lab results', Number(g.results), 2);
}

/* ========================================================================== */
section('1. Every Phase 3 table — clinic A staff see only clinic A');

for (const role of ['admin', 'doctor', 'nurse'] as const) {
  const user = A[role];
  await h.asUser(user, async (sql) => {
    for (const table of PHASE3_TABLES) {
      const rows = await sql(`select tenant_id from public.${table}`);
      const foreign = rows.filter((r) => r.tenant_id !== A.tenantId);
      checkEqual(`${role}: no clinic B rows visible in ${table}`, foreign.length, 0);
      check(`${role}: ...and clinic A's own rows ARE visible in ${table}`, rows.length > 0);
    }
  });
}

await h.asUser(A.doctor, async (sql) => {
  // Targeted lookups by clinic B's real primary keys must return nothing.
  checkEqual("A doctor querying B's vitals by id", (await sql(`select id from public.vitals where id=$1`, [dataB.vitalsId])).length, 0);
  checkEqual("A doctor querying B's task by id", (await sql(`select id from public.tasks where id=$1`, [dataB.taskId])).length, 0);
  checkEqual("A doctor querying B's bed by id", (await sql(`select id from public.beds where id=$1`, [dataB.bedId])).length, 0);
  checkEqual("A doctor querying B's administration by id", (await sql(`select id from public.medication_administrations where id=$1`, [dataB.administrationId])).length, 0);
  checkEqual("A doctor querying B's lab order by id", (await sql(`select id from public.lab_orders where id=$1`, [dataB.labOrderId])).length, 0);
  checkEqual("A doctor querying B's lab result by id", (await sql(`select id from public.lab_results where id=$1`, [dataB.labResultId])).length, 0);

  for (const table of PHASE3_TABLES) {
    checkEqual(`A doctor filtering ${table} by B's tenant_id`,
      (await sql(`select 1 from public.${table} where tenant_id=$1`, [B.tenantId])).length, 0);
  }

  // The two most sensitive reads in the phase, by content rather than by id.
  checkEqual("A doctor cannot reach B's task text by content search",
    (await sql(`select id from public.tasks where title like '%confidential%' and tenant_id <> $1`, [A.tenantId])).length, 0);
  checkEqual("A doctor cannot reach B's critical lab results by value search",
    (await sql(`select id from public.lab_results where result_value = '7.1' and tenant_id <> $1`, [A.tenantId])).length, 0);
});

/* ========================================================================== */
section('2. Views — security_invoker is genuinely in force');

// A view without security_invoker executes as its OWNER (postgres, not subject to
// RLS), which would make these two a perfect cross-tenant leak dressed up as a
// convenience. These assertions are what would catch that.
await h.asUser(A.doctor, async (sql) => {
  const rounds = await sql(`select visit_id, tenant_id from public.rounds_overview`);
  check('rounds_overview returns clinic A rows', rounds.length > 0);
  checkEqual('...and only clinic A rows', rounds.filter((r) => r.tenant_id !== A.tenantId).length, 0);
  checkEqual("...so B's visit is absent",
    rounds.filter((r) => r.visit_id === dataB.visitId).length, 0);

  const alerts = await sql(`select lab_result_id, tenant_id from public.critical_lab_alerts`);
  check('critical_lab_alerts returns clinic A alerts', alerts.length > 0);
  checkEqual('...and only clinic A alerts', alerts.filter((r) => r.tenant_id !== A.tenantId).length, 0);
  checkEqual("...so B's critical potassium is absent",
    alerts.filter((r) => r.lab_result_id === dataB.labResultId).length, 0);

  // The RPC over the view inherits the same scoping.
  const payload = await rpc(sql, 'get_critical_lab_alert_payload', '$1', [dataB.labResultId]);
  checkEqual("the alert payload for B's result is not found", payload.code, 'ALERT_NOT_FOUND');
});

// Data minimisation survives the view: billing gets the encounter, not the vitals.
await h.asUser(A.billing, async (sql) => {
  const rows = await sql(`select visit_id, temperature_c, pulse_bpm, bp_systolic from public.rounds_overview`);
  check('billing can read rounds_overview at all', rows.length > 0);
  checkEqual('...but every measurement is NULL for billing',
    rows.filter((r) => r.temperature_c !== null || r.pulse_bpm !== null || r.bp_systolic !== null).length, 0);
  checkEqual('...and critical_lab_alerts is empty for billing',
    (await sql(`select 1 from public.critical_lab_alerts`)).length, 0);
});

/* ========================================================================== */
section('3. Role scoping inside a clinic');

// A 'patient'-role login must see nothing on any Phase 3 table.
const portalEmail = 'portal.user@clinic-ia.test';
const portalId = await h.signUp({ email: portalEmail, fullName: 'Portal User' });
const portalInvite = await h.asUser(A.admin, (sql) =>
  rpc(sql, 'create_invite', '$1, $2', [portalEmail, 'patient']));
await h.asUser({ id: portalId, email: portalEmail }, (sql) =>
  rpc(sql, 'accept_invite', '$1', [portalInvite.token]));
const portalUser: SessionUser = { id: portalId, email: portalEmail };

await h.asUser(portalUser, async (sql) => {
  for (const table of PHASE3_TABLES) {
    checkEqual(`patient-role login sees 0 rows in ${table}`, (await sql(`select 1 from public.${table}`)).length, 0);
  }
  for (const view of PHASE3_VIEWS) {
    checkEqual(`patient-role login sees 0 rows in ${view}`, (await sql(`select 1 from public.${view}`)).length, 0);
  }
  const admit = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [dataA.visitId, dataA.bedId]);
  checkEqual('patient-role login cannot admit anyone', admit.code, 'NOT_STAFF');
  const med = await rpc(sql, 'record_medication_administration', '$1, $2', [dataA.itemId, dataA.patientId]);
  checkEqual('patient-role login cannot record an administration', med.code, 'NOT_CLINICAL_STAFF');
  const lab = await rpc(sql, 'record_lab_result', '$1, $2', [dataA.labOrderId, '5.0']);
  checkEqual('patient-role login cannot record a lab result', lab.code, 'NOT_CLINICAL_STAFF');
  const ack = await rpc(sql, 'acknowledge_critical_result', '$1', [dataA.labResultId]);
  checkEqual('patient-role login cannot acknowledge an alert', ack.code, 'NOT_CLINICAL_STAFF');
});

// A pending (un-onboarded) user likewise sees nothing.
const pendingId = await h.signUp({ email: 'nobody3@nowhere.test' });
await h.asUser({ id: pendingId, email: 'nobody3@nowhere.test' }, async (sql) => {
  for (const table of PHASE3_TABLES) {
    checkEqual(`pending user sees 0 rows in ${table}`, (await sql(`select 1 from public.${table}`)).length, 0);
  }
  checkEqual('pending user sees 0 rows in rounds_overview',
    (await sql(`select 1 from public.rounds_overview`)).length, 0);
});

// Data minimisation inside the clinic: billing is excluded from the clinical tables
// but keeps the operational ones it needs.
await h.asUser(A.billing, async (sql) => {
  for (const table of ['vitals', 'tasks', 'medication_administrations', 'lab_results'] as const) {
    checkEqual(`billing sees 0 rows in ${table} (deliberate minimisation)`,
      (await sql(`select 1 from public.${table}`)).length, 0);
  }
  check('billing CAN see beds (an inpatient bill names the bed)',
    (await sql(`select id from public.beds`)).length > 0);
  check('billing CAN see lab orders (it bills for them)',
    (await sql(`select id from public.lab_orders`)).length > 0);
  check('billing CAN see the auto-raised lab charge',
    (await sql(`select id from public.billing_line_items where source_type='lab'`)).length > 0);
});

// anon has no Phase 3 surface at all.
await h.asAnon(async (sql) => {
  for (const table of PHASE3_TABLES) {
    await checkRejects(`anon cannot read ${table}`, () => sql(`select 1 from public.${table}`), '42501');
  }
  for (const view of PHASE3_VIEWS) {
    await checkRejects(`anon cannot read ${view}`, () => sql(`select 1 from public.${view}`), '42501');
  }
  await checkRejects('anon cannot read the lab reference set',
    () => sql(`select 1 from public.lab_critical_ranges`), '42501');
  await checkRejects('anon cannot call tenant_has_tier',
    () => sql(`select public.tenant_has_tier(2)`), '42501');
  await checkRejects('anon cannot call current_tenant_tier',
    () => sql(`select public.current_tenant_tier()`), '42501');
});

/* ========================================================================== */
section('4. Write authority — who may do what inside a clinic');

await h.asUser(A.billing, async (sql) => {
  await checkRejects('billing cannot record vitals',
    () => sql(`insert into public.vitals (tenant_id, visit_id, recorded_by, pulse_bpm) values ($1,$2,$3,80)`,
      [A.tenantId, dataA.visitId, A.billing.id]), '42501');
  await checkRejects('billing cannot create a task',
    () => sql(`insert into public.tasks (tenant_id, visit_id, task_type, title, due_at) values ($1,$2,'custom','x', now())`,
      [A.tenantId, dataA.visitId]), '42501');
  await checkRejects('billing cannot create ward inventory',
    () => sql(`insert into public.beds (tenant_id, ward_name, bed_number) values ($1,'Smuggled','9')`,
      [A.tenantId]), '42501');
  await checkRejects('billing cannot order a lab test',
    () => sql(`insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
               values ($1,$2,$3,$4,'CBC')`,
      [A.tenantId, dataA.visitId, dataA.patientId, A.billing.id]), '42501');
});

await h.asUser(A.nurse, async (sql) => {
  await checkRejects('a nurse cannot create ward inventory (admin only)',
    () => sql(`insert into public.beds (tenant_id, ward_name, bed_number) values ($1,'ICU','1')`,
      [A.tenantId]), '42501');

  // Two different denial SHAPES, worth distinguishing because Prince has to map
  // them differently. An INSERT that fails a WITH CHECK raises 42501. An UPDATE
  // whose USING clause matches nothing simply affects 0 rows and returns success —
  // standard RLS semantics, the same shape the Phase 2 suite documents for
  // cross-tenant updates. The nurse changes nothing either way; only one of them
  // produces an error the UI can catch.
  const renamed = await sql(`update public.beds set ward_name='Renamed' where id=$1 returning id`, [dataA.bedId]);
  checkEqual('a nurse renaming a ward affects 0 rows (admin-only policy, silent filter)', renamed.length, 0);
  const stillNamed = await sql(`select ward_name from public.beds where id=$1`, [dataA.bedId]);
  checkEqual('...and the ward name is unchanged', stillNamed[0].ward_name, 'A Ward');
});

await h.asUser(A.admin, async (sql) => {
  await checkRejects('nobody can write the lab reference set',
    () => sql(`update public.lab_critical_ranges set critical_high=99 where test_code='potassium'`), '42501');
  await checkRejects('nobody can add a threshold row',
    () => sql(`insert into public.lab_critical_ranges (test_code, test_name, unit, critical_high)
               values ('made_up','Made Up','x',1)`), '42501');
  await checkRejects('even an admin cannot raise their own tier',
    () => sql(`update public.tenants set tier=3 where id=$1`, [A.tenantId]), '42501');
});

section('4b. Ungranted columns — refused outright, not silently ignored');

await h.asUser(A.nurse, async (sql) => {
  await checkRejects('cannot move a vitals row to another clinic',
    () => sql(`update public.vitals set tenant_id=$1 where id=$2`, [B.tenantId, dataA.vitalsId]), '42501');
  await checkRejects('cannot reattribute a vitals row',
    () => sql(`update public.vitals set recorded_by=$1 where id=$2`, [A.doctor.id, dataA.vitalsId]), '42501');
  await checkRejects('cannot write visits.last_vitals_at (forging freshness)',
    () => sql(`update public.visits set last_vitals_at=now() where id=$1`, [dataA.visitId]), '42501');
  await checkRejects('cannot write tasks.status',
    () => sql(`update public.tasks set status='done' where id=$1`, [dataA.taskId]), '42501');
  await checkRejects('cannot forge tasks.source_id (squatting an auto task slot)',
    () => sql(`update public.tasks set source_id=$1 where id=$2`, [dataA.visitId, dataA.taskId]), '42501');
  await checkRejects('cannot write beds.status',
    () => sql(`update public.beds set status='available' where id=$1`, [dataA.bedId]), '42501');
  await checkRejects('cannot write beds.current_visit_id',
    () => sql(`update public.beds set current_visit_id=null where id=$1`, [dataA.bedId]), '42501');
  await checkRejects('cannot write visits.care_setting',
    () => sql(`update public.visits set care_setting='opd' where id=$1`, [dataA.visitId]), '42501');
  await checkRejects('cannot write visits.discharged_at (faking a discharge)',
    () => sql(`update public.visits set discharged_at=now() where id=$1`, [dataA.visitId]), '42501');
  await checkRejects('cannot insert a medication administration by hand (bypasses the scan check)',
    () => sql(`insert into public.medication_administrations
               (tenant_id, prescription_item_id, visit_id, administered_by, status, scan_basis)
               values ($1,$2,$3,$4,'given','patient_id')`,
      [A.tenantId, dataA.itemId, dataA.visitId, A.nurse.id]), '42501');
  await checkRejects('cannot insert a lab result by hand (bypasses critical flagging)',
    () => sql(`insert into public.lab_results (lab_order_id, tenant_id, result_value, reported_by)
               values ($1,$2,'0.1',$3)`, [dataA.labOrderId, A.tenantId, A.nurse.id]), '42501');
  await checkRejects('cannot flip is_critical on an existing result',
    () => sql(`update public.lab_results set is_critical=false where id=$1`, [dataA.labResultId]), '42501');
  await checkRejects('cannot forge an acknowledgement',
    () => sql(`update public.lab_results set acknowledged_at=now() where id=$1`, [dataA.labResultId]), '42501');
  await checkRejects('cannot write lab_orders.status',
    () => sql(`update public.lab_orders set status='cancelled' where id=$1`, [dataA.labOrderId]), '42501');
});

/* ========================================================================== */
section('5. Cross-tenant writes — RLS filters, WITH CHECK and FKs reject');

await h.asUser(A.nurse, async (sql) => {
  const upd = await sql(`update public.vitals set pulse_bpm=1 where id=$1 returning id`, [dataB.vitalsId]);
  checkEqual("correcting clinic B's vitals affects 0 rows", upd.length, 0);

  const claim = await sql(`update public.tasks set assigned_to=$1 where id=$2 returning id`,
    [A.nurse.id, dataB.taskId]);
  checkEqual("claiming clinic B's task affects 0 rows", claim.length, 0);

  await checkRejects("cannot record vitals into clinic B's tenant",
    () => sql(`insert into public.vitals (tenant_id, visit_id, recorded_by, pulse_bpm) values ($1,$2,$3,80)`,
      [B.tenantId, dataB.visitId, A.nurse.id]), '42501');

  // Policy satisfied (own tenant_id), but the composite FK has no such
  // (visit_id, tenant_id) pair to point at.
  await checkRejects("cannot attach vitals to clinic B's visit under A's tenant_id",
    () => sql(`insert into public.vitals (tenant_id, visit_id, recorded_by, pulse_bpm) values ($1,$2,$3,80)`,
      [A.tenantId, dataB.visitId, A.nurse.id]), '23503');
  await checkRejects("cannot attach a task to clinic B's visit under A's tenant_id",
    () => sql(`insert into public.tasks (tenant_id, visit_id, task_type, title, due_at)
               values ($1,$2,'custom','x', now())`, [A.tenantId, dataB.visitId]), '23503');
});

await h.asUser(A.nurse, async (sql) => {
  const admit = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [dataB.visitId, dataB.bedId]);
  checkEqual("admitting clinic B's patient -> VISIT_NOT_FOUND", admit.code, 'VISIT_NOT_FOUND');

  const crossBed = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [dataA.visitId, dataB.bedId]);
  checkEqual("admitting A's patient into B's bed -> BED_NOT_FOUND", crossBed.code, 'BED_NOT_FOUND');

  const out = await rpc(sql, 'discharge_patient', '$1', [dataB.visitId]);
  checkEqual("discharging clinic B's patient -> VISIT_NOT_FOUND", out.code, 'VISIT_NOT_FOUND');

  const bedStatus = await rpc(sql, 'set_bed_status', '$1, $2', [dataB.bedId, 'maintenance']);
  checkEqual("changing B's bed status -> BED_NOT_FOUND", bedStatus.code, 'BED_NOT_FOUND');

  const task = await rpc(sql, 'complete_task', '$1', [dataB.taskId]);
  checkEqual("completing B's task -> TASK_NOT_FOUND", task.code, 'TASK_NOT_FOUND');

  const cancel = await rpc(sql, 'cancel_task', '$1', [dataB.taskId]);
  checkEqual("cancelling B's task -> TASK_NOT_FOUND", cancel.code, 'TASK_NOT_FOUND');

  const med = await rpc(sql, 'record_medication_administration', '$1, $2', [dataB.itemId, dataB.patientId]);
  checkEqual("administering B's prescribed drug -> PRESCRIPTION_ITEM_NOT_FOUND", med.code, 'PRESCRIPTION_ITEM_NOT_FOUND');

  // A's own drug, but scanning a band from clinic B. The uuid cannot resolve inside
  // A's tenant, so the check declines rather than passing.
  const crossScan = await rpc(sql, 'record_medication_administration', '$1, $2', [dataA.itemId, dataB.patientId]);
  checkEqual("scanning clinic B's band -> PATIENT_CODE_UNRECOGNISED", crossScan.code, 'PATIENT_CODE_UNRECOGNISED');
  checkEqual('...and explicitly not verified', crossScan.patient_verified, false);

  const labStatus = await rpc(sql, 'set_lab_order_status', '$1, $2', [dataB.labOrderId, 'cancelled']);
  checkEqual("cancelling B's lab order -> LAB_ORDER_NOT_FOUND", labStatus.code, 'LAB_ORDER_NOT_FOUND');

  const labRes = await rpc(sql, 'record_lab_result', '$1, $2', [dataB.labOrderId, '4.0']);
  checkEqual("recording a result on B's order -> LAB_ORDER_NOT_FOUND", labRes.code, 'LAB_ORDER_NOT_FOUND');

  const ack = await rpc(sql, 'acknowledge_critical_result', '$1', [dataB.labResultId]);
  checkEqual("acknowledging B's critical result -> LAB_RESULT_NOT_FOUND", ack.code, 'LAB_RESULT_NOT_FOUND');
});

await h.asUser(A.doctor, async (sql) => {
  await checkRejects("cannot order a test into clinic B's tenant",
    () => sql(`insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
               values ($1,$2,$3,$4,'CBC')`,
      [B.tenantId, dataB.visitId, dataB.patientId, A.doctor.id]), '42501');
  await checkRejects("cannot order a test for B's patient under A's tenant_id",
    () => sql(`insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
               values ($1,$2,$3,$4,'CBC')`,
      [A.tenantId, dataB.visitId, dataB.patientId, A.doctor.id]), '23503');
});

/* ========================================================================== */
section('6. Schema-level guarantees — hold even with RLS out of the picture');

// Run as owner (RLS does not apply to a table's owner) to show these are structural
// constraints rather than policy effects. This is the guarantee that survives a
// future policy bug.
await checkRejects("vitals cannot reference another tenant's visit, even as owner",
  () => h.asOwner(`insert into public.vitals (tenant_id, visit_id, recorded_by, pulse_bpm) values ($1,$2,$3,80)`,
    [A.tenantId, dataB.visitId, A.nurse.id]), '23503');
await checkRejects("vitals cannot be attributed to another tenant's staff, even as owner",
  () => h.asOwner(`insert into public.vitals (tenant_id, visit_id, recorded_by, pulse_bpm) values ($1,$2,$3,80)`,
    [A.tenantId, dataA.visitId, B.nurse.id]), '23503');
await checkRejects("a task cannot reference another tenant's visit, even as owner",
  () => h.asOwner(`insert into public.tasks (tenant_id, visit_id, task_type, title, due_at)
                   values ($1,$2,'custom','x', now())`, [A.tenantId, dataB.visitId]), '23503');
await checkRejects("a task cannot be assigned to another tenant's nurse, even as owner",
  () => h.asOwner(`update public.tasks set assigned_to=$1 where id=$2`, [B.nurse.id, dataA.taskId]), '23503');
// Two independent layers stop this, and which one fires depends on whether the
// foreign visit is already in a bed. Both are asserted so neither can be removed
// unnoticed.
//
// (a) B's admitted visit is already occupying B's bed, so the one-bed-per-visit
//     partial unique index rejects it first (23505) — the composite FK never gets
//     a chance to.
await checkRejects("another tenant's ALREADY-ADMITTED visit cannot also occupy A's bed (unique index), even as owner",
  () => h.asOwner(`update public.beds set status='occupied', current_visit_id=$1 where id=$2`,
    [dataB.visitId, dataA.bedId]), '23505');

// (b) A visit in B that occupies no bed gets past the unique index, so this is the
//     composite FK doing the work: no (id, tenant_id) pair exists for B's visit
//     under A's tenant.
{
  const spare = await registerPatient(h, B, { name: 'B Outpatient', phone: '9210000099', age: 30 });
  const spareVisit = await h.asUser(B.billing, (sql) =>
    rpc(sql, 'check_in_patient', '$1', [spare.patientId]));
  await checkRejects("a bed cannot be occupied by another tenant's unadmitted visit (composite FK), even as owner",
    () => h.asOwner(`update public.beds set status='occupied', current_visit_id=$1 where id=$2`,
      [spareVisit.visit_id, dataA.bedId]), '23503');
}
await checkRejects("a visit cannot point at another tenant's bed, even as owner",
  () => h.asOwner(`update public.visits set bed_id=$1 where id=$2`, [dataB.bedId, dataA.visitId]), '23503');
await checkRejects("an administration cannot reference another tenant's prescription item, even as owner",
  () => h.asOwner(`insert into public.medication_administrations
                   (tenant_id, prescription_item_id, visit_id, administered_by, status, scan_basis)
                   values ($1,$2,$3,$4,'given','patient_id')`,
    [A.tenantId, dataB.itemId, dataA.visitId, A.nurse.id]), '23503');
await checkRejects("a lab order cannot reference another tenant's patient, even as owner",
  () => h.asOwner(`insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
                   values ($1,$2,$3,$4,'CBC')`,
    [A.tenantId, dataA.visitId, dataB.patientId, A.doctor.id]), '23503');
await checkRejects("a lab result cannot reference another tenant's order, even as owner",
  () => h.asOwner(`insert into public.lab_results (lab_order_id, tenant_id, result_value, reported_by)
                   values ($1,$2,'1.0',$3)`, [dataB.labOrderId, A.tenantId, A.doctor.id]), '23503');

/* ========================================================================== */
section('NEGATIVE CONTROL — confirm the above depends on RLS');

for (const t of PHASE3_TABLES) {
  await h.asOwner(`alter table public.${t} disable row level security`);
}

const leaked: Record<string, number> = {};
await h.asUser(A.doctor, async (sql) => {
  for (const t of PHASE3_TABLES) {
    leaked[t] = (await sql(`select 1 from public.${t}`)).length;
  }
});

check('with RLS off, A doctor sees BOTH clinics\' vitals', leaked.vitals === 2, `saw ${leaked.vitals}`);
check('with RLS off, A doctor sees ALL tasks', leaked.tasks === 6, `saw ${leaked.tasks}`);
check('with RLS off, A doctor sees BOTH beds', leaked.beds === 2, `saw ${leaked.beds}`);
check('with RLS off, A doctor sees BOTH administrations', leaked.medication_administrations === 2, `saw ${leaked.medication_administrations}`);
check('with RLS off, A doctor sees BOTH lab orders', leaked.lab_orders === 2, `saw ${leaked.lab_orders}`);
check("with RLS off, A doctor sees BOTH clinics' critical results", leaked.lab_results === 2, `saw ${leaked.lab_results}`);

for (const t of PHASE3_TABLES) {
  await h.asOwner(`alter table public.${t} enable row level security`);
}

await h.asUser(A.doctor, async (sql) => {
  checkEqual('RLS restored: back to 1 vitals row', (await sql(`select 1 from public.vitals`)).length, 1);
  checkEqual('RLS restored: back to 3 tasks', (await sql(`select 1 from public.tasks`)).length, 3);
  checkEqual('RLS restored: back to 1 bed', (await sql(`select 1 from public.beds`)).length, 1);
  checkEqual('RLS restored: back to 1 administration', (await sql(`select 1 from public.medication_administrations`)).length, 1);
  checkEqual('RLS restored: back to 1 lab order', (await sql(`select 1 from public.lab_orders`)).length, 1);
  checkEqual('RLS restored: back to 1 lab result', (await sql(`select 1 from public.lab_results`)).length, 1);
});

await h.close();
summary('Phase 3 cross-tenant isolation + role scoping (local / PGlite)');
