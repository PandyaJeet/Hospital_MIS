# Contract: Billing & Invoicing

**Feature:** auto-captured charges, pending-charges view, invoice with GST, payment
**Owner (backend):** Jeet · **Owner (frontend):** Prince
**Phase:** 2 (phases.md) · **Format:** Workflow.md §1
**Backend status:** implemented, tested, and **live on the hosted project**.
**Contract status:** final for Phase 2.

> Two things to internalise before building these screens:
> 1. **Billing staff never enter a normal charge.** Consultation and medicine charges appear automatically. The billing screen is a *review and invoice* screen, not a data-entry screen.
> 2. **Tax is per line, never per invoice.** One OPD bill mixes a GST-exempt consultation with taxable medicine. There is no such quantity as "the invoice's GST rate" — do not compute one.

---

## 1. How charges appear (nobody types them)

Architecture.md §3's "one event, many views", applied to money:

```
doctor marks visit in_consultation
        └── trigger → billing_line_items  (consultation fee, is_auto = true)

doctor issues a prescription
        └── trigger → billing_line_items  (one line per item, is_auto = true)
```

phases.md's Definition of Done is explicit: *"Billing charges auto-appear with zero manual entry by billing staff."* If your UI asks a billing user to add a consultation line, something is wrong.

The fee used is the **treating doctor's** `profiles.consultation_fee`, falling back to `tenants.default_consultation_fee`. A ₹0 fee still produces a visible ₹0 line for billing to price — silently omitting the charge is the revenue leakage this mechanism exists to prevent (PRD §3).

Medicine pricing falls back `prescription_items.unit_price` → `drugs.mrp` → `0`. A zero line means "we do not know this price", not "free" — show it as needing attention.

Both triggers are **idempotent**: bouncing a visit status or re-issuing cannot double-charge.

Manual lines remain possible for anything not yet modelled (`is_auto = false`), billing/admin only.

---

## 2. GST — the part that must be right

### Why per-line

- A **consultation** is a healthcare service by a clinical establishment: **GST-exempt** under Notification 12/2017 (Central Tax – Rate).
- **Dispensed medicines** are a **taxable** supply — most drugs at 5% following the GST Council's September 2025 rationalisation, with a specific list of life-saving drugs fully exempt.

Applying one rate to the invoice total would produce a **wrong** bill, not just an imprecise one: it either taxes an exempt consultation or under-taxes medicine. Both are compliance failures and both vanish once the numbers are summed. So `tax_category` and `tax_rate` live on the line, and the invoice carries a **rate-wise summary** (`invoice_tax_lines`).

### `tax_category` vocabulary

| Value | Rate | Meaning |
|---|---|---|
| `exempt` | 0 | Healthcare service, exempt under Notification 12/2017 |
| `taxable` | > 0 | Attracts GST (medicines, non-clinical supplies) |
| `nil_rated` | 0 | Taxable category at 0% — e.g. an exempted life-saving drug |
| `non_gst` | 0 | The clinic is not GST-registered, so GST does not apply at all |

A database constraint enforces that only `taxable` may carry a non-zero rate, and that `taxable` must carry one. An inconsistent pair is unrepresentable.

### `non_gst` vs `exempt` — both zero, both different

| `tenants.gst_registered` | Consultation | Medicine | Invoice |
|---|---|---|---|
| `true` | `exempt` @ 0% | `taxable` @ drug rate (default 5%), or `nil_rated` @ 0% | **TAX INVOICE** with GSTIN + rate-wise summary |
| `false` | `non_gst` @ 0% | `non_gst` @ 0% | **BILL OF SUPPLY** — no GSTIN, **no tax lines at all**, no tax rows |

A non-registered clinic gets a genuinely different document, not a GST invoice with `0.00` in every tax box — that would misrepresent its registration status. `invoice_tax_lines` is **empty** for such a tenant, which is the signal to render the simpler layout.

### ⚠️ A business decision Jeet must confirm per clinic

`tenants.gst_registered` **defaults to `false`** and cannot be derived from code. Whether a clinic charges GST depends on its registration, which depends on turnover (₹20 lakh threshold generally, ₹10 lakh in some special-category states). A solo doctor below the threshold legitimately issues a non-GST bill.

An **admin** can set `gst_registered`, `gstin`, `gst_state_code` and `default_consultation_fee` on their own tenant (it is their own commercial/compliance fact). A clinic settings screen should expose these — with a clear warning that setting `gst_registered` changes the legal nature of every invoice issued afterwards. The DB refuses `gst_registered = true` without a GSTIN.

Note `tenants.tier` is **not** writable — that is a platform entitlement, unlike GST status.

---

