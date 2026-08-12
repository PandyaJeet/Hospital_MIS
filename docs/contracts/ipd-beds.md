# Contract: IPD Admission & Bed Management

**Phase 3. Tier 2+ feature.** Ward inventory, admission, transfer and discharge.

Three headlines:

1. **This supersedes a prediction in `opd-queue.md` §9.** IPD state did **not** extend
   `visits.status`. It landed in a new `care_setting` column. §1.
2. **Tier 2 is enforced in the database, not just by hiding a button.** `TIER_NOT_ENABLED`
   is a real response you must handle. §3.
3. **Discharge is deliberately *not* tier-gated.** §6.

Verified against the hosted project. See §11.

---

## 1. `visits` extension — and why not `visits.status`

`opd-queue.md` §9 and the Phase 2 migration header both predicted that Phase 3 would
add `admitted`/`discharged` to the named `visits_status_valid` constraint. **It did
not, and `visits_status_valid` is unchanged.**

`visits.status` is one axis: where the patient is in the **consultation** lifecycle
(`queued → in_consultation → done | cancelled`). Admission is orthogonal. A patient
can be admitted *and* mid-consultation on a ward round; a patient can be admitted with
the encounter still open. Folding both into one enum forces impossible-to-name states
("in_consultation AND admitted") into a single value, and every existing query asking
"is this visit still open" would have to learn about IPD states it does not care about.

So Phase 3 adds four columns instead:

| Column | Type | Notes |
|---|---|---|
| `care_setting` | `text not null default 'opd'` | `opd` \| `ipd` |
| `admitted_at` | `timestamptz` null | |
| `discharged_at` | `timestamptz` null | |
| `bed_id` | `uuid` null | Composite FK `(bed_id, tenant_id)` → `beds` |

**None is client-writable.** Attempting any of them returns `42501`, including for an
admin. Admission and discharge go through the RPCs, where the tier gate and the
bed-occupancy invariant live.

### The two queries you actually need

```ts
// Current inpatients
.eq('care_setting', 'ipd').is('discharged_at', null)

// Discharged this admission
.eq('care_setting', 'ipd').not('discharged_at', 'is', null)
```

Backed by a partial index on `(tenant_id, admitted_at desc) where care_setting='ipd'
and discharged_at is null`.

### ⚠️ Discharge does not write `visits.status`

Keeping discharge out of `status` is the entire point of splitting the axes. A
discharged patient's `status` is whatever the consultation lifecycle left it at —
frequently still `queued`, because admission does not advance it either.

**Do not use `visits.status` to decide whether someone is an inpatient.** Use
`care_setting` and `discharged_at`.

### Structural rules enforced by CHECK constraints

| Rule | Meaning |
|---|---|
| `admitted_at is null or care_setting = 'ipd'` | An admission timestamp on an OPD visit is incoherent |
| `discharged_at is null or (admitted_at is not null and discharged_at >= admitted_at)` | Cannot discharge someone never admitted, or before they arrived |
| `bed_id is null or admitted_at is not null` | Cannot occupy a bed without being admitted |

The converse of the last one is *allowed*: **admitted with no bed yet is a real
state** — a patient on a trolley in casualty waiting for a bed to be cleaned. Handle
`bed_id === null` on an admitted patient rather than treating it as an error.

---

## 2. Table: `beds`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `tenant_id` | `uuid` | |
| `ward_name` | `text` | Free text, not a `wards` table |
| `bed_number` | `text` | **Text, not integer** — `'12A'`, `'ICU-3'` are real |
| `status` | `text` | `available` \| `occupied` \| `cleaning` \| `maintenance`. **Not client-writable** |
| `current_visit_id` | `uuid` null | Live occupancy. **Not client-writable** |
| `notes` | `text` null | |
| `created_at` / `updated_at` | | |

Unique on `(tenant_id, ward_name, bed_number)` — a ward cannot have two bed 4s.
Violating it returns `23505`.

### `beds.current_visit_id` vs `visits.bed_id` — not mirrors

They answer different questions, and the asymmetry is deliberate:

| Field | Meaning | On discharge |
|---|---|---|
| `beds.current_visit_id` | Who is in this bed **right now** | **Cleared** |
| `visits.bed_id` | Which bed **this admission used** | **Retained** |

