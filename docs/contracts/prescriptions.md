# Contract: Prescriptions & Safety Checking

**Feature:** compose a prescription, check it for interactions/allergies, issue it
**Owner (backend):** Jeet · **Owner (frontend):** Prince
**Phase:** 2 (phases.md) · **Format:** Workflow.md §1
**Backend status:** implemented, tested, and **live on the hosted project**.
**Contract status:** final for Phase 2.

> **The safety-check return shape is the most consequential thing in this file.** It returns a **severity per finding**, never a boolean, because the product requirement — silent by default, hard interrupt only for high severity (PRD §6.1, rules.md §6.4) — is a UI decision that only you can make. If the backend returned true/false it would have made that decision for you. Read §4 before building the prescribe screen.

---

## 1. Lifecycle: draft → issued

A prescription is **composed as a draft** and then **issued**. This matters to the UI:

```
create prescription (draft)
        │
        ├── add / edit / remove items freely       ← nothing billed yet
        ├── run check_prescription_safety(...)     ← as often as you like
        │
        └── issue_prescription()
                 │
                 ├── items become immutable
                 └── medicine charges auto-appear in billing
```

Why not bill as items are added? Because a doctor composing a prescription adds a line, mistypes, removes it, adds another. If each insert had already created a charge, removing the item would either orphan a charge or require deleting a billing row that may already sit on an invoice — the patient gets billed for a drug they were never given. `issued` is the real chargeable event.

Practical consequence: **an unissued prescription is not final.** Show draft state clearly, and the PDF marks itself "DRAFT — not valid for dispensing" until issued.

---

## 2. Tables

### `prescriptions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` not null | |
| `visit_id` | `uuid` not null | FK → `visits` |
| `doctor_id` | `uuid` not null | the prescriber; must equal `auth.uid()` on insert |
| `status` | `text` not null | `draft` \| `issued` \| `cancelled`. **Not directly writable** |
| `notes` | `text` nullable | prescriber's remarks — clinical, so nullable |
| `issued_at` | `timestamptz` nullable | set by `issue_prescription()` |
| `created_at` / `updated_at` | `timestamptz` not null | |

### `prescription_items`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `prescription_id` | `uuid` not null | |
| `tenant_id` | `uuid` not null | |
| `drug_id` | `uuid` **nullable** | link to the reference list. **NULL is normal** — see §3 |
| `drug_name` | `text` **not null** | what was prescribed |
| `generic_name` | `text` nullable | |
| `is_generic` | `boolean` not null | default `false` — the generic/brand toggle |
| `dose` | `text` nullable | clinical |
| `frequency` | `text` nullable | clinical |
| `duration` | `text` nullable | clinical |
| `instructions` | `text` nullable | clinical |
| `quantity` | `numeric` nullable | drives the billing line |
| `unit_price` | `numeric` nullable | overrides the reference MRP |
| `created_at` | `timestamptz` not null | |

**rules.md §1.7 is applied here too.** The rule names clinical notes, but its purpose — no mandatory field may block a doctor-facing save — applies equally to prescribing. So `dose`, `frequency`, `duration` and `instructions` are all nullable: a half-specified item saves. `drug_name` is the one required content column, because an item naming no drug is not incomplete, it is meaningless.

### Access

| Table | select | insert | update | delete |
|---|---|---|---|---|
| `prescriptions` | **all staff** | doctor/admin, as self | prescriber, `notes` only, draft only | – |
| `prescription_items` | **all staff** | prescriber, draft only | prescriber, draft only | prescriber, draft only |

**Why billing can read prescriptions but not clinical notes.** In an Indian clinic the pharmacy and billing counter are usually the same desk, and dispensing and pricing a medicine require seeing what was prescribed. Diagnosis does not have that justification, so `clinical_notes` excludes billing (see `opd-queue.md` §6). Different answers, same minimisation principle.

`status` and `issued_at` are not grantable — use `issue_prescription()`.

---

## 3. The drug reference — `drugs` and `drug_interactions`

> **This is a STARTER dataset, not a certified drug database.** ~50 common Indian OPD drugs and ~25 well-known interaction pairs. It has **not been clinically reviewed**, it is not exhaustive, and **absence of a finding is not evidence of safety**. Surface the disclaimer the safety check returns.

Both tables are **read-only** to every client and carry **no `tenant_id`** — they are shared reference data, not tenant business data. Nobody, including an admin, can write them; maintenance is a platform-owner action. (Documented exception to rules.md §4.1, reasoned in the migration header.)

`drugs` columns worth using:

| Column | Notes |
|---|---|
| `brand_name`, `generic_name` | Indian prescribing is brand-led; search both |
| `brand_name_normalized`, `generic_name_normalized` | generated, lowercased — filter on these |
| `form`, `strength`, `drug_class` | display |
| `allergy_tags` | `text[]`, e.g. `{penicillin,beta_lactam}` |
| `interaction_generics` | `text[]` — constituent molecules for combinations |
| `mrp` | indicative price; drives auto-pricing in billing |
| `gst_rate` | per-drug override; `NULL` means the default medicine rate |
| `is_otc` | |

**Autosuggest:**

```ts
await supabase.from('drugs')
  .select('id, brand_name, generic_name, form, strength, drug_class, mrp, is_otc')
  .or(`brand_name_normalized.like.${term.toLowerCase()}%,generic_name_normalized.like.${term.toLowerCase()}%`)
  .order('brand_name')
  .limit(20);
```

**`drug_id` may be NULL, and that is expected.** A doctor must never be blocked from prescribing something the starter list does not contain. Let them type a free-text `drug_name` with no `drug_id`. That is precisely what makes the safety check report `partial` rather than implying it checked something it could not.

---

## 4. `check_prescription_safety()` — read this carefully

```ts
const { data, error } = await supabase.rpc('check_prescription_safety', {
  p_patient_id: patientId,
  p_drug_names: ['Dolo 650', 'Mox', 'Warf 5'],   // brand OR generic names
});
```

Success shape:

```ts
{
  ok: true,
  status: 'complete' | 'partial',
  findings: Array<{
    finding_type: 'interaction' | 'allergy';
    severity: 'low' | 'medium' | 'high';
    drug_a: string;
    drug_b: string | null;          // null for an allergy finding
    description: string;
    match_basis: string;            // e.g. 'allergy_tag:penicillin', 'interaction_pair'
  }>,
  warnings: Array<{ code: 'UNKNOWN_DRUGS' | 'NO_ALLERGIES_RECORDED'; message: string }>,
  unknown_drugs: string[],
  checked_drug_count: number,
  highest_severity: 'low' | 'medium' | 'high' | null,
  requires_acknowledgement: boolean,
  allergies_recorded: boolean,
  reference_disclaimer: string,
}
```

### Three states, not two

| State | Looks like | What the UI must do |
|---|---|---|
| Checked, clean | `ok: true, status: 'complete', findings: []` | Nothing. Stay silent |
| Checked, found something | `ok: true, findings: [...]` | Depends on severity — see below |
| **Could not fully check** | `ok: true, status: 'partial'` | Show **"Interaction check unavailable for some drugs — verify manually"** |
| **Failed** | `ok: false, code: 'SAFETY_CHECK_UNAVAILABLE'` | Show **"Interaction check unavailable — verify manually"** (rules.md §3.4) |

An empty `findings` array is ambiguous on its own, which is why `status` exists. **Never treat `findings.length === 0` as "safe"** without also checking `status`.

Two things cause `partial`:

- **`UNKNOWN_DRUGS`** — a prescribed drug is not in the starter reference list, so nothing could be evaluated for it. `unknown_drugs` lists them.
- **`NO_ALLERGIES_RECORDED`** — the patient's allergy field is empty. That means *nobody asked*, not that the patient has no allergies. Reporting `complete` here would be the system asserting something it does not know.

### Rendering by severity (PRD §6.1, rules.md §6.4)

```ts
if (!result.ok)                        → banner: "verify manually", allow proceeding
else if (result.highest_severity === 'high')  → BLOCKING modal, explicit acknowledgement
else if (result.status === 'partial')         → visible non-blocking banner
else if (result.findings.length > 0)          → inline badges only (silent by default)
else                                          → nothing
```

`requires_acknowledgement` is a convenience that is `true` when severity is high **or** status is partial. It is always a real boolean, never null. It does not replace reading `findings` — you still need them to render *what* was found.

Allergy findings are always `high`: prescribing into a documented allergy is the archetypal hard-interrupt case.

### Known limitation — allergy matching is textual

`patients.allergies` is free text this phase, matched against `drugs.allergy_tags` and constituent molecule names. It **can false-positive** — a note reading "no penicillin allergy" will match the penicillin tag. That is the deliberately safe direction: a spurious warning is an annoyance, a missed allergy is a patient-safety event. Every finding carries `match_basis` so you can show *what* matched and let the clinician judge. Structured allergy capture is the real fix and is a later phase.