## 3. Table: `billing_line_items`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `tenant_id`, `patient_id`, `visit_id` | `uuid` not null | |
| `invoice_id` | `uuid` **nullable** | **NULL = pending.** Not client-writable |
| `source_type` | `text` not null | `consultation` \| `medicine` \| `lab` \| `procedure` \| `other` |
| `source_id` | `uuid` nullable | the originating visit / prescription item |
| `description` | `text` not null | |
| `quantity` | `numeric` not null | default 1 |
| `unit_amount` | `numeric` not null | default 0 |
| `amount` | `numeric` **generated** | `quantity × unit_amount`, read-only |
| `tax_category` | `text` not null | see §2 |
| `tax_rate` | `numeric` not null | |
| `tax_amount` | `numeric` **generated** | `amount × rate / 100`, read-only |
| `hsn_sac_code` | `text` nullable | required on a GST invoice line |
| `is_auto` | `boolean` not null | `true` = system-captured. Not client-writable |
| `created_by` | `uuid` nullable | |
| `created_at` / `updated_at` | `timestamptz` not null | |

**"Pending charges" is a query, not a status field:**

```ts
await supabase.from('billing_line_items')
  .select('*, patient:patients(patient_number, full_name), visit:visits(queue_number, visit_date)')
  .is('invoice_id', null)
  .order('created_at');
```

### Access

| Operation | Who | Constraint |
|---|---|---|
| `select` | all staff | doctors can see what a patient is charged — transparency, and the row carries a service description, not clinical detail |
| `insert` | billing/admin | manual lines only; `is_auto` cannot be forged |
| `update` | billing/admin | **only while `invoice_id IS NULL`**; `description, quantity, unit_amount, tax_category, tax_rate, hsn_sac_code` |
| `delete` | billing/admin | **only while pending** |

Editing a line already on an invoice would desynchronise the invoice totals from their parts, so the window closes at invoicing. Deleting an auto line *is* allowed while pending — a clinic that does not dispense medicines needs to drop the medicine line.

`amount` and `tax_amount` are generated: send `quantity`, `unit_amount`, `tax_category`, `tax_rate` and read the rest back.

---

## 4. Tables: `invoices` and `invoice_tax_lines`

### `invoices`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `tenant_id`, `patient_id`, `visit_id` | `uuid` not null | one invoice per visit this phase |
| `invoice_number` | `bigint` not null | **per-tenant gapless series** — the number printed on the document |
| `status` | `text` not null | `draft` \| `issued` \| `paid` \| `cancelled` |
| `is_gst_invoice` | `boolean` not null | snapshot of the tenant's posture at creation |
| `gstin_snapshot`, `gst_state_code_snapshot` | `text` nullable | snapshotted — see below |
| `subtotal` | `numeric` not null | sum of line `amount`. Not client-writable |
| `tax_total` | `numeric` not null | **sum of `invoice_tax_lines`.** Not client-writable |
| `grand_total` | `numeric` **generated** | `subtotal + tax_total` |
| `amount_paid` | `numeric` not null | |
| `payment_mode` | `text` nullable | `cash` \| `upi` \| `card` \| `insurance` \| `other` |
| `notes` | `text` nullable | |
| `issued_at` | `timestamptz` nullable | stamped server-side |
| `created_at` / `updated_at` | `timestamptz` not null | |

**Why GSTIN is snapshotted:** an invoice is a tax document. A clinic that registers later, or fixes a typo in its GSTIN, must not retroactively rewrite invoices already handed to patients. The tenant row is current state; the invoice is history.

### `invoice_tax_lines` — the rate-wise summary

| Column | Notes |
|---|---|
| `invoice_id`, `tenant_id` | |
| `tax_category` | |
| `tax_rate` | |
| `taxable_amount` | sum of line `amount` in this bucket |
| `tax_amount` | sum of line `tax_amount` in this bucket |

One row per `(category, rate)` present. A typical GST OPD bill has two: `exempt @ 0%` and `taxable @ 5%`. **Empty for a non-GST tenant** — that emptiness is what makes the document a bill of supply.

Read-only to clients; written by `create_invoice_for_visit()`.

---

## 5. `create_invoice_for_visit()`

```ts
const { data, error } = await supabase.rpc('create_invoice_for_visit', {
  p_visit_id: visitId,
});
// success: {
//   ok: true, invoice_id, invoice_number, is_gst_invoice,
//   line_count, subtotal, tax_total, grand_total, status: 'draft'
// }
```

Billing/admin only. Pulls every pending line for the visit onto a new invoice, computes tax per `(category, rate)`, allocates the next invoice number under a lock (a tax series must not have gaps), and snapshots the GST details.

Failure codes: `NOT_AUTHENTICATED`, `NOT_BILLING_STAFF`, `VISIT_NOT_FOUND`, `INVOICE_ALREADY_EXISTS` (includes the existing `invoice_id`), `NO_PENDING_CHARGES`.

