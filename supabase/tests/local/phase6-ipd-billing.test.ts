/**
 * PHASE 6 — IPD ROOM-RENT BILLING, WARDS, BED STAYS, AND cancel_prescription()
 *
 * Run: npm run test:phase6
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A NEW FILE RATHER THAN AN EXTENSION OF phase3-flow.test.ts
 * ---------------------------------------------------------------------------
 * The instruction was to extend the existing IPD suite unless the scope warrants a
 * file of its own. It does: this phase adds two tables (`wards`, `bed_stays`), a
 * third tax category with its own statutory rule, a new `source_type`, a view and an
 * RPC. `phase3-flow.test.ts` is already 252 assertions about nurse workflows, and
 * dropping ~90 billing assertions into it would bury both.
 *
 * Cross-tenant isolation for the two new tables is NOT re-asserted here, and that is
 * deliberate rather than a gap: `phase5-pentest.test.ts` enumerates every relation in
 * `public` from the catalogue at runtime, so `wards`, `bed_stays` and
 * `ipd_accrual_current` are attacked automatically by all 9 hostile role states the
 * moment they exist. Hand-writing those cases here would duplicate generated
 * coverage. What IS asserted below is the part a generic loop cannot construct: that
 * a cross-tenant ward rate cannot be reached through the billing path (§8).
 *
 * The assertions tied to this phase's Definition of Done are marked **:
 *   ** room rent is charged, at the snapshotted rate, once per bed stay
 *   ** ICU is exempt at any rate; other rooms exempt <= 5000/day, taxable 5% above
 *   ** a mid-stay transfer bills each segment at the ward that applied then
 *   ** discharge captures the final accrued period
 *   ** bed_stays has no client write path
 *   ** cancel_prescription withdraws pending charges and reports invoiced ones
 */

import {
  createHarness, check, checkEqual, checkRejects, section, summary,
  type Harness, type Row,
} from '../harness/pglite.ts';
import { rpc, seedTenant, registerPatient, type TenantFixture } from '../harness/fixtures.ts';

const h: Harness = await createHarness();

/* ========================================================================== */
section('Fixtures — a GST-registered Tier 2 clinic, a non-GST Tier 2 clinic, a Tier 1 clinic');

const GST: TenantFixture = await seedTenant(h, {
  name: 'Ward Hospital (GST)', slug: 'p6a', consultationFee: 500, tier: 2,
  gst: { gstin: '27AABCU9603R1ZM', stateCode: '27' },
});
const NOGST: TenantFixture = await seedTenant(h, {
  name: 'Small Nursing Home', slug: 'p6b', consultationFee: 300, tier: 2,
});
const T1: TenantFixture = await seedTenant(h, {
  name: 'OPD Only Clinic', slug: 'p6c', consultationFee: 200, tier: 1,
});

/** Creates a bed, which auto-creates its ward, then prices the ward. */
async function makeWardBed(
  t: TenantFixture, ward: string, bedNumber: string,
  rate: number | null, critical: boolean,
): Promise<string> {
  const bed = await h.asUser(t.admin, (sql) => sql(
    `insert into public.beds (tenant_id, ward_name, bed_number) values ($1,$2,$3) returning id`,
    [t.tenantId, ward, bedNumber]));
  if (rate !== null) {
    await h.asUser(t.admin, (sql) => sql(
      `update public.wards set daily_rate = $3, is_critical_care = $4
        where tenant_id = $1 and name = $2`, [t.tenantId, ward, rate, critical]));
  }
  return bed[0].id as string;
}

const icuBed     = await makeWardBed(GST, 'ICU',          'ICU-1', 25000, true);
const deluxeBed  = await makeWardBed(GST, 'Deluxe',       'D-1',    8000, false);
const generalBed = await makeWardBed(GST, 'General Ward', 'G-1',    1800, false);
const unpricedBed = await makeWardBed(GST, 'New Wing',    'N-1',    null, false);
const nogstBed   = await makeWardBed(NOGST, 'General',    'G-1',    9000, false);

check('beds created across four wards', !!icuBed && !!deluxeBed && !!generalBed && !!unpricedBed);

/* ========================================================================== */
section('1. ** the wards table 20260811070400 deferred — auto-created, then priced **');

