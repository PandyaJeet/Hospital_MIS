/**
 * PHASE 2 CROSS-TENANT ISOLATION + ROLE SCOPING  (rules.md §4.1–4.3)
 *
 * Run: npm run test:isolation2
 *
 * Every table added in Phase 2 gets the same treatment Phase 1's tables got:
 * prove a user in clinic A cannot see, modify, or infer anything about clinic B,
 * and cannot escalate their own privileges inside their own clinic either.
 *
 * Three layers are checked, because they fail differently:
 *   1. RLS      — wrong-tenant rows are invisible (0 rows, no error)
 *   2. GRANTS   — ungranted columns are refused outright (42501)
 *   3. SCHEMA   — composite FKs make cross-tenant parenting impossible even with
 *                 RLS switched off, which is the guarantee that survives a
 *                 policy mistake
 *
 * Ends with a shared NEGATIVE CONTROL over the whole Phase 2 table group: RLS is
 * disabled, the leak is confirmed to appear, then re-enabled and isolation
 * re-asserted. Without it, "A sees 0 rows of B" could be passing because a
 * fixture was empty.
 */

import { createHarness, check, checkEqual, checkRejects, section, summary, type Harness, type SessionUser } from '../harness/pglite.ts';
import { rpc, seedTenant, registerPatient, type TenantFixture } from '../harness/fixtures.ts';

const h: Harness = await createHarness();

const PHASE2_TABLES = [
  'patients', 'visits', 'clinical_notes',
  'prescriptions', 'prescription_items',
  'billing_line_items', 'invoices', 'invoice_tax_lines',
] as const;

/* ========================================================================== */
section('Fixtures — two fully-populated clinics');

const A: TenantFixture = await seedTenant(h, {
  name: 'Clinic A', slug: 'a',
  gst: { gstin: '27AABCU9603R1ZM', stateCode: '27' }, consultationFee: 500,
});
const B: TenantFixture = await seedTenant(h, {
  name: 'Clinic B', slug: 'b',
  gst: { gstin: '29AABCU9603R1ZP', stateCode: '29' }, consultationFee: 400,
});

/** Runs a complete encounter so every Phase 2 table has rows in this tenant. */
async function populate(t: TenantFixture, label: string) {
  const pat = await registerPatient(h, t, { name: `${label} Patient`, phone: `9${label.charCodeAt(0)}00000001`, allergies: 'penicillin' });
  const visit = await h.asUser(t.billing, (sql) =>
    rpc(sql, 'check_in_patient', '$1, $2, $3', [pat.patientId, 'new', t.doctor.id]),
  );
  const visitId = visit.visit_id as string;
  await h.asUser(t.doctor, (sql) => rpc(sql, 'set_visit_status', '$1, $2', [visitId, 'in_consultation']));

  let rxId = '';
  await h.asUser(t.doctor, async (sql) => {
    await sql(
      `insert into public.clinical_notes (tenant_id, visit_id, author_id, diagnosis)
       values ($1,$2,$3,$4)`,
      [t.tenantId, visitId, t.doctor.id, `${label} confidential diagnosis`],
    );
    const rx = await sql(
      `insert into public.prescriptions (tenant_id, visit_id, doctor_id) values ($1,$2,$3) returning id`,
      [t.tenantId, visitId, t.doctor.id],
    );
    rxId = rx[0].id as string;
    const d = await sql(`select id from public.drugs where brand_name='Dolo 650'`);
    await sql(
      `insert into public.prescription_items (prescription_id, tenant_id, drug_id, drug_name, quantity)
       values ($1,$2,$3,'Dolo 650',10)`,
      [rxId, t.tenantId, d[0].id],
    );
    await rpc(sql, 'issue_prescription', '$1', [rxId]);
  });

  const inv = await h.asUser(t.billing, (sql) => rpc(sql, 'create_invoice_for_visit', '$1', [visitId]));

  return { patientId: pat.patientId, visitId, rxId, invoiceId: inv.invoice_id as string };
}

