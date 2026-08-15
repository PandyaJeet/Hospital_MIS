/**
 * PHASE 2 OPD FLOW + ISOLATION — against the REAL linked Supabase project.
 *
 *   npm run db:seed:reset     # must run first
 *   npm run test:opd:remote
 *
 * Companion to supabase/tests/local/{opd-flow,phase2-isolation}.test.ts. The local
 * suites prove the SQL and policy logic against a real Postgres engine with no
 * credentials. This one closes what a local harness cannot reach:
 *
 *   - real GoTrue sessions rather than simulated JWT claims
 *   - real PostgREST, so grant/policy denials arrive as the HTTP statuses and
 *     PostgrestError codes Prince actually has to map
 *   - the project's real auth schema and default privileges
 *   - jsonb envelope serialisation over the wire
 *
 * Only the publishable key is used. No service-role key appears in this file: the
 * point is to observe what a genuine end-user session can and cannot do.
 *
 * Data hygiene: every patient created here uses a run-scoped phone number so
 * repeat runs never collide with the soft duplicate check, and the suite is
 * additive — it does not delete seed fixtures. `npm run db:seed:reset` clears
 * accumulated test data.
 */

import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { anonKey, requireEnv, supabaseUrl } from '../../scripts/env.ts';
import { SEED_TENANTS } from '../../scripts/fixtures.ts';
import { check, checkEqual, section, summary } from '../harness/assert.ts';

const URL = supabaseUrl();
const ANON = anonKey();
const PASSWORD = requireEnv('SEED_USER_PASSWORD');

/** Unique per run, so the soft duplicate check never trips on a previous run. */
const RUN = Date.now().toString().slice(-8);

const [gstTenant, plainTenant] = SEED_TENANTS;

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(URL, ANON, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) {
    console.error(`\nCould not sign in as ${email}: ${error.message}`);
    console.error('Run `npm run db:seed:reset` first, and confirm SEED_USER_PASSWORD matches.\n');
    process.exit(1);
  }
  return client;
}

function emailFor(t: typeof gstTenant, role: string): string {
  return t.users.find((u) => u.role === role)!.email;
}

function isDenial(error: PostgrestError | null): boolean {
  if (!error) return false;
  return error.code === '42501' || error.code === 'PGRST301' || /permission denied|row-level security/i.test(error.message);
}

type Envelope = Record<string, unknown>;