{
  const w = await h.asOwner(
    `select name, daily_rate, is_critical_care from public.wards
      where tenant_id = $1 order by name`, [GST.tenantId]);
  checkEqual('** four wards exist, created automatically by adding beds **', w.length, 4);
  checkEqual('...named from beds.ward_name', w.map((r) => r.name),
    ['Deluxe', 'General Ward', 'ICU', 'New Wing']);

  const icu = w.find((r) => r.name === 'ICU')!;
  checkEqual('the ICU is priced', Number(icu.daily_rate), 25000);
  checkEqual('...and flagged critical care', icu.is_critical_care, true);

  const unpriced = w.find((r) => r.name === 'New Wing')!;
  checkEqual('** an un-priced ward defaults to 0, not NULL **', Number(unpriced.daily_rate), 0);

  // The FK is what makes ward_name a reference rather than free text. The trigger is
  // what stops that FK turning "add a bed" into a constraint error.
  const fk = await h.asOwner(
    `select conname from pg_constraint where conname = 'beds_ward_exists'`);
  checkEqual('** beds.ward_name is now a foreign key into wards **', fk.length, 1);

  await h.asUser(GST.admin, async (sql) => {
    const b = await sql(
      `insert into public.beds (tenant_id, ward_name, bed_number)
       values ($1,'Spontaneous Ward','S-1') returning id`, [GST.tenantId]);
    check('** adding a bed in a brand-new ward still works (the FK never blocks it) **',
      b.length === 1);
    const nw = await sql(`select daily_rate from public.wards where tenant_id=$1 and name='Spontaneous Ward'`,
      [GST.tenantId]);
    checkEqual('...and the ward row appeared', nw.length, 1);
    checkEqual('...at rate 0', Number(nw[0].daily_rate), 0);
  });

  // Renaming a ward is one UPDATE that follows through to its beds — the thing a
  // rate column on `beds` could not have given us.
  await h.asUser(GST.admin, async (sql) => {
    await sql(`update public.wards set name='Deluxe Suite' where tenant_id=$1 and name='Deluxe'`,
      [GST.tenantId]);
    const beds = await sql(`select ward_name from public.beds where id=$1`, [deluxeBed]);
    checkEqual('** renaming a ward cascades to its beds **', beds[0].ward_name, 'Deluxe Suite');
    await sql(`update public.wards set name='Deluxe' where tenant_id=$1 and name='Deluxe Suite'`,
      [GST.tenantId]);
  });
}

/* ========================================================================== */
section('2. ** the GST rule on a hospital room — all three branches **');

// Asserted directly against resolve_tax_treatment() rather than only through a bill,
// because this is a statutory rule and it deserves a unit test, not just an
// integration one.
{
  async function room(t: TenantFixture, rate: number, critical: boolean) {
    const r = await h.asOwner(
      `select tax_category, tax_rate from public.resolve_tax_treatment(
         p_tenant_id => $1, p_supply_kind => 'room_rent',
         p_drug_gst_rate => null, p_room_daily_rate => $2, p_room_critical => $3)`,
      [t.tenantId, rate, critical]);
    return { cat: r[0].tax_category as string, rate: Number(r[0].tax_rate) };
  }

  const icu = await room(GST, 25000, true);
  checkEqual('** ICU at 25000/day is EXEMPT — critical care overrides the threshold **', icu.cat, 'exempt');
  checkEqual('...at 0%', icu.rate, 0);

  const cheap = await room(GST, 1800, false);
  checkEqual('** a 1800/day room is exempt (at or below 5000) **', cheap.cat, 'exempt');

  const atThreshold = await room(GST, 5000, false);
  checkEqual('** exactly 5000/day is still EXEMPT — the rule is "above 5000" **',
    atThreshold.cat, 'exempt');

  const justOver = await room(GST, 5001, false);
  checkEqual('** 5001/day is TAXABLE **', justOver.cat, 'taxable');
  checkEqual('** ...at a flat 5% **', justOver.rate, 5);

  const deluxe = await room(GST, 8000, false);
  checkEqual('an 8000/day room is taxable', deluxe.cat, 'taxable');
  checkEqual('...also 5%, not a rate that scales', deluxe.rate, 5);

  // Axis 1 still dominates: a clinic that is not GST-registered issues a bill of
  // supply, so even an 9000/day room is non_gst rather than taxable.
  const nogst = await room(NOGST, 9000, false);
  checkEqual('** a non-GST clinic bills room rent as non_gst even above 5000 **', nogst.cat, 'non_gst');
  checkEqual('...at 0%', nogst.rate, 0);

  // The Phase 2 3-arg wrapper must still behave exactly as before, or three applied
  // triggers silently change behaviour.
  const svc = await h.asOwner(
    `select tax_category, tax_rate from public.resolve_tax_treatment($1, false, null)`, [GST.tenantId]);
  checkEqual('** the Phase 2 3-arg form still returns exempt for a service **', svc[0].tax_category, 'exempt');
  const med = await h.asOwner(
    `select tax_category, tax_rate from public.resolve_tax_treatment($1, true, 12)`, [GST.tenantId]);
  checkEqual('...and taxable for medicine', med[0].tax_category, 'taxable');
  checkEqual('...at the drug rate it was given', Number(med[0].tax_rate), 12);
}

/* ========================================================================== */
section('3. ** the day count — calendar days in the clinic timezone, minimum 1 **');

