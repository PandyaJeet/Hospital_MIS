/**
 * FULL OPD LOOP + BILLING + GST + SAFETY CHECK  (Phase 2 DoD)
 *
 * Run: npm run test:opd
 *
 * Walks the phase's headline requirement end to end for one tenant —
 *   register -> queue -> consult -> prescribe -> bill -> invoice
 * — and then asserts the three things most likely to be quietly wrong:
 *   * billing lines appear with ZERO manual entry, and never twice
 *   * tax is computed per line and summarised per category, and a non-GST
 *     tenant gets no tax at all
 *   * the safety check reports severity and distinguishes "found nothing" from
 *     "could not check"
 *
 * Fixtures are built through the real onboarding and registration RPCs, so this
 * is an integration test of the whole stack of migrations, not of one function.
 */

import { createHarness, check, checkEqual, checkRejects, section, summary, type Harness } from '../harness/pglite.ts';
import { rpc, seedTenant, registerPatient, type TenantFixture } from '../harness/fixtures.ts';

const h: Harness = await createHarness();

/* ========================================================================== */
section('Setup — one GST-registered clinic, one not registered');

// GST-registered, ₹500 tenant default, doctor overrides to ₹700.
const gstClinic: TenantFixture = await seedTenant(h, {
  name: 'Sunrise Clinic',
  slug: 'g',
  gst: { gstin: '27AABCU9603R1ZM', stateCode: '27' },
  consultationFee: 500,
  doctorFee: 700,
});
check('GST clinic created with staff', gstClinic.allStaff.length === 4);

// Not GST-registered — the solo doctor below the turnover threshold.
const plainClinic: TenantFixture = await seedTenant(h, {
  name: 'Lotus Clinic',
  slug: 'p',
  consultationFee: 300,
});
check('non-GST clinic created with staff', plainClinic.allStaff.length === 4);

const settings = await h.asOwner(
  `select name, gst_registered, gstin, default_consultation_fee from public.tenants order by name`,
);
checkEqual('GST clinic is registered', settings.find((s) => s.name === 'Sunrise Clinic')?.gst_registered, true);
checkEqual('non-GST clinic is not registered', settings.find((s) => s.name === 'Lotus Clinic')?.gst_registered, false);
check(
  'admin could set GST details through their own session (column grant works)',
  settings.find((s) => s.name === 'Sunrise Clinic')?.gstin === '27AABCU9603R1ZM',
);

/* ========================================================================== */
section('1. Register — reception creates a patient');

const reg = await h.asUser(gstClinic.billing, (sql) =>
  rpc(sql, 'register_patient', '$1, $2, $3, $4, $5, $6, $7', [
    '  Ramesh Kumar  ', '+91 98765-43210', null, 42, 'male', 'Pune', 'penicillin, dust',
  ]),
);
check('registration succeeds', reg.ok === true, JSON.stringify(reg));
checkEqual('patient_number starts at 1', Number(reg.patient_number), 1);
checkEqual('name is trimmed', reg.full_name, 'Ramesh Kumar');
const patientId = reg.patient_id as string;

const stored = await h.asOwner(`select phone, phone_normalized, age_years from public.patients where id=$1`, [patientId]);
checkEqual('phone stored as entered', stored[0]?.phone, '+91 98765-43210');
checkEqual('phone normalised to last 10 digits', stored[0]?.phone_normalized, '9876543210');
checkEqual('age recorded without inventing a DOB', Number(stored[0]?.age_years), 42);

// Second patient gets the next number.
const reg2 = await registerPatient(h, gstClinic, { name: 'Sita Devi', phone: '9123456780', age: 31 });
checkEqual('patient_number increments per tenant', reg2.patientNumber, 2);

/* ========================================================================== */
section('2. Duplicate handling — soft, overridable, and NULL-phone-safe');