Combination products work correctly: Combiflam (ibuprofen + paracetamol) matches the ibuprofen–warfarin interaction, because `drugs.interaction_generics` lists constituents.

Failure codes: `NOT_AUTHENTICATED`, `NOT_STAFF`, `VALIDATION_ERROR` (empty drug list), `PATIENT_NOT_FOUND`, `SAFETY_CHECK_UNAVAILABLE`.

---

## 5. `issue_prescription()`

```ts
const { data, error } = await supabase.rpc('issue_prescription', {
  p_prescription_id: prescriptionId,
});
// success: { ok: true, prescription_id, status: 'issued', item_count }
```

Prescriber-only. Refuses an empty prescription (`PRESCRIPTION_EMPTY`) — a prescription with no medicines is not a document worth issuing. Refuses a second issue (`PRESCRIPTION_ALREADY_ISSUED`), which makes an accidental double-tap safe.

On success the medicine billing lines appear immediately. See `billing.md`.

Failure codes: `NOT_AUTHENTICATED`, `PRESCRIPTION_NOT_FOUND`, `NOT_PRESCRIBER`, `PRESCRIPTION_ALREADY_ISSUED`, `PRESCRIPTION_CANCELLED`, `PRESCRIPTION_EMPTY`.

---

## 6. Composing — plain table operations

```ts
// 1. start a draft
const { data: rx } = await supabase.from('prescriptions')
  .insert({ tenant_id: tenantId, visit_id: visitId, doctor_id: userId })
  .select('id, status').single();

// 2. add an item (only drug_name is required)
await supabase.from('prescription_items').insert({
  prescription_id: rx.id,
  tenant_id: tenantId,
  drug_id: selectedDrug?.id ?? null,     // null when free-typed
  drug_name: 'Dolo 650',
  generic_name: 'Paracetamol',
  is_generic: false,
  dose: '650 mg', frequency: 'TDS', duration: '3 days',
  quantity: 9,
});

// 3. edit / remove while draft
await supabase.from('prescription_items').update({ frequency: 'BD' }).eq('id', itemId);
await supabase.from('prescription_items').delete().eq('id', itemId);

// 4. read back
await supabase.from('prescriptions')
  .select('id, status, notes, issued_at, items:prescription_items(*)')
  .eq('visit_id', visitId)
  .order('created_at', { ascending: false });
```

After issuing, item writes fail with `42501` — the policies only permit them while `draft`. Disable the editing UI on `status === 'issued'` rather than letting the user discover it.

---

## 7. PDF

```ts
const { data: { session } } = await supabase.auth.getSession();

const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-prescription-pdf`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token}`,
  },
  body: JSON.stringify({ prescription_id: prescriptionId }),
});

if (!res.ok) {
  const { error } = await res.json();   // { code, message }
  // show error.message; log error.code
} else {
  const blob = await res.blob();        // application/pdf
}
```

The function forwards your JWT, so RLS applies exactly as in the browser — another clinic's id returns `404 NOT_FOUND`, not a document.

**Not deployed yet.** Deploying needs a Supabase personal access token, which is not available on Jeet's machine. The *data* the PDF renders is verified (`get_prescription_for_pdf()` is covered by both suites); the rendering is not. Until it is deployed this call will 404 at the gateway — keep the print button behind a flag, or call `get_prescription_for_pdf()` directly and render client-side in the meantime:

```ts
const { data } = await supabase.rpc('get_prescription_for_pdf', { p_prescription_id: id });
// { ok, prescription, clinic, doctor, patient, visit, items[] }
```

---

## 8. Error codes

| Code | Channel | When | Suggested copy |
|---|---|---|---|
| `SAFETY_CHECK_UNAVAILABLE` | `data` | The check itself failed | **"Interaction check unavailable — verify manually."** Must be visible; do not proceed silently |
| `PATIENT_NOT_FOUND` | `data` | Unknown patient, or another clinic's | "That patient is not registered at this clinic." |
| `VALIDATION_ERROR` | `data` | Empty drug list | "Add at least one drug to check." |
| `PRESCRIPTION_EMPTY` | `data` | Issuing with no items | "Add at least one medicine before issuing." |
| `PRESCRIPTION_ALREADY_ISSUED` | `data` | Second issue | "This prescription has already been issued." |
| `PRESCRIPTION_CANCELLED` | `data` | Issuing a cancelled one | "This prescription was cancelled." |
| `PRESCRIPTION_NOT_FOUND` | `data` | Unknown id, or another clinic's | "That prescription could not be found." |
| `NOT_PRESCRIBER` | `data` | Not the authoring doctor | "Only the prescribing doctor can issue this." |
| `NOT_STAFF` / `NOT_AUTHENTICATED` | `data` | Role / session | as elsewhere |
| `42501` | `error.code` | Editing an issued prescription; nurse creating one; writing `status`; writing `drugs` | "You don't have permission" → log; UI bug |
| `23503` | `error.code` | Item pointed at another tenant's prescription | Generic → log |
| `PDF_GENERATION_FAILED` | HTTP body | Edge Function failure | "Could not generate the prescription." |
| `METHOD_NOT_ALLOWED` | HTTP body | Non-POST to `generate-prescription-pdf` | Not user-facing → log; client bug |
| `NOT_FOUND` | HTTP body | The Edge Function could not resolve the prescription | "That prescription could not be found." |

