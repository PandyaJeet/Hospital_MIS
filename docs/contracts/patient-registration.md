# Contract: Patient Registration

**Feature:** register a patient, search for one, edit demographics
**Owner (backend):** Jeet · **Owner (frontend):** Prince
**Phase:** 2 (phases.md) · **Format:** Workflow.md §1
**Backend status:** implemented, tested, and **live on the hosted project**.
**Contract status:** final for Phase 2.

> This is the first feature where **real patient PII** enters the system. rules.md §1.3 stops being theoretical: never `console.log` a patient name, phone, address or allergy string, not even in development, and never send one to an error tracker. Log `patient_id` or `patient_number` instead.

---

## 1. Table: `patients`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` not null | FK → `tenants` |
| `patient_number` | `bigint` not null | **Per-tenant serial** — the UHID/OPD number staff quote and search by. Starts at 1 per clinic |
| `full_name` | `text` **not null** | |
| `phone` | `text` nullable | Stored exactly as typed |
| `phone_normalized` | `text` **generated, read-only** | Last 10 digits of `phone`. What duplicate detection and lookup actually match on |
| `dob` | `date` nullable | |
| `age_years` | `smallint` nullable | 0–130 |
| `gender` | `text` nullable | `male` \| `female` \| `other` \| `unknown` |
| `address` | `text` nullable | |
| `allergies` | `text` nullable | Clinical free-text. Feeds the prescription safety check |
| `registered_by` | `uuid` nullable | FK → `profiles` |
| `created_at` / `updated_at` | `timestamptz` not null | `updated_at` is trigger-maintained |

**Why both `dob` and `age_years`.** Many Indian patients state an age, not a date of birth. Back-computing a DOB from "about 40" invents precision nobody gave. Capture whichever the patient actually provided; both are nullable. If you need to display an age, prefer `age_years` when present, else derive from `dob`.

**`full_name` is NOT NULL, and that does not conflict with rules.md §1.7.** §1.7 forbids mandatory fields that block saving a *clinical note*. A patient record with no name cannot be found again at the front desk, so the name is identity, not clinical content. The one clinical field here — `allergies` — is nullable.

### Client access

| Operation | Who | How |
|---|---|---|
| `select` | admin, doctor, nurse, billing | plain query |
| `update` | admin, doctor, nurse, billing | plain update, **only** `full_name, phone, dob, age_years, gender, address, allergies` |
| `insert` | nobody | **use `register_patient()`** |
| `delete` | nobody | medical records are not deleted from the app |

`tenant_id` and `patient_number` are not writable — a patient cannot be moved between clinics or renumbered from a session. The `patient` role has **no access at all** to this table in Phase 2 (see §5).

---

## 2. `register_patient()` — the one RPC

```ts
const { data, error } = await supabase.rpc('register_patient', {
  p_full_name: 'Ramesh Kumar',
  p_phone: '+91 98765 43210',       // optional
  p_dob: null,                      // optional, 'YYYY-MM-DD'
  p_age_years: 42,                  // optional
  p_gender: 'male',                 // optional
  p_address: 'Pune',                // optional
  p_allergies: 'penicillin',        // optional
  p_allow_duplicate_phone: false,   // see §3
});
// success: { ok: true, patient_id, patient_number, full_name }
```

Registration is an RPC rather than a table insert for two reasons: duplicate detection must not be bypassable, and `patient_number` has to be allocated without a race. Since `insert` is not granted on the table, this is the only door.

Failure codes: `NOT_AUTHENTICATED`, `NOT_STAFF`, `VALIDATION_ERROR`, `DUPLICATE_PATIENT`.

---

## 3. Duplicate handling — a prompt, not a wall

This is the part of the feature with real UX consequence, so it is worth reading fully.

There is **deliberately no unique constraint** on phone. Two cases break it:

- **No phone.** A walk-in with no number is ordinary. Several such patients are not duplicates of each other.
- **Shared phone.** A child on a parent's number, a spouse, an elderly patient using a son's mobile. These are *different people* who legitimately share one number. A hard constraint makes them unregistrable, and the receptionist's only escape is to invent a fake number — which corrupts the data far worse than a duplicate would.

So the flow is:

```
1. registerPatient({ full_name, phone })
        │
        ├─ ok: true            → done
        │
        └─ code: 'DUPLICATE_PATIENT', matches: [...], can_override: true
                 │
                 ├─ user picks an existing patient  → open that record
                 └─ user says "different person"    → resubmit with
                                                      p_allow_duplicate_phone: true
```

`matches` is an array of the existing patients on that number, so the UI can show a "is it one of these?" list:

```ts
matches: Array<{
  id: string; patient_number: number; full_name: string;
  phone: string | null; dob: string | null; age_years: number | null;
  gender: string | null; created_at: string;
}>
```

Matching is on **normalised** phone, so `+91 98765-43210`, `098765 43210` and `9876543210` are all recognised as the same number. Detection is skipped entirely when no phone is given.

