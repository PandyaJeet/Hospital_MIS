# Contract: Prescriptions

- **Status:** Draft (frontend-proposed) — awaiting backend confirmation
- **Phase:** 2
- **Frontend (mock):** `apps/web/lib/data/prescriptions.ts` (behind `USE_MOCK`), consumed by `app/(doctor)/prescribe`
- **Backend:** not started

## Purpose

The doctor authors a prescription — one or more medications plus general advice — for a patient's visit. PDF generation is a server-side concern (Edge Function), not part of this frontend contract.

## Tables (backend to finalize)

### `prescriptions`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` |
| `tenant_id` | uuid, not null | FK → `tenants.id` (RLS) |
| `visit_id` | uuid | FK → `visits.id` |
| `patient_id` | uuid | FK → `patients.id` |
| `doctor_id` | uuid | FK → `profiles.id` |
| `advice` | text | |
| `created_at` | timestamptz | `default now()` |

### `prescription_items`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `prescription_id` | uuid, not null | FK → `prescriptions.id` |
| `drug` | text, not null | |
| `dosage` | text | |
| `frequency` | text | |
| `duration` | text | |

- **RLS:** tenant-scoped via `prescriptions.tenant_id`.

## Shared types (frontend)

```ts
interface Medication {
  drug: string;
  dosage: string;
  frequency: string;
  duration: string;
}
interface NewPrescription {
  medications: Medication[];
  advice: string;
}
interface Prescription {
  id: string;
  createdAt: string;
}
```

## Functions (frontend-facing)

| function | input | success | error codes |
|---|---|---|---|
| `savePrescription` | `NewPrescription` | `Prescription` | `NO_MEDICATIONS`, `VALIDATION_ERROR` |

## PDF

Prescription PDF generation is a server-side Edge Function (Phase 2 Definition of Done). The frontend triggers/downloads it after save — out of scope for this contract.

## Open questions for backend

1. Is a prescription tied to a `visit_id` (the active consultation)? How is the active visit selected/passed?
2. Free-text drug names for MVP, or a structured drug catalog with autocomplete?
3. Are dosage/frequency/duration free-text or coded/structured?
4. Who generates the PDF and when — on save, or on demand?
