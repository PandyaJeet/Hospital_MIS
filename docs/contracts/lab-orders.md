# Contract: Lab Orders, Results & Critical-Value Alerts

**Phase 3.** Ordering diagnostics, recording results, and the critical-value alert.

> **File naming:** `prompts/prompt-phase4.md` refers to this document as
> `lab-orders-and-results.md`. It is **`lab-orders.md`**, per `prompt-phase3.md`.
> There is one file. Do not create a second.

Three headlines:

1. **`is_critical: false` on its own tells you nothing.** You must read
   `requires_manual_review` too. §4 — this is the most important section here.
2. **Ordering a test fans out to three places automatically.** §3.
3. **The alert Edge Function is written but not deployed.** The in-app alert does not
   depend on it. §7.

Verified against the hosted project. See §12.

---

## 1. Architecture.md §3 is the design

This module implements the worked example in `Architecture.md` §3 rather than
reinventing it:

```
Doctor orders a lab test
  -> INSERT into lab_orders (tenant_id, patient_id, ordered_by, status='pending')
     |-- Realtime on lab_orders  -> lab tech's queue updates
     |-- Realtime on lab_orders  -> nurse's task board shows "sample collection due"
     |-- DB trigger              -> billing_line_items (source_type='lab')
     `-- Edge Function           -> notify patient        [NOT BUILT — see §11]