`can_override: true` is the signal that this is a soft prompt. Do not render it as a terminal error.

---

## 4. Search and edit

```ts
// by UHID — the fastest path, and what staff will use most
await supabase.from('patients').select('*').eq('patient_number', 42).maybeSingle();

// by phone — normalise on the client the same way (last 10 digits) or just
// pass the digits; phone_normalized is what to filter on
await supabase.from('patients').select('*').eq('phone_normalized', '9876543210');

// by name — case-insensitive prefix; there is an index on lower(full_name)
await supabase.from('patients').select('*').ilike('full_name', `${term}%`).limit(20);

// recent registrations
await supabase.from('patients')
  .select('id, patient_number, full_name, phone, age_years, gender')
  .order('created_at', { ascending: false })
  .limit(25);

// edit demographics
await supabase.from('patients')
  .update({ phone: '9999988888', address: 'New address', allergies: 'sulfa' })
  .eq('id', patientId);
```

Per rules.md §6.3, paginate any patient list — never fetch-all.

---

## 5. Deliberately not in Phase 2

| Not available | Why |
|---|---|
| A patient-portal "my own record" view | The `patient` role matches **no rows** on `patients`. That is a deliberate deny, not an oversight. When it arrives it needs its own narrow policy matching a verified link between `auth.uid()` and a patient row, not a widening of the staff policy |
| Deleting / merging patients | No delete policy. Merging duplicates is a real need but needs care with visits, prescriptions and invoices already attached — Phase 4 |
| Structured allergy capture | Free text this phase. The safety check matches it textually and reports when it could not be certain — see `prescriptions.md` |
| Photo / ID document upload | Supabase Storage, not modelled yet |

---

## 6. Error codes

| Code | Channel | When | Suggested copy |
|---|---|---|---|
| `VALIDATION_ERROR` | `data` | Blank name, name > 200 chars, bad gender, future DOB, age out of 0–130, phone with no digits. Includes `fields: string[]` | Field-level message |
| `DUPLICATE_PATIENT` | `data` | Existing patient(s) on that phone. Includes `matches`, `can_override: true` | "A patient with this phone number already exists" + the match list + "Register anyway" |
| `NOT_STAFF` | `data` | Caller is `pending` or `patient` role | "Only clinic staff can register patients." |
| `NOT_AUTHENTICATED` | `data` | No session | "Your session has expired. Please sign in again." |
| `42501` | `error.code` | Tried to write an ungranted column, or insert directly | "You don't have permission to do that" → log; indicates a UI bug |
| `23514` | `error.code` | Check-constraint violation | Generic error → log |

Error-channel rule is the same as Phase 1 — `error` means transport/auth/RLS/bug, `data.ok === false` means an explainable business rule. Full reasoning in `auth-tenancy.md` §4.

---

## 7. TypeScript for the mock layer

Generated types are authoritative: `supabase/types/database.types.ts` (regenerated from the live schema). These are for the mock.

```ts
export type Gender = 'male' | 'female' | 'other' | 'unknown';

export interface Patient {
  id: string;
  tenant_id: string;
  patient_number: number;
  full_name: string;
  phone: string | null;
  phone_normalized: string | null;
  dob: string | null;
  age_years: number | null;
  gender: Gender | null;
  address: string | null;
  allergies: string | null;
  registered_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewPatientInput {
  full_name: string;
  phone?: string | null;
  dob?: string | null;
  age_years?: number | null;
  gender?: Gender | null;
  address?: string | null;
  allergies?: string | null;
  allow_duplicate_phone?: boolean;
}

export type PatientMatch = Pick<
  Patient, 'id' | 'patient_number' | 'full_name' | 'phone' | 'dob' | 'age_years' | 'gender' | 'created_at'
>;

export type RegisterPatientResult =
  | { ok: true; patient_id: string; patient_number: number; full_name: string }
  | { ok: false; code: 'DUPLICATE_PATIENT'; message: string; matches: PatientMatch[]; can_override: true }
  | { ok: false; code: 'VALIDATION_ERROR'; message: string; fields?: string[] }
  | { ok: false; code: 'NOT_STAFF' | 'NOT_AUTHENTICATED'; message: string };
```

---

## 8. Verification status

| Suite | Command | Result |
|---|---|---|
| Local (PGlite, real Postgres) | `npm run test:opd` | **131/131** |
| Local isolation + role scoping | `npm run test:isolation2` | **122/122** |
| Remote (real sessions, real PostgREST) | `npm run test:opd:remote` | **102/102** |

Covered here specifically: numbering starts at 1 and increments per tenant; phone normalisation across four input formats; duplicate detected across formatting differences; override registers a second person on the same number; two no-phone walk-ins both register; blank name rejected; cross-tenant patient invisible and un-renamable; `patient`-role login sees zero rows.
