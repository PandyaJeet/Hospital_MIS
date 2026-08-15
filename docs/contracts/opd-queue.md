# Contract: OPD Queue & Clinical Notes

**Feature:** check a patient in, the doctor's queue, the consultation, the note
**Owner (backend):** Jeet · **Owner (frontend):** Prince
**Phase:** 2 (phases.md) · **Format:** Workflow.md §1
**Backend status:** implemented, tested, and **live on the hosted project**.
**Contract status:** final for Phase 2.

---

## 1. Table: `visits`

One OPD encounter. Everything else in the phase hangs off it.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` not null | |
| `patient_id` | `uuid` not null | FK → `patients` |
| `doctor_id` | `uuid` nullable | FK → `profiles`. Null until assigned |
| `visit_type` | `text` not null | `new` \| `follow_up`, default `new` |
| `status` | `text` not null | `queued` \| `in_consultation` \| `done` \| `cancelled`. **Not directly writable** |
| `visit_date` | `date` not null | Defaults to today; the day the token belongs to |
| `queue_number` | `integer` not null | **Per tenant, per day.** Resets each morning |
| `checked_in_at` | `timestamptz` not null | |
| `consultation_started_at` | `timestamptz` nullable | |
| `consultation_ended_at` | `timestamptz` nullable | |
| `cancellation_reason` | `text` nullable | |
| `created_by` | `uuid` nullable | |
| `created_at` / `updated_at` | `timestamptz` not null | |

### Client access

| Operation | Who | How |
|---|---|---|
| `select` | admin, doctor, nurse, billing | plain query |
| `update` | same | plain update, **only** `doctor_id, visit_type` |
| `insert` | nobody | **use `check_in_patient()`** |
| `delete` | nobody | cancel instead |

`status` and the consultation timestamps are **not grantable**. Advancing a visit stamps timestamps *and* fires the consultation billing trigger, so it goes through `set_visit_status()` where the transition is validated. A direct status write could jump `done → queued` and double-bill.

---

## 2. Wait time — compute it, don't store it

Three timestamps rather than one, because "how long has this patient been waiting" and "how long did the consultation take" are different questions:

```sql
-- waiting (or waited)
coalesce(consultation_started_at, now()) - checked_in_at
-- consultation duration
consultation_ended_at - consultation_started_at
```

Nothing caches this, so nothing goes stale. In the queue query below it comes back as `wait_seconds`.

---

## 3. `check_in_patient()`

```ts
const { data, error } = await supabase.rpc('check_in_patient', {
  p_patient_id: patientId,
  p_visit_type: 'new',        // optional, 'new' | 'follow_up'
  p_doctor_id: doctorId,      // optional — assign later if unknown
});
// success: { ok: true, visit_id, queue_number, visit_type, status: 'queued' }
```

Allocates the per-day token number under a lock, so two receptionists clicking at once cannot get the same number.

**Refuses a second open visit for the same patient on the same day.** Without that, a double-click produces two tokens and, once both are consulted, two consultation charges. On `VISIT_ALREADY_OPEN` the response includes `visit_id`, `queue_number` and `status` so the UI can jump straight to the existing visit rather than showing a dead end.

Failure codes: `NOT_AUTHENTICATED`, `NOT_STAFF`, `VALIDATION_ERROR`, `PATIENT_NOT_FOUND`, `DOCTOR_NOT_FOUND`, `VISIT_ALREADY_OPEN`.

---

## 4. `set_visit_status()`

```ts
const { data, error } = await supabase.rpc('set_visit_status', {
  p_visit_id: visitId,
  p_status: 'in_consultation',       // 'in_consultation' | 'done' | 'cancelled'
  p_cancellation_reason: null,       // optional, only meaningful for 'cancelled'
});
// success: { ok: true, visit_id, status, changed: boolean }
```

Legal transitions:

```
queued          → in_consultation | cancelled
in_consultation → done            | cancelled
done            → (terminal)
cancelled       → (terminal)
```

Anything else returns `INVALID_STATUS_TRANSITION` **with `from` and `to`**, so the UI can say something specific instead of "invalid".

Two side effects worth knowing:

- Entering `in_consultation` (or `done`, if a short visit skips straight there) **captures the consultation charge**. See `billing.md`. It is idempotent — bouncing the status cannot double-charge.
- If the visit has no `doctor_id` and the caller is a doctor or admin, entering `in_consultation` **assigns the caller** as the treating doctor. That is what makes the consultation fee resolve to a real practitioner's rate rather than the tenant default.

`changed: false` means it already had that status — treat as success, no toast.

Failure codes: `NOT_AUTHENTICATED`, `NOT_STAFF`, `VALIDATION_ERROR`, `VISIT_NOT_FOUND`, `INVALID_STATUS_TRANSITION`.

---

## 5. The queue query

```ts
// today's queue with wait time — the doctor's main screen
const { data, error } = await supabase
  .from('visits')
  .select(`
    id, queue_number, status, visit_type, checked_in_at, consultation_started_at,
    patient:patients ( id, patient_number, full_name, age_years, gender, allergies )
  `)
  .eq('visit_date', new Date().toISOString().slice(0, 10))
  .in('status', ['queued', 'in_consultation'])
  .order('queue_number');