```

Which is why **ordering is a plain INSERT, not an RPC**: `Architecture.md` describes an
insert, and there is nothing to decide at insert time — no numbering to allocate, no
duplicate to detect, no transition to validate. The three downstream effects are
triggers, so they fire whichever way the row arrives.

---

## 2. Table: `lab_orders`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `tenant_id` | `uuid` | |
| `visit_id` | `uuid` | Composite FK → `visits`. Required (billing needs it) |
| `patient_id` | `uuid` | Composite FK → `patients`. Named by `Architecture.md` §3 |
| `ordered_by` | `uuid` | **Must equal the caller** |
| `test_name` | `text` | **Free text** — see below |
| `test_name_normalized` | `text` | Generated: `lower(trim(test_name))`. What the threshold lookup matches |
| `priority` | `text` | `routine` \| `urgent` \| `stat` |
| `status` | `text` | `pending` \| `sample_collected` \| `in_progress` \| `completed` \| `cancelled`. **Not client-writable** |
| `ordered_at` | `timestamptz` | |
| `notes` | `text` null | Clinical context for the lab ("fasting sample") |
| `cancellation_reason` | `text` null | Set by the RPC |
| `created_at` / `updated_at` | | |

**`test_name` is free text on purpose**, matching `prescription_items.drug_name`: the
reference set (§4) is not exhaustive and a doctor must never be blocked from ordering a
test it does not contain.

### Client access

| Operation | Who | Notes |
|---|---|---|
| `select` | **any staff, including billing** | See the split below |
| `insert` | **doctor, admin only** | `ordered_by` must be the caller |
| `update` (`notes` only) | the orderer, or an admin | |
| `delete` | **nobody** | Cancel via the RPC |

Ordering a diagnostic test is a clinical decision, so a nurse gets `42501` on insert —
the same authorship rule as prescriptions.

### ⚠️ The order/result read split

| Table | Billing can read? |
|---|---|
| `lab_orders` | **Yes** |
| `lab_results` | **No** |

Same line Phase 2 drew between `prescriptions` (billing reads it — pharmacy and
billing counter are one desk) and `clinical_notes` (billing does not). A lab **order**
is a chargeable service, and in an Indian clinic payment is very often collected before
the sample is drawn, so the billing counter genuinely needs to see that a test was
ordered. A lab **result** is a clinical finding — "sodium 118", or a reactive serology
report, is not something the front desk needs to raise an invoice.

---

## 3. What ordering a test does automatically

One insert, three effects. You do not trigger any of them.

### 3a. A pending billing charge

`billing_line_items` gets a row with `source_type='lab'` (reserved back in Phase 2 —
see `billing.md`), `source_id` = the order id, `is_auto=true`, description
`"Lab test — {test_name}"`.

**`unit_amount` is 0.** There is no lab price list in the schema, and the choice was
between a visible ₹0 line that billing prices, or no line at all. Phase 2 settled the
same question for a drug with no MRP on file: a zero-amount line is honest and gets
completed, while silently omitting the charge is the revenue leakage the whole
auto-capture mechanism exists to prevent. **Make the ₹0 obvious and editable in the
billing UI.**

Tax reuses `resolve_tax_treatment()`: a diagnostic test is a healthcare service, so
`exempt` for a GST-registered clinic and `non_gst` for one that is not. Lab lines
cannot drift from consultation lines because the logic is shared, not duplicated.

Idempotent via `billing_one_line_per_source_idx` — never double-charged.

### 3b. A nurse "sample collection due" card

`tasks` gets `task_type='sample_collection_due'`, `is_auto=true`,
`title = "Collect sample — {test}"` plus `" (URGENT)"`/`" (STAT)"` when not routine.

`due_at` is `now()` for every priority — there is no scheduler, so inventing "routine
means due in 4 hours" would assert a turnaround policy no clinic has stated. Priority
goes on the label. See `nurse-tasks.md` §2.

### 3c. A Realtime event

`lab_orders` is in the `supabase_realtime` publication, so the lab queue and the task
board both update without polling.

---

## 4. ⚠️⚠️ Table: `lab_results` — the critical flag is TWO fields

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `lab_order_id` | `uuid` | Composite FK → `lab_orders` |
| `tenant_id` | `uuid` | |
| `result_value` | `text` | **Text** — `'Reactive'`, `'Trace'`, `'No growth'`, `'<0.01'` are all real |
| `result_numeric` | `numeric` null | Server-derived numeric interpretation, when one exists |
| `unit` | `text` null | |
| `reference_range` | `text` null | The lab's own printed range, **for display only** |
| `is_critical` | `boolean not null` | Server-derived |
| `critical_check_status` | `text not null` | `evaluated` \| `no_reference` \| `unparseable_value` \| `unit_mismatch` \| `evaluation_failed` |
| `requires_manual_review` | `boolean not null` | **Generated**: `critical_check_status <> 'evaluated'` |
| `critical_direction` | `text` null | `low` \| `high` |
| `critical_low_used` / `critical_high_used` | `numeric` null | Thresholds snapshotted at flag time |
| `reported_by` / `reported_at` | | |
| `acknowledged_by` / `acknowledged_at` | | **Not client-writable** — use the RPC |
| `notes` | `text` null | |

### Read this before rendering anything

A single `is_critical boolean` cannot express the state that matters most: **"we could
not tell."** If a result arrives for a test with no thresholds on file,
`is_critical = false` would be a lie by omission — indistinguishable from a value that
*was* checked and found normal (`rules.md` §3.4).

A nullable boolean was considered and rejected: Phase 2 already learned that lesson
when `check_prescription_safety()` shipped a `NULL requires_acknowledgement`, and the
conclusion recorded then was that a safety-critical boolean must never be three-valued.

So there are **two non-nullable positive signals**:

| `is_critical` | `requires_manual_review` | Meaning | UI |
|---|---|---|---|
| `true` | `false` | Checked, and dangerously abnormal | **Red alert. Interrupt.** |
| `false` | `true` | **Could not evaluate** | "Not evaluated — verify against the lab's own range" |
| `false` | `false` | Checked, and not critical | **The only reassuring combination** |

**A UI that reads only `is_critical` will render every unevaluable result as
reassuring.** That is the failure this shape exists to prevent.

### Why a check might not complete

| `critical_check_status` | Cause |
|---|---|
| `evaluated` | A reference row matched, the unit was compatible, the value parsed |
| `no_reference` | No thresholds on file for this test name. **Not "normal"** |
| `unparseable_value` | Not a number (`'Reactive'`, `'No growth'`). Perfectly valid as a result; simply not comparable |
| `unit_mismatch` | A reference matched but the reported unit is incompatible. Comparing anyway would be worse than not comparing |
| `evaluation_failed` | An internal fault in the check. Reported louder, not quieter |

Two CHECK constraints make the pair coherent regardless of what writes the row:
`is_critical` can only be true when `critical_check_status = 'evaluated'`, and a raised
flag must state a `critical_direction`.

### Client access

| Operation | Who |
|---|---|
| `select` | admin, doctor, nurse (**not billing**) |
| `insert` / `update` / `delete` | **nobody — `42501`** |

No client INSERT: a client that could insert here could write `is_critical = false`
onto a critical potassium.

---

## 5. Table: `lab_critical_ranges` (shared reference)

> **⚠️ STARTER SET. NOT CLINICALLY REVIEWED. NOT EXHAUSTIVE. ADULT RANGES ONLY.**
> **PAEDIATRIC AND NEONATAL LIMITS DIFFER MATERIALLY** — a bilirubin of 15 mg/dL means
> something entirely different in a three-day-old than in an adult. Age-stratified
> ranges are a known gap. Surface the disclaimer the RPC returns.

14 widely-published adult critical limits: potassium, sodium, random glucose,
haemoglobin, platelets, TLC, calcium, creatinine, INR, total bilirubin, magnesium,
arterial pH, pCO2, pO2.

Deliberately **omitted**: troponin (cut-offs are assay-specific, so one number here
would be the table asserting something it cannot know — better reported as
`no_reference` than confidently wrong) and neonatal bilirubin.

**Read-only to every client**, including admins — no INSERT/UPDATE/DELETE grant and no
policy. Like `drugs`, it carries **no `tenant_id`**: a critical potassium threshold does
not vary by clinic, and per-tenant copies would let two clinics silently disagree about
what counts as life-threatening.

Useful columns for you: `test_name`, `aliases text[]`, `unit`, `unit_aliases text[]`,
`critical_low`, `critical_high`, `normal_low`, `normal_high`, `source_note`.

**Prefill `unit` from this table at result entry.** A missing unit is *assumed* to be
the reference unit, which is a pragmatic assumption (refusing to evaluate every result
with a blank unit box would mean almost nothing got checked) but not one you want
load-bearing. A unit that is present and *incompatible* is refused outright as
`unit_mismatch`.

`normal_low`/`normal_high` are for display beside the result. They do **not** drive the
critical decision — "outside normal" and "critical" are different questions, and
conflating them turns every mildly abnormal result into an alarm, which is how alert
fatigue starts.

Interchangeable units are stated **per analyte** in `unit_aliases`, not by a global
rule: mEq/L and mmol/L are identical for a monovalent ion like potassium and **not**
for a divalent one like calcium.

---

## 6. RPCs

### `evaluate_lab_critical()` — check before saving

```ts
const { data } = await supabase.rpc('evaluate_lab_critical', {
  p_test_name: 'Serum Potassium',
  p_value: '6.9',
  p_unit: 'mmol/L',
});
```

Callable by any staff member, side-effect free. Use it to show the alert **as the tech
types**, before the row is saved. Returns `status`, `is_critical`, `direction`,
`test_code`, `value_numeric`, `comparator`, `reference_unit`, `critical_low`,
`critical_high`, `normal_low`, `normal_high`, `message`.

A value **at** a limit is critical (inclusive): published limits read "notify if
K+ >= 6.2", and an exclusive test would let a result sitting exactly on the limit pass
unremarked. Censored values (`'<0.01'`, `'>1000'`) are parsed, with the comparator
returned.

### `record_lab_result()`

```ts
const { data } = await supabase.rpc('record_lab_result', {
  p_lab_order_id: orderId,
  p_result_value: '6.9',
  p_unit: 'mmol/L',
  p_reference_range: '3.5 - 5.1 mmol/L',
  p_notes: null,
});
```

Records the result, advances the order to `completed`, closes the pending
sample-collection card, and **returns the criticality decision to the person entering
it**:

```jsonc
{
  "ok": true,
  "lab_result_id": "…", "lab_order_id": "…", "test_name": "Serum Potassium",
  "visit_id": "…", "lab_order_status": "completed", "tasks_closed": 1,

  "is_critical": true,
  "critical_check_status": "evaluated",
  "requires_manual_review": false,
  "critical_direction": "high",
  "value_numeric": 6.9,
  "critical_low": 2.8,
  "critical_high": 6.2,
  "requires_acknowledgement": true,
  "reference_disclaimer": "Starter reference set, adult ranges only, …"
}
```

`requires_acknowledgement` is `is_critical || requires_manual_review` — true for a
critical result **and** for one that could not be evaluated. Same convenience field
`check_prescription_safety()` returns, computed the same way. Both inputs are NOT NULL
columns, so unlike the Phase 2 near-miss this can never ship a null.

**A critical value must be impossible to save without seeing that it is critical.** The
asynchronous alert is for everyone *not* looking at this screen; this envelope is for
the one person who is, and it works with nothing deployed.

Who may record: admin, doctor, nurse. **There is no `lab_tech` role** in `profiles` —
`Architecture.md` §3 talks about a lab tech's queue view but the role does not exist.
In a clinic of this size the nurse does sample handling and result entry. Flagged for
Phase 4.

| Code | Meaning |
|---|---|
| `LAB_ORDER_NOT_FOUND` | Unknown or another clinic's |
| `LAB_ORDER_CANCELLED` | Cannot record against a cancelled order |
| `VALIDATION_ERROR` | Blank `p_result_value`; carries `fields` |
| `NOT_CLINICAL_STAFF` / `NOT_AUTHENTICATED` | |

### `set_lab_order_status()`

```ts
await supabase.rpc('set_lab_order_status', {
  p_lab_order_id: orderId, p_status: 'sample_collected', p_reason: null,
});
```

Transitions: `pending → sample_collected | cancelled`;
`sample_collected → in_progress | completed | cancelled`;
`in_progress → completed | cancelled`. `completed` and `cancelled` are terminal.

Two side effects worth knowing:

- **`sample_collected` closes the nurse's collection card** (`tasks_closed` in the
  response). The nurse does not tick a second thing.
- **`cancelled` withdraws the pending charge.** A cancelled test must not appear on a
  bill. If the charge is already on an invoice it is left alone — an issued tax document
  cannot be silently rewritten — and `billing_line_invoiced: true` tells you a credit
  must be raised deliberately.

```jsonc
{ "ok": true, "status": "cancelled", "changed": true,
  "tasks_closed": 1, "pending_charges_removed": 1, "billing_line_invoiced": false }