> The two HTTP-body codes above were added in Phase 4 after the error-code drift audit
> (`npm run audit:codes`) found them returned by the Edge Function but documented
> nowhere. Not new behaviour — reachable since Phase 2.

---

## 9. TypeScript for the mock layer

```ts
export type PrescriptionStatus = 'draft' | 'issued' | 'cancelled';
export type Severity = 'low' | 'medium' | 'high';

export interface Prescription {
  id: string; tenant_id: string; visit_id: string; doctor_id: string;
  status: PrescriptionStatus; notes: string | null;
  issued_at: string | null; created_at: string; updated_at: string;
}

export interface PrescriptionItem {
  id: string; prescription_id: string; tenant_id: string;
  drug_id: string | null;
  drug_name: string;
  generic_name: string | null;
  is_generic: boolean;
  dose: string | null;
  frequency: string | null;
  duration: string | null;
  instructions: string | null;
  quantity: number | null;
  unit_price: number | null;
  created_at: string;
}

/** drug_name is the only required field — deliberate (rules.md §1.7). */
export type NewPrescriptionItem =
  Pick<PrescriptionItem, 'prescription_id' | 'tenant_id' | 'drug_name'> &
  Partial<Omit<PrescriptionItem, 'id' | 'prescription_id' | 'tenant_id' | 'drug_name' | 'created_at'>>;

export interface Drug {
  id: string; brand_name: string; generic_name: string;
  form: string | null; strength: string | null; drug_class: string | null;
  allergy_tags: string[]; interaction_generics: string[];
  mrp: number | null; gst_rate: number | null; is_otc: boolean; notes: string | null;
}

export interface SafetyFinding {
  finding_type: 'interaction' | 'allergy';
  severity: Severity;
  drug_a: string;
  drug_b: string | null;
  description: string;
  match_basis: string;
}

export type SafetyCheckResult =
  | {
      ok: true;
      status: 'complete' | 'partial';
      findings: SafetyFinding[];
      warnings: Array<{ code: 'UNKNOWN_DRUGS' | 'NO_ALLERGIES_RECORDED'; message: string }>;
      unknown_drugs: string[];
      checked_drug_count: number;
      highest_severity: Severity | null;
      requires_acknowledgement: boolean;
      allergies_recorded: boolean;
      reference_disclaimer: string;
    }
  | { ok: false; code: 'SAFETY_CHECK_UNAVAILABLE'; message: string; sqlstate?: string }
  | { ok: false; code: 'PATIENT_NOT_FOUND' | 'NOT_STAFF' | 'NOT_AUTHENTICATED'; message: string }
  | { ok: false; code: 'VALIDATION_ERROR'; message: string; fields?: string[] };

export type IssuePrescriptionResult =
  | { ok: true; prescription_id: string; status: 'issued'; item_count: number }
  | { ok: false;
      code: 'PRESCRIPTION_EMPTY' | 'PRESCRIPTION_ALREADY_ISSUED' | 'PRESCRIPTION_CANCELLED'
          | 'PRESCRIPTION_NOT_FOUND' | 'NOT_PRESCRIBER' | 'NOT_AUTHENTICATED';
      message: string };
```

---

## 10. Deliberately not in Phase 2

| Not available | Why |
|---|---|
| A clinically reviewed drug database | Starter dataset only. Needs review or a licensed source before real prescribing — tracked in `Memory.md` §6 |
| Structured allergy capture | Free text; textual matching, with `match_basis` for transparency |
| Order sets ("one-tap condition-specific") | PRD §6.1 wants them; no data model yet |
| Dose defaults per drug/age/weight | `drugs` has no dosing table |
| Cancelling an issued prescription | `cancelled` exists in the enum but no RPC transitions into it yet |
| Devanagari in the PDF | pdf-lib standard fonts cannot encode it; unrepresentable characters degrade to `?` rather than failing. Needs an embedded Unicode font — `Memory.md` §6 |