async function callRpc(c: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<Envelope> {
  const { data, error } = await c.rpc(fn, args);
  if (error) {
    console.error(`\nRPC ${fn} failed unexpectedly: ${error.code} ${error.message}\n`);
    process.exit(1);
  }
  return data as Envelope;
}

/* ========================================================================== */
section('Setup — real sessions for both seeded clinics');

const aAdmin = await signIn(emailFor(gstTenant, 'admin'));
const aDoctor = await signIn(emailFor(gstTenant, 'doctor'));
const aNurse = await signIn(emailFor(gstTenant, 'nurse'));
const aBilling = await signIn(emailFor(gstTenant, 'billing'));
const bDoctor = await signIn(emailFor(plainTenant, 'doctor'));
const bBilling = await signIn(emailFor(plainTenant, 'billing'));
check('six real sessions established', true);

const { data: aProf } = await aDoctor.from('profiles').select('id, tenant_id').maybeSingle();
const { data: bProf } = await bDoctor.from('profiles').select('id, tenant_id').maybeSingle();
const aTenantId = aProf?.tenant_id as string;
const bTenantId = bProf?.tenant_id as string;
check('both tenants resolved and distinct', !!aTenantId && !!bTenantId && aTenantId !== bTenantId);

const { data: aTenant } = await aAdmin.from('tenants').select('gst_registered, gstin, default_consultation_fee').maybeSingle();
checkEqual('seeded clinic A is GST-registered', aTenant?.gst_registered, true);
checkEqual('...with a GSTIN', aTenant?.gstin, '27AABCU9603R1ZM');
const { data: bTenant } = await bBilling.from('tenants').select('gst_registered').maybeSingle();
checkEqual('seeded clinic B is not GST-registered', bTenant?.gst_registered, false);

/* ========================================================================== */
section('1. Register -> queue -> consult, over real PostgREST');

const reg = await callRpc(aBilling, 'register_patient', {
  p_full_name: `Remote Test ${RUN}`,
  p_phone: `9${RUN}0`,
  p_age_years: 35,
  p_gender: 'male',
  p_allergies: 'penicillin',
});
check('registration succeeds', reg.ok === true, JSON.stringify(reg));
const patientId = reg.patient_id as string;

const dup = await callRpc(aBilling, 'register_patient', {
  p_full_name: 'Duplicate Attempt',
  p_phone: `9${RUN}0`,
});
checkEqual('duplicate phone -> DUPLICATE_PATIENT over the wire', dup.code, 'DUPLICATE_PATIENT');
check('...returns the matching record for the UI prompt', Array.isArray(dup.matches));

const override = await callRpc(aBilling, 'register_patient', {
  p_full_name: 'Child On Same Number',
  p_phone: `9${RUN}0`,
  p_allow_duplicate_phone: true,
});
check('override works over the wire', override.ok === true, JSON.stringify(override));

const ci = await callRpc(aBilling, 'check_in_patient', {
  p_patient_id: patientId,
  p_visit_type: 'new',
  p_doctor_id: aProf?.id,
});
check('check-in succeeds', ci.ok === true, JSON.stringify(ci));
const visitId = ci.visit_id as string;
check('token number allocated', Number(ci.queue_number) > 0);

const reCi = await callRpc(aBilling, 'check_in_patient', { p_patient_id: patientId });
checkEqual('second same-day check-in -> VISIT_ALREADY_OPEN', reCi.code, 'VISIT_ALREADY_OPEN');

const start = await callRpc(aDoctor, 'set_visit_status', { p_visit_id: visitId, p_status: 'in_consultation' });
check('doctor advances the visit', start.ok === true, JSON.stringify(start));

/* ========================================================================== */
section('2. Consultation charge auto-appeared — zero manual entry');

{
  const { data, error } = await aBilling
    .from('billing_line_items')
    .select('source_type, unit_amount, amount, tax_category, tax_rate, tax_amount, is_auto')
    .eq('visit_id', visitId);
  check('billing staff can read the charges', !error, error?.message);
  checkEqual('exactly one consultation line', data?.length, 1);
  checkEqual('...auto-captured', data?.[0]?.is_auto, true);
  checkEqual('...at the seeded tenant fee', Number(data?.[0]?.unit_amount), 500);
  checkEqual('...GST-exempt healthcare service', data?.[0]?.tax_category, 'exempt');
  checkEqual('...with no tax', Number(data?.[0]?.tax_amount), 0);
}

/* ========================================================================== */
section('3. Clinical note — empty note saves over the wire (rules.md §1.7)');

{
  const { data, error } = await aDoctor
    .from('clinical_notes')
    .insert({ tenant_id: aTenantId, visit_id: visitId, author_id: aProf?.id })
    .select('id, note_text, diagnosis');
  check('a completely empty clinical note persists via PostgREST', !error && data?.length === 1, error?.message);
  checkEqual('...note_text null', data?.[0]?.note_text, null);

  const { error: nurseErr } = await aNurse
    .from('clinical_notes')
    .insert({ tenant_id: aTenantId, visit_id: visitId, author_id: aProf?.id, note_text: 'nurse' });
  check('a nurse cannot author a note', nurseErr !== null, 'insert unexpectedly succeeded');

  const { data: billingView } = await aBilling.from('clinical_notes').select('id').eq('visit_id', visitId);
  checkEqual('billing sees 0 clinical notes (data minimisation)', billingView?.length, 0);
}

/* ========================================================================== */
section('4. Safety check — severity and partial status over the wire');

{
  const allergy = await callRpc(aDoctor, 'check_prescription_safety', {
    p_patient_id: patientId,
    p_drug_names: ['Mox'],
  });
  check('check runs', allergy.ok === true, JSON.stringify(allergy));
  const findings = allergy.findings as Array<Record<string, unknown>>;
  check('allergy against recorded penicillin detected', findings.length > 0, JSON.stringify(allergy));
  checkEqual('...severity high, not a boolean', findings[0]?.severity, 'high');
  checkEqual('...acknowledgement demanded', allergy.requires_acknowledgement, true);

  const interaction = await callRpc(aDoctor, 'check_prescription_safety', {
    p_patient_id: patientId,
    p_drug_names: ['Ecosprin', 'Warf 5'],
  });
  const f2 = interaction.findings as Array<Record<string, unknown>>;
  check('aspirin + warfarin flagged high', f2.some((f) => f.severity === 'high' && f.finding_type === 'interaction'), JSON.stringify(interaction));

  const unknown = await callRpc(aDoctor, 'check_prescription_safety', {
    p_patient_id: patientId,
    p_drug_names: ['Definitely Not A Real Drug'],
  });
  checkEqual('unknown drug -> partial, not a clean result', unknown.status, 'partial');
  checkEqual('...still demands acknowledgement', unknown.requires_acknowledgement, true);
  check('...requires_acknowledgement is a real boolean, not null', typeof unknown.requires_acknowledgement === 'boolean');

  const crossTenant = await callRpc(bDoctor, 'check_prescription_safety', {
    p_patient_id: patientId,
    p_drug_names: ['Mox'],
  });
  checkEqual("clinic B cannot run a check on clinic A's patient", crossTenant.code, 'PATIENT_NOT_FOUND');
}

/* ========================================================================== */
section('5. Prescribe and issue — medicine charges auto-appear');

let prescriptionId = '';
{
  const { data: rx, error } = await aDoctor
    .from('prescriptions')
    .insert({ tenant_id: aTenantId, visit_id: visitId, doctor_id: aProf?.id })
    .select('id, status')
    .single();
  check('prescription created as draft', !error && rx?.status === 'draft', error?.message);
  prescriptionId = rx!.id as string;

  const { data: dolo } = await aDoctor.from('drugs').select('id, mrp').eq('brand_name', 'Dolo 650').single();
  const { error: itemErr } = await aDoctor.from('prescription_items').insert({
    prescription_id: prescriptionId,
    tenant_id: aTenantId,
    drug_id: dolo?.id,
    drug_name: 'Dolo 650',
    dose: '650 mg',
    frequency: 'TDS',
    duration: '3 days',
    quantity: 9,
  });
  check('item added to the draft', itemErr === null, itemErr?.message);

  // Nothing billed while draft.
  const { data: preIssue } = await aBilling
    .from('billing_line_items')
    .select('id')
    .eq('visit_id', visitId)
    .eq('source_type', 'medicine');
  checkEqual('draft prescription bills nothing', preIssue?.length, 0);

  const issued = await callRpc(aDoctor, 'issue_prescription', { p_prescription_id: prescriptionId });
  check('issue succeeds', issued.ok === true, JSON.stringify(issued));

  const { data: medLines } = await aBilling
    .from('billing_line_items')
    .select('description, quantity, unit_amount, amount, tax_category, tax_rate, tax_amount')
    .eq('visit_id', visitId)
    .eq('source_type', 'medicine');
  checkEqual('medicine charge auto-appeared on issue', medLines?.length, 1);
  checkEqual('...priced from the reference MRP', Number(medLines?.[0]?.unit_amount), 30);
  checkEqual('...line total = 9 x 30', Number(medLines?.[0]?.amount), 270);
  checkEqual('...taxed as a medicine', medLines?.[0]?.tax_category, 'taxable');
  checkEqual('...at 5%', Number(medLines?.[0]?.tax_rate), 5);
  checkEqual('...tax = 13.50', Number(medLines?.[0]?.tax_amount), 13.5);

  const twice = await callRpc(aDoctor, 'issue_prescription', { p_prescription_id: prescriptionId });
  checkEqual('re-issuing is refused', twice.code, 'PRESCRIPTION_ALREADY_ISSUED');
}

/* ========================================================================== */
section('6. Invoice — per-category tax on a real GST tenant');

let invoiceId = '';
{
  const doctorAttempt = await callRpc(aDoctor, 'create_invoice_for_visit', { p_visit_id: visitId });
  checkEqual('a doctor cannot raise an invoice', doctorAttempt.code, 'NOT_BILLING_STAFF');

  const inv = await callRpc(aBilling, 'create_invoice_for_visit', { p_visit_id: visitId });
  check('billing raises the invoice', inv.ok === true, JSON.stringify(inv));
  invoiceId = inv.invoice_id as string;
  checkEqual('flagged as a GST invoice', inv.is_gst_invoice, true);
  checkEqual('subtotal = 500 + 270', Number(inv.subtotal), 770);
  checkEqual('tax = 5% of the medicine line only', Number(inv.tax_total), 13.5);
  checkEqual('grand total', Number(inv.grand_total), 783.5);

  const { data: taxLines } = await aBilling
    .from('invoice_tax_lines')
    .select('tax_category, tax_rate, taxable_amount, tax_amount')
    .eq('invoice_id', invoiceId);
  checkEqual('two tax buckets, not one blended rate', taxLines?.length, 2);
  const exempt = taxLines?.find((t) => t.tax_category === 'exempt');
  const taxable = taxLines?.find((t) => t.tax_category === 'taxable');
  checkEqual('exempt bucket = consultation', Number(exempt?.taxable_amount), 500);
  checkEqual('...no tax on it', Number(exempt?.tax_amount), 0);
  checkEqual('taxable bucket = medicine', Number(taxable?.taxable_amount), 270);
  checkEqual('...taxed at 5%', Number(taxable?.tax_rate), 5);
  checkEqual('...tax 13.50', Number(taxable?.tax_amount), 13.5);

  const again = await callRpc(aBilling, 'create_invoice_for_visit', { p_visit_id: visitId });
  checkEqual('second invoice for the same visit refused', again.code, 'INVOICE_ALREADY_EXISTS');

  const pdf = await callRpc(aBilling, 'get_invoice_for_pdf', { p_invoice_id: invoiceId });
  check('PDF payload returns', pdf.ok === true);
  checkEqual('...with the rate-wise summary the renderer needs', (pdf.tax_summary as unknown[]).length, 2);
  const rxPdf = await callRpc(aDoctor, 'get_prescription_for_pdf', { p_prescription_id: prescriptionId });
  check('prescription PDF payload returns', rxPdf.ok === true);
  checkEqual('...with the item', (rxPdf.items as unknown[]).length, 1);
}

/* ========================================================================== */
section('7. Non-GST clinic — bill of supply, no tax lines');

{
  const bReg = await callRpc(bBilling, 'register_patient', {
    p_full_name: `Remote B ${RUN}`,
    p_phone: `8${RUN}0`,
  });
  check('clinic B registers a patient', bReg.ok === true, JSON.stringify(bReg));
  const bCi = await callRpc(bBilling, 'check_in_patient', {
    p_patient_id: bReg.patient_id,
    p_doctor_id: bProf?.id,
  });
  const bVisitId = bCi.visit_id as string;
  await callRpc(bDoctor, 'set_visit_status', { p_visit_id: bVisitId, p_status: 'in_consultation' });

  const { data: bLines } = await bBilling
    .from('billing_line_items')
    .select('tax_category, tax_rate, tax_amount')
    .eq('visit_id', bVisitId);
  check('every line is non_gst', (bLines ?? []).every((l) => l.tax_category === 'non_gst'), JSON.stringify(bLines));

  const bInv = await callRpc(bBilling, 'create_invoice_for_visit', { p_visit_id: bVisitId });
  check('non-GST invoice created', bInv.ok === true, JSON.stringify(bInv));
  checkEqual('flagged NOT a GST invoice', bInv.is_gst_invoice, false);
  checkEqual('zero tax', Number(bInv.tax_total), 0);

  const { data: bTaxLines } = await bBilling
    .from('invoice_tax_lines')
    .select('id')
    .eq('invoice_id', bInv.invoice_id as string);
  checkEqual('NO tax lines at all -> renders a bill of supply', bTaxLines?.length, 0);

  const bPdf = await callRpc(bBilling, 'get_invoice_for_pdf', { p_invoice_id: bInv.invoice_id });
  checkEqual('PDF payload tax_summary is empty', (bPdf.tax_summary as unknown[]).length, 0);
}

/* ========================================================================== */
section('8. Cross-tenant isolation on every Phase 2 table');

const PHASE2_TABLES = [
  'patients', 'visits', 'clinical_notes', 'prescriptions',
  'prescription_items', 'billing_line_items', 'invoices', 'invoice_tax_lines',
] as const;

for (const table of PHASE2_TABLES) {
  const { data, error } = await bDoctor.from(table).select('tenant_id');
  check(`clinic B sees no clinic A rows in ${table}`, !error && (data ?? []).every((r) => r.tenant_id === bTenantId), error?.message ?? 'foreign tenant row visible');
}

{
  const { data: byId } = await bDoctor.from('patients').select('id').eq('id', patientId);
  checkEqual("clinic B querying clinic A's patient by id", byId?.length, 0);
  const { data: byVisit } = await bDoctor.from('visits').select('id').eq('id', visitId);
  checkEqual("clinic B querying clinic A's visit by id", byVisit?.length, 0);
  const { data: byInv } = await bBilling.from('invoices').select('id').eq('id', invoiceId);
  checkEqual("clinic B querying clinic A's invoice by id", byInv?.length, 0);
  const { data: byTenant } = await bDoctor.from('clinical_notes').select('id').eq('tenant_id', aTenantId);
  checkEqual("clinic B filtering notes by clinic A's tenant_id", byTenant?.length, 0);

  const crossInv = await callRpc(bBilling, 'create_invoice_for_visit', { p_visit_id: visitId });
  checkEqual("clinic B invoicing clinic A's visit -> VISIT_NOT_FOUND", crossInv.code, 'VISIT_NOT_FOUND');
  const crossStatus = await callRpc(bDoctor, 'set_visit_status', { p_visit_id: visitId, p_status: 'done' });
  checkEqual("clinic B advancing clinic A's visit -> VISIT_NOT_FOUND", crossStatus.code, 'VISIT_NOT_FOUND');
  const crossPdf = await callRpc(bDoctor, 'get_prescription_for_pdf', { p_prescription_id: prescriptionId });
  checkEqual("clinic B fetching clinic A's prescription -> not found", crossPdf.code, 'PRESCRIPTION_NOT_FOUND');
}

/* ========================================================================== */
section('9. anon and privilege escalation over real PostgREST');

{
  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  for (const table of PHASE2_TABLES) {
    const { data, error } = await anon.from(table).select('id');
    check(
      `anon reading ${table} is denied or empty`,
      isDenial(error) || (data?.length ?? 0) === 0,
      error ? `code=${error.code}` : `returned ${data?.length} rows`,
    );
  }
  const { error: rpcErr } = await anon.rpc('register_patient', { p_full_name: 'Hostile' });
  check('anon cannot call register_patient', rpcErr !== null);
}

{
  const { error: tierErr } = await aAdmin.from('tenants').update({ tier: 3 }).eq('id', aTenantId);
  check('even an admin cannot raise their own tier', tierErr !== null, 'update unexpectedly succeeded');

  const { error: statusErr } = await aDoctor.from('visits').update({ status: 'done' }).eq('id', visitId);
  check('visits.status is not directly writable', statusErr !== null, 'update unexpectedly succeeded');

  const { error: subErr } = await aBilling.from('invoices').update({ subtotal: 1 }).eq('id', invoiceId);
  check('invoice subtotal is not writable', subErr !== null, 'update unexpectedly succeeded');

  const { error: chargeErr } = await aDoctor.from('billing_line_items').insert({
    tenant_id: aTenantId, patient_id: patientId, visit_id: visitId,
    source_type: 'other', description: 'Invented', unit_amount: 9999,
  });
  check('a doctor cannot hand-write a charge', chargeErr !== null, 'insert unexpectedly succeeded');

  const { error: drugErr } = await aAdmin.from('drugs').update({ mrp: 1 }).eq('brand_name', 'Dolo 650');
  check('nobody can write the shared drug reference', drugErr !== null, 'update unexpectedly succeeded');

  const { error: rxStatusErr } = await aDoctor.from('prescriptions').update({ status: 'draft' }).eq('id', prescriptionId);
  check('prescriptions.status is not directly writable', rxStatusErr !== null, 'update unexpectedly succeeded');

  const { error: patTenantErr } = await aBilling.from('patients').update({ tenant_id: bTenantId }).eq('id', patientId);
  check('a patient cannot be moved to another clinic', patTenantErr !== null, 'update unexpectedly succeeded');
}

/* ========================================================================== */
section('10. Close the loop');

{
  const done = await callRpc(aDoctor, 'set_visit_status', { p_visit_id: visitId, p_status: 'done' });
  check('visit marked done', done.ok === true, JSON.stringify(done));

  const { data: paid, error } = await aBilling
    .from('invoices')
    .update({ status: 'paid', amount_paid: 783.5, payment_mode: 'upi' })
    .eq('id', invoiceId)
    .select('status, issued_at')
    .single();
  check('billing records payment', !error && paid?.status === 'paid', error?.message);
  check('issued_at stamped by the guard trigger', paid?.issued_at !== null);

  const { error: revertErr } = await aBilling.from('invoices').update({ status: 'draft' }).eq('id', invoiceId);
  check('a paid invoice cannot revert to draft', revertErr !== null, 'update unexpectedly succeeded');
}

for (const c of [aAdmin, aDoctor, aNurse, aBilling, bDoctor, bBilling]) await c.auth.signOut();

summary('Phase 2 OPD flow + isolation (remote / real Supabase project)');