```

| Code | Meaning |
|---|---|
| `INVALID_STATUS_TRANSITION` | Carries `from` and `to` |
| `LAB_ORDER_NOT_FOUND` | |
| `VALIDATION_ERROR` | Unknown status |
| `NOT_CLINICAL_STAFF` / `NOT_AUTHENTICATED` | |

### `acknowledge_critical_result()`

```ts
await supabase.rpc('acknowledge_critical_result', {
  p_lab_result_id: id, p_note: 'Doctor informed',
});
```

This is what makes `phases.md`'s "visible alerts, not passive queue entries" verifiable
rather than aspirational: an unacknowledged critical result is an outstanding
obligation with a name attached once someone clears it.

Clinical roles only — **billing cannot clear a clinical alert** (`NOT_CLINICAL_STAFF`).
Idempotent (`changed: false` on a second call). A result that raised no alert returns
`NOT_ALERTABLE`, so a UI bug cannot mark everything seen.

### `get_critical_lab_alert_payload()`

Returns the assembled alert for one result — test, value, unit, direction, thresholds,
ward/bed, plus a precomputed `severity` (`critical` \| `unevaluated`) and `headline`.
Use it for a detail panel. `ALERT_NOT_FOUND` covers unknown id, another clinic's, and
"raised no alert" — one answer, so it cannot be used to probe.

**Carries no patient name**, by construction. See §7.

---

## 7. The alert: view + Realtime, and the undeployed function

### View: `critical_lab_alerts`

`security_invoker`. Every result that demands attention — critical **or** unevaluable.
Both, on purpose: "we could not check this" is an outstanding obligation just as much as
"this is dangerously high".

Includes acknowledged rows too; filter for the live banner:

```ts
const { data } = await supabase
  .from('critical_lab_alerts')
  .select('*')
  .is('acknowledged_at', null)
  .order('reported_at', { ascending: false });
