/**
 * PHASE 3 — NURSE WORKFLOWS, IPD, MEDICATION ADMINISTRATION AND LAB VALUES
 * against the REAL linked Supabase project.
 *
 *   npm run db:seed            # 2 tenants x 4 roles; Sunrise=Tier 1, Lotus=Tier 2
 *   npm run test:phase3:remote
 *
 * Companion to supabase/tests/local/phase3-flow.test.ts (236 assertions) and
 * phase3-isolation.test.ts (169). The local suites prove the SQL, the policies and
 * the triggers are correct against a real Postgres engine with no credentials
 * needed. This one closes what the local harness cannot reach:
 *
 *   - real GoTrue sessions, not simulated JWT claims — so current_tenant_id(),
 *     has_tenant_role() and tenant_has_tier() are resolving from a genuine
 *     `auth.uid()` inside a genuine request
 *   - real PostgREST, so denials arrive as the HTTP statuses and PostgrestError
 *     codes Prince actually has to map
 *   - the hosted project's own policies and grants, as applied by `db push`,
 *     rather than as replayed into a fresh local database
 *
 * SCOPE. This deliberately does NOT re-assert all 405 local checks. It covers the
 * claims in phases.md's Definition of Done plus every path where the real stack
 * could plausibly differ from the local harness. Catalogue-level facts that
 * supabase-js cannot observe at all — Realtime publication membership,
 * security_invoker on the views, whether a REVOKE landed — are verified separately
 * by `npm run verify:catalog`.
 *
 * TIER FIXTURES MATTER HERE. Sunrise (tenant A) is Tier 1 and Lotus (tenant B) is
 * Tier 2, set by the seed script with the service role because `tenants.tier` is
 * unwritable from any client session. That gives both sides of the Tier 2 gate a
 * real tenant to be tested against; a suite with only a Tier 2 tenant would
 * confirm the feature works and never confirm the gate does.
 *
 * Uses only the publishable/anon key. No service-role key anywhere in this file.
 *
 * RE-RUNNABLE without a reset: every patient this suite registers carries a
 * run-scoped phone suffix, so a second run does not trip register_patient()'s
 * duplicate-phone detection.
 */

import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { anonKey, requireEnv, supabaseUrl } from '../../scripts/env.ts';
import { SEED_TENANTS, tenantAdmin } from '../../scripts/fixtures.ts';
import { check, checkEqual, section, summary } from '../harness/assert.ts';

const URL = supabaseUrl();
const ANON = anonKey();
const PASSWORD = requireEnv('SEED_USER_PASSWORD');

const [tenantAFixture, tenantBFixture] = SEED_TENANTS;

/** Distinguishes this run's fixture data from any previous run's. */
const RUN = String(Date.now()).slice(-7);

type Envelope = Record<string, unknown> & { ok?: boolean; code?: string };

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) {
    console.error(`\nCould not sign in as ${email}: ${error.message}`);
    console.error('Run `npm run db:seed` first, and confirm SEED_USER_PASSWORD matches.\n');
    process.exit(1);
  }
  return client;
}

/** True when the error is a permission/RLS denial rather than a bug. */
function isDenial(error: PostgrestError | null): boolean {
  if (!error) return false;
  return (
    error.code === '42501' ||
    error.code === 'PGRST301' ||
    /permission denied|row-level security/i.test(error.message)
  );
}

/** True when the error is a CHECK/constraint rejection. */
function isConstraint(error: PostgrestError | null, sqlstate = '23514'): boolean {
  return !!error && error.code === sqlstate;
}

