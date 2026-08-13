/**
 * PHASE 5 — CONCURRENT-WRITE LOAD TESTS, against the REAL hosted project.
 *
 *   npm run db:seed          # 2 tenants x 4 roles; Sunrise=Tier 1, Lotus=Tier 2
 *   npm run test:concurrency
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHY THIS IS A REMOTE-ONLY SUITE, AND CANNOT BE A PGlite ONE
 * ---------------------------------------------------------------------------
 * Every other local suite in this repo runs on PGlite, and this one deliberately does
 * not. PGlite is a single PostgreSQL instance compiled to WebAssembly, running
 * in-process behind ONE connection. The driver serialises statements onto that
 * connection, and the harness's `asUser()` wraps each block in
 * `begin; set local role …; …; commit`. Firing two of those "concurrently" with
 * Promise.all would interleave BEGIN/COMMIT on a single backend — that is not
 * concurrency, it is corruption, and any result it produced would be meaningless.
 *
 * **Row-level locks, `for update` clauses and unique-index races only exist when there
 * are genuinely multiple backends.** So this suite talks to the real hosted Postgres
 * over HTTP: each supabase-js client is an independent connection, and Promise.all
 * across them produces true parallel execution with real lock contention.
 *
 * This is the gap Phase 5 was for. Every prior suite across four phases called RPCs
 * sequentially, one await at a time — which is exactly where a race condition hides,
 * because sequential tests pass whether or not the locking is correct.
 *
 * Uses only the publishable/anon key. No service-role key anywhere in this file.
 * Re-runnable without a reset: fixtures carry a run-scoped suffix.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { anonKey, requireEnv, supabaseUrl } from '../../scripts/env.ts';
import { SEED_TENANTS, tenantAdmin } from '../../scripts/fixtures.ts';
import { check, checkEqual, section, summary } from '../harness/assert.ts';

const URL = supabaseUrl();
const ANON = anonKey();
const PASSWORD = requireEnv('SEED_USER_PASSWORD');
const RUN = String(Date.now()).slice(-6);

const [tenantAFixture, tenantBFixture] = SEED_TENANTS;

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

async function callRpc(c: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<Envelope> {
  const { data, error } = await c.rpc(fn, args);
  if (error) return { ok: false, code: `TRANSPORT_${error.code ?? 'ERROR'}`, message: error.message };
  return (data ?? {}) as Envelope;
}

/** Counts how many of a set of envelopes succeeded. */
const okCount = (rs: Envelope[]) => rs.filter((r) => r.ok === true).length;
const codesOf = (rs: Envelope[]) => rs.map((r) => (r.ok === true ? 'OK' : String(r.code ?? 'ERR'))).sort();

/* ========================================================================== */
section('Setup — independent sessions per participant (separate connections)');

// TWO SEPARATE CLIENTS PER ROLE, on purpose. Two requests on one client would still
// be two HTTP requests and therefore two backends, but using distinct clients makes
// the "these are genuinely different sessions" property explicit rather than incidental.
const A = {
  billing1: await signIn(tenantAFixture.users.find((u) => u.role === 'billing')!.email),
  billing2: await signIn(tenantAFixture.users.find((u) => u.role === 'billing')!.email),
  doctor: await signIn(tenantAFixture.users.find((u) => u.role === 'doctor')!.email),
  admin: await signIn(tenantAdmin(tenantAFixture).email),
  nurse1: await signIn(tenantAFixture.users.find((u) => u.role === 'nurse')!.email),
  nurse2: await signIn(tenantAFixture.users.find((u) => u.role === 'nurse')!.email),
};
const B = {
  billing: await signIn(tenantBFixture.users.find((u) => u.role === 'billing')!.email),
  doctor: await signIn(tenantBFixture.users.find((u) => u.role === 'doctor')!.email),
  admin: await signIn(tenantAdmin(tenantBFixture).email),
  nurse1: await signIn(tenantBFixture.users.find((u) => u.role === 'nurse')!.email),
  nurse2: await signIn(tenantBFixture.users.find((u) => u.role === 'nurse')!.email),
};
check('independent sessions established for both clinics', true);

async function whoami(c: SupabaseClient) {
  const { data } = await c.from('profiles').select('id, tenant_id').limit(1).maybeSingle();
  return { id: data!.id as string, tenantId: data!.tenant_id as string };
}
const meDoctorA = await whoami(A.doctor);
const meDoctorB = await whoami(B.doctor);
const meNurseB = await whoami(B.nurse1);
const tenantAId = meDoctorA.tenantId;
const tenantBId = meDoctorB.tenantId;

