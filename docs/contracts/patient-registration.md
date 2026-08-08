# Contract: Patient Registration

- **Status:** Draft (frontend-proposed) — awaiting backend confirmation
- **Phase:** 2
- **Frontend (mock):** `apps/web/lib/data/patients.ts` (behind `USE_MOCK`), consumed by `app/(billing)/register`
- **Backend:** not started

## Purpose

Front-desk / billing staff register a new patient. Creating a patient is the first step of the OPD loop (register → queue → consult → prescribe → bill).

## Tables (backend to finalize)

### `patients`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` |
| `tenant_id` | uuid, not null | FK → `tenants.id` (RLS) |
| `full_name` | text, not null | |
| `phone` | text, not null | 10-digit; used for lookup/dedupe |
| `age` | int | (or `date_of_birth date` — see open questions) |
| `sex` | text | `male` / `female` / `other` |
| `created_at` | timestamptz | `default now()` |

- **RLS:** rows scoped to `tenant_id`. Consider a unique index on `(tenant_id, phone)` to enforce dedupe.

## Shared types (frontend)

```ts
type Sex = "male" | "female" | "other";
interface Patient {
  id: string;
  fullName: string;
  phone: string;
  age: number;
  sex: Sex;
  createdAt: string;
}
interface NewPatientInput {
  fullName: string;
  phone: string;
  age: number;
  sex: Sex;
}
```

## Functions (frontend-facing)

| function | input | success | error codes |
|---|---|---|---|
| `registerPatient` | `NewPatientInput` | `Patient` | `VALIDATION_ERROR`, `DUPLICATE_PATIENT` |

Future: `searchPatients(query) -> Patient[]` (top-bar search / find-existing).

## Error codes → UI message keys

| code | meaning | UI key |
|---|---|---|
| `DUPLICATE_PATIENT` | phone already exists in tenant | `register.duplicate` (offer to open existing) |
| `VALIDATION_ERROR` | invalid field(s) | field-level messages |

## Current mock behavior (`lib/data/patients.ts`)

- `registerPatient`: phone `9999999999` → `DUPLICATE_PATIENT`; otherwise success with a generated id.

## Open questions for backend

1. `age` vs `date_of_birth`? Indian OPD desks often capture age, but DOB is more durable long-term.
2. Should registration also create a visit (enqueue for OPD) in one call, or is enqueuing the separate **OPD Queue** contract?
3. Dedupe scope: unique phone per tenant? How to handle families sharing one phone number?
4. Which fields are mandatory for the pilot (is age/sex required or optional)?
