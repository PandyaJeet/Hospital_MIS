/**
 * PHASE 3 — NURSE WORKFLOWS, IPD, MEDICATION ADMINISTRATION AND LAB VALUES
 *
 * Run: npm run test:phase3
 *
 * Behavioural suite for everything Phase 3 adds, run against real PostgreSQL
 * (PGlite) with real RLS and real triggers. Its companion,
 * phase3-isolation.test.ts, covers cross-tenant and role scoping; this file is
 * about whether the features actually work and whether the safety-critical paths
 * fail loudly.
 *
 * The assertions that matter most, i.e. the ones tied to phases.md's Definition of
 * Done, are marked ** in the section headers:
 *   ** no NOT NULL on any vitals measurement column
 *   ** a nurse's vitals entry updates the doctor's rounds data with no separate fetch
 *   ** Tier 2 gates bed/IPD assignment SERVER-SIDE
 *   ** medication administration validates patient match server-side, and a
 *      duplicate attempt is distinguishable
 *   ** an unevaluable critical-value check is distinguishable from "checked, normal"
 *   ** the five tables are in the supabase_realtime publication
 */

import {
  createHarness, check, checkEqual, checkRejects, section, summary,
  type Harness, type Row,
} from '../harness/pglite.ts';
import { rpc, seedTenant, registerPatient, type TenantFixture } from '../harness/fixtures.ts';

const h: Harness = await createHarness();

/* ========================================================================== */
section('Fixtures — one Tier 1 clinic and one Tier 2 clinic');

// Tier 1: a solo clinic. Employs a nurse, takes vitals, orders the odd lab test —
// and must NOT be able to run an inpatient ward. That combination is the whole
// point of the tier boundary drawn in 20260811070400.
const T1: TenantFixture = await seedTenant(h, {
  name: 'Solo Clinic (Tier 1)', slug: 't1', consultationFee: 300, tier: 1,
});

// Tier 2: a nursing home with beds.
const T2: TenantFixture = await seedTenant(h, {
  name: 'Nursing Home (Tier 2)', slug: 't2',
  gst: { gstin: '27AABCU9603R1ZM', stateCode: '27' }, consultationFee: 500, tier: 2,
});

checkEqual('Tier 1 clinic really is tier 1',
  Number((await h.asOwner(`select tier from public.tenants where id=$1`, [T1.tenantId]))[0].tier), 1);
checkEqual('Tier 2 clinic really is tier 2',
  Number((await h.asOwner(`select tier from public.tenants where id=$1`, [T2.tenantId]))[0].tier), 2);

/** Registers a patient and opens a visit. Returns both ids. */
async function openVisit(t: TenantFixture, name: string, phone: string, allergies?: string) {
  const pat = await registerPatient(h, t, { name, phone, allergies, age: 44 });
  const v = await h.asUser(t.billing, (sql) =>
    rpc(sql, 'check_in_patient', '$1, $2, $3', [pat.patientId, 'new', t.doctor.id]),
  );
  if (v.ok !== true) throw new Error(`check_in_patient failed: ${JSON.stringify(v)}`);
  return { patientId: pat.patientId, patientNumber: pat.patientNumber, visitId: v.visit_id as string };
}

const t1Case = await openVisit(T1, 'Tier1 Patient', '9800000001');
const t2Case = await openVisit(T2, 'Tier2 Patient', '9900000001', 'penicillin');
check('both clinics have an open visit', !!t1Case.visitId && !!t2Case.visitId);

/* ========================================================================== */
section('1. vitals — ** EVERY measurement column is nullable **');

// The single most important assertion in this file. A nurse mid-round with nothing
// but a thermometer reading must be able to save. If any of these four inserts
// fails, the product requirement is broken regardless of what the schema says.
await h.asUser(T2.nurse, async (sql) => {
  const empty = await sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by) values ($1,$2,$3) returning id`,
    [T2.tenantId, t2Case.visitId, T2.nurse.id],
  );
  check('a vitals row with NO measurements at all saves', empty.length === 1);

  const tempOnly = await sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by, temperature_c)
     values ($1,$2,$3,38.4) returning id, temperature_c`,
    [T2.tenantId, t2Case.visitId, T2.nurse.id],
  );
  check('temperature alone saves', tempOnly.length === 1 && Number(tempOnly[0].temperature_c) === 38.4);

  const pulseOnly = await sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by, pulse_bpm) values ($1,$2,$3,96) returning id`,
    [T2.tenantId, t2Case.visitId, T2.nurse.id],
  );
  check('pulse alone saves', pulseOnly.length === 1);

  // The real-world case the rule exists for: cuff in use elsewhere, so the nurse
  // has a palpated systolic and no diastolic.
  const halfBp = await sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by, bp_systolic) values ($1,$2,$3,138) returning id`,
    [T2.tenantId, t2Case.visitId, T2.nurse.id],
  );
  check('systolic with NO diastolic saves (partial BP is legitimate)', halfBp.length === 1);
});

// Schema-level proof rather than behavioural: ask the catalogue directly, so this
// keeps holding even if a future migration adds a column.
{
  const notNulls = await h.asOwner(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='vitals' and is_nullable='NO'
    order by column_name`);
  const names = notNulls.map((r) => r.column_name as string);
  const measurements = ['temperature_c', 'pulse_bpm', 'bp_systolic', 'bp_diastolic',
    'respiratory_rate', 'spo2_percent', 'blood_glucose', 'notes'];
  const offenders = names.filter((n) => measurements.includes(n));
  checkEqual('** catalogue check: zero NOT NULL measurement columns **', offenders, []);
  // And the structural ones ARE not-null, so this is not passing vacuously.
  check('...while the structural columns are NOT NULL',
    ['tenant_id', 'visit_id', 'recorded_by', 'recorded_at'].every((c) => names.includes(c)),
    `got ${JSON.stringify(names)}`);
}

section('1b. vitals — impossible values are still refused');

// Nullability is about INCOMPLETE data. A slipped decimal point is a typo, and
// letting it onto a trend graph a doctor reads at a glance is the harm here.
await h.asUser(T2.nurse, async (sql) => {
  await checkRejects('temperature 385 (decimal slip) is rejected',
    () => sql(`insert into public.vitals (tenant_id, visit_id, recorded_by, temperature_c) values ($1,$2,$3,385)`,
      [T2.tenantId, t2Case.visitId, T2.nurse.id]), '23514');
  await checkRejects('SpO2 150% is rejected',
    () => sql(`insert into public.vitals (tenant_id, visit_id, recorded_by, spo2_percent) values ($1,$2,$3,150)`,
      [T2.tenantId, t2Case.visitId, T2.nurse.id]), '23514');
  await checkRejects('pulse 900 is rejected',
    () => sql(`insert into public.vitals (tenant_id, visit_id, recorded_by, pulse_bpm) values ($1,$2,$3,900)`,
      [T2.tenantId, t2Case.visitId, T2.nurse.id]), '23514');
  // ...but a genuinely extreme real reading is not.
  const shock = await sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by, bp_systolic, bp_diastolic, spo2_percent)
     values ($1,$2,$3,60,30,82) returning id`,
    [T2.tenantId, t2Case.visitId, T2.nurse.id]);
  check('a genuinely extreme reading (BP 60/30, SpO2 82) still saves', shock.length === 1);
});