So after discharge the visit still records where the patient stayed, while the bed
reads as unoccupied. Both are written only by the RPCs, in one transaction.

Occupancy is trustworthy because of a CHECK, not because the RPC is careful:

```sql
(status = 'occupied' and current_visit_id is not null)
or (status <> 'occupied' and current_visit_id is null)
```

Plus a partial unique index on `current_visit_id`, so **one visit cannot occupy two
beds**. Both hold even against a service-role write.

### Client access

| Operation | Who | Tier gate |
|---|---|---|
| `select` | any staff, **including billing** | **No** — deliberately ungated |
| `insert` | admin only | **Yes**, Tier 2+ |
| `update` (`ward_name`, `bed_number`, `notes`) | admin only | **Yes**, Tier 2+ |
| `delete` | admin only, and only when not `occupied` | **Yes**, Tier 2+ |

Billing is included in reads because a ward/bed label is operational, not clinical,
and an inpatient bill needs to say which bed.

**Note the denial shapes differ.** An INSERT that fails the policy raises `42501`. An
UPDATE whose policy matches nothing **affects 0 rows and returns success** — standard
RLS semantics. A nurse trying to rename a ward changes nothing but gets no error, so
check the affected-row count rather than relying on an exception.

`status` and `current_visit_id` are not grantable. A client that could write
`current_visit_id` could put two patients in one bed or free an occupied one.

---

## 3. ⚠️ Tier 2 gating — what is gated and what is not

`Architecture.md` §6 marks exactly one table in this phase as tier-restricted:
`beds — IPD bed tracking (Tier 2+)`. `vitals`, `tasks`, `lab_orders` and `lab_results`
carry no tier annotation.

That is the line drawn, and it is a judgement call, documented:

| Gated (Tier 2+) | Not gated |
|---|---|
| Creating/editing bed inventory | Vitals |
| Changing a bed's status | Task board |
| **Admitting a patient to a bed** | Medication administration |
| | Lab orders and results |