const dataA = await populate(A, 'A');
const dataB = await populate(B, 'B');
check('both clinics populated end to end', !!dataA.invoiceId && !!dataB.invoiceId);

// Ground truth as owner, so the assertions below are known to be filtering real
// rows rather than querying empty tables.
const counts = await h.asOwner(`
  select (select count(*) from public.patients)           as patients,
         (select count(*) from public.visits)             as visits,
         (select count(*) from public.clinical_notes)     as notes,
         (select count(*) from public.prescriptions)      as rx,
         (select count(*) from public.prescription_items) as items,
         (select count(*) from public.billing_line_items) as billing,
         (select count(*) from public.invoices)           as invoices,
         (select count(*) from public.invoice_tax_lines)  as taxlines`);
const g = counts[0];
checkEqual('ground truth: 2 patients', Number(g.patients), 2);
checkEqual('ground truth: 2 visits', Number(g.visits), 2);
checkEqual('ground truth: 2 notes', Number(g.notes), 2);
checkEqual('ground truth: 2 prescriptions', Number(g.rx), 2);
checkEqual('ground truth: 4 billing lines', Number(g.billing), 4);
checkEqual('ground truth: 2 invoices', Number(g.invoices), 2);
check('ground truth: tax lines exist in both', Number(g.taxlines) >= 4);

/* ========================================================================== */
section('1. Every Phase 2 table — clinic A staff see only clinic A');

for (const role of ['admin', 'doctor', 'billing'] as const) {
  const user = A[role];
  await h.asUser(user, async (sql) => {
    for (const table of PHASE2_TABLES) {
      // clinical_notes is deliberately invisible to billing — asserted separately.
      if (table === 'clinical_notes' && role === 'billing') continue;

      const rows = await sql(`select tenant_id from public.${table}`);
      const foreign = rows.filter((r) => r.tenant_id !== A.tenantId);
      checkEqual(`${role}: no clinic B rows visible in ${table}`, foreign.length, 0);
    }
  });
}

await h.asUser(A.doctor, async (sql) => {
  // Targeted lookups by clinic B's real primary keys must return nothing.
  checkEqual("A doctor querying B's patient by id", (await sql(`select id from public.patients where id=$1`, [dataB.patientId])).length, 0);
  checkEqual("A doctor querying B's visit by id", (await sql(`select id from public.visits where id=$1`, [dataB.visitId])).length, 0);
  checkEqual("A doctor querying B's prescription by id", (await sql(`select id from public.prescriptions where id=$1`, [dataB.rxId])).length, 0);
  checkEqual("A doctor querying B's invoice by id", (await sql(`select id from public.invoices where id=$1`, [dataB.invoiceId])).length, 0);
  checkEqual("A doctor filtering notes by B's tenant_id", (await sql(`select id from public.clinical_notes where tenant_id=$1`, [B.tenantId])).length, 0);

  // The most sensitive read in the system: another clinic's diagnosis text.
  const leak = await sql(`select id from public.clinical_notes where diagnosis like '%confidential%' and tenant_id <> $1`, [A.tenantId]);
  checkEqual("A doctor cannot reach B's clinical notes by content search", leak.length, 0);
});

/* ========================================================================== */
section('2. Role scoping inside a clinic');

// A 'patient'-role login must see nothing on any Phase 2 table this phase.
const patientUserId = await h.signUp({ email: 'portal.user@clinic-a.test', fullName: 'Portal User' });
const patientInvite = await h.asUser(A.admin, (sql) => rpc(sql, 'create_invite', '$1, $2', ['portal.user@clinic-a.test', 'patient']));
await h.asUser({ id: patientUserId, email: 'portal.user@clinic-a.test' }, (sql) =>
  rpc(sql, 'accept_invite', '$1', [patientInvite.token]),
);
const patientUser: SessionUser = { id: patientUserId, email: 'portal.user@clinic-a.test' };