{
  async function days(start: string, end: string, tz = 'Asia/Kolkata') {
    const r = await h.asOwner(
      `select public.bed_stay_days($1::timestamptz, $2::timestamptz, $3) as d`, [start, end, tz]);
    return Number(r[0].d);
  }

  checkEqual('** a same-day admit and discharge is charged 1 day, never 0 **',
    await days('2026-08-14T09:00:00+05:30', '2026-08-14T18:00:00+05:30'), 1);
  checkEqual('** 22:00 to 06:00 next morning is 1 night **',
    await days('2026-08-14T22:00:00+05:30', '2026-08-15T06:00:00+05:30'), 1);
  checkEqual('three calendar days is 3',
    await days('2026-08-14T10:00:00+05:30', '2026-08-17T10:00:00+05:30'), 3);

  // ---- the reason tenants.billing_timezone exists ----
  //
  // A stay that starts and ends in the small hours IST. Each IST calendar date
  // boundary sits at 18:30 the previous day in UTC, so a UTC count picks up one
  // extra boundary crossing:
  //   14 Aug 02:00 IST = 13 Aug 20:30 UTC   ->  UTC date 08-13, IST date 08-14
  //   16 Aug 09:00 IST = 16 Aug 03:30 UTC   ->  UTC date 08-16, IST date 08-16
  // IST: 16 - 14 = 2 nights.  UTC: 16 - 13 = 3.  A whole extra day billed.
  //
  // Note the earlier attempt at this assertion used a single-night example, where
  // the `greatest(1, ...)` floor happened to mask the difference — 0 and 1 both
  // clamp to 1. The gap only shows once the stay is longer than the floor, which is
  // exactly the case that would have over-billed in production.
  const ist = await days('2026-08-14T02:00:00+05:30', '2026-08-16T09:00:00+05:30', 'Asia/Kolkata');
  const utc = await days('2026-08-14T02:00:00+05:30', '2026-08-16T09:00:00+05:30', 'UTC');
  checkEqual('** a 2-night IST stay counts 2 days in the clinic timezone **', ist, 2);
  checkEqual('** ...and would have counted 3 under UTC — the bug the column prevents **', utc, 3);
}

/* ========================================================================== */
section('4. ** admission opens a bed stay and snapshots the ward terms **');

/**
 * Returns a bed to 'available' if housekeeping needs to.
 *
 * Not incidental plumbing — it is Phase 3 behaviour these tests have to respect.
 * discharge_patient() leaves a bed in 'cleaning', not 'available', because a bed
 * someone just left needs turning over before the next patient. So any test that
 * reuses a bed has to release it the way a real ward would, through
 * set_bed_status(). Skipped when the bed is occupied, which set_bed_status()
 * correctly refuses anyway.
 */
async function releaseBed(t: TenantFixture, bedId: string) {
  const cur = await h.asOwner(`select status from public.beds where id = $1`, [bedId]);
  if (cur.length === 0 || cur[0].status === 'available' || cur[0].status === 'occupied') return;
  await h.asUser(t.nurse, (sql) => rpc(sql, 'set_bed_status', '$1, $2', [bedId, 'available']));
}

/** Registers a patient, admits them to a bed, returns ids. */
let seq = 0;
async function admit(t: TenantFixture, bedId: string, label: string) {
  seq += 1;
  await releaseBed(t, bedId);
  const pat = await registerPatient(h, t, { name: label, phone: `96000000${String(seq).padStart(2, '0')}`, age: 60 });
  const v = await h.asUser(t.billing, (sql) =>
    rpc(sql, 'check_in_patient', '$1, $2, $3', [pat.patientId, 'new', t.doctor.id]));
  const visitId = v.visit_id as string;
  const a = await h.asUser(t.nurse, (sql) =>
    rpc(sql, 'admit_patient_to_bed', '$1, $2', [visitId, bedId]));
  return { patientId: pat.patientId, visitId, admit: a };
}

{
  const enc = await admit(GST, generalBed, 'General Stay');
  checkEqual('admission succeeded', enc.admit.ok, true);
  checkEqual('** ...and reports the daily rate it will bill at **', Number(enc.admit.daily_rate), 1800);
  checkEqual('...and whether it is critical care', enc.admit.is_critical_care, false);

  const st = await h.asOwner(
    `select ward_name, daily_rate, is_critical_care, ended_at, end_reason
       from public.bed_stays where visit_id = $1`, [enc.visitId]);
  checkEqual('** exactly one bed stay was opened **', st.length, 1);
  checkEqual('...naming the ward', st[0].ward_name, 'General Ward');
  checkEqual('** ...with the ward rate SNAPSHOTTED onto it **', Number(st[0].daily_rate), 1800);
  checkEqual('...and still open', st[0].ended_at, null);
  checkEqual('...with no end reason yet', st[0].end_reason, null);

  // Nothing is charged while the patient is still in the bed.
  const lines = await h.asOwner(
    `select id from public.billing_line_items where visit_id=$1 and source_type='room_rent'`,
    [enc.visitId]);
  checkEqual('** no room-rent line exists yet — the charge lands when the stay closes **', lines.length, 0);

  // ...but the accrual is visible, which is the trade-off the view exists to cover.
  await h.asUser(GST.billing, async (sql) => {
    const acc = await sql(
      `select days_so_far, accrued_amount, tax_category, ward_unpriced
         from public.ipd_accrual_current where visit_id = $1`, [enc.visitId]);
    checkEqual('** the accrual view shows the ongoing stay **', acc.length, 1);
    checkEqual('...at 1 day so far', Number(acc[0].days_so_far), 1);
    checkEqual('...accruing the ward rate', Number(acc[0].accrued_amount), 1800);
    checkEqual('...exempt, being under 5000', acc[0].tax_category, 'exempt');
    checkEqual('...and the ward is priced', acc[0].ward_unpriced, false);
  });

  // ---- discharge closes it and bills it ----
  await h.asOwner(
    `update public.bed_stays set started_at = now() - interval '3 days' where visit_id = $1`,
    [enc.visitId]);

  const d = await h.asUser(GST.nurse, (sql) => rpc(sql, 'discharge_patient', '$1', [enc.visitId]));
  checkEqual('discharge succeeded', d.ok, true);
  checkEqual('** ...and closed exactly one bed stay **', Number(d.bed_stays_closed), 1);

  const bill = await h.asOwner(
    `select source_type, source_id, description, quantity, unit_amount, amount,
            tax_category, tax_rate, tax_amount, is_auto
       from public.billing_line_items where visit_id=$1 and source_type='room_rent'`,
    [enc.visitId]);
  checkEqual('** exactly one room-rent line was captured **', bill.length, 1);
  checkEqual('** ...for 3 days **', Number(bill[0].quantity), 3);
  checkEqual('** ...at the snapshotted 1800/day **', Number(bill[0].unit_amount), 1800);
  checkEqual('** ...totalling 5400 **', Number(bill[0].amount), 5400);
  checkEqual('** ...exempt, because 1800/day is under the threshold **', bill[0].tax_category, 'exempt');
  checkEqual('...with no tax', Number(bill[0].tax_amount), 0);
  checkEqual('...marked auto-captured', bill[0].is_auto, true);
  check('...describing the ward and the day count', String(bill[0].description).includes('General Ward')
    && String(bill[0].description).includes('3 days'), String(bill[0].description));

  // The description is read at a billing counter and printed on an invoice.
  check('** ...and carrying no clinical content **',
    !/diagnos|complaint|fever|sepsis/i.test(String(bill[0].description)), String(bill[0].description));

  const stayId = await h.asOwner(`select id from public.bed_stays where visit_id=$1`, [enc.visitId]);
  checkEqual('** the line points at the bed stay, which is what makes it bill once **',
    bill[0].source_id, stayId[0].id);
}