```

Compute wait time client-side from `checked_in_at`, or ask for it in SQL if you prefer a view later.

```ts
// one patient's visit history (patient chart header)
await supabase.from('visits')
  .select('id, visit_date, visit_type, status, doctor_id')
  .eq('patient_id', patientId)
  .order('created_at', { ascending: false })
  .limit(20);
```

**Realtime** (rules.md §6.1 — subscribe, don't poll):

```ts
supabase.channel('opd-queue')
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'visits' },
      (payload) => { /* refresh */ })
  .subscribe();
```

Realtime respects RLS, so a subscription only ever delivers your own tenant's rows. You still need `visits` added to the `supabase_realtime` publication — **not yet done**, see §9.

---

## 6. Table: `clinical_notes`

> ### Every clinical column here is nullable, on purpose.
> rules.md §1.7 is a **product requirement**: no mandatory field may block a doctor from saving. An empty note is a legitimate state — it means the doctor opened the encounter and saved before writing anything. Do not add client-side required-field validation that the schema deliberately refuses to impose.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` **not null** | structural |
| `visit_id` | `uuid` **not null** | structural |
| `author_id` | `uuid` **not null** | structural — must equal `auth.uid()` |
| `template_type` | `text` nullable | clinical |
| `chief_complaint` | `text` nullable | clinical |
| `history` | `text` nullable | clinical |
| `examination` | `text` nullable | clinical |
| `diagnosis` | `text` nullable | clinical |
| `advice` | `text` nullable | clinical |
| `follow_up_instructions` | `text` nullable | clinical |
| `note_text` | `text` nullable | clinical |
| `created_at` / `updated_at` | `timestamptz` not null | |

The four NOT NULL columns are "which encounter, whose clinic, who wrote it" — none is something a doctor types into a form, so none can block a save.

**Multiple notes per visit are allowed** (no unique constraint on `visit_id`). A doctor may save early and add an addendum after results. Show the latest, allow appending.

### Who can read — and who deliberately cannot

| Role | `clinical_notes` |
|---|---|
| admin, doctor, nurse | read |
| **billing** | **no rows** |
| patient, pending, anon | no rows |

Billing does not need a diagnosis to raise an invoice. Giving a front-desk role clinical-note access by default is the kind of over-broad grant DPDP alignment (PRD §7) gets judged on. Billing sees the billing tables, which carry a service description rather than clinical content. If insurance/TPA work in Phase 4 needs a diagnosis on a claim, that should be an explicit narrow addition then.

Write access: **doctor or admin only**, and `author_id` must be the caller — a note cannot be attributed to a colleague. Updates are author-only. There is no delete.

### Note operations — plain CRUD, not an RPC

Note-taking is the one flow that must be frictionless, so wrapping it in an RPC that could reject something would work against §1.7.