let seq = 0;
/** Registers a fresh patient in the given clinic. */
async function newPatient(billing: SupabaseClient, label: string): Promise<string> {
  seq += 1;
  const r = await callRpc(billing, 'register_patient', {
    p_full_name: `Conc ${label} ${RUN}-${seq}`,
    p_phone: `9${RUN}${String(seq).padStart(3, '0')}`.slice(0, 10),
    p_age_years: 40,
    p_allow_duplicate_phone: true,
  });
  if (r.ok !== true) throw new Error(`register_patient: ${JSON.stringify(r)}`);
  return r.patient_id as string;
}

/* ========================================================================== */
section('1. Double check-in race — two simultaneous check_in_patient(), same patient');

{
  const patientId = await newPatient(A.billing1, 'CheckIn');

  // The actual race: both requests in flight before either completes.
  const results = await Promise.all([
    callRpc(A.billing1, 'check_in_patient', { p_patient_id: patientId, p_visit_type: 'new' }),
    callRpc(A.billing2, 'check_in_patient', { p_patient_id: patientId, p_visit_type: 'new' }),
  ]);

  checkEqual('** exactly ONE check-in succeeded **', okCount(results), 1);
  const loser = results.find((r) => r.ok !== true)!;
  checkEqual('** ...and the other got VISIT_ALREADY_OPEN, not a duplicate or a deadlock **',
    loser.code, 'VISIT_ALREADY_OPEN');
  check('...returning the existing visit so the UI can navigate to it',
    typeof loser.visit_id === 'string', JSON.stringify(loser));

  // The invariant, checked in the database rather than inferred from the responses.
  const { data: visits } = await A.billing1
    .from('visits').select('id, queue_number').eq('patient_id', patientId);
  checkEqual('** exactly one visit row exists for that patient **', visits?.length, 1);
}

/* ========================================================================== */
section('2. Double invoice race — two simultaneous create_invoice_for_visit()');

{
  const patientId = await newPatient(A.billing1, 'Invoice');
  const v = await callRpc(A.billing1, 'check_in_patient', { p_patient_id: patientId, p_doctor_id: meDoctorA.id });
  const visitId = v.visit_id as string;
  await callRpc(A.doctor, 'set_visit_status', { p_visit_id: visitId, p_status: 'in_consultation' });
  await callRpc(A.doctor, 'set_visit_status', { p_visit_id: visitId, p_status: 'done' });

  const results = await Promise.all([
    callRpc(A.billing1, 'create_invoice_for_visit', { p_visit_id: visitId }),
    callRpc(A.billing2, 'create_invoice_for_visit', { p_visit_id: visitId }),
  ]);

  checkEqual('** exactly ONE invoice was created **', okCount(results), 1);
  const loser = results.find((r) => r.ok !== true)!;
  check('** ...and the other was refused distinguishably **',
    loser.code === 'INVOICE_ALREADY_EXISTS' || loser.code === 'NO_PENDING_CHARGES',
    `got ${loser.code}`);

  const { data: invoices } = await A.billing1
    .from('invoices').select('id, invoice_number, subtotal, tax_total, grand_total').eq('visit_id', visitId);
  checkEqual('** exactly one invoice row exists for that visit **', invoices?.length, 1);

  // Not just "one row" — one row whose totals are not a partially-applied mess.
  const inv = invoices![0];
  const { data: lines } = await A.billing1
    .from('billing_line_items').select('amount, tax_amount').eq('invoice_id', inv.id);
  const lineSub = (lines ?? []).reduce((s, l) => s + Number(l.amount), 0);
  const lineTax = (lines ?? []).reduce((s, l) => s + Number(l.tax_amount), 0);
  check('** ...and its stored totals match its lines (no torn write) **',
    Math.abs(Number(inv.subtotal) - lineSub) < 0.01 && Math.abs(Number(inv.tax_total) - lineTax) < 0.01,
    `stored ${inv.subtotal}/${inv.tax_total} vs lines ${lineSub}/${lineTax}`);
}

/* ========================================================================== */
section('3. Bed race — two patients, one available bed, simultaneous admits (Tier 2)');