> Numeric values inside the envelope arrive as **JSON numbers** (`13.5`), while direct column reads arrive as scale-preserving **strings** (`"13.50"`). Format for display; don't compare the two representations.

---

## 6. Payment and status

Status/payment are a plain update — no side effects to guard, so no RPC:

```ts
await supabase.from('invoices')
  .update({ status: 'paid', amount_paid: 783.5, payment_mode: 'upi' })
  .eq('id', invoiceId);
```

Writable: `status`, `amount_paid`, `payment_mode`, `notes`. Monetary totals are not.

A trigger enforces ordering and stamps `issued_at`:

```
draft → issued | paid | cancelled
issued → paid | cancelled
paid → cancelled
cancelled → (terminal)
```

Illegal moves (`paid → draft`, anything out of `cancelled`) raise `23514`. A **draft** invoice may be deleted, which releases its lines back to pending; an **issued** one is cancelled, never deleted — its number is spent.

---

## 7. Reading invoices

```ts
// full invoice for the screen
await supabase.from('invoices')
  .select(`
    id, invoice_number, status, is_gst_invoice, gstin_snapshot,
    subtotal, tax_total, grand_total, amount_paid, payment_mode, issued_at,
    patient:patients ( patient_number, full_name, phone ),
    lines:billing_line_items ( description, source_type, hsn_sac_code, quantity,
                               unit_amount, amount, tax_category, tax_rate, tax_amount ),
    tax_summary:invoice_tax_lines ( tax_category, tax_rate, taxable_amount, tax_amount )
  `)
  .eq('id', invoiceId).single();

// today's invoices — end-of-day list
await supabase.from('invoices')
  .select('id, invoice_number, status, grand_total, amount_paid, created_at')
  .gte('created_at', startOfDayIso)
  .order('invoice_number', { ascending: false });
```

Render `tax_summary` only when `is_gst_invoice` is true; it is empty otherwise.

---

## 8. PDF

```ts
const { data: { session } } = await supabase.auth.getSession();
const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-invoice-pdf`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
  body: JSON.stringify({ invoice_id: invoiceId }),
});
if (!res.ok) { const { error } = await res.json(); /* { code, message } */ }
else { const blob = await res.blob(); }
```

The function renders **TAX INVOICE** or **BILL OF SUPPLY** from `is_gst_invoice`, and does not compute tax — it formats the summary SQL already produced.

**Not deployed yet** (needs a Supabase personal access token, unavailable on Jeet's machine). The payload is verified by both suites; the rendering is not. Interim: call `get_invoice_for_pdf()` directly and render client-side.

```ts
const { data } = await supabase.rpc('get_invoice_for_pdf', { p_invoice_id: invoiceId });
// { ok, invoice, clinic, patient, visit, lines[], tax_summary[] }
```

---

## 9. Error codes

| Code | Channel | When | Suggested copy |
|---|---|---|---|
| `NOT_BILLING_STAFF` | `data` | A doctor/nurse tried to invoice | "Only billing staff or an admin can raise an invoice." |
| `NO_PENDING_CHARGES` | `data` | Nothing uninvoiced for the visit | "There are no pending charges for this visit." |
| `INVOICE_ALREADY_EXISTS` | `data` | Live invoice already exists. Includes `invoice_id` | "An invoice already exists for this visit" → link to it |
| `VISIT_NOT_FOUND` | `data` | Unknown, or another clinic's | "That visit does not exist at this clinic." |
| `NOT_AUTHENTICATED` | `data` | No session | "Your session has expired." |
| `42501` | `error.code` | Editing an invoiced line; writing `subtotal`/`tax_total`/`invoice_id`/`is_auto`; a doctor inserting a charge; writing `tier` | "You don't have permission" → log; UI bug |
| `23514` | `error.code` | Illegal status transition, or an inconsistent category/rate pair | "That invoice cannot change status" |
| `23503` | `error.code` | Cross-tenant reference | Generic → log |
| `INVOICE_NOT_FOUND` | `data` | `get_invoice_for_pdf()` given an unknown id, or another clinic's | "That invoice could not be found." |
| `PDF_GENERATION_FAILED` | HTTP body | Edge Function failure | "Could not generate the invoice." |
| `METHOD_NOT_ALLOWED` | HTTP body | Non-POST to `generate-invoice-pdf` | Not user-facing → log; client bug |
| `NOT_FOUND` | HTTP body | The Edge Function could not resolve the invoice (its own gate, distinct from `INVOICE_NOT_FOUND` above) | "That invoice could not be found." |

> `INVOICE_NOT_FOUND`, `METHOD_NOT_ALLOWED` and `NOT_FOUND` were added to this table in
> Phase 4 after the error-code drift audit (`npm run audit:codes`) found all three
> returned by code but documented nowhere. They are not new behaviour — they have been
> reachable since Phase 2.

---

## 10. TypeScript for the mock layer

```ts
export type TaxCategory = 'exempt' | 'taxable' | 'nil_rated' | 'non_gst';
export type SourceType = 'consultation' | 'medicine' | 'lab' | 'procedure' | 'other';
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'cancelled';
export type PaymentMode = 'cash' | 'upi' | 'card' | 'insurance' | 'other';