```ts
// create (all clinical fields optional — this exact call is valid)
await supabase.from('clinical_notes').insert({
  tenant_id: tenantId,
  visit_id: visitId,
  author_id: userId,
});

// with content
await supabase.from('clinical_notes').insert({
  tenant_id: tenantId, visit_id: visitId, author_id: userId,
  template_type: 'fever', chief_complaint: 'Fever 3 days',
  examination: 'Temp 101F', diagnosis: 'Viral fever',
  advice: 'Rest, fluids', note_text: '...',
});

// revise your own
await supabase.from('clinical_notes')
  .update({ diagnosis: 'Dengue — NS1 positive' })
  .eq('id', noteId);

// read for a visit, latest first
await supabase.from('clinical_notes')
  .select('*').eq('visit_id', visitId).order('created_at', { ascending: false });
```

`tenant_id` is accepted on insert but pinned by the policy to your own tenant — a forged value is rejected, not trusted.

---

## 7. Error codes

| Code | Channel | When | Suggested copy |
|---|---|---|---|
| `VALIDATION_ERROR` | `data` | Bad visit type or unknown status. Includes `fields` | Field-level message |
| `NOT_STAFF` | `data` | `pending` or `patient` role | "Only clinic staff can do this." |
| `NOT_AUTHENTICATED` | `data` | No session | "Your session has expired." |
| `PATIENT_NOT_FOUND` | `data` | Unknown id, or belongs to another clinic | "That patient is not registered at this clinic." |
| `DOCTOR_NOT_FOUND` | `data` | Not a doctor/admin in this clinic | "That doctor is not part of this clinic." |
| `VISIT_ALREADY_OPEN` | `data` | Same patient already queued today. Includes `visit_id`, `queue_number`, `status` | "Already in today's queue (token N)" → link to it |
| `VISIT_NOT_FOUND` | `data` | Unknown id, or another clinic's | "That visit does not exist at this clinic." |
| `INVALID_STATUS_TRANSITION` | `data` | Illegal move. Includes `from`, `to` | "A visit that is already {from} cannot be marked {to}." |
| `42501` | `error.code` | Wrote an ungranted column (e.g. `status`), or a nurse tried to author a note | "You don't have permission" → log; UI bug |
| `23503` | `error.code` | Referenced a parent in another tenant | Generic error → log |
| `PGRST116` | `error.code` | `.single()` matched 0 rows | Usually RLS filtered it — treat as empty |

Note-taking failures worth handling explicitly: a nurse attempting to insert a note gets `42501`, and so does any attempt to set `author_id` to someone else.

---

## 8. TypeScript for the mock layer

```ts
export type VisitStatus = 'queued' | 'in_consultation' | 'done' | 'cancelled';
export type VisitType = 'new' | 'follow_up';

export interface Visit {
  id: string;
  tenant_id: string;
  patient_id: string;
  doctor_id: string | null;
  visit_type: VisitType;
  status: VisitStatus;
  visit_date: string;
  queue_number: number;
  checked_in_at: string;
  consultation_started_at: string | null;
  consultation_ended_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** What the queue screen actually renders. */
export interface QueueEntry {
  id: string;
  queue_number: number;
  status: VisitStatus;
  visit_type: VisitType;
  checked_in_at: string;
  consultation_started_at: string | null;
  patient: {
    id: string; patient_number: number; full_name: string;
    age_years: number | null; gender: string | null; allergies: string | null;
  };
}

export interface ClinicalNote {
  id: string;
  tenant_id: string;
  visit_id: string;
  author_id: string;
  template_type: string | null;
  chief_complaint: string | null;
  history: string | null;
  examination: string | null;
  diagnosis: string | null;
  advice: string | null;
  follow_up_instructions: string | null;
  note_text: string | null;
  created_at: string;
  updated_at: string;
}

/** Every clinical field optional — that is the contract, not an oversight. */
export type NewClinicalNote =
  Pick<ClinicalNote, 'tenant_id' | 'visit_id' | 'author_id'> &
  Partial<Omit<ClinicalNote, 'id' | 'tenant_id' | 'visit_id' | 'author_id' | 'created_at' | 'updated_at'>>;

export type CheckInResult =
  | { ok: true; visit_id: string; queue_number: number; visit_type: VisitType; status: 'queued' }
  | { ok: false; code: 'VISIT_ALREADY_OPEN'; message: string; visit_id: string; queue_number: number; status: VisitStatus }
  | { ok: false; code: 'PATIENT_NOT_FOUND' | 'DOCTOR_NOT_FOUND' | 'NOT_STAFF' | 'NOT_AUTHENTICATED'; message: string }
  | { ok: false; code: 'VALIDATION_ERROR'; message: string; fields?: string[] };

export type SetVisitStatusResult =
  | { ok: true; visit_id: string; status: VisitStatus; changed: boolean }
  | { ok: false; code: 'INVALID_STATUS_TRANSITION'; message: string; from: VisitStatus; to: VisitStatus }
  | { ok: false; code: 'VISIT_NOT_FOUND' | 'NOT_STAFF' | 'NOT_AUTHENTICATED'; message: string }
  | { ok: false; code: 'VALIDATION_ERROR'; message: string; fields?: string[] };
```