{
  // Lotus is the Tier 2 seed clinic, so the IPD path is open there.
  const p1 = await newPatient(B.billing, 'Bed1');
  const p2 = await newPatient(B.billing, 'Bed2');
  const v1 = (await callRpc(B.billing, 'check_in_patient', { p_patient_id: p1, p_doctor_id: meDoctorB.id })).visit_id as string;
  const v2 = (await callRpc(B.billing, 'check_in_patient', { p_patient_id: p2, p_doctor_id: meDoctorB.id })).visit_id as string;

  const bed = await B.admin
    .from('beds')
    .insert({ tenant_id: tenantBId, ward_name: 'Race Ward', bed_number: `R-${RUN}` })
    .select('id').maybeSingle();
  check('a single available bed exists', !bed.error && !!bed.data?.id, bed.error?.message);
  const bedId = bed.data!.id as string;

  const results = await Promise.all([
    callRpc(B.nurse1, 'admit_patient_to_bed', { p_visit_id: v1, p_bed_id: bedId }),
    callRpc(B.nurse2, 'admit_patient_to_bed', { p_visit_id: v2, p_bed_id: bedId }),
  ]);

  checkEqual('** exactly ONE admission succeeded **', okCount(results), 1);
  const loser = results.find((r) => r.ok !== true)!;
  checkEqual('** ...and the other got BED_NOT_AVAILABLE **', loser.code, 'BED_NOT_AVAILABLE');

  // The occupancy invariant must hold under real contention, not just in sequential
  // test logic: beds_occupancy_consistent + the partial unique index on current_visit_id.
  const { data: bedRow } = await B.nurse1
    .from('beds').select('status, current_visit_id').eq('id', bedId).maybeSingle();
  checkEqual('** the bed is occupied **', bedRow?.status, 'occupied');
  check('** ...by exactly one of the two visits **',
    bedRow?.current_visit_id === v1 || bedRow?.current_visit_id === v2,
    `current_visit_id=${bedRow?.current_visit_id}`);

  const { data: admitted } = await B.nurse1
    .from('visits').select('id, bed_id').in('id', [v1, v2]);
  const withBed = (admitted ?? []).filter((r) => r.bed_id === bedId);
  checkEqual('** ...and only one visit records that bed **', withBed.length, 1);

  // Clean up so a re-run has a fresh bed.
  await callRpc(B.nurse1, 'discharge_patient', { p_visit_id: bedRow!.current_visit_id as string });
}

/* ========================================================================== */
section('4. Token allocation under load — a busy OPD morning, 8 simultaneous check-ins');

{
  // check_in_patient() allocates the per-tenant, per-day queue number under a lock.
  // Sequential tests cannot tell a correct lock from a missing one; this can.
  const N = 8;
  const patients: string[] = [];
  for (let i = 0; i < N; i++) patients.push(await newPatient(B.billing, `Token${i}`));

  const results = await Promise.all(
    patients.map((p, i) =>
      callRpc(i % 2 === 0 ? B.billing : B.admin, 'check_in_patient', { p_patient_id: p })),
  );

  checkEqual(`** all ${N} concurrent check-ins succeeded **`, okCount(results), N);

  const tokens = results.map((r) => Number(r.queue_number)).sort((a, b) => a - b);
  const unique = new Set(tokens);
  check('** ...with NO duplicate token numbers **', unique.size === N,
    `tokens: ${tokens.join(',')}`);
  check('...all positive integers', tokens.every((t) => Number.isInteger(t) && t > 0), tokens.join(','));
  // Gapless is not strictly required (a rolled-back allocation could legitimately skip),
  // but a contiguous run is evidence the lock serialised cleanly rather than colliding.
  const contiguous = tokens.every((t, i) => i === 0 || t === tokens[i - 1] + 1);
  check(`...and contiguous (${tokens[0]}..${tokens[N - 1]}) — the lock serialised cleanly`,
    contiguous, `tokens: ${tokens.join(',')}`);
}

/* ========================================================================== */
section('5. Concurrent vitals — two nurse sessions, same visit, same instant');