await h.asUser(patientUser, async (sql) => {
  for (const table of PHASE2_TABLES) {
    const rows = await sql(`select 1 from public.${table}`);
    checkEqual(`patient-role login sees 0 rows in ${table}`, rows.length, 0);
  }
  const reg = await rpc(sql, 'register_patient', '$1', ['Self Registered']);
  checkEqual('patient-role login cannot register patients', reg.code, 'NOT_STAFF');
  const ci = await rpc(sql, 'check_in_patient', '$1', [dataA.patientId]);
  checkEqual('patient-role login cannot check anyone in', ci.code, 'NOT_STAFF');
});

// A pending (un-onboarded) user likewise sees nothing.
const pendingId = await h.signUp({ email: 'nobody@nowhere.test' });
await h.asUser({ id: pendingId, email: 'nobody@nowhere.test' }, async (sql) => {
  for (const table of PHASE2_TABLES) {
    checkEqual(`pending user sees 0 rows in ${table}`, (await sql(`select 1 from public.${table}`)).length, 0);
  }
});

// anon has no Phase 2 surface at all.
await h.asAnon(async (sql) => {
  for (const table of PHASE2_TABLES) {
    await checkRejects(`anon cannot read ${table}`, () => sql(`select 1 from public.${table}`), '42501');
  }
  await checkRejects('anon cannot call register_patient', () => sql(`select public.register_patient('X')`), '42501');
  await checkRejects('anon cannot call check_prescription_safety', () => sql(`select public.check_prescription_safety($1,$2)`, [dataA.patientId, ['Mox']]), '42501');
  await checkRejects('anon cannot read the drug reference', () => sql(`select 1 from public.drugs`), '42501');
});

// Data minimisation: billing does not get clinical notes, but doctors do.
await h.asUser(A.billing, async (sql) => {
  checkEqual('billing sees 0 clinical notes (deliberate minimisation)', (await sql(`select id from public.clinical_notes`)).length, 0);
  check('billing CAN see prescriptions (needed to dispense)', (await sql(`select id from public.prescriptions`)).length > 0);
  check('billing CAN see billing lines', (await sql(`select id from public.billing_line_items`)).length > 0);
});
await h.asUser(A.doctor, async (sql) => {
  check('doctor CAN see clinical notes in own tenant', (await sql(`select id from public.clinical_notes`)).length > 0);
});
await h.asUser(A.nurse, async (sql) => {
  check('nurse CAN see clinical notes (continuity of care)', (await sql(`select id from public.clinical_notes`)).length > 0);
});

/* ========================================================================== */
section('3. Write authority — who may do what');

await h.asUser(A.doctor, async (sql) => {
  await checkRejects(
    'doctor cannot hand-write a billing charge',
    () => sql(
      `insert into public.billing_line_items (tenant_id, patient_id, visit_id, source_type, description, unit_amount)
       values ($1,$2,$3,'other','Invented charge',9999)`,
      [A.tenantId, dataA.patientId, dataA.visitId],
    ),
    '42501',
  );
  const inv = await rpc(sql, 'create_invoice_for_visit', '$1', [dataA.visitId]);
  checkEqual('doctor cannot raise an invoice', inv.code, 'NOT_BILLING_STAFF');
});

await h.asUser(A.nurse, async (sql) => {
  await checkRejects(
    'nurse cannot author a clinical note',
    () => sql(
      `insert into public.clinical_notes (tenant_id, visit_id, author_id, note_text)
       values ($1,$2,$3,'nurse wrote this')`,
      [A.tenantId, dataA.visitId, A.nurse.id],
    ),
    '42501',
  );
  await checkRejects(
    'nurse cannot create a prescription',
    () => sql(
      `insert into public.prescriptions (tenant_id, visit_id, doctor_id) values ($1,$2,$3)`,
      [A.tenantId, dataA.visitId, A.nurse.id],
    ),
    '42501',
  );
});