```

Columns: `lab_result_id`, `tenant_id`, `lab_order_id`, `test_name`, `priority`,
`visit_id`, `patient_id`, `ordered_by`, `ordered_at`, `patient_number`, `care_setting`,
`ward_name`, `bed_number`, `result_value`, `result_numeric`, `unit`, `is_critical`,
`critical_check_status`, `requires_manual_review`, `critical_direction`,
`critical_low_used`, `critical_high_used`, `reported_at`, `reported_by`,
`acknowledged_at`, `acknowledged_by`.

**No patient name, deliberately.** `patient_number` (the UHID staff already use), ward
and bed identify the patient well enough to act on, and the name is one join away for a
clinician authorised to read it. Keeping names out of this shape by construction matters
because **the same shape feeds the notification dispatcher**, and that path will
eventually terminate at WhatsApp or SMS. A payload that never contains a name cannot
leak one into a third party, whatever a future integration does (`rules.md` §1.3).

### Realtime

`lab_results` is published. A critical value must not depend on anyone having the right
screen open:

```ts
supabase
  .channel('critical-labs')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'lab_results' },
      (p) => { if (p.new.is_critical || p.new.requires_manual_review) raiseModal(p.new); })
  .subscribe();
```

`Design.md` reserves modals for critical alerts — this is that case.

### ⚠️ `notify-critical-lab-value` is NOT deployed

Committed at `supabase/functions/notify-critical-lab-value/index.ts`, never executed.
Deploying needs a personal access token that is not available on Jeet's machine — the
same constraint as the Phase 2 PDF functions.

**The in-app alert does not depend on it.** Everything that decides or describes a
critical value lives in Postgres and is covered by the SQL suites:
`evaluate_lab_critical()`, the flagging trigger, `record_lab_result()`'s envelope, the
`critical_lab_alerts` view, `acknowledge_critical_result()`,
`get_critical_lab_alert_payload()`.

What is missing without it: **out-of-app notification** (push/SMS/WhatsApp) to a
clinician who does not have the app open. That is also blocked on the WhatsApp/SMS
integration, which does not exist. It additionally needs a Database Webhook configured
in the dashboard, which cannot be done from SQL or the CLI here.

---

## 8. Error codes

| Code | Where | Meaning |
|---|---|---|
| `LAB_ORDER_NOT_FOUND` | record_lab_result, set_lab_order_status | Unknown or another clinic's |
| `LAB_ORDER_CANCELLED` | record_lab_result | |
| `INVALID_STATUS_TRANSITION` | set_lab_order_status | Carries `from`, `to` |
| `LAB_RESULT_NOT_FOUND` | acknowledge_critical_result | |
| `NOT_ALERTABLE` | acknowledge_critical_result | Result raised no alert |
| `ALERT_NOT_FOUND` | get_critical_lab_alert_payload | Unknown, another clinic's, or not alertable |
| `VALIDATION_ERROR` | record_lab_result, set_lab_order_status | Carries `fields` |
| `NOT_CLINICAL_STAFF` | all RPCs | Billing or patient role |
| `NOT_AUTHENTICATED` | all RPCs | |
| `42501` | `lab_orders` insert (nurse), `lab_results` insert, `status` writes | Policy or column-grant denial |
| `23503` | `lab_orders` insert with another clinic's visit/patient | Composite FK |

**Not error codes, but the values you must branch on:** `critical_check_status` ∈
{`evaluated`, `no_reference`, `unparseable_value`, `unit_mismatch`,
`evaluation_failed`}.

---

## 9. TypeScript for the mock layer

```ts
export type LabPriority = 'routine' | 'urgent' | 'stat';
export type LabOrderStatus =
  | 'pending' | 'sample_collected' | 'in_progress' | 'completed' | 'cancelled';