---

## 11. Verification status

| Suite | Command | Result |
|---|---|---|
| Local OPD flow | `npm run test:opd` | **131/131** |
| Local isolation + role scoping | `npm run test:isolation2` | **122/122** |
| Remote | `npm run test:opd:remote` | **102/102** |

Covered here specifically: a bare item (drug name only) saves; draft bills nothing; issue creates one line per item; re-issue refused; empty prescription refused; allergy → `high`; aspirin+warfarin → `high` in **both** drug orders; Combiflam matches the ibuprofen pair; amlodipine+atorvastatin → `low`; clean check on a patient *with* allergies → `complete` and `requires_acknowledgement: false`; unknown drug → `partial` + `UNKNOWN_DRUGS` + acknowledgement demanded despite zero findings; empty allergy history → `partial` + `NO_ALLERGIES_RECORDED`; unknown patient → `ok: false` (distinct from a clean check); cross-tenant patient/prescription both refused.

---

## 12. PHASE 6 ADDITION — `cancel_prescription()`

§1 described the lifecycle as `draft → issued` and noted `cancelled` existed in the
enum. It was unreachable: `status` is in no client grant and no RPC wrote it. So a
doctor who issued a prescription in error had no way to retract it — the read side had
been ready since Phase 3 (`record_medication_administration()` returns
`PRESCRIPTION_CANCELLED`), but nothing could produce that state.

```ts
const { data } = await supabase.rpc('cancel_prescription', {
  p_prescription_id: rxId,
  p_reason: 'Allergy noticed after issue',   // optional
});
```

Success:

```jsonc
{
  "ok": true,
  "prescription_id": "…",
  "status": "cancelled",
  "changed": true,
  "was_issued": true,
  "charges_withdrawn": 1,   // pending medicine lines removed
  "charges_invoiced": 0,    // ⚠️ see below
  "reason": "Allergy noticed after issue"
}
```

Cancelling an already-cancelled prescription is an **idempotent no-op success**
(`changed: false`), so a double-tapped button is harmless.

### 12.1 Who may cancel — wider than who may issue

`issue_prescription()` is prescriber-only. Cancelling is **the prescriber OR any
admin**, and the asymmetry is deliberate: an un-retracted wrong prescription is a drug
that may be administered, and if the only person who can retract it has gone home,
"wait for the prescriber" is not an acceptable answer on a ward at 2am. Stopping is
safer to over-permit than starting.

A nurse cannot cancel (`NOT_CLINICAL_STAFF`) — it is a prescribing decision — but they
are already protected, because `record_medication_administration()` refuses a
cancelled item.

### 12.2 ⚠️ What happens to medicine charges already captured

Issuing fires the medicine billing trigger, so by the time a prescription can be
cancelled the charges usually exist. The rule follows the one Phase 3 already set for
a cancelled lab order:

- **Still pending (`invoice_id is null`) → deleted.** Reported as
  `charges_withdrawn`. The patient is not billed for medicine explicitly never
  dispensed.
- **Already on an invoice → left exactly as it is.** Reported as
  `charges_invoiced`. An issued tax document is not silently rewritten.

**`charges_invoiced > 0` is a signal you must surface.** It means a charge for
undispensed medicine is sitting on an issued invoice and needs a credit note — which
this system does not model. Suggested copy: *"This prescription was cancelled, but ₹X
of medicine is already on invoice #N. Raise a credit note or adjust the payment."*

### 12.3 Side effects on the prescription row

- `status` → `cancelled`
- `issued_at` → **NULL** (the `prescriptions_issued_has_timestamp` constraint pairs
  them, and would reject a cancelled row still claiming an issue time)
- `notes` → the reason is appended as `Cancelled: <reason>`, preserving anything
  already there. There is no separate `cancellation_reason` column: `notes` is already
  the prescriber's free-text field on this table.

### 12.4 Error codes

| Code | Meaning |
|---|---|
| `NOT_AUTHENTICATED` | No session |
| `NOT_CLINICAL_STAFF` | Caller is not a doctor or an admin |
| `PRESCRIPTION_NOT_FOUND` | Unknown id, or another clinic's — same answer either way |
| `NOT_PRESCRIBER` | A doctor trying to cancel a colleague's prescription (an admin may) |

All four already existed elsewhere in this contract set, so `npm run audit:codes` is
unchanged at 67/67.
