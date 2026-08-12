# Contract: Tier 3 Placeholders — Insurance Claims, OT Schedule, Blood Bank

**Phase 4. STRUCTURE ONLY.**

> ### ⚠️ These are not working modules.
>
> `phases.md` asks for "Schema/RLS for `insurance_claims`, placeholder schema for
> `ot_schedule`, `blood_bank` (Tier 3, structure only)". That is exactly what this is:
> tables, constraints, RLS and tier gating, so a Tier 3 tenant has somewhere to put
> data and you have a shape to build a form against.
>
> There is **no claims adjudication, no theatre scheduling logic, no cross-match or
> compatibility checking, no inventory workflow, and no RPC for any of them.** Nothing
> validates a status transition on these three tables. Do not read the presence of a
> `status` column as a state machine.

PRD §5.4 places all three at Tier 3: "+ OT scheduling, blood bank, radiology/PACS
integration, insurance/TPA claims, multi-department workflows".

---

## 1. Gating: reads open, writes Tier 3 — and why

| | Tier 1 / Tier 2 | Tier 3 |
|---|---|---|
| `select` | ✅ allowed (returns nothing) | ✅ |
| `insert` / `update` | ❌ `42501` | ✅ by role |
| `delete` | ❌ nobody, any tier | ❌ |

**Reads are deliberately not tier-gated,** the same rule Phase 3 applied to `beds`.

The tempting argument for gating reads: unlike a bed, nothing will ever be *in* an OT
schedule or blood bank for a tenant that never had Tier 3, so gating costs nothing.
That holds for a tenant that never had the tier. It fails for one that **had it and was
downgraded**, which is the case worth designing for:

- **`blood_units` is the strongest example.** A unit reserved for a patient currently in
  theatre must never become invisible because a billing flag changed. Hiding which units
  exist, which are reserved and which have expired is a patient-safety problem, not a
  paywall.
- **`ot_schedule`** holds scheduled operations — live clinical commitments with a time, a
  patient and a surgeon.
- **`insurance_claims`** is only money, but a submitted claim vanishing loses a
  reimbursement the clinic is owed.

One rule across all three, so a reader never has to remember which Tier 3 table behaves
which way.

**No new tier helper was needed.** Phase 3's `tenant_has_tier(integer)` is generic, so
`tenant_has_tier(3)` works as-is.

### Write roles, per table

| Table | Who may write | Why |
|---|---|---|
| `insurance_claims` | admin, **billing** | PRD §6.3 puts claim-format support with Reception/Billing |
| `ot_schedule` | admin, **doctor** | Booking a theatre is a clinical decision |
| `blood_units` | admin, **nurse** | Bank handling is ward work; there is no `lab_tech` role |

---

## 2. `insurance_claims`

> **PRD §8 is a hard boundary:** "Insurance underwriting/claims adjudication
> (submission-format support only)". So `status` covers **submission only** —
> `draft` / `submitted` / `closed`. There is deliberately no `approved`, `rejected`,
> `appealed` or `settled`. Those would imply this system tracks an adjudication
> outcome, which PRD §8 rules out entirely rather than deferring. **Do not build an
> approval workflow UI.** `'closed'` means the clinic stopped working the claim, not
> that a payer decided anything.

| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id` | `uuid` | |
| `patient_id`, `visit_id` | `uuid` | Required. Composite FKs |
| `invoice_id` | `uuid` null | **Nullable** — a claim is often prepared before the final bill, especially for a planned admission needing pre-authorisation |
| `payer_type` | `text` | `cghs` \| `esic` \| `private_tpa` \| `government_scheme` \| `other` |
| `payer_name` | `text` | The specific scheme or TPA. Free text — the list of Indian TPAs is long, changes and varies by region |
| `policy_or_beneficiary_number` | `text` | **⚠️ PII — see below** |
| `claim_amount` | `numeric(12,2)` | |
| `status` | `text` | `draft` \| `submitted` \| `closed` |
| `submitted_at` | `timestamptz` null | Required once status ≠ draft |
| `notes` | `text` null | |
| `created_by`, `created_at`, `updated_at` | | |

**`policy_or_beneficiary_number` is personal data.** It identifies a person and is
exactly what `rules.md` §1.3 covers. It is stored because a submission cannot be
produced without it. **Never log it**, and note it is excluded from the `audit_log`
allow-list.

Constraint worth knowing: `status = 'draft' or submitted_at is not null` — a submitted
claim must say when. Violating it returns `23514`.

---

## 3. `ot_schedule`

| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id` | `uuid` | |
| `patient_id`, `visit_id` | `uuid` | Required |
| `surgeon_id` | `uuid` null | **Nullable** — a slot is often booked before the surgeon is confirmed |
| `procedure_name` | `text` | |
| `ot_room` | `text` null | Free text |
| `scheduled_start` / `scheduled_end` | `timestamptz` | `end > start` enforced |
| `status` | `text` | `scheduled` \| `in_progress` \| `completed` \| `cancelled` — **not validated** |
| `notes`, `created_by`, timestamps | | |

**⚠️ Nothing prevents double-booking a theatre or a surgeon.** There is no overlap
constraint. Two operations can be scheduled in OT-2 at the same time and the database
will accept both. If this module is ever prioritised, an exclusion constraint on a
`tstzrange` per room is the first thing to add.

The one thing enforced structurally is `scheduled_end > scheduled_start` (`23514`),
because that is the error a date picker actually produces.

---

## 4. `blood_units`

> **⚠️ NO COMPATIBILITY OR CROSS-MATCH CHECKING.** Nothing verifies that a unit's blood
> group is compatible with the recipient, and **the presence of
> `reserved_for_visit_id` is NOT evidence that a cross-match was performed.**
> Transfusion safety is a clinical process with its own checks; a placeholder table must
> not imply it has absorbed them. This is the most important caveat on these three
> tables. If you build any UI here, do not present a reservation as a safety
> confirmation.

| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id` | `uuid` | |
| `unit_code` | `text` | Bag/segment number from the label. Unique per clinic |
| `blood_group` | `text` | `A+` `A-` `B+` `B-` `AB+` `AB-` `O+` `O-` |
| `component_type` | `text` | `whole_blood` \| `packed_red_cells` \| `plasma` \| `platelets` \| `cryoprecipitate` |
| `status` | `text` | `available` \| `reserved` \| `issued` \| `discarded` \| `expired` |
| `collected_at` / `expires_at` | `timestamptz` null | `expires_at > collected_at` enforced |
| `reserved_for_visit_id` | `uuid` null | Required when `status = 'reserved'` |
| `issued_to_visit_id`, `issued_at`, `issued_by` | | Required when `status = 'issued'` |
| `notes`, timestamps | | |

Status/link coherence **is** enforced (`23514`): a `reserved` unit must name a visit, and
an `issued` unit must name a recipient and a time. So "issued" always has someone to
point at.

**Nothing expires a unit automatically.** `expired` is a status a human sets — there is
no scheduled job, and this stack has none. Query
`.lt('expires_at', now).eq('status','available')` to find units that *should* be expired
and surface them.

**No reservation history.** One table rather than units + issues, so a
reserve → release → re-reserve cycle keeps no trail. Acceptable for groundwork; recorded
as a limitation.

---

## 5. Error codes

All plain CRUD, so these are Postgres/PostgREST codes:

| Code | When |
|---|---|
| `42501` | Wrong tier, wrong role, or any DELETE. **Also what a Tier 1/2 tenant gets on every write** |
| `23514` | A CHECK failed: bad blood group or component, `end <= start`, expiry before collection, submitted claim with no timestamp, reserved/issued unit with no visit, or an adjudication status like `approved` |
| `23505` | Duplicate `unit_code` within the clinic |
| `23503` | Composite FK — referencing another tenant's patient/visit |

Note that **wrong-tier and wrong-role are indistinguishable** (both `42501`). If you
need to tell the user which, read `tenants.tier` and their own role and decide in the
UI — the database deliberately does not disclose which check failed.

---

## 6. TypeScript for the mock layer

```ts
export type PayerType = 'cghs' | 'esic' | 'private_tpa' | 'government_scheme' | 'other';
/** SUBMISSION states only — PRD §8 rules out adjudication. */
export type ClaimStatus = 'draft' | 'submitted' | 'closed';