async function callRpc(c: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<Envelope> {
  const { data, error } = await c.rpc(fn, args);
  if (error) return { ok: false, code: `TRANSPORT_${error.code ?? 'ERROR'}`, message: error.message };
  return (data ?? {}) as Envelope;
}

/* ========================================================================== */
section('Setup — eight real sessions, two tenants, two tiers');

const A = {
  admin: await signIn(tenantAdmin(tenantAFixture).email),
  doctor: await signIn(tenantAFixture.users.find((u) => u.role === 'doctor')!.email),
  nurse: await signIn(tenantAFixture.users.find((u) => u.role === 'nurse')!.email),
  billing: await signIn(tenantAFixture.users.find((u) => u.role === 'billing')!.email),
};
const B = {
  admin: await signIn(tenantAdmin(tenantBFixture).email),
  doctor: await signIn(tenantBFixture.users.find((u) => u.role === 'doctor')!.email),
  nurse: await signIn(tenantBFixture.users.find((u) => u.role === 'nurse')!.email),
  billing: await signIn(tenantBFixture.users.find((u) => u.role === 'billing')!.email),
};
check('eight real sessions established', true);

async function whoami(c: SupabaseClient): Promise<{ id: string; tenantId: string }> {
  const { data, error } = await c.from('profiles').select('id, tenant_id').limit(1).maybeSingle();
  if (error || !data) throw new Error(`could not resolve own profile: ${error?.message}`);
  return { id: data.id as string, tenantId: data.tenant_id as string };
}

// A non-admin sees only their own profile row, so this resolves unambiguously.
const nurseA = await whoami(A.nurse);
const nurseB = await whoami(B.nurse);
const doctorA = await whoami(A.doctor);
const doctorB = await whoami(B.doctor);
const tenantAId = nurseA.tenantId;
const tenantBId = nurseB.tenantId;
check('the two tenants are distinct', tenantAId !== tenantBId);

{
  const { data: tA } = await A.admin.from('tenants').select('tier').eq('id', tenantAId).maybeSingle();
  const { data: tB } = await B.admin.from('tenants').select('tier').eq('id', tenantBId).maybeSingle();
  checkEqual('tenant A (Sunrise) is Tier 1 on the hosted project', Number(tA?.tier), 1);
  checkEqual('tenant B (Lotus) is Tier 2 on the hosted project', Number(tB?.tier), 2);
  check('...so both sides of the Tier 2 gate have a real tenant', Number(tA?.tier) < 2 && Number(tB?.tier) >= 2);
}

/** Registers a patient and opens a visit through the real RPCs. */
async function openVisit(
  t: { billing: SupabaseClient; doctor: SupabaseClient },
  doctorId: string,
  label: string,
  phoneTail: string,
  allergies?: string,
): Promise<{ patientId: string; patientNumber: number; visitId: string }> {
  const reg = await callRpc(t.billing, 'register_patient', {
    p_full_name: `${label} ${RUN}`,
    p_phone: `9${phoneTail}${RUN}`.slice(0, 10),
    p_age_years: 54,
    p_allergies: allergies ?? null,
  });
  if (reg.ok !== true) throw new Error(`register_patient failed: ${JSON.stringify(reg)}`);
  const visit = await callRpc(t.billing, 'check_in_patient', {
    p_patient_id: reg.patient_id,
    p_visit_type: 'new',
    p_doctor_id: doctorId,
  });
  if (visit.ok !== true) throw new Error(`check_in_patient failed: ${JSON.stringify(visit)}`);
  return {
    patientId: reg.patient_id as string,
    patientNumber: Number(reg.patient_number),
    visitId: visit.visit_id as string,
  };
}

const caseA = await openVisit(A, doctorA.id, 'RemoteA Patient', '11');
const caseB = await openVisit(B, doctorB.id, 'RemoteB Patient', '21', 'penicillin');
const caseB2 = await openVisit(B, doctorB.id, 'RemoteB Other', '22');
check('fixture encounters opened in both tenants', !!caseA.visitId && !!caseB.visitId && !!caseB2.visitId);

/* ========================================================================== */
section('1. vitals — the nullability contract, through real PostgREST');

// The headline product requirement, exercised over the actual wire rather than
// against the local harness. If PostgREST or the hosted grants disagreed with the
// migration, this is where it would show.
{
  const empty = await A.nurse
    .from('vitals')
    .insert({ tenant_id: tenantAId, visit_id: caseA.visitId, recorded_by: nurseA.id })
    .select('id')
    .maybeSingle();
  check('** a vitals row with NO measurements saves over PostgREST **', !empty.error && !!empty.data?.id,
    empty.error ? `code=${empty.error.code} ${empty.error.message}` : undefined);

  const tempOnly = await A.nurse
    .from('vitals')
    .insert({ tenant_id: tenantAId, visit_id: caseA.visitId, recorded_by: nurseA.id, temperature_c: 38.4 })
    .select('id, temperature_c')
    .maybeSingle();
  check('temperature alone saves', !tempOnly.error && Number(tempOnly.data?.temperature_c) === 38.4,
    tempOnly.error?.message);

  const halfBp = await A.nurse
    .from('vitals')
    .insert({ tenant_id: tenantAId, visit_id: caseA.visitId, recorded_by: nurseA.id, bp_systolic: 138 })
    .select('id')
    .maybeSingle();
  check('systolic with no diastolic saves (partial BP is legitimate)', !halfBp.error, halfBp.error?.message);

  // Impossible values are still refused — nullability is about incomplete data,
  // not about a slipped decimal point.
  const slip = await A.nurse
    .from('vitals')
    .insert({ tenant_id: tenantAId, visit_id: caseA.visitId, recorded_by: nurseA.id, temperature_c: 385 });
  check('temperature 385 is rejected with a CHECK violation', isConstraint(slip.error),
    slip.error ? `code=${slip.error.code}` : 'insert unexpectedly succeeded');

  const spo2 = await A.nurse
    .from('vitals')
    .insert({ tenant_id: tenantAId, visit_id: caseA.visitId, recorded_by: nurseA.id, spo2_percent: 150 });
  check('SpO2 150% is rejected', isConstraint(spo2.error),
    spo2.error ? `code=${spo2.error.code}` : 'insert unexpectedly succeeded');

  // Authorship cannot be reassigned.
  const forged = await A.nurse
    .from('vitals')
    .insert({ tenant_id: tenantAId, visit_id: caseA.visitId, recorded_by: doctorA.id, pulse_bpm: 80 });
  check('a nurse cannot attribute an observation to a colleague', forged.error !== null,
    forged.error ? `code=${forged.error.code}` : 'insert unexpectedly succeeded');
}

// Data minimisation, observed through the real stack.
{
  const { data, error } = await A.billing.from('vitals').select('id');
  check('billing reading vitals is denied or empty', isDenial(error) || (data?.length ?? 0) === 0,
    error ? `code=${error.code}` : `returned ${data?.length} rows`);

  const doc = await A.doctor.from('vitals').select('id');
  check('the doctor CAN read the nurse\'s vitals', !doc.error && (doc.data?.length ?? 0) > 0, doc.error?.message);
}

/* ========================================================================== */
section('2. ** the rounds trigger fired on the hosted project **');

{
  const { data, error } = await A.doctor
    .from('visits')
    .select('id, last_vitals_at')
    .eq('id', caseA.visitId)
    .maybeSingle();
  check('the visit row is readable', !error, error?.message);
  check('** visits.last_vitals_at was stamped by the trigger **', data?.last_vitals_at !== null);

  // The freshness signal must not be forgeable.
  const forge = await A.nurse
    .from('visits')
    .update({ last_vitals_at: new Date().toISOString() })
    .eq('id', caseA.visitId);
  check('visits.last_vitals_at is not client-writable', forge.error !== null,
    forge.error ? `code=${forge.error.code}` : 'update unexpectedly succeeded');
}

// rounds_overview is a security_invoker view; through PostgREST it must inherit the
// caller's policies on every base table.
{
  const doc = await A.doctor
    .from('rounds_overview')
    .select('visit_id, patient_name, temperature_c, bp_systolic, pulse_bpm, last_vitals_at, vitals_age_seconds, vitals_row_count, vitals_component_times')
    .eq('visit_id', caseA.visitId)
    .maybeSingle();
  check('the doctor can read rounds_overview', !doc.error, doc.error?.message);

  // THE ASSERTION THAT CAUGHT THE DEFECT FIXED IN 20260811071200.
  //
  // Section 1 recorded three separate rows for this encounter, in the realistic
  // partial-entry order: an empty set, then a temperature alone, then a systolic
  // alone. The original view took the single newest ROW, so the temperature — taken
  // moments earlier — read as NULL on the rounds card, which a clinician reads as
  // "not measured".
  //
  // Each measurement is now the latest known non-null value for the encounter, so
  // both survive. The local suite could not catch this: its fixture happened to
  // insert the fullest observation set last.
  check('** temperature from an EARLIER row still shows (latest known value per field) **',
    doc.data?.temperature_c !== null, `temperature_c=${doc.data?.temperature_c}`);
  check('** ...and so does the systolic from the newest row **',
    doc.data?.bp_systolic !== null, `bp_systolic=${doc.data?.bp_systolic}`);
  checkEqual('...with the exact values', Number(doc.data?.temperature_c), 38.4);
  checkEqual('...and the systolic', Number(doc.data?.bp_systolic), 138);

  // A measurement never recorded is still NULL — the property that makes the card
  // safe to read at a glance.
  checkEqual('a never-recorded measurement is NULL, unambiguously', doc.data?.pulse_bpm, null);

  const times = doc.data?.vitals_component_times as Record<string, string> | null;
  check('...and each populated value carries its own timestamp', !!times?.temperature_c && !!times?.bp_systolic,
    JSON.stringify(times));
  check('...while unpopulated ones are absent from the map, not null-valued',
    times !== null && !('pulse_bpm' in (times ?? {})), JSON.stringify(times));
  check('...so a composite card is detectable: the two times differ',
    times?.temperature_c !== times?.bp_systolic);
  check('...with the row count exposed', Number(doc.data?.vitals_row_count) >= 3);
  check('...with a computed staleness', Number(doc.data?.vitals_age_seconds) >= 0);

  const bill = await A.billing
    .from('rounds_overview')
    .select('visit_id, patient_name, temperature_c, pulse_bpm, last_vitals_at')
    .eq('visit_id', caseA.visitId)
    .maybeSingle();
  check('billing can read the rounds row (it needs the encounter)', !bill.error, bill.error?.message);
  check('...and sees the patient', typeof bill.data?.patient_name === 'string');
  check('** but every measurement is NULL for billing, through the view **',
    bill.data?.temperature_c === null && bill.data?.pulse_bpm === null,
    `temp=${bill.data?.temperature_c} pulse=${bill.data?.pulse_bpm}`);
  check('...while the non-clinical freshness timestamp is visible', bill.data?.last_vitals_at !== null);
}

/* ========================================================================== */
section('3. ** the Tier 2 gate, server-side, on the hosted project **');

// Tenant A is Tier 1. Every write path into the IPD surface must be shut.
{
  const bed = await A.admin
    .from('beds')
    .insert({ tenant_id: tenantAId, ward_name: 'General', bed_number: `T1-${RUN}` });
  check('** a Tier 1 admin cannot create a bed **', bed.error !== null,
    bed.error ? `code=${bed.error.code}` : 'insert unexpectedly succeeded');

  const admit = await callRpc(A.nurse, 'admit_patient_to_bed', {
    p_visit_id: caseA.visitId,
    p_bed_id: '00000000-0000-0000-0000-000000000000',
  });
  checkEqual('** admitting in a Tier 1 clinic returns TIER_NOT_ENABLED **', admit.code, 'TIER_NOT_ENABLED');
  checkEqual('...before any bed lookup, so it cannot be used to probe bed ids', admit.code, 'TIER_NOT_ENABLED');
  checkEqual('...naming the required tier', Number(admit.required_tier), 2);
  checkEqual('...and the current one', Number(admit.current_tier), 1);
}

// ...and the ungated surfaces genuinely work for that same Tier 1 clinic. This is
// the other half of the documented boundary: a solo clinic's nurse takes vitals.
{
  const task = await A.nurse
    .from('tasks')
    .insert({ tenant_id: tenantAId, visit_id: caseA.visitId, task_type: 'custom', title: 'Call back', due_at: new Date().toISOString() })
    .select('id')
    .maybeSingle();
  check('** a Tier 1 nurse CAN use the task board (deliberately ungated) **', !task.error, task.error?.message);

  const order = await A.doctor
    .from('lab_orders')
    .insert({ tenant_id: tenantAId, visit_id: caseA.visitId, patient_id: caseA.patientId, ordered_by: doctorA.id, test_name: 'Haemoglobin' })
    .select('id')
    .maybeSingle();
  check('** a Tier 1 doctor CAN order a lab test (deliberately ungated) **', !order.error, order.error?.message);
}

section('3b. the Tier 2 clinic can actually run a ward');

let bedB = '';
let bedB2 = '';
{
  const b1 = await B.admin
    .from('beds')
    .insert({ tenant_id: tenantBId, ward_name: 'General', bed_number: `R-${RUN}-1` })
    .select('id, status')
    .maybeSingle();
  check('a Tier 2 admin can create a bed', !b1.error, b1.error?.message);
  checkEqual('...and it starts available', b1.data?.status, 'available');
  bedB = b1.data?.id as string;

  const b2 = await B.admin
    .from('beds')
    .insert({ tenant_id: tenantBId, ward_name: 'General', bed_number: `R-${RUN}-2` })
    .select('id')
    .maybeSingle();
  bedB2 = b2.data?.id as string;

  const nurseBed = await B.nurse
    .from('beds')
    .insert({ tenant_id: tenantBId, ward_name: 'ICU', bed_number: `R-${RUN}-X` });
  check('a nurse cannot create ward inventory even at Tier 2', nurseBed.error !== null,
    nurseBed.error ? `code=${nurseBed.error.code}` : 'insert unexpectedly succeeded');

  const forgeStatus = await B.admin.from('beds').update({ status: 'occupied' }).eq('id', bedB);
  check('beds.status is not client-writable', forgeStatus.error !== null,
    forgeStatus.error ? `code=${forgeStatus.error.code}` : 'update unexpectedly succeeded');
}

{
  const admit = await callRpc(B.nurse, 'admit_patient_to_bed', { p_visit_id: caseB.visitId, p_bed_id: bedB });
  checkEqual('admitting succeeds at Tier 2', admit.ok, true);
  checkEqual('...reporting the ward', admit.ward_name, 'General');

  const again = await callRpc(B.nurse, 'admit_patient_to_bed', { p_visit_id: caseB.visitId, p_bed_id: bedB });
  checkEqual('re-admitting to the same bed is an idempotent no-op', again.changed, false);

  const clash = await callRpc(B.nurse, 'admit_patient_to_bed', { p_visit_id: caseB2.visitId, p_bed_id: bedB });
  checkEqual('** a second patient cannot take an occupied bed **', clash.code, 'BED_NOT_AVAILABLE');
  checkEqual('...and the reason is machine-readable', clash.bed_status, 'occupied');
  check('...without naming the occupant', clash.patient_id === undefined && clash.patient_number === undefined);

  const { data: v } = await B.nurse
    .from('visits')
    .select('care_setting, admitted_at, bed_id, status')
    .eq('id', caseB.visitId)
    .maybeSingle();
  checkEqual('the visit became an IPD encounter', v?.care_setting, 'ipd');
  check('...with an admission timestamp', v?.admitted_at !== null);
  checkEqual('...pointing at the bed', v?.bed_id, bedB);
  checkEqual('...and admission did NOT touch visits.status (separate axis)', v?.status, 'queued');

  const { data: bed } = await B.nurse.from('beds').select('status, current_visit_id').eq('id', bedB).maybeSingle();
  checkEqual('the bed is occupied', bed?.status, 'occupied');
  checkEqual('...by that visit', bed?.current_visit_id, caseB.visitId);

  const badStatus = await callRpc(B.nurse, 'set_bed_status', { p_bed_id: bedB, p_status: 'occupied' });
  checkEqual('set_bed_status refuses "occupied" as a target', badStatus.code, 'INVALID_BED_STATUS');
  const busy = await callRpc(B.nurse, 'set_bed_status', { p_bed_id: bedB, p_status: 'cleaning' });
  checkEqual('...and refuses to touch an occupied bed', busy.code, 'BED_OCCUPIED');
}

/* ========================================================================== */
section('4. tasks — auto-generation and auto-completion on the hosted project');

{
  const { data: admissionTasks, error } = await B.nurse
    .from('tasks')
    .select('id, task_type, status, is_auto, source_type, title')
    .eq('visit_id', caseB.visitId)
    .eq('source_type', 'admission');
  check('the admission task query succeeds', !error, error?.message);
  checkEqual('admission created exactly ONE baseline vitals task', admissionTasks?.length, 1);
  checkEqual('...of the right type', admissionTasks?.[0]?.task_type, 'vitals_due');
  checkEqual('...flagged system-generated', admissionTasks?.[0]?.is_auto, true);
  checkEqual('...and still pending', admissionTasks?.[0]?.status, 'pending');

  // Recording observations should close it, with no second tap.
  const v = await B.nurse
    .from('vitals')
    .insert({ tenant_id: tenantBId, visit_id: caseB.visitId, recorded_by: nurseB.id, temperature_c: 39.2, pulse_bpm: 112 })
    .select('id')
    .maybeSingle();
  check('the nurse records observations', !v.error, v.error?.message);

  const { data: after } = await B.nurse
    .from('tasks')
    .select('status, completed_by, completed_at')
    .eq('id', admissionTasks?.[0]?.id as string)
    .maybeSingle();
  checkEqual('** recording vitals auto-completed the vitals_due task **', after?.status, 'done');
  checkEqual('...attributed to the recording nurse', after?.completed_by, nurseB.id);
  check('...with a completion timestamp', after?.completed_at !== null);
}

{
  const manual = await B.nurse
    .from('tasks')
    .insert({ tenant_id: tenantBId, visit_id: caseB.visitId, task_type: 'custom', title: `Dressing ${RUN}`, due_at: new Date().toISOString() })
    .select('id')
    .maybeSingle();
  const taskId = manual.data?.id as string;

  const noTitle = await B.nurse
    .from('tasks')
    .insert({ tenant_id: tenantBId, visit_id: caseB.visitId, task_type: 'custom', due_at: new Date().toISOString() });
  check('a custom task with no title is refused', isConstraint(noTitle.error),
    noTitle.error ? `code=${noTitle.error.code}` : 'insert unexpectedly succeeded');

  const forgeStatus = await B.nurse.from('tasks').update({ status: 'done' }).eq('id', taskId);
  check('tasks.status is not client-writable', forgeStatus.error !== null,
    forgeStatus.error ? `code=${forgeStatus.error.code}` : 'update unexpectedly succeeded');

  const claim = await B.nurse.from('tasks').update({ assigned_to: nurseB.id }).eq('id', taskId).select('assigned_to');
  check('a nurse can claim an unclaimed task', !claim.error && claim.data?.[0]?.assigned_to === nurseB.id, claim.error?.message);

  const done = await callRpc(B.nurse, 'complete_task', { p_task_id: taskId, p_notes: 'done' });
  checkEqual('complete_task marks it done', done.status, 'done');
  const twice = await callRpc(B.nurse, 'complete_task', { p_task_id: taskId });
  checkEqual('completing twice is refused distinguishably', twice.code, 'TASK_ALREADY_DONE');
}

/* ========================================================================== */
section('5. ** medication administration — the right-patient check **');

let itemB = '';
{
  await callRpc(B.doctor, 'set_visit_status', { p_visit_id: caseB.visitId, p_status: 'in_consultation' });
  const rx = await B.doctor
    .from('prescriptions')
    .insert({ tenant_id: tenantBId, visit_id: caseB.visitId, doctor_id: doctorB.id })
    .select('id')
    .maybeSingle();
  check('a prescription is created', !rx.error, rx.error?.message);

  const item = await B.doctor
    .from('prescription_items')
    .insert({
      prescription_id: rx.data?.id, tenant_id: tenantBId,
      drug_name: 'Dolo 650', dose: '650 mg', frequency: 'TDS', quantity: 9,
    })
    .select('id')
    .maybeSingle();
  itemB = item.data?.id as string;
  check('...with one item', !item.error, item.error?.message);

  const issued = await callRpc(B.doctor, 'issue_prescription', { p_prescription_id: rx.data?.id });
  checkEqual('...and is issued', issued.ok, true);
}

{
  const direct = await B.nurse.from('medication_administrations').insert({
    tenant_id: tenantBId, prescription_item_id: itemB, visit_id: caseB.visitId,
    administered_by: nurseB.id, status: 'given', scan_basis: 'patient_id',
  });
  check('no client INSERT — the scan check cannot be bypassed', direct.error !== null,
    direct.error ? `code=${direct.error.code}` : 'insert unexpectedly succeeded');

  const noScan = await callRpc(B.nurse, 'record_medication_administration', {
    p_prescription_item_id: itemB, p_scanned_patient_code: '',
  });
  checkEqual('** an empty scan is SCAN_REQUIRED, not a skipped check **', noScan.code, 'SCAN_REQUIRED');

  const junk = await callRpc(B.nurse, 'record_medication_administration', {
    p_prescription_item_id: itemB, p_scanned_patient_code: 'UHID-99999999',
  });
  checkEqual('** an unknown band is PATIENT_CODE_UNRECOGNISED **', junk.code, 'PATIENT_CODE_UNRECOGNISED');
  checkEqual('...and says the patient was not verified', junk.patient_verified, false);

  // Right drug, wrong bedside — the case the whole feature exists for.
  const wrong = await callRpc(B.nurse, 'record_medication_administration', {
    p_prescription_item_id: itemB, p_scanned_patient_code: caseB2.patientId,
  });
  checkEqual('** scanning a DIFFERENT patient returns PATIENT_MISMATCH **', wrong.code, 'PATIENT_MISMATCH');
  checkEqual('...not verified', wrong.patient_verified, false);
  checkEqual('...and demands acknowledgement', wrong.requires_acknowledgement, true);
  check('...while leaking neither patient\'s identity',
    wrong.patient_id === undefined && wrong.patient_number === undefined && wrong.full_name === undefined);

  const ok1 = await callRpc(B.nurse, 'record_medication_administration', {
    p_prescription_item_id: itemB, p_scanned_patient_code: `UHID-${caseB.patientNumber}`,
  });
  checkEqual('** the correct patient by UHID is accepted **', ok1.ok, true);
  checkEqual('...with positive verification, not silent success', ok1.patient_verified, true);
  checkEqual('...recording how the code resolved', ok1.scan_basis, 'patient_number');

  const dup = await callRpc(B.nurse, 'record_medication_administration', {
    p_prescription_item_id: itemB, p_scanned_patient_code: caseB.patientId,
  });
  checkEqual('** a repeat dose is ALREADY_ADMINISTERED, distinguishably **', dup.code, 'ALREADY_ADMINISTERED');
  checkEqual('...the patient check still passed', dup.patient_verified, true);
  checkEqual('...and it is overridable, because TDS really is three doses', dup.can_override, true);

  const ok2 = await callRpc(B.nurse, 'record_medication_administration', {
    p_prescription_item_id: itemB, p_scanned_patient_code: caseB.patientId,
    p_status: 'given', p_notes: 'second dose', p_allow_repeat: true,
  });
  checkEqual('overriding records the genuine second dose', ok2.ok, true);
  checkEqual('...resolving a uuid band too', ok2.scan_basis, 'patient_id');

  const { data, error } = await B.billing.from('medication_administrations').select('id');
  check('billing cannot read the administration log', isDenial(error) || (data?.length ?? 0) === 0,
    error ? `code=${error.code}` : `returned ${data?.length} rows`);
}

/* ========================================================================== */
section('6. ** critical lab values — the four-state check **');

// The decision function on its own, through a real session.
{
  const ev = (name: string, value: string, unit: string | null) =>
    callRpc(B.doctor, 'evaluate_lab_critical', { p_test_name: name, p_value: value, p_unit: unit });

  const high = await ev('Serum Potassium', '6.5', 'mmol/L');
  checkEqual('K+ 6.5 is evaluated', high.status, 'evaluated');
  checkEqual('...and critical high', high.is_critical, true);

  const boundary = await ev('potassium', '6.2', 'mmol/L');
  checkEqual('a value exactly on the limit is critical (inclusive)', boundary.is_critical, true);

  const alias = await ev('K+', '2.5', 'meq/l');
  checkEqual('an alias plus a per-analyte unit alias resolves', alias.status, 'evaluated');
  checkEqual('...critical low', alias.critical_direction ?? alias.direction, 'low');

  const normal = await ev('potassium', '4.2', 'mmol/L');
  checkEqual('** K+ 4.2 is evaluated and NOT critical — the real "checked, normal" **', normal.is_critical, false);
  checkEqual('...with status evaluated', normal.status, 'evaluated');

  const unknown = await ev('Serum Unobtainium', '42', 'mg/dL');
  checkEqual('** an unknown test is no_reference, NOT normal **', unknown.status, 'no_reference');
  checkEqual('...and does not claim to be critical', unknown.is_critical, false);

  const text = await ev('potassium', 'Haemolysed sample', 'mmol/L');
  checkEqual('a non-numeric result is unparseable_value', text.status, 'unparseable_value');

  const badUnit = await ev('potassium', '6.5', 'mg/dL');
  checkEqual('** an incompatible unit is unit_mismatch, not a silent comparison **', badUnit.status, 'unit_mismatch');

  const calcium = await ev('calcium', '14.0', 'meq/l');
  checkEqual('mEq/L is refused for a divalent ion', calcium.status, 'unit_mismatch');
}

section('6b. ordering, the fan-out, and the three result states');

let criticalResultId = '';
{
  const order = await B.doctor
    .from('lab_orders')
    .insert({
      tenant_id: tenantBId, visit_id: caseB.visitId, patient_id: caseB.patientId,
      ordered_by: doctorB.id, test_name: 'Serum Potassium', priority: 'urgent',
    })
    .select('id, status')
    .maybeSingle();
  check('a doctor can order a test with a plain insert', !order.error, order.error?.message);
  checkEqual('...starting pending', order.data?.status, 'pending');
  const orderId = order.data?.id as string;

  const nurseOrder = await B.nurse.from('lab_orders').insert({
    tenant_id: tenantBId, visit_id: caseB.visitId, patient_id: caseB.patientId,
    ordered_by: nurseB.id, test_name: 'CBC',
  });
  check('a nurse cannot order a test (clinical decision)', nurseOrder.error !== null,
    nurseOrder.error ? `code=${nurseOrder.error.code}` : 'insert unexpectedly succeeded');

  const { data: charge } = await B.billing
    .from('billing_line_items')
    .select('source_type, unit_amount, tax_category, tax_rate, is_auto, description')
    .eq('source_id', orderId);
  checkEqual('the order raised exactly one billing line', charge?.length, 1);
  checkEqual('...of source_type lab', charge?.[0]?.source_type, 'lab');
  checkEqual('...auto-captured', charge?.[0]?.is_auto, true);
  checkEqual('...at zero for billing to price', Number(charge?.[0]?.unit_amount), 0);
  // 'non_gst', NOT 'exempt' — and that is the correct answer for THIS tenant.
  // Lotus is the deliberately non-GST-registered seed clinic, and
  // resolve_tax_treatment() distinguishes the two cases: a registered clinic issues
  // an exempt line on a GST invoice, an unregistered one issues a bill of supply
  // with no tax concept at all. Collapsing them would produce a tax document
  // asserting a registration the clinic does not have. The local suite covers the
  // 'exempt' branch with a registered tenant; this covers the other one.
  checkEqual('...and non_gst, because this clinic is not GST-registered', charge?.[0]?.tax_category, 'non_gst');
  checkEqual('...with no tax rate', Number(charge?.[0]?.tax_rate ?? 0), 0);

  const { data: sampleTask } = await B.nurse
    .from('tasks')
    .select('task_type, status, title')
    .eq('source_id', orderId);
  checkEqual('...and one nurse task', sampleTask?.length, 1);
  checkEqual('...to collect the sample', sampleTask?.[0]?.task_type, 'sample_collection_due');
  check('...labelled with the test and priority',
    String(sampleTask?.[0]?.title).includes('Serum Potassium') && String(sampleTask?.[0]?.title).includes('URGENT'));

  const collected = await callRpc(B.nurse, 'set_lab_order_status', { p_lab_order_id: orderId, p_status: 'sample_collected' });
  checkEqual('marking the sample collected succeeds', collected.ok, true);
  checkEqual('...and closes the collection card', Number(collected.tasks_closed), 1);

  const bad = await callRpc(B.nurse, 'set_lab_order_status', { p_lab_order_id: orderId, p_status: 'pending' });
  checkEqual('an illegal transition is refused', bad.code, 'INVALID_STATUS_TRANSITION');

  const direct = await B.nurse.from('lab_results').insert({
    lab_order_id: orderId, tenant_id: tenantBId, result_value: '6.9', reported_by: nurseB.id,
  });
  check('no client INSERT on lab_results — flags are server-derived', direct.error !== null,
    direct.error ? `code=${direct.error.code}` : 'insert unexpectedly succeeded');

  const res = await callRpc(B.nurse, 'record_lab_result', {
    p_lab_order_id: orderId, p_result_value: '6.9', p_unit: 'mmol/L',
  });
  criticalResultId = res.lab_result_id as string;
  checkEqual('recording a critical result succeeds', res.ok, true);
  checkEqual('** flagged critical **', res.is_critical, true);
  checkEqual('...evaluated, so the flag is meaningful', res.critical_check_status, 'evaluated');
  checkEqual('...high', res.critical_direction, 'high');
  checkEqual('...no manual review needed — the check ran', res.requires_manual_review, false);
  checkEqual('** ...and the person entering it must acknowledge **', res.requires_acknowledgement, true);
  checkEqual('...with the threshold that fired', Number(res.critical_high), 6.2);
  checkEqual('the order is completed by recording a result', res.lab_order_status, 'completed');
}

// The Definition-of-Done assertion: unevaluable must not read as clean.
{
  const order = await B.doctor
    .from('lab_orders')
    .insert({
      tenant_id: tenantBId, visit_id: caseB.visitId, patient_id: caseB.patientId,
      ordered_by: doctorB.id, test_name: 'Serum Unobtainium',
    })
    .select('id')
    .maybeSingle();
  const res = await callRpc(B.nurse, 'record_lab_result', {
    p_lab_order_id: order.data?.id, p_result_value: '42', p_unit: 'mg/dL',
  });
  checkEqual('an unknown test still records a result', res.ok, true);
  checkEqual('** critical_check_status = no_reference **', res.critical_check_status, 'no_reference');
  checkEqual('** is_critical false BUT requires_manual_review TRUE **', res.requires_manual_review, true);
  checkEqual('** so requires_acknowledgement is true — never a silent pass **', res.requires_acknowledgement, true);
  checkEqual('...and it does not pretend to be critical', res.is_critical, false);
}

let normalResultId = '';
{
  const order = await B.doctor
    .from('lab_orders')
    .insert({
      tenant_id: tenantBId, visit_id: caseB.visitId, patient_id: caseB.patientId,
      ordered_by: doctorB.id, test_name: 'Haemoglobin',
    })
    .select('id')
    .maybeSingle();
  const res = await callRpc(B.nurse, 'record_lab_result', {
    p_lab_order_id: order.data?.id, p_result_value: '13.4', p_unit: 'g/dL',
  });
  normalResultId = res.lab_result_id as string;
  checkEqual('** a checked-and-normal result: is_critical false **', res.is_critical, false);
  checkEqual('** requires_manual_review false **', res.requires_manual_review, false);
  checkEqual('** requires_acknowledgement false — the ONLY reassuring combination **', res.requires_acknowledgement, false);
}

section('6c. the alert is an alert, not a passive row');

{
  const { data: alerts, error } = await B.doctor
    .from('critical_lab_alerts')
    .select('lab_result_id, test_name, patient_number, is_critical, requires_manual_review, acknowledged_at');
  check('the alert feed is readable by the doctor', !error, error?.message);
  check('...holding the critical AND the unevaluable result', (alerts?.length ?? 0) >= 2);
  checkEqual('...and not the normal one',
    (alerts ?? []).filter((a) => a.lab_result_id === normalResultId).length, 0);
  check('...identifying the patient by UHID with no name column',
    (alerts ?? []).every((a) => a.patient_number !== null) && !('patient_name' in (alerts?.[0] ?? {})));

  const payload = await callRpc(B.doctor, 'get_critical_lab_alert_payload', { p_lab_result_id: criticalResultId });
  checkEqual('the assembled payload resolves', payload.ok, true);
  const alert = payload.alert as Record<string, unknown>;
  checkEqual('...with a precomputed severity', alert?.severity, 'critical');
  check('...and a ready-made headline', String(alert?.headline).includes('critically HIGH'));
  check('...carrying no patient name', alert?.patient_name === undefined && alert?.full_name === undefined);

  const missing = await callRpc(B.doctor, 'get_critical_lab_alert_payload', { p_lab_result_id: normalResultId });
  checkEqual('a non-alertable result yields no payload', missing.code, 'ALERT_NOT_FOUND');

  const ack = await callRpc(B.nurse, 'acknowledge_critical_result', { p_lab_result_id: criticalResultId, p_note: 'Doctor informed' });
  checkEqual('a nurse can acknowledge', ack.ok, true);
  checkEqual('...attributed', ack.acknowledged_by, nurseB.id);
  const again = await callRpc(B.nurse, 'acknowledge_critical_result', { p_lab_result_id: criticalResultId });
  checkEqual('...idempotently', again.changed, false);
  const notAlert = await callRpc(B.nurse, 'acknowledge_critical_result', { p_lab_result_id: normalResultId });
  checkEqual('a normal result cannot be acknowledged', notAlert.code, 'NOT_ALERTABLE');

  const billingAck = await callRpc(B.billing, 'acknowledge_critical_result', { p_lab_result_id: criticalResultId });
  checkEqual('billing cannot clear a clinical alert', billingAck.code, 'NOT_CLINICAL_STAFF');
}

{
  const orders = await B.billing.from('lab_orders').select('id');
  check('** billing CAN read lab ORDERS (it bills for them) **', !orders.error && (orders.data?.length ?? 0) > 0,
    orders.error?.message);
  const results = await B.billing.from('lab_results').select('id');
  check('** ...but NOT lab RESULTS (a finding is not a service line) **',
    isDenial(results.error) || (results.data?.length ?? 0) === 0,
    results.error ? `code=${results.error.code}` : `returned ${results.data?.length} rows`);
  const alerts = await B.billing.from('critical_lab_alerts').select('lab_result_id');
  check('...and the alert view is empty for billing', (alerts.data?.length ?? 0) === 0);
}

/* ========================================================================== */
section('7. discharge — including the deliberate tier exception');

{
  const notAdmitted = await callRpc(B.nurse, 'discharge_patient', { p_visit_id: caseB2.visitId });
  checkEqual('discharging an OPD visit returns NOT_ADMITTED', notAdmitted.code, 'NOT_ADMITTED');

  const out = await callRpc(B.nurse, 'discharge_patient', { p_visit_id: caseB.visitId, p_notes: 'Stable' });
  checkEqual('discharge succeeds', out.ok, true);
  checkEqual('...releasing the bed', out.bed_released, bedB);

  const twice = await callRpc(B.nurse, 'discharge_patient', { p_visit_id: caseB.visitId });
  checkEqual('discharging twice is refused distinguishably', twice.code, 'ALREADY_DISCHARGED');

  const { data: v } = await B.nurse
    .from('visits')
    .select('discharged_at, bed_id, care_setting')
    .eq('id', caseB.visitId)
    .maybeSingle();
  check('discharged_at is stamped', v?.discharged_at !== null);
  checkEqual('visits.bed_id is RETAINED as part of the encounter record', v?.bed_id, bedB);
  checkEqual('...and it is still an IPD encounter', v?.care_setting, 'ipd');

  const { data: bed } = await B.nurse.from('beds').select('status, current_visit_id').eq('id', bedB).maybeSingle();
  checkEqual('the bed goes to cleaning, not straight to available', bed?.status, 'cleaning');
  checkEqual('...and is freed', bed?.current_visit_id, null);

  const turned = await callRpc(B.nurse, 'set_bed_status', { p_bed_id: bedB, p_status: 'available' });
  checkEqual('housekeeping can release a cleaned bed', turned.status, 'available');
}

/* ========================================================================== */
section('8. cross-tenant isolation through real sessions');

{
  // Tenant A staff must not see any of tenant B's Phase 3 rows, and vice versa.
  for (const table of ['vitals', 'tasks', 'beds', 'medication_administrations', 'lab_orders', 'lab_results'] as const) {
    const { data, error } = await A.doctor.from(table).select('tenant_id');
    check(`doctor A reading ${table} succeeds`, !error, error?.message);
    checkEqual(`...with zero tenant B rows in ${table}`,
      (data ?? []).filter((r) => r.tenant_id === tenantBId).length, 0);

    const byTenant = await A.doctor.from(table).select('tenant_id').eq('tenant_id', tenantBId);
    checkEqual(`...and filtering ${table} by tenant B gets 0 rows`, byTenant.data?.length ?? 0, 0);
  }

  const rounds = await A.doctor.from('rounds_overview').select('tenant_id');
  checkEqual('rounds_overview leaks no tenant B rows',
    (rounds.data ?? []).filter((r) => r.tenant_id === tenantBId).length, 0);
  const alerts = await A.doctor.from('critical_lab_alerts').select('tenant_id');
  checkEqual('critical_lab_alerts leaks no tenant B rows',
    (alerts.data ?? []).filter((r) => r.tenant_id === tenantBId).length, 0);

  // ...and every cross-tenant RPC returns a not-found rather than acting.
  const admit = await callRpc(A.nurse, 'admit_patient_to_bed', { p_visit_id: caseB.visitId, p_bed_id: bedB });
  check("admitting tenant B's patient is refused", admit.code === 'TIER_NOT_ENABLED' || admit.code === 'VISIT_NOT_FOUND',
    `got ${admit.code}`);

  const med = await callRpc(A.nurse, 'record_medication_administration', {
    p_prescription_item_id: itemB, p_scanned_patient_code: caseB.patientId,
  });
  checkEqual("administering tenant B's drug -> PRESCRIPTION_ITEM_NOT_FOUND", med.code, 'PRESCRIPTION_ITEM_NOT_FOUND');

  const labRes = await callRpc(A.nurse, 'record_lab_result', { p_lab_order_id: criticalResultId, p_result_value: '1' });
  checkEqual("recording onto tenant B's order -> LAB_ORDER_NOT_FOUND", labRes.code, 'LAB_ORDER_NOT_FOUND');

  const ack = await callRpc(A.nurse, 'acknowledge_critical_result', { p_lab_result_id: criticalResultId });
  checkEqual("acknowledging tenant B's result -> LAB_RESULT_NOT_FOUND", ack.code, 'LAB_RESULT_NOT_FOUND');

  const bedStatus = await callRpc(A.nurse, 'set_bed_status', { p_bed_id: bedB, p_status: 'maintenance' });
  check("changing tenant B's bed status is refused",
    bedStatus.code === 'TIER_NOT_ENABLED' || bedStatus.code === 'BED_NOT_FOUND', `got ${bedStatus.code}`);

  // Composite FK: policy satisfied (own tenant_id), but no such parent pair exists.
  const crossVitals = await A.nurse
    .from('vitals')
    .insert({ tenant_id: tenantAId, visit_id: caseB.visitId, recorded_by: nurseA.id, pulse_bpm: 80 });
  check("cannot attach vitals to tenant B's visit under A's tenant_id", crossVitals.error !== null,
    crossVitals.error ? `code=${crossVitals.error.code}` : 'insert unexpectedly succeeded');
  checkEqual('...and it is the composite FK that says no', crossVitals.error?.code, '23503');
}

/* ========================================================================== */
section('9. anon — no Phase 3 surface at all');

{
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  for (const table of ['vitals', 'tasks', 'beds', 'medication_administrations',
    'lab_orders', 'lab_results', 'lab_critical_ranges'] as const) {
    const { data, error } = await anon.from(table).select('id');
    check(`anon reading ${table} is denied or empty`, isDenial(error) || (data?.length ?? 0) === 0,
      error ? `code=${error.code}` : `returned ${data?.length} rows`);
  }
  for (const view of ['rounds_overview', 'critical_lab_alerts'] as const) {
    const { data, error } = await anon.from(view).select('tenant_id');
    check(`anon reading ${view} is denied or empty`, isDenial(error) || (data?.length ?? 0) === 0,
      error ? `code=${error.code}` : `returned ${data?.length} rows`);
  }
  for (const fn of ['admit_patient_to_bed', 'record_medication_administration',
    'record_lab_result', 'evaluate_lab_critical', 'acknowledge_critical_result'] as const) {
    const { error } = await anon.rpc(fn, {});
    check(`anon cannot call ${fn}`, !!error, error ? undefined : 'call unexpectedly succeeded');
  }
}

for (const c of [...Object.values(A), ...Object.values(B)]) await c.auth.signOut();

summary('Phase 3 nurse workflows, IPD, medication administration and lab values (remote / real Supabase project)');