await h.asUser(gstClinic.billing, async (sql) => {
  // Same number, differently formatted -> still detected.
  const dup = await rpc(sql, 'register_patient', '$1, $2', ['Ramesh K', '098765 43210']);
  checkEqual('same number reformatted -> DUPLICATE_PATIENT', dup.code, 'DUPLICATE_PATIENT');
  check('the existing record is returned so the UI can prompt', Array.isArray(dup.matches) && (dup.matches as unknown[]).length === 1);
  checkEqual('flagged as overridable', dup.can_override, true);

  // The guardian's-number case: deliberately register a second person on it.
  const child = await rpc(sql, 'register_patient', '$1, $2, $3, $4, $5, $6, $7, $8', [
    'Baby Kumar', '9876543210', null, 2, null, null, null, true,
  ]);
  check('override registers a second person on the same number', child.ok === true, JSON.stringify(child));
  checkEqual('...and gets its own patient_number', Number(child.patient_number), 3);

  // No phone at all: two walk-ins are not duplicates of each other.
  const w1 = await rpc(sql, 'register_patient', '$1', ['Walk-in One']);
  const w2 = await rpc(sql, 'register_patient', '$1', ['Walk-in Two']);
  check('first no-phone walk-in registers', w1.ok === true, JSON.stringify(w1));
  check('second no-phone walk-in also registers', w2.ok === true, JSON.stringify(w2));

  const blank = await rpc(sql, 'register_patient', '$1', ['   ']);
  checkEqual('blank name -> VALIDATION_ERROR', blank.code, 'VALIDATION_ERROR');
});

/* ========================================================================== */
section('3. Queue — check-in, token numbers, wait time');

const checkIn = await h.asUser(gstClinic.billing, (sql) =>
  rpc(sql, 'check_in_patient', '$1, $2, $3', [patientId, 'new', gstClinic.doctor.id]),
);
check('check-in succeeds', checkIn.ok === true, JSON.stringify(checkIn));
checkEqual('first token of the day is 1', Number(checkIn.queue_number), 1);
checkEqual('starts queued', checkIn.status, 'queued');
const visitId = checkIn.visit_id as string;

await h.asUser(gstClinic.billing, async (sql) => {
  const again = await rpc(sql, 'check_in_patient', '$1', [patientId]);
  checkEqual('same patient twice in one day -> VISIT_ALREADY_OPEN', again.code, 'VISIT_ALREADY_OPEN');
  checkEqual('...and points at the existing visit', again.visit_id, visitId);

  const second = await rpc(sql, 'check_in_patient', '$1, $2', [reg2.patientId, 'follow_up']);
  check('a different patient gets the next token', second.ok === true);
  checkEqual('token increments', Number(second.queue_number), 2);

  const ghost = await rpc(sql, 'check_in_patient', '$1', ['00000000-0000-0000-0000-000000000000']);
  checkEqual('unknown patient -> PATIENT_NOT_FOUND', ghost.code, 'PATIENT_NOT_FOUND');
});

// The queue view a doctor actually renders, including computed wait time.
await h.asUser(gstClinic.doctor, async (sql) => {
  const queue = await sql(
    `select v.queue_number, v.status, v.visit_type, p.full_name,
            extract(epoch from (coalesce(v.consultation_started_at, now()) - v.checked_in_at))::int as wait_seconds
       from public.visits v
       join public.patients p on p.id = v.patient_id
      where v.visit_date = current_date and v.status = 'queued'
      order by v.queue_number`,
  );
  checkEqual('doctor sees both queued patients', queue.length, 2);
  check('wait time is computable from the stored timestamps', Number(queue[0]?.wait_seconds) >= 0);
});

/* ========================================================================== */
section('4. Consult — status transitions and the consultation charge');

await h.asUser(gstClinic.doctor, async (sql) => {
  const bad = await rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'done']);
  checkEqual('queued -> done is rejected', bad.code, 'INVALID_STATUS_TRANSITION');
  checkEqual('...and reports both ends', `${bad.from}->${bad.to}`, 'queued->done');

  const start = await rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'in_consultation']);
  check('queued -> in_consultation allowed', start.ok === true, JSON.stringify(start));
});