export interface InsuranceClaim {
  id: string; tenant_id: string;
  patient_id: string; visit_id: string;
  invoice_id: string | null;
  payer_type: PayerType;
  payer_name: string;
  policy_or_beneficiary_number: string;   // PII — never log
  claim_amount: number;
  status: ClaimStatus;
  submitted_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string; updated_at: string;
}

export type OtStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

export interface OtSlot {
  id: string; tenant_id: string;
  patient_id: string; visit_id: string;
  surgeon_id: string | null;
  procedure_name: string;
  ot_room: string | null;
  scheduled_start: string; scheduled_end: string;
  status: OtStatus;                        // not validated by the DB
  notes: string | null;
  created_by: string | null;
  created_at: string; updated_at: string;
}

export type BloodGroup = 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';
export type BloodComponent =
  | 'whole_blood' | 'packed_red_cells' | 'plasma' | 'platelets' | 'cryoprecipitate';
export type BloodUnitStatus = 'available' | 'reserved' | 'issued' | 'discarded' | 'expired';

export interface BloodUnit {
  id: string; tenant_id: string;
  unit_code: string;
  blood_group: BloodGroup;
  component_type: BloodComponent;
  status: BloodUnitStatus;                 // nothing auto-expires
  collected_at: string | null;
  expires_at: string | null;
  reserved_for_visit_id: string | null;    // NOT a cross-match confirmation
  issued_to_visit_id: string | null;
  issued_at: string | null;
  issued_by: string | null;
  notes: string | null;
  created_at: string; updated_at: string;
}
```

---

## 7. What a real module would need (so nobody mistakes this for one)

| Table | Missing before it is usable |
|---|---|
| `insurance_claims` | Submission-format generators per payer (CGHS/ESIC layouts), document attachment, pre-authorisation tracking, a link from claim to the specific line items claimed |
| `ot_schedule` | Overlap prevention, theatre/staff availability, procedure duration defaults, consent and pre-op checklist linkage, post-op notes |
| `blood_units` | Cross-match records, donor records, component separation lineage, temperature/storage logging, automatic expiry, statutory reporting, and a transfusion reaction record |

None of these is planned. `phases.md` says "without fully building them yet unless
prioritized" — that prioritisation has not happened.

---

## 8. Verification status

| Suite | Command | Result |
|---|---|---|
| Local Phase 4 | `npm run test:phase4` | **211/211** |
| Hosted catalogue | `npm run verify:catalog` | **93/93** |

Covered here specifically: a Tier 1 admin refused on all three tables; a Tier 1 clinic
reads all three without error and finds nothing (reads ungated); Tier 3 billing can file
a claim but not schedule an operation, Tier 3 doctor can schedule but not add blood
stock, Tier 3 nurse can add stock but the doctor cannot; every CHECK exercised —
invalid blood group, unknown component, expiry before collection, duplicate bag number,
`end <= start`, reserved/issued without a visit, submitted claim without a timestamp,
**and `status='approved'` rejected because adjudication states do not exist**; all four
roles can read in a Tier 3 clinic; DELETE refused on all three; cross-tenant reads
return nothing and composite FKs reject cross-tenant references **even as table owner**;
`anon` refused on all three; and a **negative control** disabling RLS to confirm the
Tier 1 clinic's zero-row result genuinely depends on it, then re-enabling and
re-asserting.