await h.asUser(A.doctor, async (sql) => {
  await checkRejects(
    'a doctor cannot attribute a note to a colleague',
    () => sql(
      `insert into public.clinical_notes (tenant_id, visit_id, author_id, note_text)
       values ($1,$2,$3,'forged')`,
      [A.tenantId, dataA.visitId, A.admin.id],
    ),
    '42501',
  );
});

/* ========================================================================== */
section('4. Ungranted columns — refused outright, not silently ignored');

await h.asUser(A.billing, async (sql) => {
  await checkRejects('cannot move a patient to another clinic', () => sql(`update public.patients set tenant_id=$1 where id=$2`, [B.tenantId, dataA.patientId]), '42501');
  await checkRejects('cannot renumber a patient', () => sql(`update public.patients set patient_number=999 where id=$1`, [dataA.patientId]), '42501');
  await checkRejects('cannot write visits.status directly (bypasses billing trigger validation)', () => sql(`update public.visits set status='done' where id=$1`, [dataA.visitId]), '42501');
  await checkRejects('cannot forge a queue number', () => sql(`update public.visits set queue_number=1 where id=$1`, [dataA.visitId]), '42501');
  await checkRejects('cannot attach a billing line to an arbitrary invoice', () => sql(`update public.billing_line_items set invoice_id=$1 where tenant_id=$2`, [dataA.invoiceId, A.tenantId]), '42501');
  await checkRejects('cannot rewrite invoice subtotal', () => sql(`update public.invoices set subtotal=1 where id=$1`, [dataA.invoiceId]), '42501');
  await checkRejects('cannot rewrite invoice tax_total', () => sql(`update public.invoices set tax_total=0 where id=$1`, [dataA.invoiceId]), '42501');
  await checkRejects('cannot forge is_auto on a manual charge', () => sql(`update public.billing_line_items set is_auto=true where tenant_id=$1`, [A.tenantId]), '42501');
  await checkRejects('cannot insert invoice_tax_lines by hand', () => sql(`insert into public.invoice_tax_lines (invoice_id, tenant_id, tax_category, tax_rate) values ($1,$2,'taxable',5)`, [dataA.invoiceId, A.tenantId]), '42501');
  await checkRejects('cannot insert an invoice by hand', () => sql(`insert into public.invoices (tenant_id, patient_id, visit_id, invoice_number) values ($1,$2,$3,99)`, [A.tenantId, dataA.patientId, dataA.visitId]), '42501');
  await checkRejects('cannot insert a patient by hand (bypasses duplicate check)', () => sql(`insert into public.patients (tenant_id, patient_number, full_name) values ($1,99,'Bypass')`, [A.tenantId]), '42501');
  await checkRejects('cannot insert a visit by hand (bypasses token allocation)', () => sql(`insert into public.visits (tenant_id, patient_id, queue_number) values ($1,$2,99)`, [A.tenantId, dataA.patientId]), '42501');
});

await h.asUser(A.admin, async (sql) => {
  await checkRejects('even an admin cannot raise their own tier', () => sql(`update public.tenants set tier=3 where id=$1`, [A.tenantId]), '42501');
  await checkRejects('nobody can write the drug reference', () => sql(`update public.drugs set mrp=1 where brand_name='Dolo 650'`), '42501');
  await checkRejects('nobody can add an interaction pair', () => sql(`insert into public.drug_interactions (generic_a, generic_b, severity, description) values ('a','b','low','x')`), '42501');
  await checkRejects('prescriptions.status is not directly writable', () => sql(`update public.prescriptions set status='issued' where id=$1`, [dataA.rxId]), '42501');
});

/* ========================================================================== */
section('5. Cross-tenant writes — RLS silently filters, WITH CHECK rejects');