let lines = await h.asOwner(
  `select source_type, description, quantity, unit_amount, amount, tax_category, tax_rate, tax_amount, is_auto
     from public.billing_line_items where visit_id=$1 order by created_at`,
  [visitId],
);
checkEqual('consultation charge appeared with ZERO manual entry', lines.length, 1);
checkEqual('...as a consultation line', lines[0]?.source_type, 'consultation');
checkEqual('...flagged auto-captured', lines[0]?.is_auto, true);
checkEqual("...priced at the DOCTOR's fee, not the tenant default", String(lines[0]?.unit_amount), '700.00');
checkEqual('...GST-exempt (healthcare service)', lines[0]?.tax_category, 'exempt');
checkEqual('...at 0%', String(lines[0]?.tax_rate), '0.00');
checkEqual('...so no tax on it', String(lines[0]?.tax_amount), '0.00');

// Idempotency: bouncing the status must not double-charge.
await h.asUser(gstClinic.doctor, async (sql) => {
  await rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'in_consultation']);
});
lines = await h.asOwner(`select id from public.billing_line_items where visit_id=$1 and source_type='consultation'`, [visitId]);
checkEqual('re-entering in_consultation does not double-charge', lines.length, 1);

/* ========================================================================== */
section('5. Clinical note — an EMPTY note must save (rules.md §1.7)');

await h.asUser(gstClinic.doctor, async (sql) => {
  // The critical assertion of this whole phase for clinician adoption: every
  // clinical column omitted, and it still persists.
  const empty = await sql(
    `insert into public.clinical_notes (tenant_id, visit_id, author_id)
     values ($1, $2, $3) returning id, note_text, diagnosis`,
    [gstClinic.tenantId, visitId, gstClinic.doctor.id],
  );
  checkEqual('a completely empty clinical note saves', empty.length, 1);
  checkEqual('...note_text is null, not rejected', empty[0]?.note_text, null);
  checkEqual('...diagnosis is null, not rejected', empty[0]?.diagnosis, null);

  const partial = await sql(
    `insert into public.clinical_notes (tenant_id, visit_id, author_id, chief_complaint)
     values ($1, $2, $3, $4) returning id`,
    [gstClinic.tenantId, visitId, gstClinic.doctor.id, 'Fever 3 days'],
  );
  checkEqual('a half-filled note saves too', partial.length, 1);

  const notes = await sql(`select id from public.clinical_notes where visit_id=$1`, [visitId]);
  checkEqual('multiple notes per visit are allowed (addenda)', notes.length, 2);
});

/* ========================================================================== */
section('6. Safety check — severity, not a boolean');

await h.asUser(gstClinic.doctor, async (sql) => {
  // Patient's allergies say "penicillin". Amoxicillin carries that tag.
  const allergy = await rpc(sql, 'check_prescription_safety', '$1, $2', [patientId, ['Mox']]);
  check('check runs', allergy.ok === true, JSON.stringify(allergy));
  const findings = allergy.findings as Array<Record<string, unknown>>;
  checkEqual('allergy detected', findings.length, 1);
  checkEqual('...typed as an allergy', findings[0]?.finding_type, 'allergy');
  checkEqual('...severity is high, so the UI can hard-interrupt', findings[0]?.severity, 'high');
  checkEqual('...highest_severity reflects it', allergy.highest_severity, 'high');
  checkEqual('...and acknowledgement is demanded', allergy.requires_acknowledgement, true);
  check('...with a match_basis so the UI can explain itself', typeof findings[0]?.match_basis === 'string');

  // A real high-severity interaction pair.
  const interact = await rpc(sql, 'check_prescription_safety', '$1, $2', [reg2.patientId, ['Ecosprin', 'Warf 5']]);
  const f2 = interact.findings as Array<Record<string, unknown>>;
  check('aspirin + warfarin flagged', f2.some((f) => f.finding_type === 'interaction' && f.severity === 'high'), JSON.stringify(interact));

  // Reversed order must find the same pair — canonical ordering working.
  const reversed = await rpc(sql, 'check_prescription_safety', '$1, $2', [reg2.patientId, ['Warf 5', 'Ecosprin']]);
  const f3 = reversed.findings as Array<Record<string, unknown>>;
  checkEqual('reversed drug order finds the same interaction', f3.length, f2.length);

  // A fixed-dose combination must still match a single-molecule pair.
  const combo = await rpc(sql, 'check_prescription_safety', '$1, $2', [reg2.patientId, ['Combiflam', 'Warf 5']]);
  const f4 = combo.findings as Array<Record<string, unknown>>;
  check(
    'combination product (Combiflam = ibuprofen + paracetamol) matches the ibuprofen-warfarin pair',
    f4.some((f) => f.finding_type === 'interaction' && f.severity === 'high'),
    JSON.stringify(combo),
  );

  // Low severity must be reported as low, so the UI can stay silent.
  const low = await rpc(sql, 'check_prescription_safety', '$1, $2', [reg2.patientId, ['Amlong 5', 'Atorva 10']]);
  const f5 = low.findings as Array<Record<string, unknown>>;
  check('amlodipine + atorvastatin reported as low severity', f5.some((f) => f.severity === 'low'), JSON.stringify(low));
  checkEqual('...highest_severity is low', low.highest_severity, 'low');

  // "Checked and clean" vs "could not check" must be distinguishable.
  const clean = await rpc(sql, 'check_prescription_safety', '$1, $2', [patientId, ['Dolo 650']]);
  checkEqual('a clean check on a patient WITH allergies recorded is complete', clean.status, 'complete');
  checkEqual('...with no findings', (clean.findings as unknown[]).length, 0);
  checkEqual('...and no acknowledgement demanded', clean.requires_acknowledgement, false);

  const unknown = await rpc(sql, 'check_prescription_safety', '$1, $2', [patientId, ['Unobtainium 500']]);
  checkEqual('an unrecognised drug makes the result partial', unknown.status, 'partial');
  checkEqual('...lists the drug it could not check', (unknown.unknown_drugs as string[])[0], 'unobtainium 500');
  checkEqual('...and demands acknowledgement despite zero findings', unknown.requires_acknowledgement, true);
  check(
    '...with an explicit UNKNOWN_DRUGS warning',
    (unknown.warnings as Array<Record<string, unknown>>).some((w) => w.code === 'UNKNOWN_DRUGS'),
  );
});