/** Only 'evaluated' means the threshold comparison actually happened. */
export type CriticalCheckStatus =
  | 'evaluated' | 'no_reference' | 'unparseable_value' | 'unit_mismatch' | 'evaluation_failed';

export interface LabOrder {
  id: string;
  tenant_id: string;
  visit_id: string;
  patient_id: string;
  ordered_by: string;
  test_name: string;
  test_name_normalized: string;
  priority: LabPriority;
  status: LabOrderStatus;          // not client-writable
  ordered_at: string;
  notes: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Only these are accepted on insert (doctor/admin; ordered_by must be you). */
export type LabOrderInsert =
  Pick<LabOrder, 'tenant_id' | 'visit_id' | 'patient_id' | 'ordered_by' | 'test_name'> &
  Partial<Pick<LabOrder, 'priority' | 'notes'>>;

export interface LabResult {
  id: string;
  lab_order_id: string;
  tenant_id: string;
  result_value: string;            // text: 'Reactive', '<0.01', '6.9'
  result_numeric: number | null;
  unit: string | null;
  reference_range: string | null;

  // READ BOTH. is_critical:false alone does not mean "fine".
  is_critical: boolean;
  critical_check_status: CriticalCheckStatus;
  requires_manual_review: boolean; // generated: status !== 'evaluated'
  critical_direction: 'low' | 'high' | null;
  critical_low_used: number | null;
  critical_high_used: number | null;