**Why nurse work is ungated:** a solo Tier 1 clinic employing a nurse who takes vitals
at the OPD desk before the doctor sees the patient is completely ordinary in India —
that is triage, not inpatient care. Gating vitals behind Tier 2 would break OPD triage
for exactly the pilot-sized clinic Phase 2 was built for, to enforce a boundary the
product does not want. The same holds for a task board ("call this patient back for a
dressing change") and for recording a result from an outside pathology lab. None
requires a ward.

**What genuinely requires Tier 2 is the thing that presupposes a ward: beds.**

Enforced in **RLS *and* in the RPCs**, per `rules.md` §4.3. Policies alone would not
stop an admit against a bed that somehow exists; an RPC check alone would leave a
direct PostgREST insert on `beds` ungated.

The gate has teeth because **`tenants.tier` is not client-writable at all**, not even
by a tenant admin. An admin who could raise their own tier would make every tier check
cosmetic. Tier changes are a platform-owner action.

### Reads are deliberately ungated

`beds` SELECT is tenant-scoped but **not** tier-gated. If a tenant were downgraded
from Tier 2 to Tier 1 while a patient was in a bed, a tier-gated read would make that
patient's bed vanish from every screen while they were still lying in it. The gate is
on the ability to *run* an inpatient service, which is the write path.

### Helpers available to you

`tenant_has_tier(2)` and `current_tenant_tier()` are callable by `authenticated`, so
you can hide UI without guessing. `current_tenant_tier()` returns `null` for a
pending (un-onboarded) user — "not in a clinic" is a different fact from "Tier 1".

---

## 4. `admit_patient_to_bed()`

```ts
const { data } = await supabase.rpc('admit_patient_to_bed', {
  p_visit_id: visitId,
  p_bed_id: bedId,
});
```

Any onboarded staff member may call it (`is_tenant_staff()`), matching
`check_in_patient()`. The *decision* to admit is a doctor's, but the *recording* of it
happens at the front desk in every clinic this product targets.

Sets `care_setting='ipd'`, `admitted_at`, `visits.bed_id`, and marks the bed
`occupied` with `current_visit_id` — all in one transaction. Locks visit then bed, in
that order, so concurrent admissions cannot deadlock.

**It also handles transfers.** Called on an already-admitted visit with a *different*
bed, it frees the old bed to `cleaning` and occupies the new one. Without this, a bed
assigned by mistake could only be undone by discharging the patient, which would
falsify a discharge time on a medical record to fix a typo.

| Response | Meaning |
|---|---|
| `{ ok: true, changed: true, bed_id, ward_name, bed_number, admitted_at }` | Admitted |
| `{ ok: true, changed: true, transferred_from: { bed_id, ward_name, bed_number } }` | Transferred |
| `{ ok: true, changed: false }` | Already in that exact bed — **idempotent success**, a double-tap is harmless |
| `{ ok: false, code: 'TIER_NOT_ENABLED', required_tier: 2, current_tier: 1 }` | Not a Tier 2 clinic |
| `{ ok: false, code: 'BED_NOT_AVAILABLE', bed_status, ward_name, bed_number }` | Occupied, cleaning or maintenance |
| `{ ok: false, code: 'BED_NOT_FOUND' }` | Unknown bed, or another clinic's |
| `{ ok: false, code: 'VISIT_NOT_FOUND' }` | Unknown visit, or another clinic's |
| `{ ok: false, code: 'VISIT_CANCELLED' }` | Cancelled visit |
| `{ ok: false, code: 'ALREADY_DISCHARGED' }` | Start a new visit for a re-admission |
| `{ ok: false, code: 'NOT_STAFF' }` | Patient/pending role |

`TIER_NOT_ENABLED` is checked **before any lookup**, so a Tier 1 caller cannot use the
other codes to probe which bed ids exist. It carries `required_tier` and `current_tier`
so you can say "upgrade to enable inpatient management" — a different message from
"you are not allowed to do this".

`BED_NOT_AVAILABLE` returns `bed_status` so you can distinguish "bed 4 is taken" from
"bed 4 is being cleaned" without a second round trip. It **deliberately does not
reveal who occupies it** — that would be a patient identity leak into an error path.

---

## 5. `set_bed_status()`

```ts
await supabase.rpc('set_bed_status', { p_bed_id: bedId, p_status: 'available' });
```

Housekeeping transitions only: `available` ↔ `cleaning` ↔ `maintenance`.
**Nursing or admin only** — turning a bed over is ward work, not front-desk work.
Tier 2 gated.

| Response | Meaning |
|---|---|
| `{ ok: true, status, changed: true }` | Changed |
| `{ ok: true, status, changed: false }` | Already that status |
| `{ ok: false, code: 'INVALID_BED_STATUS' }` | You passed `'occupied'` |
| `{ ok: false, code: 'BED_OCCUPIED' }` | Discharge or transfer the patient first |
| `{ ok: false, code: 'VALIDATION_ERROR', fields: ['p_status'] }` | Not one of the three |
| `{ ok: false, code: 'TIER_NOT_ENABLED' }` | Not Tier 2 |
| `{ ok: false, code: 'BED_NOT_FOUND' }` | Unknown or another clinic's |
| `{ ok: false, code: 'NOT_WARD_STAFF' }` | Doctor, billing or patient role |

**`'occupied'` is rejected as a target.** Occupancy is an outcome of admitting
somebody, never a state to type in. The CHECK would refuse it anyway, but that
surfaces as an opaque `23514`, and a caller who tried this needs to be told to use
`admit_patient_to_bed()`.

---

## 6. `discharge_patient()` — and why it is *not* tier-gated

```ts
const { data } = await supabase.rpc('discharge_patient', {
  p_visit_id: visitId,
  p_notes: 'Stable, discharged home',
});
```

**Every other bed operation is Tier 2 gated. This one is not.**

If a tenant's tier were lowered while a patient was in a bed, a gated discharge would
leave that patient permanently admitted, the bed permanently occupied, and no in-app
way out. A feature gate exists to stop a clinic *starting* to use a module it has not
paid for, not to trap clinical state it already has. **Unwinding is always allowed.**
This is asserted in the test suite: after a downgrade, new admissions return
`TIER_NOT_ENABLED` while the already-admitted patient can still be discharged.

What it does: stamps `discharged_at`, releases the bed to **`cleaning`** (not
`available` — a bed someone just left needs turning over), clears
`current_visit_id`, **retains `visits.bed_id`**, and **cancels the visit's pending
tasks** with reason `'Patient discharged'`. Completed tasks are left alone; they are
the record of care given.

A board still showing "vitals due" for a patient who went home costs a nurse a walk
to an empty bed, and the card can never legitimately be completed.

| Response | Meaning |
|---|---|
| `{ ok: true, discharged_at, bed_released, pending_tasks_cancelled, notes }` | Discharged |
| `{ ok: false, code: 'NOT_ADMITTED' }` | Not an admission |
| `{ ok: false, code: 'ALREADY_DISCHARGED', discharged_at }` | Already done |
| `{ ok: false, code: 'VISIT_NOT_FOUND' }` | Unknown or another clinic's |
| `{ ok: false, code: 'NOT_STAFF' }` | Patient/pending role |

`p_notes` is echoed back but **not stored** — there is no discharge-summary field this
phase. See §9.

---

## 7. The ward board query

```ts
const { data } = await supabase
  .from('beds')
  .select('id, ward_name, bed_number, status, current_visit_id, notes')
  .order('ward_name')
  .order('bed_number');
```

Backed by indexes on `(tenant_id, ward_name, bed_number)` and `(tenant_id, status)`.

For occupancy with patient detail, use `rounds_overview` (see
`vitals-and-rounds.md` §4) — it already carries `ward_name` and `bed_number` joined to
the patient, so you do not need to resolve `current_visit_id` yourself.

---

## 8. Error codes

| Code | RPC | Meaning |
|---|---|---|
| `TIER_NOT_ENABLED` | admit, set_bed_status | Not a Tier 2 clinic. Carries `required_tier`, `current_tier` |
| `BED_NOT_AVAILABLE` | admit | Carries `bed_status`, `ward_name`, `bed_number` |
| `BED_NOT_FOUND` | admit, set_bed_status | Unknown or another clinic's |
| `BED_OCCUPIED` | set_bed_status | Discharge or transfer first |
| `INVALID_BED_STATUS` | set_bed_status | `'occupied'` passed as a target |
| `VISIT_NOT_FOUND` | admit, discharge | Unknown or another clinic's |
| `VISIT_CANCELLED` | admit | |
| `ALREADY_DISCHARGED` | admit, discharge | |
| `NOT_ADMITTED` | discharge | |
| `NOT_STAFF` | admit, discharge | |
| `NOT_WARD_STAFF` | set_bed_status | Nursing/admin only |
| `VALIDATION_ERROR` | set_bed_status | Carries `fields` |
| `NOT_AUTHENTICATED` | all | |
| `23505` | `beds` insert | Duplicate `(ward_name, bed_number)` |
| `42501` | `beds` insert, `visits` update | Policy or column-grant denial |

---

## 9. TypeScript for the mock layer

```ts
export type BedStatus = 'available' | 'occupied' | 'cleaning' | 'maintenance';
export type CareSetting = 'opd' | 'ipd';

export interface Bed {
  id: string;
  tenant_id: string;
  ward_name: string;
  bed_number: string;              // text: '12A', 'ICU-3'
  status: BedStatus;
  current_visit_id: string | null; // live occupancy; cleared on discharge
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Only these three are accepted on insert (admin + Tier 2). */
export type BedInsert = Pick<Bed, 'tenant_id' | 'ward_name' | 'bed_number'> &
  Partial<Pick<Bed, 'notes'>>;

/** The Phase 3 additions to `visits`. None is client-writable. */
export interface VisitIpdFields {
  care_setting: CareSetting;
  admitted_at: string | null;
  discharged_at: string | null;
  bed_id: string | null;           // retained after discharge
}

export type AdmitResult =
  | {
      ok: true;
      visit_id: string;
      bed_id: string;
      ward_name: string;
      bed_number: string;
      admitted_at: string;
      changed: boolean;
      transferred_from?: { bed_id: string; ward_name: string; bed_number: string } | null;
    }
  | { ok: false; code: 'TIER_NOT_ENABLED'; message: string; required_tier: number; current_tier: number | null }
  | { ok: false; code: 'BED_NOT_AVAILABLE'; message: string; bed_status: BedStatus; ward_name: string; bed_number: string }
  | { ok: false; code: 'BED_NOT_FOUND' | 'VISIT_NOT_FOUND' | 'VISIT_CANCELLED' | 'ALREADY_DISCHARGED' | 'NOT_STAFF' | 'NOT_AUTHENTICATED'; message: string };

export type DischargeResult =
  | {
      ok: true;
      visit_id: string;
      discharged_at: string;
      bed_released: string | null;
      pending_tasks_cancelled: number;
      notes: string | null;          // echoed, NOT stored
    }
  | { ok: false; code: 'NOT_ADMITTED' | 'VISIT_NOT_FOUND' | 'NOT_STAFF' | 'NOT_AUTHENTICATED'; message: string }
  | { ok: false; code: 'ALREADY_DISCHARGED'; message: string; discharged_at: string };

export type SetBedStatusResult =
  | { ok: true; bed_id: string; status: Exclude<BedStatus, 'occupied'>; changed: boolean }
  | { ok: false; code: 'INVALID_BED_STATUS'; message: string; fields?: string[] }
  | { ok: false; code: 'BED_OCCUPIED' | 'BED_NOT_FOUND' | 'NOT_WARD_STAFF' | 'NOT_AUTHENTICATED'; message: string }
  | { ok: false; code: 'TIER_NOT_ENABLED'; message: string; required_tier: number; current_tier: number | null }
  | { ok: false; code: 'VALIDATION_ERROR'; message: string; fields?: string[] };
```

---

## 10. Deliberately not in Phase 3

| Not available | Why |
|---|---|
| **Bed charges / bed-day billing** | Per-day room rent needs a scheduled job and a rate card. Admission raises **no** billing line. The largest gap here for a real IPD pilot |
| **Discharge summary** | `p_notes` is echoed, not stored. No summary field or document |
| Bed transfer *history* | `visits.bed_id` holds the latest bed only. A transfer log would be its own table |
| A `wards` table | `ward_name` is free text. Ward-level attributes (rate, gender restriction, nurse station) would justify one later |
| Ward/bed-type classification (ICU vs general) | Nothing distinguishes bed classes, which real IPD billing needs |
| Expected discharge date, length-of-stay targets | Not modelled |
| Occupancy reporting / dashboards | Phase 4 |
| Tier 3 modules (OT, blood bank) | Phase 4, structure only |

---

## 11. Verification status

| Suite | Command | Result |
|---|---|---|
| Local flow | `npm run test:phase3` | **252/252** |
| Local isolation + role scoping | `npm run test:isolation3` | **169/169** |
| Remote (real sessions + PostgREST) | `npm run test:phase3:remote` | **203/203** |
| Hosted catalogue | `npm run verify:catalog` | **64/64** |

Covered here specifically, **both locally and against the hosted project with real
GoTrue sessions**: a Tier 1 admin cannot create a bed; a Tier 1 nurse admitting gets
`TIER_NOT_ENABLED` with `required_tier`/`current_tier`, returned before any bed lookup;
`set_bed_status` gated the same way; a Tier 1 nurse **can** still record vitals and use
the task board; a Tier 2 admin creates beds while a nurse cannot; duplicate
`(ward, bed_number)` rejected; `beds.status` and `current_visit_id` refused with
`42501`; admission sets `care_setting='ipd'` and occupies the bed **without touching
`visits.status`**; admission creates exactly one baseline vitals task; re-admitting the
same bed is `changed: false`; a second patient gets `BED_NOT_AVAILABLE` with
`bed_status` and no occupant identity; transfer frees the old bed to `cleaning` and
reports `transferred_from`; the occupancy CHECK and one-bed-per-visit index hold **even
as table owner**; an OPD visit cannot carry `admitted_at` even as owner;
`set_bed_status('occupied')` refused; an occupied bed cannot be re-statused or deleted;
discharge releases the bed to `cleaning`, cancels pending tasks, **retains
`visits.bed_id`**; double discharge returns `ALREADY_DISCHARGED`; discharging an OPD
visit returns `NOT_ADMITTED`; and **after a tier downgrade, new admissions are blocked
while the already-admitted patient can still be discharged**.