/* ========================================================================== */
section('5. ** a taxable room, and the ICU exemption, end to end **');

{
  // 8000/day: above the threshold, so 5% applies.
  const dx = await admit(GST, deluxeBed, 'Deluxe Stay');
  await h.asOwner(`update public.bed_stays set started_at = now() - interval '2 days' where visit_id=$1`,
    [dx.visitId]);
  await h.asUser(GST.nurse, (sql) => rpc(sql, 'discharge_patient', '$1', [dx.visitId]));

  const dxBill = await h.asOwner(
    `select quantity, unit_amount, amount, tax_category, tax_rate, tax_amount
       from public.billing_line_items where visit_id=$1 and source_type='room_rent'`, [dx.visitId]);
  checkEqual('** an 8000/day room is TAXABLE **', dxBill[0].tax_category, 'taxable');
  checkEqual('** ...at 5% **', Number(dxBill[0].tax_rate), 5);
  checkEqual('...for 2 days = 16000', Number(dxBill[0].amount), 16000);
  checkEqual('** ...so 800 of GST **', Number(dxBill[0].tax_amount), 800);

  // 25000/day ICU: far above the threshold, and exempt anyway.
  const icu = await admit(GST, icuBed, 'ICU Stay');
  await h.asOwner(`update public.bed_stays set started_at = now() - interval '4 days' where visit_id=$1`,
    [icu.visitId]);
  await h.asUser(GST.nurse, (sql) => rpc(sql, 'discharge_patient', '$1', [icu.visitId]));

  const icuBill = await h.asOwner(
    `select quantity, amount, tax_category, tax_amount
       from public.billing_line_items where visit_id=$1 and source_type='room_rent'`, [icu.visitId]);
  checkEqual('...4 days of ICU', Number(icuBill[0].quantity), 4);
  checkEqual('...at 100000', Number(icuBill[0].amount), 100000);
  checkEqual('** an ICU bed is EXEMPT at 25000/day — five times the threshold **',
    icuBill[0].tax_category, 'exempt');
  checkEqual('** ...so not one rupee of GST on a 100000 ICU bill **', Number(icuBill[0].tax_amount), 0);

  // A non-GST clinic above the threshold: non_gst, not taxable.
  const ng = await admit(NOGST, nogstBed, 'NoGST Stay');
  await h.asOwner(`update public.bed_stays set started_at = now() - interval '1 days' where visit_id=$1`,
    [ng.visitId]);
  await h.asUser(NOGST.nurse, (sql) => rpc(sql, 'discharge_patient', '$1', [ng.visitId]));
  const ngBill = await h.asOwner(
    `select tax_category, tax_amount from public.billing_line_items
      where visit_id=$1 and source_type='room_rent'`, [ng.visitId]);
  checkEqual('** a non-registered clinic bills a 9000/day room as non_gst **',
    ngBill[0].tax_category, 'non_gst');
  checkEqual('...with no tax', Number(ngBill[0].tax_amount), 0);
}

/* ========================================================================== */
section('6. ** a mid-stay transfer bills each ward at the rate that applied then **');