{
  const p = await newPatient(B.billing, 'Vitals');
  const visitId = (await callRpc(B.billing, 'check_in_patient', { p_patient_id: p, p_doctor_id: meDoctorB.id })).visit_id as string;

  // Distinct recorded_at values, written concurrently and deliberately OUT OF ORDER,
  // so "last write wins" would produce the wrong answer. The trigger recomputes
  // max(recorded_at) from the table rather than copying NEW, per Memory.md §3 — this
  // is the assertion that the recompute genuinely holds under a race.
  const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const newer = new Date().toISOString();

  const [r1, r2] = await Promise.all([
    B.nurse1.from('vitals').insert({
      tenant_id: tenantBId, visit_id: visitId, recorded_by: meNurseB.id,
      recorded_at: newer, temperature_c: 39.4, pulse_bpm: 118,
    }).select('id').maybeSingle(),
    B.nurse2.from('vitals').insert({
      tenant_id: tenantBId, visit_id: visitId, recorded_by: meNurseB.id,
      recorded_at: older, temperature_c: 37.1, bp_systolic: 120,
    }).select('id').maybeSingle(),
  ]);

  check('** both concurrent vitals inserts succeeded as separate rows **',
    !r1.error && !r2.error, `${r1.error?.message ?? ''} ${r2.error?.message ?? ''}`);

  const { data: rows } = await B.nurse1
    .from('vitals').select('id, recorded_at').eq('visit_id', visitId);
  checkEqual('** two vitals rows exist **', rows?.length, 2);

  const { data: visit } = await B.nurse1
    .from('visits').select('last_vitals_at').eq('id', visitId).maybeSingle();
  const truth = (rows ?? []).map((r) => new Date(String(r.recorded_at)).getTime()).sort((a, b) => b - a)[0];
  checkEqual('** visits.last_vitals_at equals max(recorded_at) regardless of write order **',
    new Date(String(visit?.last_vitals_at)).getTime(), truth);
  check('** ...i.e. the older concurrent write did NOT clobber the newer freshness **',
    new Date(String(visit?.last_vitals_at)).getTime() === new Date(newer).getTime(),
    `last_vitals_at=${visit?.last_vitals_at} expected=${newer}`);

  // And the rounds view still resolves each measurement independently under the race.
  const { data: ro } = await B.doctor
    .from('rounds_overview').select('temperature_c, pulse_bpm, bp_systolic, vitals_row_count')
    .eq('visit_id', visitId).maybeSingle();
  checkEqual('rounds_overview counted both rows', Number(ro?.vitals_row_count), 2);
  checkEqual('...took the newer temperature', Number(ro?.temperature_c), 39.4);
  checkEqual('...and still surfaces the systolic that only the older row carried',
    Number(ro?.bp_systolic), 120);
}

/* ========================================================================== */
section('5b. Vitals freshness under HEAVY contention — 8 writers, newest issued first');

{
  // ---------------------------------------------------------------------------
  // WHY THIS EXISTS ALONGSIDE §5, WHICH ALREADY TESTS TWO CONCURRENT WRITERS.
  //
  // §5 uses two writers, and with two writers a lost-update race on
  // visits.last_vitals_at only manifests when the OLDER writer happens to commit its
  // UPDATE last — roughly a coin flip. A suite that catches a real bug half the time
  // reports "passed" half the time, which is indistinguishable from correct.
  //
  // Eight writers with DESCENDING timestamps closes that gap. Index 0 carries the
  // newest stamp and is issued first, so the writer holding the true max is likely to
  // commit early; each of the other seven computed its max before that commit was
  // visible, so whichever of them lands last would write a staler value. The failure
  // probability goes from ~1/2 to ~7/8.
  //
  // The assertion is deliberately not "the value moved". It is "the value equals the
  // true max", because the bug this catches does not corrupt the timestamp — it makes
  // the freshness cache LAG, which on a rounds list means a patient shows as more
  // recently checked than they were, or less overdue than they are.
  // ---------------------------------------------------------------------------
  const p = await newPatient(B.billing, 'Fresh');
  const visitId = (await callRpc(B.billing, 'check_in_patient',
    { p_patient_id: p, p_doctor_id: meDoctorB.id })).visit_id as string;

  const N = 8;
  const stamps = Array.from({ length: N }, (_, i) =>
    new Date(Date.now() - i * 60 * 60 * 1000).toISOString());
  const newest = stamps[0] as string;

  // Alternating sessions, so these are genuinely separate backends rather than
  // pipelined requests on one connection.
  const results = await Promise.all(stamps.map((ts, i) =>
    (i % 2 === 0 ? B.nurse1 : B.nurse2).from('vitals').insert({
      tenant_id: tenantBId, visit_id: visitId, recorded_by: meNurseB.id,
      recorded_at: ts, pulse_bpm: 60 + i,
    }).select('id').maybeSingle()));

  const errored = results.filter((r) => r.error);
  checkEqual(`** all ${N} concurrent vitals inserts landed **`, errored.length, 0);
  if (errored.length > 0) {
    check('...insert errors', false, JSON.stringify(errored.map((e) => e.error?.message).slice(0, 3)));
  }

  const { data: rows } = await B.nurse1
    .from('vitals').select('recorded_at').eq('visit_id', visitId);
  checkEqual(`** ${N} vitals rows exist for the visit **`, rows?.length, N);

  // The truth, computed from the rows that actually committed.
  const observedMax = (rows ?? [])
    .map((r) => new Date(String(r.recorded_at)).getTime())
    .sort((a, b) => b - a)[0] as number;

  const { data: visit } = await B.nurse1
    .from('visits').select('last_vitals_at').eq('id', visitId).maybeSingle();
  const cached = new Date(String(visit?.last_vitals_at)).getTime();
  const lagHours = (observedMax - cached) / 3_600_000;

  checkEqual('** visits.last_vitals_at equals max(recorded_at) under 8-way contention **',
    cached, observedMax);
  check('** ...and is the newest stamp, not a staler max a losing writer precomputed **',
    cached === new Date(newest).getTime(),
    `cached=${visit?.last_vitals_at} expected=${newest} lag=${lagHours}h`);
  // Stated as its own assertion because a lagging freshness cache is precisely a
  // "this patient looks less overdue than they are" bug on the rounds list.
  check('** ...so the rounds list cannot under-report how overdue this patient is **',
    lagHours === 0, `freshness lags the true latest reading by ${lagHours}h`);
}