// A patient with NO allergy history must not be reported as "checked clean".
const noAllergyPatient = await registerPatient(h, gstClinic, { name: 'No History', phone: '9000000001' });
await h.asUser(gstClinic.doctor, async (sql) => {
  const res = await rpc(sql, 'check_prescription_safety', '$1, $2', [noAllergyPatient.patientId, ['Mox']]);
  checkEqual('empty allergy history -> partial, not complete', res.status, 'partial');
  checkEqual('...allergies_recorded is false', res.allergies_recorded, false);
  check(
    '...with a NO_ALLERGIES_RECORDED warning so the UI says "verify manually"',
    (res.warnings as Array<Record<string, unknown>>).some((w) => w.code === 'NO_ALLERGIES_RECORDED'),
  );
  checkEqual('...and acknowledgement demanded', res.requires_acknowledgement, true);

  const noPatient = await rpc(sql, 'check_prescription_safety', '$1, $2', ['00000000-0000-0000-0000-000000000000', ['Mox']]);
  checkEqual('unknown patient is an error, not an empty result', noPatient.code, 'PATIENT_NOT_FOUND');
  checkEqual('...and ok is false, distinct from a clean check', noPatient.ok, false);

  const noDrugs = await rpc(sql, 'check_prescription_safety', '$1, $2', [patientId, []]);
  checkEqual('empty drug list -> VALIDATION_ERROR', noDrugs.code, 'VALIDATION_ERROR');
});

/* ========================================================================== */
section('7. Prescribe — draft, then issue triggers medicine billing');