section('1c. vitals — authorship and correction');

await h.asUser(T2.nurse, async (sql) => {
  await checkRejects('a nurse cannot attribute an observation to a colleague',
    () => sql(`insert into public.vitals (tenant_id, visit_id, recorded_by, pulse_bpm) values ($1,$2,$3,80)`,
      [T2.tenantId, t2Case.visitId, T2.doctor.id]), '42501');

  const mine = await sql(`select id from public.vitals where recorded_by=$1 order by created_at limit 1`, [T2.nurse.id]);
  const fixed = await sql(`update public.vitals set pulse_bpm=88 where id=$1 returning pulse_bpm`, [mine[0].id]);
  checkEqual('the recorder can correct their own reading', Number(fixed[0].pulse_bpm), 88);

  await checkRejects('...but cannot move it to a different encounter',
    () => sql(`update public.vitals set visit_id=$1 where id=$2`, [t2Case.visitId, mine[0].id]), '42501');
  await checkRejects('...and cannot delete it (medical record)',
    () => sql(`delete from public.vitals where id=$1`, [mine[0].id]), '42501');
});

await h.asUser(T2.billing, async (sql) => {
  checkEqual('billing sees 0 vitals (deliberate minimisation)',
    (await sql(`select id from public.vitals`)).length, 0);
});
await h.asUser(T2.doctor, async (sql) => {
  check('the doctor CAN see the nurse\'s vitals', (await sql(`select id from public.vitals`)).length > 0);
});

/* ========================================================================== */
section('2. ** rounds data auto-updates on a vitals entry — no separate fetch **');

// A dedicated encounter so the timeline is unambiguous.
const roundsCase = await openVisit(T2, 'Rounds Patient', '9900000002');

