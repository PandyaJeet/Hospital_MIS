# Contract: Patient Chart

- **Status:** Draft (frontend-proposed) — awaiting backend confirmation
- **Phase:** 2
- **Frontend (mock):** `apps/web/lib/data/patient-chart.ts` (behind `USE_MOCK`), consumed by `app/(doctor)/patient/[id]` (server component)
- **Backend:** not started

## Purpose

The doctor's read view of a patient: demographics, known allergies, and past-visit history. Reached by opening a patient from the queue.

## Tables (backend to finalize)

Reads from `patients` (see patient-registration contract) plus `visits` (see opd-queue contract), joined for history. Allergies may be a column (`patients.allergies text[]`) or a separate `allergies` table — see open questions.

## Shared types (frontend)

```ts
interface VisitSummary {
  id: string;
  date: string;        // ISO date
  reason: string;
  note: string;
  doctorName: string;
}
interface PatientDetail {
  id: string;
  fullName: string;
  age: number;
  sex: "male" | "female" | "other";
  phone: string;
  allergies: string[];
  visits: VisitSummary[];  // most-recent first
}
```

## Functions (frontend-facing)

| function | input | success | error codes |
|---|---|---|---|
| `getPatient` | `id: string` | `PatientDetail` | `PATIENT_NOT_FOUND` |

## Current mock behavior (`lib/data/patient-chart.ts`)

- `getPatient`: ids `v1`–`v4` (matching the queue mock) return full detail; any other id → `PATIENT_NOT_FOUND`.

## Open questions for backend

1. Is visit history a join on `visits`, or a dedicated `encounters`/`notes` table? What's the returned shape and ordering?
2. Allergies: a `text[]` column on `patients`, or a normalized `allergies` table (with severity)?
3. Are clinical notes free-text (one per visit) or structured? Who can view/edit them (RLS by role)?
4. Pagination for long histories, or return the last N visits?