{
  const enc = await admit(GST, generalBed, 'Transfer Stay');

  // Three days in the General Ward...
  await h.asOwner(`update public.bed_stays set started_at = now() - interval '3 days' where visit_id=$1`,
    [enc.visitId]);

  // ...then deteriorates and moves to the ICU. The ICU bed was used earlier in this
  // suite and left in 'cleaning' by that discharge, so housekeeping releases it
  // first — exactly as a real ward would.
  await releaseBed(GST, icuBed);
  const t = await h.asUser(GST.nurse, (sql) =>
    rpc(sql, 'admit_patient_to_bed', '$1, $2', [enc.visitId, icuBed]));
  checkEqual('the transfer succeeded', t.ok, true);
  check('...reporting where they came from', (t.transferred_from as Row)?.ward_name === 'General Ward',
    JSON.stringify(t.transferred_from));
  checkEqual('** ...and the new stay reports the ICU rate **', Number(t.daily_rate), 25000);

  const stays = await h.asOwner(
    `select ward_name, daily_rate, is_critical_care, ended_at, end_reason
       from public.bed_stays where visit_id=$1 order by started_at`, [enc.visitId]);
  checkEqual('** two bed stays now exist for one admission **', stays.length, 2);
  checkEqual('...the first closed', stays[0].end_reason, 'transfer');
  check('...the second still open', stays[1].ended_at === null);
  checkEqual('...and the second carries the ICU snapshot', Number(stays[1].daily_rate), 25000);

  // The outgoing ward bills immediately, at ITS rate.
  const first = await h.asOwner(
    `select quantity, unit_amount, tax_category from public.billing_line_items
      where visit_id=$1 and source_type='room_rent'`, [enc.visitId]);
  checkEqual('** the outgoing ward is billed at once, on transfer **', first.length, 1);
  checkEqual('** ...3 days at 1800, the General Ward rate — NOT the ICU rate **',
    Number(first[0].unit_amount), 1800);
  checkEqual('...for 3 days', Number(first[0].quantity), 3);
  checkEqual('...exempt at that rate', first[0].tax_category, 'exempt');

  // Two ICU days, then discharge.
  await h.asOwner(
    `update public.bed_stays set started_at = now() - interval '2 days'
      where visit_id=$1 and ended_at is null`, [enc.visitId]);
  await h.asUser(GST.nurse, (sql) => rpc(sql, 'discharge_patient', '$1', [enc.visitId]));

  const both = await h.asOwner(
    `select quantity, unit_amount, amount, tax_category from public.billing_line_items
      where visit_id=$1 and source_type='room_rent' order by unit_amount`, [enc.visitId]);
  checkEqual('** two room-rent lines: one per ward stint **', both.length, 2);
  checkEqual('...General Ward, 3 days at 1800', Number(both[0].amount), 5400);
  checkEqual('...ICU, 2 days at 25000', Number(both[1].amount), 50000);
  checkEqual('** each at the rate that actually applied that night **',
    [Number(both[0].unit_amount), Number(both[1].unit_amount)], [1800, 25000]);
  checkEqual('...and each with its own tax treatment',
    [both[0].tax_category, both[1].tax_category], ['exempt', 'exempt']);
}

/* ========================================================================== */
section('7. ** a ward re-pricing does NOT change what an earlier stay charged **');

{
  const enc = await admit(GST, generalBed, 'Snapshot Stay');
  await h.asOwner(`update public.bed_stays set started_at = now() - interval '2 days' where visit_id=$1`,
    [enc.visitId]);

  // The clinic raises the General Ward rate mid-stay, and above the GST threshold.
  await h.asUser(GST.admin, (sql) => sql(
    `update public.wards set daily_rate = 6000 where tenant_id=$1 and name='General Ward'`,
    [GST.tenantId]));

  await h.asUser(GST.nurse, (sql) => rpc(sql, 'discharge_patient', '$1', [enc.visitId]));

  const bill = await h.asOwner(
    `select unit_amount, amount, tax_category from public.billing_line_items
      where visit_id=$1 and source_type='room_rent'`, [enc.visitId]);
  checkEqual('** the stay bills at 1800 — the rate when it STARTED, not the new 6000 **',
    Number(bill[0].unit_amount), 1800);
  checkEqual('...so 2 days is 3600', Number(bill[0].amount), 3600);
  checkEqual('** ...and stays EXEMPT, rather than being retroactively taxed at the new rate **',
    bill[0].tax_category, 'exempt');

  // A stay started AFTER the change picks up the new rate, so the snapshot is a
  // snapshot and not a freeze.
  const after = await admit(GST, generalBed, 'Post Repricing');
  const st = await h.asOwner(
    `select daily_rate from public.bed_stays where visit_id=$1`, [after.visitId]);
  checkEqual('** a stay starting after the change picks up the new rate **',
    Number(st[0].daily_rate), 6000);
  await h.asUser(GST.nurse, (sql) => rpc(sql, 'discharge_patient', '$1', [after.visitId]));
  const b2 = await h.asOwner(
    `select tax_category, tax_rate from public.billing_line_items
      where visit_id=$1 and source_type='room_rent'`, [after.visitId]);
  checkEqual('** ...and is now TAXABLE, 6000 being above 5000 **', b2[0].tax_category, 'taxable');
  checkEqual('...at 5%', Number(b2[0].tax_rate), 5);

  await h.asUser(GST.admin, (sql) => sql(
    `update public.wards set daily_rate = 1800 where tenant_id=$1 and name='General Ward'`,
    [GST.tenantId]));
}

/* ========================================================================== */
section('8. ** idempotency, an unpriced ward, and the structural guarantees **');

