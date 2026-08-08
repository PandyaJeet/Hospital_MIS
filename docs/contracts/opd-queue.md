# Contract: OPD Queue

- **Status:** Draft (frontend-proposed) — awaiting backend confirmation
- **Phase:** 2
- **Frontend (mock):** `apps/web/lib/data/queue.ts` (behind `USE_MOCK`) via `apps/web/hooks/use-queue.ts`, consumed by `app/(doctor)/queue`
- **Backend:** not started

## Purpose

The doctor sees today's OPD queue — patients checked in, their status, and how long they've waited. In production the queue updates in real time (Supabase Realtime); the mock is a static snapshot.

## Tables (backend to finalize)

### `visits`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` |
| `tenant_id` | uuid, not null | FK → `tenants.id` (RLS) |
| `patient_id` | uuid, not null | FK → `patients.id` |
| `token_number` | int | daily token |
| `status` | text | `waiting` / `in_consultation` / `done` |
| `doctor_id` | uuid, null | FK → `profiles.id` |
| `checked_in_at` | timestamptz | `default now()` |

- **RLS:** tenant-scoped. "Today's queue" = visits where `checked_in_at::date = today` in the tenant's timezone.

## Shared types (frontend)

```ts
type QueueStatus = "waiting" | "in_consultation" | "done";
interface QueueEntry {
  id: string;          // visit id
  patientName: string;
  tokenNumber: number;
  status: QueueStatus;
  waitMinutes: number;
  age: number;
  sex: "male" | "female" | "other";
}
```

`patientName` / `age` / `sex` are denormalized for display — the backend likely returns a `visits`⋈`patients` join or a view.

## Functions (frontend-facing)

| function | input | success | error codes |
|---|---|---|---|
| `getQueue` | — | `QueueEntry[]` | `LOAD_FAILED` |
| `updateVisitStatus` (future) | `(visitId, status)` | `QueueEntry` | — |

## Realtime

Production: `hooks/use-queue.ts` subscribes to tenant-scoped `visits` changes via Supabase Realtime and keeps the list live. Mock: a one-shot load. The hook's public shape (`{ entries, loading, error, refresh }`) stays the same after the realtime swap.

## Open questions for backend

1. Is the queue clinic-wide or per-doctor (multi-doctor clinics)?
2. How are `token_number`s generated and reset (daily per tenant)?
3. Exact status enum + allowed transitions, and who may change status?
4. Does the list come from a DB view or a client-side join, and what's the realtime payload shape?
5. Is `waitMinutes` computed server-side or derived client-side from `checked_in_at`?
