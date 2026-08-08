# Workflow.md
## Contract-First Parallel Development — Prince & Jeet

**Problem this solves:** In `phases.md`, Jeet's schema work technically comes "before" Prince's UI work in each phase — which sounds like Prince waits. This document removes that wait. Both of you work at the same time, every phase, without either person blocked on the other finishing first.

**Core idea:** Instead of "Jeet builds the table, then Prince builds the UI," you both start from a **shared contract** — a short, agreed definition of what a feature needs (table names, column names, types, function names) — written together in 15–30 minutes at the start of each feature. Once the contract exists, you both build independently against it, in parallel, and integrate at the end.

---

## 1. The Contract — What It Is

Before any feature (e.g., "patient registration"), you both agree on and write down:

```
Feature: Patient Registration

Table: patients
Columns: id, tenant_id, name, phone, dob, gender, address, created_at

Function Prince will call: 
  registerPatient(data: NewPatientInput): Promise<{ data: Patient | null, error: AppError | null }>

Expected error cases:
  - duplicate phone number within tenant → { code: 'DUPLICATE_PATIENT', message: '...' }
  - validation failure → { code: 'VALIDATION_ERROR', message: '...', fields: [...] }
```

This takes minutes to write and lives in `docs/contracts/` as a markdown file per feature. It's the single source of truth both of you build against — **not** a finished backend.

### Where contracts live
```
docs/contracts/
├── auth-tenancy.md
├── patient-registration.md
├── opd-queue.md
├── prescriptions.md
├── billing.md
├── nurse-tasks.md
└── ...one per feature, created just before that feature's work starts
```

---

## 2. How Each Side Works From the Contract, Simultaneously

### Jeet (backend track)
- Writes the actual migration (real `patients` table, real RLS policy)
- Writes the actual function/Edge Function logic matching the contract's function signature
- Tests it directly against Supabase (via SQL editor, Postman, or a script) — doesn't need Prince's UI to exist to verify it works

### Prince (frontend track)
- Builds the UI and the hook (`useRegisterPatient()`) **against the contract**, not against Jeet's finished code
- Uses a **mock data layer** that returns fake responses matching the contract's shape, so the UI is fully clickable/testable before Jeet's real backend is done
- Builds loading states, error states, and success states using the contract's stated error cases — this actually makes Prince's error handling *more* thorough, since he's designing for all documented failure cases up front, not just the ones he happens to hit

---

## 3. The Mock Layer — How Prince Stays Unblocked

Add one lightweight switch in the data-access layer:

```typescript
// lib/data/patients.ts

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === 'true';

export async function registerPatient(data: NewPatientInput) {
  if (USE_MOCK) {
    return mockRegisterPatient(data); // returns fake data matching the contract
  }
  return realRegisterPatient(data); // actual Supabase call
}
```

- Prince builds `mockRegisterPatient()` himself in 5 minutes, based on the contract — no need to wait for Jeet
- All UI, loading states, and error handling get built and tested against the mock
- One environment variable (`NEXT_PUBLIC_USE_MOCK`) flips the whole app between mock and real data
- When Jeet's real implementation is ready, Prince flips the switch and tests against the real backend — integration becomes a quick verification step, not a build step

This is the actual mechanism that makes parallel work possible: **Prince is never waiting on Supabase to exist to build a working, demoable screen.**

---

## 4. Integration Points

Not every feature needs a scheduled "integration meeting" — but every feature does need one **integration checkpoint** before it's marked done:

1. Prince flips `USE_MOCK` off for that feature
2. Both run through the feature together (or Prince runs it and reports back) against Jeet's real backend
3. Mismatches between contract and reality get fixed on whichever side is wrong — contract was a plan, not a guarantee
4. Feature only marked "done" in `phases.md` after this checkpoint passes

**Rule:** if reality needs to diverge from the contract (a column needs a different type, a function needs an extra parameter), whoever discovers it updates the contract file immediately and pings the other — the contract stays truthful, not aspirational.

---

## 5. Git Workflow to Avoid Collisions

- `main` branch is always deployable
- Each feature gets its own branch: `prince/patient-registration-ui`, `jeet/patient-registration-schema`
- Since you're working against a contract, **your branches rarely touch the same files** — Jeet's changes live in `supabase/migrations/` and `lib/data/*-real.ts`; Prince's live in `app/`, `components/`, `lib/data/*-mock.ts`
- Merge to `main` happens per-feature after the integration checkpoint passes, not in one big weekly merge
- If a merge conflict does happen, it's almost always in a shared file like `lib/data/patients.ts` (the switch file) — keep these files tiny and mechanical specifically so conflicts are trivial to resolve

---

## 6. Daily/Per-Feature Rhythm

```
1. Quick sync (15–30 min): agree on the contract for the next feature, write it down
2. Both start immediately:
   Jeet  → migration + RLS + real function
   Prince → UI + mock data + hook + all UI states
3. Both work independently, no blocking
4. Whoever finishes first can move to the next feature's contract-writing,
   or help review/test the other's in-progress work
5. Integration checkpoint when both sides are ready
6. Mark feature done in phases.md, merge to main
```

This rhythm repeats for every feature inside every phase from `phases.md` — the phases still define *what* gets built and in what order overall, but within a phase, features move in this parallel contract → build → integrate loop rather than strictly sequential handoffs.

---

## 7. What This Changes About `phases.md`

`phases.md` still defines phase boundaries and Definition-of-Done per phase — that structure stays. What changes is **how work happens inside each phase**:

- Old assumption: Jeet's whole list finishes, then Prince's whole list finishes
- New reality: Prince and Jeet's lists for the same phase run **at the same time**, feature by feature, connected by contracts — a phase is done when all its features have passed their integration checkpoints, not when one person's list is done before the other's starts

No change needed to phase content or role split — just how the two tracks interleave in time.

---

## 8. Quick Checklist Per Feature

- [ ] Contract written and saved in `docs/contracts/`
- [ ] Jeet: migration + RLS policy written and tested independently
- [ ] Jeet: real function implemented, matching contract's function signature
- [ ] Prince: mock function written, matching contract's shape
- [ ] Prince: full UI built and tested against mock (all states: loading, success, error, empty)
- [ ] Integration checkpoint: mock switched off, tested against real backend
- [ ] Contract file updated if reality diverged from plan
- [ ] Feature merged to `main`, marked done in `phases.md`

---

*This workflow is the mechanism that makes the phase-based plan actually parallelizable. Keep contracts short and written before code, not after — the moment you skip writing the contract "to save time," you're back to sequential blocking.*