{
  // Closing an already-closed stay must not produce a second charge. Attempted as
  // owner, i.e. the writer the index has to defend against, not just the RPC.
  const enc = await admit(GST, unpricedBed, 'Unpriced Stay');
  await h.asUser(GST.nurse, (sql) => rpc(sql, 'discharge_patient', '$1', [enc.visitId]));

  const zero = await h.asOwner(
    `select quantity, unit_amount, amount, tax_category from public.billing_line_items
      where visit_id=$1 and source_type='room_rent'`, [enc.visitId]);
  checkEqual('** an unpriced ward still produces a visible line, not a silent omission **',
    zero.length, 1);
  checkEqual('...at 0', Number(zero[0].amount), 0);
  checkEqual('...exempt', zero[0].tax_category, 'exempt');

  // Re-close it as the owner: the trigger guard should stop it, and the unique index
  // would stop it even if the guard were removed.
  await h.asOwner(
    `update public.bed_stays set ended_at = now(), end_reason = 'discharge' where visit_id=$1`,
    [enc.visitId]);
  const again = await h.asOwner(
    `select id from public.billing_line_items where visit_id=$1 and source_type='room_rent'`,
    [enc.visitId]);
  checkEqual('** re-closing a closed stay does NOT double-charge **', again.length, 1);

  // And prove the index itself bites, independently of the trigger, using a free
  // source_id-shaped duplicate.
  const stay = await h.asOwner(`select id, tenant_id, visit_id from public.bed_stays where visit_id=$1`,
    [enc.visitId]);
  await checkRejects('** a duplicate room_rent line for the same stay is rejected structurally **',
    () => h.asOwner(
      `insert into public.billing_line_items
         (tenant_id, patient_id, visit_id, source_type, source_id, description, quantity, unit_amount)
       select $1, v.patient_id, $2, 'room_rent', $3, 'dup', 1, 0
         from public.visits v where v.id = $2`,
      [stay[0].tenant_id, stay[0].visit_id, stay[0].id]), '23505');

  // bed_stays is system-derived: no client write path at all.
  await h.asUser(GST.admin, async (sql) => {
    await checkRejects('** an admin cannot INSERT a bed stay **',
      () => sql(`insert into public.bed_stays (tenant_id, visit_id, bed_id, ward_name, daily_rate, is_critical_care)
                 values ($1,$2,$3,'X',1,false)`, [GST.tenantId, enc.visitId, generalBed]), '42501');
    await checkRejects('** ...nor lengthen one to inflate a bill **',
      () => sql(`update public.bed_stays set started_at = now() - interval '30 days' where visit_id=$1`,
        [enc.visitId]), '42501');
    await checkRejects('** ...nor delete one to suppress a charge **',
      () => sql(`delete from public.bed_stays where visit_id=$1`, [enc.visitId]), '42501');
  });

  // One open stay per visit and per bed, structurally.
  const idx = await h.asOwner(
    `select indexname from pg_indexes where schemaname='public'
       and indexname in ('bed_stays_one_open_per_visit_idx','bed_stays_one_open_per_bed_idx')
      order by indexname`);
  checkEqual('** one-open-stay-per-bed and per-visit are enforced by unique indexes **', idx.length, 2);

  // Ward rates are admin-only, like every other commercial term.
  //
  // Asserted on the OUTCOME, not on an exception, and the difference matters. The
  // update grant on these columns goes to `authenticated` (all roles), exactly as
  // `beds` does for ward_name/bed_number — so the protection here is the RLS policy,
  // and a policy that fails its USING clause makes the row invisible to the UPDATE
  // rather than raising. The statement therefore "succeeds" having changed nothing.
  // Checking the stored value is the only assertion that proves the guarantee;
  // expecting 42501 would have been asserting the wrong mechanism.
  await h.asUser(GST.nurse, async (sql) => {
    await sql(`update public.wards set daily_rate = 1 where tenant_id=$1 and name='ICU'`, [GST.tenantId]);
    await sql(`update public.wards set is_critical_care = true where tenant_id=$1 and name='General Ward'`,
      [GST.tenantId]);
    const seen = await sql(`select name, daily_rate, is_critical_care from public.wards
                             where tenant_id=$1 and name in ('ICU','General Ward') order by name`,
      [GST.tenantId]);
    checkEqual('a nurse can still read the ward list', seen.length, 2);
  });
  {
    const w = await h.asOwner(
      `select name, daily_rate, is_critical_care from public.wards
        where tenant_id=$1 and name in ('ICU','General Ward') order by name`, [GST.tenantId]);
    checkEqual('** a nurse re-pricing a ward changes nothing — General Ward still 1800 **',
      Number(w.find((r) => r.name === 'General Ward')!.daily_rate), 1800);
    checkEqual('** ...and cannot declare a ward critical care, which would change its tax **',
      w.find((r) => r.name === 'General Ward')!.is_critical_care, false);
    checkEqual('** ...nor drop the ICU rate to 1 **',
      Number(w.find((r) => r.name === 'ICU')!.daily_rate), 25000);
  }

  // The tier gate falls out of the admission path — no second gate needed.
  await h.asUser(T1.admin, async (sql) => {
    await checkRejects('** a Tier 1 clinic cannot create ward inventory at all **', () => sql(
      `insert into public.beds (tenant_id, ward_name, bed_number) values ($1,'W','1')`,
      [T1.tenantId]), '42501');
  });
  {
    const pat = await registerPatient(h, T1, { name: 'T1 Patient', phone: '9611110000', age: 40 });
    const v = await h.asUser(T1.billing, (sql) =>
      rpc(sql, 'check_in_patient', '$1, $2, $3', [pat.patientId, 'new', T1.doctor.id]));
    const denied = await h.asUser(T1.nurse, (sql) =>
      rpc(sql, 'admit_patient_to_bed', '$1, $2', [v.visit_id, generalBed]));
    checkEqual('** ...so a Tier 1 admission is refused, and no bed stay can exist to bill **',
      denied.code, 'TIER_NOT_ENABLED');
    const stays = await h.asOwner(
      `select id from public.bed_stays where visit_id=$1`, [v.visit_id as string]);
    checkEqual('** ...confirmed: zero bed stays, therefore zero room rent **', stays.length, 0);
  }

  // Cross-tenant: a ward rate from another clinic must not be reachable. The generic
  // pentest matrix covers plain SELECT; this covers the billing-specific path.
  await h.asUser(NOGST.admin, async (sql) => {
    const seen = await sql(`select id from public.wards where tenant_id=$1`, [GST.tenantId]);
    checkEqual('** another clinic cannot read this clinic wards **', seen.length, 0);
    const stays = await sql(`select id from public.bed_stays where tenant_id=$1`, [GST.tenantId]);
    checkEqual('** ...nor its bed stays **', stays.length, 0);
    const acc = await sql(`select bed_stay_id from public.ipd_accrual_current where tenant_id=$1`,
      [GST.tenantId]);
    checkEqual('** ...nor its accruals through the view **', acc.length, 0);
  });
}