/* ========================================================================== */
section('5c. DEADLOCK PROBE — vitals writes racing discharge_patient on one visit');

{
  // ---------------------------------------------------------------------------
  // This exists because of what migration 20260811090100 changed, not because of a
  // reported bug. That migration made both vitals triggers take a FOR NO KEY UPDATE
  // lock on the visit row, and a lock-ordering change is precisely the kind of fix
  // that trades one defect for a worse one if the order is wrong.
  //
  // The hazard it closes: a vitals INSERT fires two AFTER triggers, and Postgres fires
  // them in name order, so vitals_autocomplete_task (which locks a `tasks` row with
  // FOR UPDATE SKIP LOCKED) runs before vitals_refresh_visit_freshness (which wants the
  // `visits` row). That gave a vitals insert the order tasks -> visits, while
  // discharge_patient() takes visits FOR UPDATE and then cancels the visit's pending
  // tasks — visits -> tasks. Opposite orders on the same two rows is a deadlock.
  //
  // The visit must be ADMITTED, because that is what creates the pending vitals_due
  // task via autoinsert_admission_vitals_task(). Without it there is no contended task
  // row and the probe would pass vacuously.
  //
  // The assertion is on the ERROR CLASS, not on who wins. Either side may legitimately
  // lose a row-lock wait or find the visit already discharged; what nobody may see is
  // 40P01.
  // ---------------------------------------------------------------------------
  const ROUNDS = 4;
  const WRITES = 4;
  const deadlocks: string[] = [];
  let admitted = 0;

  for (let r = 0; r < ROUNDS; r++) {
    const p = await newPatient(B.billing, `Dead${r}`);
    const visitId = (await callRpc(B.billing, 'check_in_patient',
      { p_patient_id: p, p_doctor_id: meDoctorB.id })).visit_id as string;

    const bed = await B.admin.from('beds')
      .insert({ tenant_id: tenantBId, ward_name: 'Deadlock Ward', bed_number: `D-${RUN}-${r}` })
      .select('id').maybeSingle();
    if (bed.error || !bed.data) {
      check(`round ${r}: bed created`, false, bed.error?.message);
      continue;
    }

    const adm = await callRpc(B.nurse1, 'admit_patient_to_bed',
      { p_visit_id: visitId, p_bed_id: bed.data.id as string });
    if (adm.ok !== true) {
      check(`round ${r}: admission succeeded (needed for the pending task)`, false, JSON.stringify(adm));
      continue;
    }
    admitted += 1;

    // Discharge and several vitals writes, all in flight together. Both sides now want
    // the same visits row and the same pending vitals_due task row.
    const outcomes = await Promise.all([
      callRpc(B.doctor, 'discharge_patient', { p_visit_id: visitId }),
      ...Array.from({ length: WRITES }, (_, i) =>
        (i % 2 === 0 ? B.nurse1 : B.nurse2).from('vitals').insert({
          tenant_id: tenantBId, visit_id: visitId, recorded_by: meNurseB.id,
          recorded_at: new Date(Date.now() - i * 60_000).toISOString(),
          pulse_bpm: 80 + i,
        }).select('id').maybeSingle()),
    ]);

    for (const o of outcomes) {
      const blob = JSON.stringify(o);
      if (/40P01|deadlock/i.test(blob)) deadlocks.push(`round ${r}: ${blob.slice(0, 200)}`);
    }
  }

  checkEqual(`** every round actually admitted, so the probe is not vacuous **`, admitted, ROUNDS);
  checkEqual(`** NO deadlock (40P01) across ${ROUNDS} rounds of vitals-vs-discharge contention **`,
    deadlocks, []);
}