await h.asUser(A.doctor, async (sql) => {
  const upd = await sql(`update public.patients set full_name='Renamed' where id=$1 returning id`, [dataB.patientId]);
  checkEqual("renaming clinic B's patient affects 0 rows", upd.length, 0);

  await checkRejects(
    "cannot write a note into clinic B's tenant",
    () => sql(`insert into public.clinical_notes (tenant_id, visit_id, author_id, note_text) values ($1,$2,$3,'x')`,
      [B.tenantId, dataB.visitId, A.doctor.id]),
    '42501',
  );
  await checkRejects(
    "cannot attach a note to clinic B's visit under A's tenant_id",
    () => sql(`insert into public.clinical_notes (tenant_id, visit_id, author_id, note_text) values ($1,$2,$3,'x')`,
      [A.tenantId, dataB.visitId, A.doctor.id]),
    '23503',   // composite FK: (visit_id, tenant_id) pair does not exist
  );
  // Blocked at 42501, not 23503: the RLS WITH CHECK (which requires the parent
  // prescription to be a draft owned by the caller in the caller's tenant) is
  // evaluated before the composite FK, so the policy rejects it first. Either
  // layer alone would stop it; this documents which one actually does.
  await checkRejects(
    "cannot add an item to clinic B's prescription",
    () => sql(`insert into public.prescription_items (prescription_id, tenant_id, drug_name) values ($1,$2,'X')`,
      [dataB.rxId, A.tenantId]),
    '42501',
  );
});

await h.asUser(A.billing, async (sql) => {
  const cross = await rpc(sql, 'create_invoice_for_visit', '$1', [dataB.visitId]);
  checkEqual("invoicing clinic B's visit -> VISIT_NOT_FOUND", cross.code, 'VISIT_NOT_FOUND');
  const ci = await rpc(sql, 'check_in_patient', '$1', [dataB.patientId]);
  checkEqual("checking in clinic B's patient -> PATIENT_NOT_FOUND", ci.code, 'PATIENT_NOT_FOUND');
  const vs = await rpc(sql, 'set_visit_status', '$1, $2', [dataB.visitId, 'done']);
  checkEqual("advancing clinic B's visit -> VISIT_NOT_FOUND", vs.code, 'VISIT_NOT_FOUND');
});

await h.asUser(A.doctor, async (sql) => {
  const safety = await rpc(sql, 'check_prescription_safety', '$1, $2', [dataB.patientId, ['Mox']]);
  checkEqual("safety check on clinic B's patient -> PATIENT_NOT_FOUND", safety.code, 'PATIENT_NOT_FOUND');
  const pdf = await rpc(sql, 'get_prescription_for_pdf', '$1', [dataB.rxId]);
  checkEqual("PDF payload for clinic B's prescription -> not found", pdf.code, 'PRESCRIPTION_NOT_FOUND');
  const ip = await rpc(sql, 'issue_prescription', '$1', [dataB.rxId]);
  checkEqual("issuing clinic B's prescription -> not found", ip.code, 'PRESCRIPTION_NOT_FOUND');
});
await h.asUser(A.billing, async (sql) => {
  const pdf = await rpc(sql, 'get_invoice_for_pdf', '$1', [dataB.invoiceId]);
  checkEqual("PDF payload for clinic B's invoice -> not found", pdf.code, 'INVOICE_NOT_FOUND');
});

/* ========================================================================== */
section('6. Schema-level guarantees — hold even with RLS out of the picture');