let prescriptionId = '';
await h.asUser(gstClinic.doctor, async (sql) => {
  const rx = await sql(
    `insert into public.prescriptions (tenant_id, visit_id, doctor_id, notes)
     values ($1,$2,$3,$4) returning id, status`,
    [gstClinic.tenantId, visitId, gstClinic.doctor.id, 'Take after food'],
  );
  prescriptionId = rx[0].id as string;
  checkEqual('prescription starts as draft', rx[0]?.status, 'draft');

  const empty = await rpc(sql, 'issue_prescription', '$1', [prescriptionId]);
  checkEqual('issuing an empty prescription is refused', empty.code, 'PRESCRIPTION_EMPTY');

  const dolo = await sql(`select id, mrp, gst_rate from public.drugs where brand_name='Dolo 650'`);
  const insulin = await sql(`select id, mrp, gst_rate from public.drugs where brand_name='Human Actrapid'`);

  await sql(
    `insert into public.prescription_items
       (prescription_id, tenant_id, drug_id, drug_name, generic_name, dose, frequency, duration, quantity)
     values ($1,$2,$3,'Dolo 650','Paracetamol','650 mg','TDS','3 days',9)`,
    [prescriptionId, gstClinic.tenantId, dolo[0].id],
  );
  // A drug with an explicit 0% rate — the exempt life-saving category.
  await sql(
    `insert into public.prescription_items
       (prescription_id, tenant_id, drug_id, drug_name, generic_name, quantity)
     values ($1,$2,$3,'Human Actrapid','Insulin human',1)`,
    [prescriptionId, gstClinic.tenantId, insulin[0].id],
  );
  // A partially-specified item: no dose, no frequency, no price. Must still save.
  await sql(
    `insert into public.prescription_items (prescription_id, tenant_id, drug_name)
     values ($1,$2,'Some Ointment')`,
    [prescriptionId, gstClinic.tenantId],
  );

  const items = await sql(`select drug_name, dose from public.prescription_items where prescription_id=$1`, [prescriptionId]);
  checkEqual('all three items saved, including the bare one', items.length, 3);

  // Nothing billed while still a draft — this is the whole point of the lifecycle.
  const pending = await sql(`select id from public.billing_line_items where visit_id=$1 and source_type='medicine'`, [visitId]);
  checkEqual('draft prescription bills nothing yet', pending.length, 0);

  const issued = await rpc(sql, 'issue_prescription', '$1', [prescriptionId]);
  check('issue succeeds', issued.ok === true, JSON.stringify(issued));
  checkEqual('...reporting the item count', Number(issued.item_count), 3);

  const twice = await rpc(sql, 'issue_prescription', '$1', [prescriptionId]);
  checkEqual('issuing twice is refused', twice.code, 'PRESCRIPTION_ALREADY_ISSUED');
});

const medLines = await h.asOwner(
  `select description, quantity, unit_amount, amount, tax_category, tax_rate, tax_amount
     from public.billing_line_items
    where visit_id=$1 and source_type='medicine' order by description`,
  [visitId],
);
checkEqual('one medicine line per item, auto-captured', medLines.length, 3);

const dolo = medLines.find((l) => String(l.description).startsWith('Dolo'));
checkEqual('Dolo priced from the reference MRP', String(dolo?.unit_amount), '30.00');
checkEqual('...quantity carried over', String(dolo?.quantity), '9.00');
checkEqual('...line total = qty x price', String(dolo?.amount), '270.00');
checkEqual('...taxed as a medicine', dolo?.tax_category, 'taxable');
checkEqual('...at the default 5%', String(dolo?.tax_rate), '5.00');
checkEqual('...tax = 5% of 270.00', String(dolo?.tax_amount), '13.50');

const ins = medLines.find((l) => String(l.description).startsWith('Human Actrapid'));
checkEqual('exempt life-saving drug is nil_rated, not taxed at 5%', ins?.tax_category, 'nil_rated');
checkEqual('...with zero tax', String(ins?.tax_amount), '0.00');

const ointment = medLines.find((l) => String(l.description).startsWith('Some Ointment'));
checkEqual('unpriced item yields a visible zero-amount line for billing to complete', String(ointment?.amount), '0.00');

/* ========================================================================== */
section('8. Invoice — tax summarised PER CATEGORY, never a flat rate');

const inv = await h.asUser(gstClinic.billing, (sql) =>
  rpc(sql, 'create_invoice_for_visit', '$1', [visitId]),
);
check('invoice created', inv.ok === true, JSON.stringify(inv));
checkEqual('numbered from 1 per tenant', Number(inv.invoice_number), 1);
checkEqual('flagged as a GST invoice', inv.is_gst_invoice, true);
checkEqual('all four pending lines pulled on', Number(inv.line_count), 4);
const invoiceId = inv.invoice_id as string;