/* ========================================================================== */
section('9. ** cancel_prescription() — the write path the guard was waiting for **');

{
  /** Issues a prescription with one priced item on a fresh visit. */
  async function issuedRx(t: TenantFixture, label: string, phone: string) {
    const pat = await registerPatient(h, t, { name: label, phone, age: 45 });
    const v = await h.asUser(t.billing, (sql) =>
      rpc(sql, 'check_in_patient', '$1, $2, $3', [pat.patientId, 'new', t.doctor.id]));
    const visitId = v.visit_id as string;
    const rxId = await h.asUser(t.doctor, async (sql) => {
      await rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'in_consultation']);
      const rx = await sql(
        `insert into public.prescriptions (tenant_id, visit_id, doctor_id) values ($1,$2,$3) returning id`,
        [t.tenantId, visitId, t.doctor.id]);
      await sql(
        `insert into public.prescription_items (prescription_id, tenant_id, drug_name, dose, quantity, unit_price)
         values ($1,$2,'Augmentin 625','625 mg',10,42)`, [rx[0].id, t.tenantId]);
      const iss = await rpc(sql, 'issue_prescription', '$1', [rx[0].id]);
      checkEqual(`${label}: prescription issued`, iss.ok, true);
      return rx[0].id as string;
    });
    return { visitId, rxId };
  }

  // ---- a draft: nothing to withdraw ----
  {
    const pat = await registerPatient(h, GST, { name: 'Draft Rx', phone: '9612000001', age: 30 });
    const v = await h.asUser(GST.billing, (sql) =>
      rpc(sql, 'check_in_patient', '$1, $2, $3', [pat.patientId, 'new', GST.doctor.id]));
    const rxId = await h.asUser(GST.doctor, async (sql) => {
      const rx = await sql(`insert into public.prescriptions (tenant_id, visit_id, doctor_id)
                            values ($1,$2,$3) returning id`,
        [GST.tenantId, v.visit_id, GST.doctor.id]);
      return rx[0].id as string;
    });
    const c = await h.asUser(GST.doctor, (sql) => rpc(sql, 'cancel_prescription', '$1, $2',
      [rxId, 'Wrong patient selected']));
    checkEqual('** a draft can be cancelled **', c.ok, true);
    checkEqual('...reported as a change', c.changed, true);
    checkEqual('...and it was never issued', c.was_issued, false);
    checkEqual('...so nothing was withdrawn', Number(c.charges_withdrawn), 0);

    const row = await h.asOwner(`select status, issued_at, notes from public.prescriptions where id=$1`, [rxId]);
    checkEqual('** the status is cancelled **', row[0].status, 'cancelled');
    checkEqual('** ...and issued_at is NULL, as the paired constraint requires **', row[0].issued_at, null);
    check('...with the reason recorded in notes', String(row[0].notes).includes('Wrong patient selected'),
      String(row[0].notes));

    // Idempotent.
    const again = await h.asUser(GST.doctor, (sql) => rpc(sql, 'cancel_prescription', '$1', [rxId]));
    checkEqual('** cancelling twice is an idempotent no-op success **', again.ok, true);
    checkEqual('...reported as no change', again.changed, false);
  }

  // ---- issued, charges still pending: withdrawn ----
  {
    const { visitId, rxId } = await issuedRx(GST, 'Pending Rx', '9612000002');
    const before = await h.asOwner(
      `select id from public.billing_line_items where visit_id=$1 and source_type='medicine'`, [visitId]);
    checkEqual('the medicine charge was auto-captured on issue', before.length, 1);

    const c = await h.asUser(GST.doctor, (sql) =>
      rpc(sql, 'cancel_prescription', '$1, $2', [rxId, 'Allergy noticed after issue']));
    checkEqual('** an issued prescription can be cancelled **', c.ok, true);
    checkEqual('...and it was issued', c.was_issued, true);
    checkEqual('** ...withdrawing the pending medicine charge **', Number(c.charges_withdrawn), 1);
    checkEqual('...with none stuck on an invoice', Number(c.charges_invoiced), 0);

    const after = await h.asOwner(
      `select id from public.billing_line_items where visit_id=$1 and source_type='medicine'`, [visitId]);
    checkEqual('** the patient is no longer billed for medicine never dispensed **', after.length, 0);

    // The Phase 3 guard that has been waiting for this since 20260811070600.
    const itemId = await h.asOwner(
      `select id from public.prescription_items where prescription_id=$1`, [rxId]);
    const pat = await h.asOwner(`select patient_id from public.visits where id=$1`, [visitId]);
    const adm = await h.asUser(GST.nurse, (sql) => rpc(sql, 'record_medication_administration', '$1, $2',
      [itemId[0].id, pat[0].patient_id]));
    checkEqual('** administering off a cancelled prescription is refused **', adm.code, 'PRESCRIPTION_CANCELLED');
  }

  // ---- issued AND invoiced: left alone, and reported ----
  {
    const { visitId, rxId } = await issuedRx(GST, 'Invoiced Rx', '9612000003');
    await h.asUser(GST.doctor, (sql) => rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'done']));
    const inv = await h.asUser(GST.billing, (sql) =>
      rpc(sql, 'create_invoice_for_visit', '$1', [visitId]));
    checkEqual('an invoice was raised, pulling the medicine charge onto it', inv.ok, true);

    const c = await h.asUser(GST.admin, (sql) =>
      rpc(sql, 'cancel_prescription', '$1, $2', [rxId, 'Dispensing error']));
    checkEqual('** an admin can cancel another doctor prescription **', c.ok, true);
    checkEqual('** ...but an invoiced charge is NOT silently deleted **', Number(c.charges_withdrawn), 0);
    checkEqual('** ...it is counted and reported, so a credit note can be raised **',
      Number(c.charges_invoiced), 1);

    const still = await h.asOwner(
      `select invoice_id from public.billing_line_items where visit_id=$1 and source_type='medicine'`,
      [visitId]);
    checkEqual('** the invoiced line is still there — a tax document is not rewritten **', still.length, 1);
    check('...still attached to its invoice', still[0].invoice_id !== null);
  }

  // ---- authorisation ----
  {
    const { rxId } = await issuedRx(GST, 'Auth Rx', '9612000004');
    await h.asUser(GST.nurse, async (sql) => {
      const denied = await rpc(sql, 'cancel_prescription', '$1', [rxId]);
      checkEqual('** a nurse cannot cancel a prescription **', denied.code, 'NOT_CLINICAL_STAFF');
    });
    await h.asUser(GST.billing, async (sql) => {
      const denied = await rpc(sql, 'cancel_prescription', '$1', [rxId]);
      checkEqual('...nor can billing', denied.code, 'NOT_CLINICAL_STAFF');
    });
    await h.asUser(NOGST.doctor, async (sql) => {
      const denied = await rpc(sql, 'cancel_prescription', '$1', [rxId]);
      checkEqual('** another clinic doctor gets NOT_FOUND, not a permission hint **',
        denied.code, 'PRESCRIPTION_NOT_FOUND');
    });
    await h.asUser(GST.admin, (sql) => rpc(sql, 'cancel_prescription', '$1', [rxId]));
  }
}