---

## 9. Deliberately not in Phase 2

> **Two rows in this table were corrected after Phase 3 shipped.** Both are marked
> **✅ DONE IN PHASE 3** below rather than deleted, so the change of plan stays
> visible instead of looking like it was always this way.

| Not available | Why |
|---|---|
| ~~**Realtime publication** for `visits`~~ | **✅ DONE IN PHASE 3.** `visits` is now in the `supabase_realtime` publication, together with `vitals`, `tasks`, `lab_orders` and `lab_results` (migration `20260811071100`). Subscribe away. Note that `visits` now also emits a change when a nurse records vitals, because the rounds trigger writes `visits.last_vitals_at` — that is deliberate, and it is what makes a queue or rounds subscription update without a separate fetch. Verified on the hosted project by `npm run verify:catalog` |
| ~~IPD admit/discharge~~ | **✅ DONE IN PHASE 3, BUT NOT THE WAY THIS ROW PREDICTED.** This said `visits.status` would extend additively via `visits_status_valid`. It did not: IPD state landed in a **new `care_setting` column** (`opd` \| `ipd`) plus `admitted_at`, `discharged_at`, `bed_id`, and `visits_status_valid` is **unchanged**. Reason: `status` tracks the *consultation* lifecycle and admission is an orthogonal axis — folding them together forces states like "in_consultation AND admitted" into one enum value. **A discharge does not write `visits.status`.** "Currently an inpatient" is `care_setting = 'ipd' and discharged_at is null`. Full detail in `docs/contracts/ipd-beds.md` |
| Note version history | An edit overwrites in place. Amendment history belongs with the Phase 4 audit log; recorded as a risk in `Memory.md` §6 |
| Voice dictation | PRD §6.1 wants it; it is a client-side concern, no backend dependency |
| Order sets / templates as data | `template_type` is free text this phase. A template *library* table would be Phase 3 |

---

## 10. Verification status

| Suite | Command | Result |
|---|---|---|
| Local OPD flow | `npm run test:opd` | **131/131** |
| Local isolation + role scoping | `npm run test:isolation2` | **122/122** |
| Remote | `npm run test:opd:remote` | **102/102** |

Covered here specifically: token starts at 1 and increments; same-patient double check-in refused with the existing visit returned; `queued → done` rejected with `from`/`to`; consultation timestamps stamped; wait time computable; **a completely empty clinical note saves** (asserted both locally and over real PostgREST); multiple notes per visit; nurse cannot author a note; billing sees zero notes while doctor and nurse see them; cross-tenant visit invisible and un-advanceable.

### Phase 3 additions to this table

`visits` gained six columns in Phase 3. None is client-writable, and none changes any behaviour documented above.

| Column | Meaning | Contract |
|---|---|---|
| `care_setting` | `opd` \| `ipd` | `ipd-beds.md` |
| `admitted_at` / `discharged_at` | Admission window; nullable | `ipd-beds.md` |
| `bed_id` | Bed this admission used; **retained after discharge** | `ipd-beds.md` |
| `last_vitals_at` | Server-derived freshness of the latest observation | `vitals-and-rounds.md` |

One consequence worth knowing when you build the queue: because the vitals trigger touches `visits`, a queue subscription will receive change events for encounters whose *queue* state did not change. Re-render from the row you receive rather than assuming a change means the status moved.