{
  const before = await h.asOwner(`select last_vitals_at from public.visits where id=$1`, [roundsCase.visitId]);
  checkEqual('a fresh visit has no vitals timestamp', before[0].last_vitals_at, null);

  await h.asUser(T2.nurse, (sql) => sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by, recorded_at, temperature_c, pulse_bpm)
     values ($1,$2,$3, now() - interval '30 minutes', 37.2, 78)`,
    [T2.tenantId, roundsCase.visitId, T2.nurse.id]));

  const after = await h.asOwner(
    `select v.last_vitals_at, (select max(recorded_at) from public.vitals where visit_id=v.id) as truth
     from public.visits v where v.id=$1`, [roundsCase.visitId]);
  check('** the trigger stamped visits.last_vitals_at **', after[0].last_vitals_at !== null);
  checkEqual('...and it equals max(vitals.recorded_at)',
    String(after[0].last_vitals_at), String(after[0].truth));

  // Back-entering an OLDER observation from paper must not move freshness backwards.
  await h.asUser(T2.nurse, (sql) => sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by, recorded_at, pulse_bpm)
     values ($1,$2,$3, now() - interval '6 hours', 70)`,
    [T2.tenantId, roundsCase.visitId, T2.nurse.id]));

  const afterOld = await h.asOwner(`select last_vitals_at from public.visits where id=$1`, [roundsCase.visitId]);
  checkEqual('back-entering an older reading does NOT move freshness backwards',
    String(afterOld[0].last_vitals_at), String(after[0].last_vitals_at));

  // A newer one does.
  await h.asUser(T2.nurse, (sql) => sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by, temperature_c, pulse_bpm, spo2_percent)
     values ($1,$2,$3, 38.9, 104, 94)`,
    [T2.tenantId, roundsCase.visitId, T2.nurse.id]));
  const afterNew = await h.asOwner(`select last_vitals_at from public.visits where id=$1`, [roundsCase.visitId]);
  check('a newer reading moves freshness forward',
    new Date(String(afterNew[0].last_vitals_at)) > new Date(String(after[0].last_vitals_at)));
}

// The cache must be server-derived only, or the freshness signal could be forged.
await h.asUser(T2.nurse, async (sql) => {
  await checkRejects('visits.last_vitals_at is not client-writable',
    () => sql(`update public.visits set last_vitals_at = now() where id=$1`, [roundsCase.visitId]), '42501');
});

section('2b. rounds_overview — the view the doctor reads');

await h.asUser(T2.doctor, async (sql) => {
  const rows = await sql(
    `select visit_id, patient_name, patient_number, temperature_c, pulse_bpm, spo2_percent,
            last_vitals_at, vitals_age_seconds, pending_tasks
       from public.rounds_overview where visit_id=$1`, [roundsCase.visitId]);
  checkEqual('the doctor gets exactly one row for the encounter', rows.length, 1);
  const r = rows[0];
  checkEqual('...showing the LATEST temperature, not the first', Number(r.temperature_c), 38.9);
  checkEqual('...and the latest pulse', Number(r.pulse_bpm), 104);
  checkEqual('...and the latest SpO2', Number(r.spo2_percent), 94);
  check('...with a computed staleness in seconds', Number(r.vitals_age_seconds) >= 0);
  check('...and the patient identity for the header', typeof r.patient_name === 'string');
});

// The reason vitals values were NOT cached onto `visits`: billing can read visits.
// Through the view, the vitals policy still excludes them.
await h.asUser(T2.billing, async (sql) => {
  const rows = await sql(
    `select visit_id, patient_name, last_vitals_at, temperature_c, pulse_bpm
       from public.rounds_overview where visit_id=$1`, [roundsCase.visitId]);
  checkEqual('billing can read the rounds row (it needs the encounter)', rows.length, 1);
  check('...and sees the patient', typeof rows[0].patient_name === 'string');
  checkEqual('** but every measurement is NULL for billing (security_invoker + vitals RLS) **',
    [rows[0].temperature_c, rows[0].pulse_bpm], [null, null]);
  // Freshness is a bare timestamp with no clinical content, so it is not withheld.
  check('...while the non-clinical freshness timestamp is visible', rows[0].last_vitals_at !== null);
});

/* ========================================================================== */
section('3. tasks — the nurse board');

await h.asUser(T2.nurse, async (sql) => {
  await checkRejects('a custom task with no title is refused (the label IS the task)',
    () => sql(`insert into public.tasks (tenant_id, visit_id, task_type) values ($1,$2,'custom')`,
      [T2.tenantId, roundsCase.visitId]), '23514');

  const custom = await sql(
    `insert into public.tasks (tenant_id, visit_id, task_type, title, due_at, created_by)
     values ($1,$2,'custom','Change dressing', now(), $3) returning id, status, is_auto`,
    [T2.tenantId, roundsCase.visitId, T2.nurse.id]);
  checkEqual('a custom task with a title saves as pending', custom[0].status, 'pending');
  checkEqual('...and is not marked system-generated', custom[0].is_auto, false);

  // A known task type needs no label — the UI derives one.
  const typed = await sql(
    `insert into public.tasks (tenant_id, visit_id, task_type, due_at) values ($1,$2,'medication_due', now()) returning id`,
    [T2.tenantId, roundsCase.visitId]);
  check('a medication_due task needs no title', typed.length === 1);

  await checkRejects('tasks.status is not client-writable',
    () => sql(`update public.tasks set status='done' where id=$1`, [custom[0].id]), '42501');
  await checkRejects('tasks.is_auto cannot be forged',
    () => sql(`update public.tasks set is_auto=true where id=$1`, [custom[0].id]), '42501');
  await checkRejects('tasks.completed_by cannot be forged',
    () => sql(`update public.tasks set completed_by=$1 where id=$2`, [T2.nurse.id, custom[0].id]), '42501');
  await checkRejects('a task cannot be deleted (cancel instead)',
    () => sql(`delete from public.tasks where id=$1`, [custom[0].id]), '42501');

  // Claiming and rescheduling ARE ordinary board interactions.
  const claimed = await sql(`update public.tasks set assigned_to=$1 where id=$2 returning assigned_to`,
    [T2.nurse.id, custom[0].id]);
  checkEqual('a nurse can claim an unclaimed task', claimed[0].assigned_to, T2.nurse.id);

  const done = await rpc(sql, 'complete_task', '$1, $2', [custom[0].id, 'Dressing changed']);
  checkEqual('complete_task marks it done', done.status, 'done');
  const again = await rpc(sql, 'complete_task', '$1', [custom[0].id]);
  checkEqual('completing it twice is refused distinguishably', again.code, 'TASK_ALREADY_DONE');
  const cancelDone = await rpc(sql, 'cancel_task', '$1', [custom[0].id]);
  checkEqual('a completed task cannot be cancelled', cancelDone.code, 'TASK_ALREADY_DONE');

  const stamped = await sql(`select completed_by, completed_at from public.tasks where id=$1`, [custom[0].id]);
  checkEqual('...and completion is attributed server-side', stamped[0].completed_by, T2.nurse.id);
  check('...with a timestamp', stamped[0].completed_at !== null);

  const cancelled = await rpc(sql, 'cancel_task', '$1, $2', [typed[0].id, 'Not required']);
  checkEqual('cancel_task works on a pending task', cancelled.status, 'cancelled');
  const cancelledAgain = await rpc(sql, 'cancel_task', '$1', [typed[0].id]);
  checkEqual('...and is idempotent', cancelledAgain.changed, false);
});

await h.asUser(T2.billing, async (sql) => {
  checkEqual('billing sees 0 tasks', (await sql(`select id from public.tasks`)).length, 0);
});

/* ========================================================================== */
section('4. ** Tier 2 gates bed/IPD assignment SERVER-SIDE, not in the UI **');

// ---- the Tier 1 clinic: every write path into the IPD surface is closed --------
await h.asUser(T1.admin, async (sql) => {
  await checkRejects('** a Tier 1 admin cannot create a bed at all (RLS, not a hidden button) **',
    () => sql(`insert into public.beds (tenant_id, ward_name, bed_number) values ($1,'General','1')`,
      [T1.tenantId]), '42501');
});

// The RPC gate is checked independently of the table gate, because either alone
// would leave a hole: policies alone would not stop an admit against a bed that
// somehow exists, and an RPC check alone would not stop a direct PostgREST insert.
await h.asOwner(`insert into public.beds (tenant_id, ward_name, bed_number, status)
                 values ($1,'Smuggled','X1','available')`, [T1.tenantId]);
await h.asUser(T1.nurse, async (sql) => {
  const bed = await sql(`select id from public.beds where tenant_id=$1`, [T1.tenantId]);
  checkEqual('(a bed planted by the platform owner is readable — SELECT is deliberately not gated)', bed.length, 1);
  const admit = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [t1Case.visitId, bed[0].id]);
  checkEqual('** admitting in a Tier 1 clinic returns TIER_NOT_ENABLED **', admit.code, 'TIER_NOT_ENABLED');
  checkEqual('...with the required tier, so the UI can say what to upgrade to', Number(admit.required_tier), 2);
  checkEqual('...and the current tier', Number(admit.current_tier), 1);

  const status = await rpc(sql, 'set_bed_status', '$1, $2', [bed[0].id, 'maintenance']);
  checkEqual('set_bed_status is gated too', status.code, 'TIER_NOT_ENABLED');
});
await h.asOwner(`delete from public.beds where tenant_id=$1`, [T1.tenantId]);

// ...and the ungated surfaces genuinely still work for a Tier 1 clinic. This is the
// other half of the boundary decision: a solo clinic's nurse takes vitals.
await h.asUser(T1.nurse, async (sql) => {
  const v = await sql(
    `insert into public.vitals (tenant_id, visit_id, recorded_by, temperature_c) values ($1,$2,$3,37.1) returning id`,
    [T1.tenantId, t1Case.visitId, T1.nurse.id]);
  check('** a Tier 1 nurse CAN record vitals (deliberately not tier-gated) **', v.length === 1);
  const t = await sql(
    `insert into public.tasks (tenant_id, visit_id, task_type, title, due_at) values ($1,$2,'custom','Call back', now()) returning id`,
    [T1.tenantId, t1Case.visitId]);
  check('** a Tier 1 nurse CAN use the task board **', t.length === 1);
});

section('4b. beds and admission in the Tier 2 clinic');

let bedA = '';
let bedB = '';
await h.asUser(T2.admin, async (sql) => {
  const a = await sql(`insert into public.beds (tenant_id, ward_name, bed_number)
                       values ($1,'General','4') returning id, status`, [T2.tenantId]);
  const b = await sql(`insert into public.beds (tenant_id, ward_name, bed_number)
                       values ($1,'General','5') returning id`, [T2.tenantId]);
  bedA = a[0].id as string;
  bedB = b[0].id as string;
  checkEqual('a Tier 2 admin can create a bed, and it starts available', a[0].status, 'available');

  await checkRejects('a ward cannot have two bed 4s',
    () => sql(`insert into public.beds (tenant_id, ward_name, bed_number) values ($1,'General','4')`,
      [T2.tenantId]), '23505');
  await checkRejects('beds.status is not client-writable',
    () => sql(`update public.beds set status='occupied' where id=$1`, [bedA]), '42501');
  await checkRejects('beds.current_visit_id is not client-writable',
    () => sql(`update public.beds set current_visit_id=$1 where id=$2`, [t2Case.visitId, bedA]), '42501');
});

await h.asUser(T2.nurse, async (sql) => {
  await checkRejects('a nurse cannot create ward inventory even at Tier 2 (admin only)',
    () => sql(`insert into public.beds (tenant_id, ward_name, bed_number) values ($1,'ICU','1')`,
      [T2.tenantId]), '42501');
});

const ipdCase = await openVisit(T2, 'Inpatient One', '9900000003');

await h.asUser(T2.nurse, async (sql) => {
  const admit = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [ipdCase.visitId, bedA]);
  checkEqual('admitting succeeds at Tier 2', admit.ok, true);
  checkEqual('...and reports the ward', admit.ward_name, 'General');
  checkEqual('...and the bed', admit.bed_number, '4');
  checkEqual('...marked as a change', admit.changed, true);

  const again = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [ipdCase.visitId, bedA]);
  checkEqual('re-admitting to the same bed is an idempotent no-op', again.changed, false);
});

{
  const st = await h.asOwner(
    `select v.care_setting, v.admitted_at, v.bed_id, v.discharged_at,
            b.status as bed_status, b.current_visit_id
       from public.visits v join public.beds b on b.id=$2
      where v.id=$1`, [ipdCase.visitId, bedA]);
  checkEqual('the visit became an IPD encounter', st[0].care_setting, 'ipd');
  check('...with an admission timestamp', st[0].admitted_at !== null);
  checkEqual('...pointing at the bed', st[0].bed_id, bedA);
  checkEqual('the bed became occupied', st[0].bed_status, 'occupied');
  checkEqual('...by that visit', st[0].current_visit_id, ipdCase.visitId);
}

// Admission is deliberately NOT wired into visits.status — the two axes are
// separate, which is the point of care_setting existing at all.
{
  const s = await h.asOwner(`select status from public.visits where id=$1`, [ipdCase.visitId]);
  checkEqual('admission did NOT touch visits.status (separate axis)', s[0].status, 'queued');
}

// One-shot task generation.
{
  const tasks = await h.asOwner(
    `select task_type, status, is_auto, source_type, title from public.tasks
      where visit_id=$1 and source_type='admission'`, [ipdCase.visitId]);
  checkEqual('admission created exactly ONE baseline vitals task', tasks.length, 1);
  checkEqual('...of the right type', tasks[0].task_type, 'vitals_due');
  checkEqual('...flagged as system-generated', tasks[0].is_auto, true);
}

section('4c. bed availability, transfer, and the occupancy invariant');

const secondCase = await openVisit(T2, 'Inpatient Two', '9900000004');
await h.asUser(T2.nurse, async (sql) => {
  const clash = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [secondCase.visitId, bedA]);
  checkEqual('** a second patient cannot be admitted to an occupied bed **', clash.code, 'BED_NOT_AVAILABLE');
  checkEqual('...and the response says why without naming the occupant', clash.bed_status, 'occupied');
  check('...and carries no patient identity', clash.patient_id === undefined && clash.patient_number === undefined);

  const transfer = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [ipdCase.visitId, bedB]);
  checkEqual('transferring the first patient to another bed works', transfer.ok, true);
  check('...and reports where they came from', (transfer.transferred_from as Row)?.bed_number === '4');
});

{
  const beds = await h.asOwner(`select id, status, current_visit_id from public.beds where id in ($1,$2) order by bed_number`, [bedA, bedB]);
  const a = beds.find((b) => b.id === bedA)!;
  const b = beds.find((b) => b.id === bedB)!;
  checkEqual('the vacated bed goes to cleaning, not straight to available', a.status, 'cleaning');
  checkEqual('...and is no longer occupied', a.current_visit_id, null);
  checkEqual('the new bed is occupied', b.status, 'occupied');
}

// Structural, not policy: holds even as the owner with RLS out of the picture.
await checkRejects('an occupied bed cannot claim to be available, even as owner',
  () => h.asOwner(`update public.beds set status='available' where id=$1`, [bedB]), '23514');
await checkRejects('a bed cannot be occupied with no occupant, even as owner',
  () => h.asOwner(`update public.beds set status='occupied' where id=$1`, [bedA]), '23514');
await checkRejects('one visit cannot occupy two beds, even as owner',
  () => h.asOwner(`update public.beds set status='occupied', current_visit_id=$1 where id=$2`,
    [ipdCase.visitId, bedA]), '23505');
await checkRejects('an OPD visit cannot carry an admission timestamp, even as owner',
  () => h.asOwner(`update public.visits set admitted_at=now() where id=$1`, [t2Case.visitId]), '23514');

await h.asUser(T2.nurse, async (sql) => {
  const bad = await rpc(sql, 'set_bed_status', '$1, $2', [bedA, 'occupied']);
  checkEqual('set_bed_status refuses "occupied" as a target', bad.code, 'INVALID_BED_STATUS');
  const busy = await rpc(sql, 'set_bed_status', '$1, $2', [bedB, 'cleaning']);
  checkEqual('...and refuses to touch an occupied bed', busy.code, 'BED_OCCUPIED');
  const turned = await rpc(sql, 'set_bed_status', '$1, $2', [bedA, 'available']);
  checkEqual('housekeeping can release a cleaned bed', turned.status, 'available');
});

await h.asUser(T2.admin, async (sql) => {
  const del = await sql(`delete from public.beds where id=$1 returning id`, [bedB]);
  checkEqual('an occupied bed cannot be deleted (policy filters it out)', del.length, 0);
});

section('4d. discharge — and why it is NOT tier-gated');

await h.asUser(T2.nurse, async (sql) => {
  const notAdmitted = await rpc(sql, 'discharge_patient', '$1', [t2Case.visitId]);
  checkEqual('discharging an OPD visit returns NOT_ADMITTED', notAdmitted.code, 'NOT_ADMITTED');

  const out = await rpc(sql, 'discharge_patient', '$1, $2', [ipdCase.visitId, 'Stable, home']);
  checkEqual('discharge succeeds', out.ok, true);
  checkEqual('...releasing the bed', out.bed_released, bedB);
  check('...and cancelling the pending ward tasks', Number(out.pending_tasks_cancelled) >= 1);

  const twice = await rpc(sql, 'discharge_patient', '$1', [ipdCase.visitId]);
  checkEqual('discharging twice is refused distinguishably', twice.code, 'ALREADY_DISCHARGED');
});

{
  const st = await h.asOwner(
    `select v.discharged_at, v.bed_id, v.care_setting, b.status, b.current_visit_id
       from public.visits v join public.beds b on b.id=$2 where v.id=$1`, [ipdCase.visitId, bedB]);
  check('discharged_at is stamped', st[0].discharged_at !== null);
  checkEqual('the bed goes to cleaning', st[0].status, 'cleaning');
  checkEqual('...and is freed', st[0].current_visit_id, null);
  // The asymmetry is deliberate: live occupancy is cleared, the encounter's record
  // of which bed was used is kept.
  checkEqual('visits.bed_id is RETAINED as part of the encounter record', st[0].bed_id, bedB);
  checkEqual('...and it is still an IPD encounter', st[0].care_setting, 'ipd');

  const tasks = await h.asOwner(
    `select status, cancellation_reason from public.tasks
      where visit_id=$1 and source_type='admission'`, [ipdCase.visitId]);
  checkEqual('the baseline task was cancelled, not left haunting the board', tasks[0].status, 'cancelled');
  checkEqual('...with a reason', tasks[0].cancellation_reason, 'Patient discharged');
}

// The documented exception: a tier downgrade must never trap an admitted patient.
{
  const trapped = await openVisit(T2, 'Downgrade Patient', '9900000005');
  await h.asUser(T2.nurse, (sql) => rpc(sql, 'admit_patient_to_bed', '$1, $2', [trapped.visitId, bedA]));
  // Platform owner lowers the tier while somebody is in a bed.
  await h.asOwner(`update public.tenants set tier=1 where id=$1`, [T2.tenantId]);
  await h.asUser(T2.nurse, async (sql) => {
    const admitNow = await rpc(sql, 'admit_patient_to_bed', '$1, $2', [secondCase.visitId, bedB]);
    checkEqual('after a downgrade, new admissions are blocked', admitNow.code, 'TIER_NOT_ENABLED');
    const out = await rpc(sql, 'discharge_patient', '$1', [trapped.visitId]);
    checkEqual('** ...but the already-admitted patient can still be discharged **', out.ok, true);
  });
  await h.asOwner(`update public.tenants set tier=2 where id=$1`, [T2.tenantId]);
  await h.asUser(T2.nurse, (sql) => rpc(sql, 'set_bed_status', '$1, $2', [bedA, 'available']));
}

await h.asUser(T2.admin, async (sql) => {
  await checkRejects('even a Tier 2 admin cannot write visits.care_setting directly',
    () => sql(`update public.visits set care_setting='ipd' where id=$1`, [t2Case.visitId]), '42501');
  await checkRejects('...nor admitted_at',
    () => sql(`update public.visits set admitted_at=now() where id=$1`, [t2Case.visitId]), '42501');
  await checkRejects('...nor bed_id',
    () => sql(`update public.visits set bed_id=$1 where id=$2`, [bedA, t2Case.visitId]), '42501');
  await checkRejects('...and still cannot raise their own tier',
    () => sql(`update public.tenants set tier=3 where id=$1`, [T2.tenantId]), '42501');
});

/* ========================================================================== */
section('5. ** medication administration — the right-patient check **');

// An issued prescription with one item, for the Tier 2 inpatient.
const medCase = await openVisit(T2, 'Medication Patient', '9900000006');
let itemId = '';
let draftItemId = '';
await h.asUser(T2.doctor, async (sql) => {
  await rpc(sql, 'set_visit_status', '$1, $2', [medCase.visitId, 'in_consultation']);
  const rx = await sql(`insert into public.prescriptions (tenant_id, visit_id, doctor_id) values ($1,$2,$3) returning id`,
    [T2.tenantId, medCase.visitId, T2.doctor.id]);
  const drug = await sql(`select id from public.drugs where brand_name='Dolo 650'`);
  const item = await sql(
    `insert into public.prescription_items (prescription_id, tenant_id, drug_id, drug_name, dose, frequency, quantity)
     values ($1,$2,$3,'Dolo 650','650 mg','TDS',9) returning id`,
    [rx[0].id, T2.tenantId, drug[0].id]);
  itemId = item[0].id as string;
  const issued = await rpc(sql, 'issue_prescription', '$1', [rx[0].id]);
  checkEqual('a prescription is issued for the administration tests', issued.ok, true);

  // ...and a second one left as a draft, to prove an unissued drug cannot be given.
  const draft = await sql(`insert into public.prescriptions (tenant_id, visit_id, doctor_id) values ($1,$2,$3) returning id`,
    [T2.tenantId, medCase.visitId, T2.doctor.id]);
  const dItem = await sql(
    `insert into public.prescription_items (prescription_id, tenant_id, drug_name) values ($1,$2,'Draft Drug') returning id`,
    [draft[0].id, T2.tenantId]);
  draftItemId = dItem[0].id as string;
});

await h.asUser(T2.nurse, async (sql) => {
  await checkRejects('no client INSERT on medication_administrations (the check cannot be bypassed)',
    () => sql(`insert into public.medication_administrations
               (tenant_id, prescription_item_id, visit_id, administered_by, status, scan_basis)
               values ($1,$2,$3,$4,'given','patient_id')`,
      [T2.tenantId, itemId, medCase.visitId, T2.nurse.id]), '42501');

  const noScan = await rpc(sql, 'record_medication_administration', '$1, $2', [itemId, '']);
  checkEqual('** an empty scan is SCAN_REQUIRED, not a skipped check **', noScan.code, 'SCAN_REQUIRED');

  const junk = await rpc(sql, 'record_medication_administration', '$1, $2', [itemId, 'UHID-999999']);
  checkEqual('** an unreadable/unknown band is PATIENT_CODE_UNRECOGNISED **', junk.code, 'PATIENT_CODE_UNRECOGNISED');
  checkEqual('...and says explicitly that the patient was not verified', junk.patient_verified, false);

  // The case the whole feature exists for: right drug, wrong bedside.
  const wrong = await rpc(sql, 'record_medication_administration', '$1, $2',
    [itemId, `UHID-${ipdCase.patientNumber}`]);
  checkEqual('** scanning a DIFFERENT patient returns PATIENT_MISMATCH **', wrong.code, 'PATIENT_MISMATCH');
  checkEqual('...not verified', wrong.patient_verified, false);
  checkEqual('...and demands acknowledgement', wrong.requires_acknowledgement, true);
  check('...while leaking neither patient\'s identity',
    wrong.patient_id === undefined && wrong.patient_number === undefined && wrong.full_name === undefined);

  const draftGiven = await rpc(sql, 'record_medication_administration', '$1, $2',
    [draftItemId, `UHID-${medCase.patientNumber}`]);
  checkEqual('a drug on an unissued draft cannot be given', draftGiven.code, 'PRESCRIPTION_NOT_ISSUED');

  // Correct scan, by UHID.
  const ok1 = await rpc(sql, 'record_medication_administration', '$1, $2',
    [itemId, `UHID-${medCase.patientNumber}`]);
  checkEqual('** the correct patient by UHID is accepted **', ok1.ok, true);
  checkEqual('...with positive verification, not silent success', ok1.patient_verified, true);
  checkEqual('...recording how the code resolved', ok1.scan_basis, 'patient_number');
  checkEqual('...and echoing the drug for the confirmation toast', ok1.drug_name, 'Dolo 650');

  // Second dose of the SAME item — legitimate for 'TDS', but must be flagged.
  const dup = await rpc(sql, 'record_medication_administration', '$1, $2',
    [itemId, `UHID-${medCase.patientNumber}`]);
  checkEqual('** a repeat dose is reported distinguishably as ALREADY_ADMINISTERED **', dup.code, 'ALREADY_ADMINISTERED');
  checkEqual('...the patient check still passed, so the UI can say which problem this is', dup.patient_verified, true);
  checkEqual('...and it is overridable, because TDS really is three doses', dup.can_override, true);
  check('...with the previous administration attached', (dup.previous_administration as Row)?.id !== undefined);

  const ok2 = await rpc(sql, 'record_medication_administration', '$1, $2, $3, $4, $5',
    [itemId, `UHID-${medCase.patientNumber}`, 'given', 'Second dose of the day', true]);
  checkEqual('overriding records the genuine second dose', ok2.ok, true);

  // A refusal is an event, not an absence.
  const refused = await rpc(sql, 'record_medication_administration', '$1, $2, $3, $4',
    [itemId, medCase.patientId, 'refused', 'Patient declined']);
  checkEqual('a refusal is recordable', refused.ok, true);
  checkEqual('...and the uuid form of the code also resolves', refused.scan_basis, 'patient_id');
});

{
  const rows = await h.asOwner(
    `select status, scan_basis from public.medication_administrations
      where prescription_item_id=$1 order by administered_at`, [itemId]);
  checkEqual('three administration events are on record', rows.length, 3);
  checkEqual('...and the refusal is one of them',
    rows.filter((r) => r.status === 'refused').length, 1);
}

await h.asUser(T2.billing, async (sql) => {
  checkEqual('billing sees 0 medication administrations',
    (await sql(`select id from public.medication_administrations`)).length, 0);
});
await h.asUser(T2.nurse, async (sql) => {
  const mine = await sql(`select id from public.medication_administrations limit 1`);
  await checkRejects('the administration log is append-only — no UPDATE',
    () => sql(`update public.medication_administrations set notes='edited' where id=$1`, [mine[0].id]), '42501');
  await checkRejects('...and no DELETE',
    () => sql(`delete from public.medication_administrations where id=$1`, [mine[0].id]), '42501');
});

/* ========================================================================== */
section('6. ** critical lab values — "could not evaluate" is not "normal" **');

// The decision function on its own, either side of every boundary.
{
  const ev = async (name: string, value: string, unit: string | null) =>
    (await h.asUser(T2.doctor, (sql) =>
      rpc(sql, 'evaluate_lab_critical', '$1, $2, $3', [name, value, unit]))) as Row;

  const high = await ev('Serum Potassium', '6.5', 'mmol/L');
  checkEqual('K+ 6.5 mmol/L is evaluated', high.status, 'evaluated');
  checkEqual('...and critical', high.is_critical, true);
  checkEqual('...high', high.direction, 'high');

  const onBoundary = await ev('potassium', '6.2', 'mmol/L');
  checkEqual('a value exactly ON the critical limit is critical (inclusive)', onBoundary.is_critical, true);

  const low = await ev('K+', '2.5', 'meq/l');
  checkEqual('an alias (K+) resolves', low.status, 'evaluated');
  checkEqual('...a per-analyte unit alias (mEq/L for a monovalent ion) is accepted', low.is_critical, true);
  checkEqual('...low', low.direction, 'low');

  const normal = await ev('potassium', '4.2', 'mmol/L');
  checkEqual('K+ 4.2 is evaluated', normal.status, 'evaluated');
  checkEqual('...and NOT critical — this is the real "checked, normal"', normal.is_critical, false);

  const unknown = await ev('Serum Unobtainium', '42', 'mg/dL');
  checkEqual('** a test with no thresholds on file is no_reference, NOT normal **', unknown.status, 'no_reference');
  checkEqual('...and does not claim to be critical either', unknown.is_critical, false);

  const text = await ev('potassium', 'Haemolysed sample', 'mmol/L');
  checkEqual('a non-numeric result is unparseable_value', text.status, 'unparseable_value');

  const wrongUnit = await ev('potassium', '6.5', 'mg/dL');
  checkEqual('** an incompatible unit is unit_mismatch, not a silent comparison **', wrongUnit.status, 'unit_mismatch');

  // The per-analyte unit rule earning its keep: mEq/L is NOT interchangeable for a
  // divalent ion, so calcium must refuse it even though potassium accepts it.
  const calcium = await ev('calcium', '14.0', 'meq/l');
  checkEqual('mEq/L is refused for calcium (divalent — not interchangeable)', calcium.status, 'unit_mismatch');
  const calciumOk = await ev('calcium', '14.0', 'mg/dL');
  checkEqual('...while mg/dL is evaluated', calciumOk.is_critical, true);

  const censored = await ev('creatinine', '>9.5', 'mg/dL');
  checkEqual('a censored result (>9.5) is parsed', censored.status, 'evaluated');
  checkEqual('...and flagged', censored.is_critical, true);

  const noUnit = await ev('potassium', '6.8', null);
  checkEqual('a missing unit is assumed to be the reference unit (documented)', noUnit.status, 'evaluated');
}

section('6b. ordering a test — Architecture.md §3\'s fan-out');

let labOrderId = '';
await h.asUser(T2.doctor, async (sql) => {
  const o = await sql(
    `insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name, priority)
     values ($1,$2,$3,$4,'Serum Potassium','urgent') returning id, status`,
    [T2.tenantId, medCase.visitId, medCase.patientId, T2.doctor.id]);
  labOrderId = o[0].id as string;
  checkEqual('a doctor can order a test with a plain insert', o[0].status, 'pending');

  await checkRejects('lab_orders.status is not client-writable',
    () => sql(`update public.lab_orders set status='completed' where id=$1`, [labOrderId]), '42501');
  await checkRejects('a doctor cannot attribute an order to a colleague',
    () => sql(`insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
               values ($1,$2,$3,$4,'X')`,
      [T2.tenantId, medCase.visitId, medCase.patientId, T2.admin.id]), '42501');
});

await h.asUser(T2.nurse, async (sql) => {
  await checkRejects('a nurse cannot order a test (clinical decision)',
    () => sql(`insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
               values ($1,$2,$3,$4,'CBC')`,
      [T2.tenantId, medCase.visitId, medCase.patientId, T2.nurse.id]), '42501');
});

{
  const charge = await h.asOwner(
    `select source_type, description, unit_amount, tax_category, is_auto
       from public.billing_line_items where source_id=$1`, [labOrderId]);
  checkEqual('the order raised exactly one billing line', charge.length, 1);
  checkEqual('...of source_type lab (reserved back in Phase 2)', charge[0].source_type, 'lab');
  checkEqual('...auto-captured', charge[0].is_auto, true);
  checkEqual('...at zero, for billing to price', Number(charge[0].unit_amount), 0);
  checkEqual('...and exempt, because a diagnostic test is a healthcare service', charge[0].tax_category, 'exempt');

  const task = await h.asOwner(
    `select task_type, status, title, is_auto from public.tasks where source_id=$1`, [labOrderId]);
  checkEqual('...and one nurse task', task.length, 1);
  checkEqual('...to collect the sample', task[0].task_type, 'sample_collection_due');
  check('...labelled with the test and its priority', String(task[0].title).includes('Serum Potassium')
    && String(task[0].title).includes('URGENT'));
}

await h.asUser(T2.nurse, async (sql) => {
  const collected = await rpc(sql, 'set_lab_order_status', '$1, $2', [labOrderId, 'sample_collected']);
  checkEqual('marking the sample collected succeeds', collected.ok, true);
  checkEqual('...and closes the collection card automatically', Number(collected.tasks_closed), 1);

  const bad = await rpc(sql, 'set_lab_order_status', '$1, $2', [labOrderId, 'pending']);
  checkEqual('an illegal transition is refused with from/to', bad.code, 'INVALID_STATUS_TRANSITION');
  checkEqual('...naming where it came from', bad.from, 'sample_collected');
});

section('6c. recording results — and the three states of a critical check');

let criticalResultId = '';
await h.asUser(T2.nurse, async (sql) => {
  await checkRejects('no client INSERT on lab_results (flags are server-derived)',
    () => sql(`insert into public.lab_results (lab_order_id, tenant_id, result_value, reported_by)
               values ($1,$2,'6.9',$3)`, [labOrderId, T2.tenantId, T2.nurse.id]), '42501');

  const res = await rpc(sql, 'record_lab_result', '$1, $2, $3', [labOrderId, '6.9', 'mmol/L']);
  criticalResultId = res.lab_result_id as string;
  checkEqual('recording a result succeeds', res.ok, true);
  checkEqual('** a critical potassium is flagged critical **', res.is_critical, true);
  checkEqual('...evaluated, so the flag is meaningful', res.critical_check_status, 'evaluated');
  checkEqual('...high', res.critical_direction, 'high');
  checkEqual('...no manual review needed — the check ran', res.requires_manual_review, false);
  checkEqual('** ...and the person entering it is told to acknowledge **', res.requires_acknowledgement, true);
  checkEqual('...with the threshold that fired', Number(res.critical_high), 6.2);
  checkEqual('the order is completed by recording a result', res.lab_order_status, 'completed');
  check('...and the disclaimer travels with it', typeof res.reference_disclaimer === 'string');
});

// The DoD assertion: an unevaluable check must not look like a clean one.
await h.asUser(T2.doctor, async (sql) => {
  const o = await sql(
    `insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
     values ($1,$2,$3,$4,'Serum Unobtainium') returning id`,
    [T2.tenantId, medCase.visitId, medCase.patientId, T2.doctor.id]);
  const res = await rpc(sql, 'record_lab_result', '$1, $2, $3', [o[0].id, '42', 'mg/dL']);
  checkEqual('an unknown test still records a result', res.ok, true);
  checkEqual('** ...with critical_check_status = no_reference **', res.critical_check_status, 'no_reference');
  checkEqual('** ...is_critical false BUT requires_manual_review TRUE **', res.requires_manual_review, true);
  checkEqual('** ...so requires_acknowledgement is true — never a silent pass **', res.requires_acknowledgement, true);
  checkEqual('...and it does not pretend to be critical either', res.is_critical, false);
});

// ...and a genuinely clean result is distinguishable from both.
let normalResultId = '';
await h.asUser(T2.doctor, async (sql) => {
  const o = await sql(
    `insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
     values ($1,$2,$3,$4,'Haemoglobin') returning id`,
    [T2.tenantId, medCase.visitId, medCase.patientId, T2.doctor.id]);
  const res = await rpc(sql, 'record_lab_result', '$1, $2, $3', [o[0].id, '13.4', 'g/dL']);
  normalResultId = res.lab_result_id as string;
  checkEqual('** a checked-and-normal result: is_critical false **', res.is_critical, false);
  checkEqual('** ...requires_manual_review false **', res.requires_manual_review, false);
  checkEqual('** ...requires_acknowledgement false. This is the ONLY reassuring combination **',
    res.requires_acknowledgement, false);
});

// Structural: the flag cannot be raised on an unevaluated result, whatever writes it.
await checkRejects('is_critical cannot be set without an evaluated check, even as owner',
  () => h.asOwner(`update public.lab_results set is_critical=true, critical_check_status='no_reference',
                   critical_direction='high' where id=$1`, [normalResultId]), '23514');
// normalResultId is 'evaluated' with no direction, so this isolates the
// direction constraint rather than the evaluation one above.
await checkRejects('a critical flag must state a direction, even as owner',
  () => h.asOwner(`update public.lab_results set is_critical=true where id=$1`, [normalResultId]), '23514');
await checkRejects('...and a direction cannot be set without the flag',
  () => h.asOwner(`update public.lab_results set critical_direction='high' where id=$1`, [normalResultId]), '23514');

section('6d. the alert is an alert, not a passive row');

await h.asUser(T2.doctor, async (sql) => {
  const alerts = await sql(
    `select lab_result_id, test_name, patient_number, is_critical, requires_manual_review,
            acknowledged_at, ward_name
       from public.critical_lab_alerts order by reported_at`);
  checkEqual('the alert feed holds the critical AND the unevaluable result', alerts.length, 2);
  checkEqual('...and not the normal one',
    alerts.filter((a) => a.lab_result_id === normalResultId).length, 0);
  check('...all unacknowledged so far', alerts.every((a) => a.acknowledged_at === null));
  check('...identifying the patient by UHID only, with no name column',
    alerts.every((a) => a.patient_number !== null) && !('patient_name' in alerts[0]));

  const payload = await rpc(sql, 'get_critical_lab_alert_payload', '$1', [criticalResultId]);
  checkEqual('the assembled payload resolves', payload.ok, true);
  const alert = payload.alert as Row;
  checkEqual('...with a precomputed severity the dispatcher does not have to infer', alert.severity, 'critical');
  check('...and a ready-made headline', String(alert.headline).includes('critically HIGH'));
  check('...carrying no patient name', alert.patient_name === undefined && alert.full_name === undefined);

  const missing = await rpc(sql, 'get_critical_lab_alert_payload', '$1', [normalResultId]);
  checkEqual('a non-alertable result yields no payload', missing.code, 'ALERT_NOT_FOUND');
});

await h.asUser(T2.nurse, async (sql) => {
  const ack = await rpc(sql, 'acknowledge_critical_result', '$1, $2', [criticalResultId, 'Doctor informed']);
  checkEqual('a nurse can acknowledge the alert', ack.ok, true);
  checkEqual('...and it is attributed', ack.acknowledged_by, T2.nurse.id);
  const again = await rpc(sql, 'acknowledge_critical_result', '$1', [criticalResultId]);
  checkEqual('acknowledging twice is idempotent, not an error', again.changed, false);
  const notAlert = await rpc(sql, 'acknowledge_critical_result', '$1', [normalResultId]);
  checkEqual('a normal result cannot be acknowledged (NOT_ALERTABLE)', notAlert.code, 'NOT_ALERTABLE');
});

await h.asUser(T2.billing, async (sql) => {
  checkEqual('** billing can read lab ORDERS (it bills for them) **',
    (await sql(`select id from public.lab_orders`)).length > 0, true);
  checkEqual('** ...but sees 0 lab RESULTS (a finding is not a service line) **',
    (await sql(`select id from public.lab_results`)).length, 0);
  const ack = await rpc(sql, 'acknowledge_critical_result', '$1', [criticalResultId]);
  checkEqual('...and cannot clear a clinical alert', ack.code, 'NOT_CLINICAL_STAFF');
});

section('6e. cancelling an order withdraws its charge');

await h.asUser(T2.doctor, async (sql) => {
  const o = await sql(
    `insert into public.lab_orders (tenant_id, visit_id, patient_id, ordered_by, test_name)
     values ($1,$2,$3,$4,'Serum Sodium') returning id`,
    [T2.tenantId, medCase.visitId, medCase.patientId, T2.doctor.id]);
  const orderId = o[0].id as string;

  const before = await sql(`select id from public.billing_line_items where source_id=$1`, [orderId]);
  checkEqual('the order raised a pending charge', before.length, 1);

  const cancelled = await rpc(sql, 'set_lab_order_status', '$1, $2, $3', [orderId, 'cancelled', 'Ordered in error']);
  checkEqual('cancelling succeeds', cancelled.ok, true);
  checkEqual('** ...and withdraws the pending charge, so a cancelled test is not billed **',
    Number(cancelled.pending_charges_removed), 1);
  checkEqual('...reporting that nothing was already invoiced', cancelled.billing_line_invoiced, false);
  checkEqual('...and cancelling the collection card', Number(cancelled.tasks_closed), 1);

  const after = await sql(`select id from public.billing_line_items where source_id=$1`, [orderId]);
  checkEqual('the charge is gone', after.length, 0);

  const res = await rpc(sql, 'record_lab_result', '$1, $2', [orderId, '140']);
  checkEqual('a result cannot be recorded against a cancelled order', res.code, 'LAB_ORDER_CANCELLED');
});

/* ========================================================================== */
section('7. ** the supabase_realtime publication **');

{
  const expected = ['lab_orders', 'lab_results', 'tasks', 'visits', 'vitals'];
  const rows = await h.asOwner(`
    select tablename from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public'
    order by tablename`);
  const present = rows.map((r) => r.tablename as string);
  for (const t of expected) {
    check(`** public.${t} is published for Realtime **`, present.includes(t),
      `publication holds ${JSON.stringify(present)}`);
  }
  // Carried forward from Phase 2, where it was deliberately deferred.
  check('...including visits, which Phase 2 left out until a subscriber existed',
    present.includes('visits'));
}

/* ========================================================================== */
section('8. anon has no Phase 3 surface');

await h.asAnon(async (sql) => {
  for (const t of ['vitals', 'tasks', 'beds', 'medication_administrations',
    'lab_orders', 'lab_results', 'lab_critical_ranges'] as const) {
    await checkRejects(`anon cannot read ${t}`, () => sql(`select 1 from public.${t}`), '42501');
  }
  for (const v of ['rounds_overview', 'critical_lab_alerts'] as const) {
    await checkRejects(`anon cannot read the ${v} view`, () => sql(`select 1 from public.${v}`), '42501');
  }
  await checkRejects('anon cannot call admit_patient_to_bed',
    () => sql(`select public.admit_patient_to_bed($1,$2)`, [ipdCase.visitId, bedA]), '42501');
  await checkRejects('anon cannot call record_medication_administration',
    () => sql(`select public.record_medication_administration($1,$2)`, [itemId, 'x']), '42501');
  await checkRejects('anon cannot call evaluate_lab_critical',
    () => sql(`select public.evaluate_lab_critical('potassium','6.9','mmol/L')`), '42501');
  await checkRejects('anon cannot call record_lab_result',
    () => sql(`select public.record_lab_result($1,'1')`, [labOrderId]), '42501');
});

await h.close();
summary('Phase 3 nurse workflows, IPD, medication administration and lab values (local / PGlite)');