  reported_by: string;
  reported_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  notes: string | null;
  created_at: string;
}

export type EvaluateCriticalResult = {
  status: CriticalCheckStatus;
  is_critical: boolean;
  direction: 'low' | 'high' | null;
  test_code?: string;
  test_name?: string;
  value_numeric?: number;
  comparator?: '<' | '>' | '<=' | '>=' | null;
  reference_unit?: string;
  reported_unit?: string;
  critical_low?: number | null;
  critical_high?: number | null;
  normal_low?: number | null;
  normal_high?: number | null;
  message: string;
};

export type RecordLabResultResponse =
  | {
      ok: true;
      lab_result_id: string;
      lab_order_id: string;
      test_name: string;
      visit_id: string;
      lab_order_status: 'completed';
      tasks_closed: number;
      is_critical: boolean;
      critical_check_status: CriticalCheckStatus;
      requires_manual_review: boolean;
      critical_direction: 'low' | 'high' | null;
      value_numeric: number | null;
      critical_low: number | null;
      critical_high: number | null;
      requires_acknowledgement: boolean;   // is_critical || requires_manual_review
      reference_disclaimer: string;
    }
  | { ok: false; code: 'LAB_ORDER_NOT_FOUND' | 'LAB_ORDER_CANCELLED' | 'NOT_CLINICAL_STAFF' | 'NOT_AUTHENTICATED'; message: string }
  | { ok: false; code: 'VALIDATION_ERROR'; message: string; fields?: string[] };

export type SetLabOrderStatusResponse =
  | {
      ok: true;
      lab_order_id: string;
      status: LabOrderStatus;
      changed: boolean;
      tasks_closed?: number;
      pending_charges_removed?: number;
      billing_line_invoiced?: boolean;     // true => raise a credit deliberately
    }
  | { ok: false; code: 'INVALID_STATUS_TRANSITION'; message: string; from: LabOrderStatus; to: LabOrderStatus }
  | { ok: false; code: 'LAB_ORDER_NOT_FOUND' | 'NOT_CLINICAL_STAFF' | 'NOT_AUTHENTICATED'; message: string }
  | { ok: false; code: 'VALIDATION_ERROR'; message: string; fields?: string[] };

export interface CriticalLabAlert {
  lab_result_id: string;
  tenant_id: string;
  lab_order_id: string;
  test_name: string;
  priority: LabPriority;
  visit_id: string;
  patient_id: string;
  ordered_by: string;
  ordered_at: string;
  patient_number: number;          // NO patient name in this view, by design
  care_setting: 'opd' | 'ipd';
  ward_name: string | null;
  bed_number: string | null;
  result_value: string;
  result_numeric: number | null;
  unit: string | null;
  is_critical: boolean;
  critical_check_status: CriticalCheckStatus;
  requires_manual_review: boolean;
  critical_direction: 'low' | 'high' | null;
  critical_low_used: number | null;
  critical_high_used: number | null;
  reported_at: string;
  reported_by: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}
```

---

## 10. Deliberately not in Phase 3

| Not available | Why |
|---|---|
| **Lab price list** | Charges land at ₹0 for billing to price. No test catalogue with per-tenant pricing |
| **Panels / multi-analyte results** | One order = one test, one or more result rows. A CBC means several orders. Structured panels are future work |
| **Age-stratified reference ranges** | Adult only. Neonatal bilirubin especially differs |
| **`lab_tech` role** | Not in the `profiles` role enum, though `Architecture.md` §3 assumes one. Nurses record results |
| Patient notification on result-ready | `Architecture.md` §3's fourth branch. Needs WhatsApp/SMS, which does not exist. Nothing in `lab_orders` blocks it |
| External lab / HL7 integration | The flagging trigger is on the table rather than in the RPC specifically so a future importer is flagged too |
| Amending or voiding a result | No UPDATE/DELETE grant. Needs the Phase 4 audit log |
| Result documents / PDF attachments | No storage integration for lab reports |
| Reflex/derived testing rules | Not modelled |

---

## 11. Verification status

| Suite | Command | Result |
|---|---|---|
| Local flow | `npm run test:phase3` | **252/252** |
| Local isolation + role scoping | `npm run test:isolation3` | **169/169** |
| Remote (real sessions + PostgREST) | `npm run test:phase3:remote` | **203/203** |
| Hosted catalogue | `npm run verify:catalog` | **64/64** |

Covered here specifically, **both locally and against the hosted project**: K+ 6.5
critical high; a value exactly **on** the limit critical (inclusive); the `K+` alias and
the mEq/L unit alias both resolving; **K+ 4.2 evaluated and not critical — the real
"checked, normal"**; an unknown test → `no_reference` **and not** `is_critical`; a
non-numeric result → `unparseable_value`; an incompatible unit → `unit_mismatch`;
**mEq/L refused for calcium** (divalent) while mg/dL is evaluated; a censored `>9.5`
parsed and flagged; ordering raises exactly one `source_type='lab'` line at ₹0 with the
right tax category **for both a GST-registered and a non-registered clinic**, plus
exactly one `sample_collection_due` card labelled with test and priority; a nurse cannot
order; `lab_orders.status` and `lab_results` inserts refused with `42501`;
`sample_collected` closes the card; an illegal transition returns `from`/`to`; a
critical result returns `is_critical` + `requires_acknowledgement` with the threshold
that fired and completes the order; **an unknown test returns `is_critical:false` with
`requires_manual_review:true` and `requires_acknowledgement:true`**; a normal result
returns all three false; `is_critical` cannot be set without an evaluated check **even
as table owner**, and a raised flag must carry a direction; the alert view holds the
critical **and** the unevaluable result but not the normal one, with no name column;
acknowledgement is attributed and idempotent; `NOT_ALERTABLE` for a normal result;
**billing reads orders but not results and cannot clear an alert**; cancelling an order
removes the pending charge and reports `billing_line_invoiced`.