// 700 consultation + 270 Dolo + 165 insulin + 0 ointment = 1135
// Values inside a jsonb envelope arrive as JSON numbers, so compare numerically.
// Direct column reads (below) come back as scale-preserving numeric strings.
checkEqual('subtotal is the sum of line amounts', Number(inv.subtotal), 1135);
checkEqual('tax_total is 5% of the Dolo line only', Number(inv.tax_total), 13.5);
checkEqual('grand_total = subtotal + tax', Number(inv.grand_total), 1148.5);

const taxLines = await h.asOwner(
  `select tax_category, tax_rate, taxable_amount, tax_amount
     from public.invoice_tax_lines where invoice_id=$1 order by tax_category, tax_rate`,
  [invoiceId],
);
checkEqual('three distinct tax buckets, not one blended rate', taxLines.length, 3);
const exempt = taxLines.find((t) => t.tax_category === 'exempt');
const nil = taxLines.find((t) => t.tax_category === 'nil_rated');
const taxable = taxLines.find((t) => t.tax_category === 'taxable');
checkEqual('exempt bucket holds the consultation', String(exempt?.taxable_amount), '700.00');
checkEqual('...with no tax', String(exempt?.tax_amount), '0.00');
checkEqual('nil-rated bucket holds the exempt drug', String(nil?.taxable_amount), '165.00');
checkEqual('taxable bucket holds the 5% medicine', String(taxable?.taxable_amount), '270.00');
checkEqual('...and its tax', String(taxable?.tax_amount), '13.50');
checkEqual('taxable bucket carries the actual rate', String(taxable?.tax_rate), '5.00');

const sumCheck = await h.asOwner(
  `select (select tax_total from public.invoices where id=$1) as invoice_tax,
          (select coalesce(sum(tax_amount),0) from public.invoice_tax_lines where invoice_id=$1) as bucket_sum`,
  [invoiceId],
);
checkEqual('invoice.tax_total equals the sum of its buckets', String(sumCheck[0]?.invoice_tax), String(sumCheck[0]?.bucket_sum));

const snap = await h.asOwner(`select gstin_snapshot, gst_state_code_snapshot from public.invoices where id=$1`, [invoiceId]);
checkEqual('GSTIN snapshotted onto the invoice', snap[0]?.gstin_snapshot, '27AABCU9603R1ZM');

await h.asUser(gstClinic.billing, async (sql) => {
  const again = await rpc(sql, 'create_invoice_for_visit', '$1', [visitId]);
  checkEqual('a second invoice for the same visit is refused', again.code, 'INVOICE_ALREADY_EXISTS');

  const pending = await sql(`select id from public.billing_line_items where visit_id=$1 and invoice_id is null`, [visitId]);
  checkEqual('no charges left pending after invoicing', pending.length, 0);
});

/* ========================================================================== */
section('9. Non-GST clinic — a bill of supply, not a zeroed GST invoice');

const pPatient = await registerPatient(h, plainClinic, { name: 'Anita Rao', phone: '9333333333' });
const pVisit = await h.asUser(plainClinic.billing, (sql) =>
  rpc(sql, 'check_in_patient', '$1, $2, $3', [pPatient.patientId, 'new', plainClinic.doctor.id]),
);
await h.asUser(plainClinic.doctor, (sql) => rpc(sql, 'set_visit_status', '$1, $2', [pVisit.visit_id, 'in_consultation']));

let pRxId = '';
await h.asUser(plainClinic.doctor, async (sql) => {
  const rx = await sql(
    `insert into public.prescriptions (tenant_id, visit_id, doctor_id) values ($1,$2,$3) returning id`,
    [plainClinic.tenantId, pVisit.visit_id, plainClinic.doctor.id],
  );
  pRxId = rx[0].id as string;
  const d = await sql(`select id from public.drugs where brand_name='Dolo 650'`);
  await sql(
    `insert into public.prescription_items (prescription_id, tenant_id, drug_id, drug_name, quantity)
     values ($1,$2,$3,'Dolo 650',10)`,
    [pRxId, plainClinic.tenantId, d[0].id],
  );
  await rpc(sql, 'issue_prescription', '$1', [pRxId]);
});