/* ========================================================================== */
section('6. Deactivation racing an in-flight session');

{
  // A nurse fires a batch of writes at the same moment an admin revokes their access.
  // The requirement is not that a particular side wins — it is that NOTHING lands in a
  // partial or corrupted state, and that access is genuinely gone afterwards.
  const p = await newPatient(A.billing1, 'Deact');
  const visitId = (await callRpc(A.billing1, 'check_in_patient', { p_patient_id: p, p_doctor_id: meDoctorA.id })).visit_id as string;
  const meNurseA = await whoami(A.nurse1);

  const inFlight = Array.from({ length: 6 }, (_, i) =>
    A.nurse1.from('vitals').insert({
      tenant_id: tenantAId, visit_id: visitId, recorded_by: meNurseA.id,
      pulse_bpm: 70 + i,
    }).select('id').maybeSingle());

  const [deact, ...writes] = await Promise.all([
    callRpc(A.admin, 'admin_set_user_active', { p_user_id: meNurseA.id, p_is_active: false }),
    ...inFlight,
  ]);

  checkEqual('the deactivation itself succeeded', (deact as Envelope).ok, true);

  // Every write must be unambiguous: either it committed, or it was refused. No
  // half-states, and no unexpected error class.
  const succeeded = writes.filter((w) => !(w as { error: unknown }).error).length;
  const refused = writes.filter((w) => {
    const e = (w as { error: { code?: string } | null }).error;
    return e !== null && (e.code === '42501' || /permission denied|row-level security/i.test(String(e.code)));
  }).length;
  check('** every in-flight write either committed or was cleanly refused **',
    succeeded + refused === writes.length,
    `${succeeded} ok + ${refused} refused of ${writes.length}`);

  // The rows that did commit must be real, complete rows — not partial writes.
  const { data: landed } = await A.admin
    .from('vitals').select('id, tenant_id, visit_id, recorded_by, pulse_bpm').eq('visit_id', visitId);
  check('** ...and every row that landed is structurally complete **',
    (landed ?? []).every((r) =>
      r.tenant_id === tenantAId && r.visit_id === visitId &&
      r.recorded_by === meNurseA.id && r.pulse_bpm !== null),
    JSON.stringify(landed?.slice(0, 2)));
  checkEqual('...matching the number that reported success', landed?.length, succeeded);

  // Access is definitively gone now, whatever happened during the race.
  const { data: after } = await A.nurse1.from('patients').select('id');
  checkEqual('** the deactivated nurse now reads zero patients **', after?.length ?? 0, 0);

  // Restore, so the seed dataset is left as documented.
  const back = await callRpc(A.admin, 'admin_set_user_active', { p_user_id: meNurseA.id, p_is_active: true });
  checkEqual('nurse reactivated for a clean fixture state', back.ok, true);
}

/* ========================================================================== */
section('7. Cross-tenant isolation holds under concurrency');

{
  // Locks and races are a plausible place for isolation to slip, so the property is
  // re-asserted while both clinics write simultaneously rather than only at rest.
  const pa = await newPatient(A.billing1, 'IsoA');
  const pb = await newPatient(B.billing, 'IsoB');

  const [ra, rb] = await Promise.all([
    callRpc(A.billing1, 'check_in_patient', { p_patient_id: pa }),
    callRpc(B.billing, 'check_in_patient', { p_patient_id: pb }),
  ]);
  checkEqual('both clinics checked in simultaneously', okCount([ra, rb]), 2);

  const [seenByA, seenByB] = await Promise.all([
    A.doctor.from('visits').select('tenant_id'),
    B.doctor.from('visits').select('tenant_id'),
  ]);
  checkEqual('** clinic A sees no clinic B visits, mid-concurrency **',
    (seenByA.data ?? []).filter((r) => r.tenant_id === tenantBId).length, 0);
  checkEqual('** clinic B sees no clinic A visits, mid-concurrency **',
    (seenByB.data ?? []).filter((r) => r.tenant_id === tenantAId).length, 0);
}

for (const c of [...Object.values(A), ...Object.values(B)]) await c.auth.signOut();

summary('Phase 5 concurrent-write load tests (remote / real Supabase project)');