// Run as owner (RLS does not apply) to show these are structural constraints,
// not policy effects. This is the guarantee that survives a future policy bug.
await checkRejects(
  "a visit cannot reference another tenant's patient, even as owner",
  () => h.asOwner(`insert into public.visits (tenant_id, patient_id, queue_number) values ($1,$2,900)`, [A.tenantId, dataB.patientId]),
  '23503',
);
await checkRejects(
  "a prescription cannot reference another tenant's visit, even as owner",
  () => h.asOwner(`insert into public.prescriptions (tenant_id, visit_id, doctor_id) values ($1,$2,$3)`, [A.tenantId, dataB.visitId, A.doctor.id]),
  '23503',
);
await checkRejects(
  "a doctor from another tenant cannot be assigned to a visit, even as owner",
  () => h.asOwner(`update public.visits set doctor_id=$1 where id=$2`, [B.doctor.id, dataA.visitId]),
  '23503',
);
await checkRejects(
  'a taxable line cannot carry a zero rate',
  () => h.asOwner(`insert into public.billing_line_items (tenant_id, patient_id, visit_id, source_type, description, unit_amount, tax_category, tax_rate) values ($1,$2,$3,'other','x',100,'taxable',0)`, [A.tenantId, dataA.patientId, dataA.visitId]),
  '23514',
);
await checkRejects(
  'an exempt line cannot carry a non-zero rate',
  () => h.asOwner(`insert into public.billing_line_items (tenant_id, patient_id, visit_id, source_type, description, unit_amount, tax_category, tax_rate) values ($1,$2,$3,'other','x',100,'exempt',5)`, [A.tenantId, dataA.patientId, dataA.visitId]),
  '23514',
);
await checkRejects(
  'a tenant cannot claim GST registration without a GSTIN',
  () => h.asOwner(`update public.tenants set gst_registered=true, gstin=null, gst_state_code=null where id=$1`, [A.tenantId]),
  '23514',
);
await checkRejects(
  'a non-GST invoice cannot carry tax',
  () => h.asOwner(`update public.invoices set is_gst_invoice=false, tax_total=10 where id=$1`, [dataA.invoiceId]),
  '23514',
);

/* ========================================================================== */
section('NEGATIVE CONTROL — confirm the above depends on RLS');

for (const t of PHASE2_TABLES) {
  await h.asOwner(`alter table public.${t} disable row level security`);
}

const leaked: Record<string, number> = {};
await h.asUser(A.doctor, async (sql) => {
  for (const t of PHASE2_TABLES) {
    leaked[t] = (await sql(`select 1 from public.${t}`)).length;
  }
});

check('with RLS off, A doctor sees BOTH patients', leaked.patients === 2, `saw ${leaked.patients}`);
check('with RLS off, A doctor sees BOTH visits', leaked.visits === 2, `saw ${leaked.visits}`);
check("with RLS off, A doctor sees BOTH clinics' notes", leaked.clinical_notes === 2, `saw ${leaked.clinical_notes}`);
check('with RLS off, A doctor sees BOTH prescriptions', leaked.prescriptions === 2, `saw ${leaked.prescriptions}`);
check('with RLS off, A doctor sees ALL billing lines', leaked.billing_line_items === 4, `saw ${leaked.billing_line_items}`);
check('with RLS off, A doctor sees BOTH invoices', leaked.invoices === 2, `saw ${leaked.invoices}`);
check('with RLS off, A doctor sees ALL tax lines', leaked.invoice_tax_lines >= 4, `saw ${leaked.invoice_tax_lines}`);

for (const t of PHASE2_TABLES) {
  await h.asOwner(`alter table public.${t} enable row level security`);
}

await h.asUser(A.doctor, async (sql) => {
  checkEqual('RLS restored: back to 1 patient', (await sql(`select 1 from public.patients`)).length, 1);
  checkEqual('RLS restored: back to 1 visit', (await sql(`select 1 from public.visits`)).length, 1);
  checkEqual('RLS restored: back to 1 note', (await sql(`select 1 from public.clinical_notes`)).length, 1);
  checkEqual('RLS restored: back to 2 billing lines', (await sql(`select 1 from public.billing_line_items`)).length, 2);
  checkEqual('RLS restored: back to 1 invoice', (await sql(`select 1 from public.invoices`)).length, 1);
});

await h.close();
summary('Phase 2 cross-tenant isolation + role scoping (local / PGlite)');