const pLines = await h.asOwner(
  `select source_type, tax_category, tax_rate, tax_amount from public.billing_line_items where visit_id=$1`,
  [pVisit.visit_id],
);
check('every line at a non-GST clinic is non_gst', pLines.every((l) => l.tax_category === 'non_gst'), JSON.stringify(pLines));
check('...with zero rate', pLines.every((l) => String(l.tax_rate) === '0.00'));
check('...and zero tax, including on medicine', pLines.every((l) => String(l.tax_amount) === '0.00'));

const pInv = await h.asUser(plainClinic.billing, (sql) =>
  rpc(sql, 'create_invoice_for_visit', '$1', [pVisit.visit_id]),
);
check('non-GST invoice created', pInv.ok === true, JSON.stringify(pInv));
checkEqual('flagged NOT a GST invoice', pInv.is_gst_invoice, false);
checkEqual('tax_total is zero', Number(pInv.tax_total), 0);

const pTaxLines = await h.asOwner(`select id from public.invoice_tax_lines where invoice_id=$1`, [pInv.invoice_id]);
checkEqual('NO tax lines written at all — so the PDF renders a bill of supply', pTaxLines.length, 0);

const pSnap = await h.asOwner(`select gstin_snapshot from public.invoices where id=$1`, [pInv.invoice_id]);
checkEqual('no GSTIN on a non-GST bill', pSnap[0]?.gstin_snapshot, null);

/* ========================================================================== */
section('10. PDF payloads — the data the Edge Functions render');

await h.asUser(gstClinic.doctor, async (sql) => {
  const payload = await rpc(sql, 'get_prescription_for_pdf', '$1', [prescriptionId]);
  check('prescription payload returns', payload.ok === true, JSON.stringify(payload).slice(0, 200));
  const p = payload as Record<string, Record<string, unknown>>;
  checkEqual('clinic name present', p.clinic?.name, 'Sunrise Clinic');
  checkEqual('patient name present', p.patient?.name, 'Ramesh Kumar');
  checkEqual('all items present', (payload.items as unknown[]).length, 3);
  check('doctor name present', typeof p.doctor?.name === 'string');
});

await h.asUser(gstClinic.billing, async (sql) => {
  const payload = await rpc(sql, 'get_invoice_for_pdf', '$1', [invoiceId]);
  check('invoice payload returns', payload.ok === true);
  checkEqual('all lines present', (payload.lines as unknown[]).length, 4);
  checkEqual('rate-wise tax summary present for the renderer', (payload.tax_summary as unknown[]).length, 3);
  const i = payload as Record<string, Record<string, unknown>>;
  checkEqual('grand total present', Number(i.invoice?.grand_total), 1148.5);
});

await h.asUser(plainClinic.billing, async (sql) => {
  const payload = await rpc(sql, 'get_invoice_for_pdf', '$1', [pInv.invoice_id]);
  checkEqual('non-GST payload has an empty tax_summary', (payload.tax_summary as unknown[]).length, 0);
  const i = payload as Record<string, Record<string, unknown>>;
  checkEqual('...and is flagged non-GST for the renderer', i.invoice?.is_gst_invoice, false);
});

/* ========================================================================== */
section('11. Close the loop — mark done, record payment');

await h.asUser(gstClinic.doctor, async (sql) => {
  const done = await rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'done']);
  check('in_consultation -> done', done.ok === true, JSON.stringify(done));
});

const ended = await h.asOwner(`select consultation_started_at, consultation_ended_at from public.visits where id=$1`, [visitId]);
check('consultation timestamps both stamped', ended[0]?.consultation_started_at !== null && ended[0]?.consultation_ended_at !== null);

await h.asUser(gstClinic.billing, async (sql) => {
  const paid = await sql(
    `update public.invoices set status='paid', amount_paid=1148.50, payment_mode='upi'
      where id=$1 returning status, issued_at`,
    [invoiceId],
  );
  checkEqual('billing can record payment', paid[0]?.status, 'paid');
  check('issued_at stamped server-side by the guard trigger', paid[0]?.issued_at !== null);

  await checkRejects(
    'a paid invoice cannot revert to draft',
    () => sql(`update public.invoices set status='draft' where id=$1`, [invoiceId]),
    '23514',
  );
});

await h.close();
summary('Full OPD flow, billing, GST and safety check (local / PGlite)');