export interface BillingLineItem {
  id: string;
  tenant_id: string; patient_id: string; visit_id: string;
  invoice_id: string | null;
  source_type: SourceType;
  source_id: string | null;
  description: string;
  quantity: number;
  unit_amount: number;
  amount: number;        // generated
  tax_category: TaxCategory;
  tax_rate: number;
  tax_amount: number;    // generated
  hsn_sac_code: string | null;
  is_auto: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** amount / tax_amount / is_auto are server-owned. */
export type NewManualLineItem = Pick<
  BillingLineItem,
  'tenant_id' | 'patient_id' | 'visit_id' | 'source_type' | 'description'
> & Partial<Pick<BillingLineItem, 'quantity' | 'unit_amount' | 'tax_category' | 'tax_rate' | 'hsn_sac_code' | 'source_id'>>;

export interface InvoiceTaxLine {
  tax_category: TaxCategory;
  tax_rate: number;
  taxable_amount: number;
  tax_amount: number;
}

export interface Invoice {
  id: string;
  tenant_id: string; patient_id: string; visit_id: string;
  invoice_number: number;
  status: InvoiceStatus;
  is_gst_invoice: boolean;
  gstin_snapshot: string | null;
  gst_state_code_snapshot: string | null;
  subtotal: number;
  tax_total: number;
  grand_total: number;   // generated
  amount_paid: number;
  payment_mode: PaymentMode | null;
  notes: string | null;
  issued_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CreateInvoiceResult =
  | { ok: true; invoice_id: string; invoice_number: number; is_gst_invoice: boolean;
      line_count: number; subtotal: number; tax_total: number; grand_total: number; status: 'draft' }
  | { ok: false; code: 'INVOICE_ALREADY_EXISTS'; message: string; invoice_id: string }
  | { ok: false; code: 'NO_PENDING_CHARGES' | 'NOT_BILLING_STAFF' | 'VISIT_NOT_FOUND' | 'NOT_AUTHENTICATED'; message: string };

/** Clinic billing settings, on the tenants row. */
export interface TenantBillingSettings {
  gst_registered: boolean;
  gstin: string | null;
  gst_state_code: string | null;
  default_consultation_fee: number;
}
```

---

## 11. Deliberately not in Phase 2

| Not available | Why |
|---|---|
| End-of-day reconciliation view | PRD §6.3 wants it; the aggregation queries are Phase 4 (phases.md) |
| Insurance / TPA claim formats | Phase 4 |
| Multi-visit / package invoices | `invoices.visit_id` is NOT NULL this phase; consolidating an IPD stay is Phase 3 |
| Partial payments as a ledger | `amount_paid` is a single figure, not a payment history table |
| Lab / procedure charges | `source_type` already accepts them so Phase 3 adds rows, not a constraint change |
| HSN/SAC on seeded drugs | The column exists and prints, but the starter drug list does not populate it. A GST invoice for medicines really wants it — flagged for Jeet |
| Credit notes / refunds | Cancel-and-reissue only |

---

## 12. Verification status

| Suite | Command | Result |
|---|---|---|
| Local OPD flow (incl. all GST math) | `npm run test:opd` | **131/131** |
| Local isolation + role scoping | `npm run test:isolation2` | **122/122** |
| Remote | `npm run test:opd:remote` | **102/102** |

Covered here specifically: consultation line auto-appears at the **doctor's** fee rather than the tenant default; status bounce does not double-charge; draft prescription bills nothing while issuing bills every item; MRP-based auto-pricing; an exempt life-saving drug lands as `nil_rated` rather than being taxed at 5%; an unpriced item yields a visible ₹0 line; invoice `subtotal`/`tax_total`/`grand_total` correct with tax from the medicine line only; **three distinct tax buckets** on a mixed bill and `tax_total` equal to their sum; GSTIN snapshotted; second invoice per visit refused; no charges left pending after invoicing; a **non-GST tenant produces zero tax lines** and no GSTIN; a doctor cannot invoice or hand-write a charge; `subtotal` and `invoice_id` unwritable; `paid → draft` rejected; every table cross-tenant isolated with the negative control confirming RLS is what does it.