/* ========================================================================== */
section('10. NEGATIVE CONTROL — confirm the Phase 6 assertions depend on RLS');

{
  await h.asOwner(`alter table public.wards disable row level security`);
  await h.asOwner(`alter table public.bed_stays disable row level security`);

  await h.asUser(NOGST.admin, async (sql) => {
    const w = await sql(`select id from public.wards where tenant_id=$1`, [GST.tenantId]);
    check('with RLS off, the other clinic DOES see these wards', w.length > 0, `saw ${w.length}`);
    const s = await sql(`select id from public.bed_stays where tenant_id=$1`, [GST.tenantId]);
    check('...and DOES see the bed stays', s.length > 0, `saw ${s.length}`);
  });

  await h.asOwner(`alter table public.wards enable row level security`);
  await h.asOwner(`alter table public.bed_stays enable row level security`);

  await h.asUser(NOGST.admin, async (sql) => {
    checkEqual('RLS restored: back to 0 wards', (await sql(
      `select id from public.wards where tenant_id=$1`, [GST.tenantId])).length, 0);
    checkEqual('RLS restored: back to 0 bed stays', (await sql(
      `select id from public.bed_stays where tenant_id=$1`, [GST.tenantId])).length, 0);
  });
}

summary('Phase 6 IPD room-rent billing, wards, bed stays and prescription cancellation (local / PGlite)');
