# Playwright E2E Specification

**Status: BLOCKED — not implemented, deliberately.**

Playwright drives a browser. There is no browser target: `apps/web` does not exist in this
repo, and it is Prince's track. Building even a minimal page for Playwright to click through
would mean writing frontend code from the backend track, which is out of scope and would
create exactly the kind of parallel structure `rules.md` §5.1 exists to prevent.

So this file is a **specification and a checklist**, not an implementation. It contains no
test code. When `apps/web` lands, this is the list to work through.

---

## What is already covered, and at which layer

This distinction matters, because "we have no E2E tests" and "the flow is untested" are
different statements.

The register → consult → prescribe → bill journey is already exercised end to end **at the
API layer**, twice:

| Suite | Layer | What it proves |
|---|---|---|
| `supabase/tests/local/opd-flow.test.ts` | PGlite, real RLS/triggers/constraints | the full OPD flow works, with every policy and trigger live |
| `supabase/tests/remote/opd-flow.remote.test.ts` | hosted project, real GoTrue sessions + real PostgREST | the same flow works through the actual auth and API stack a browser would use |
| `supabase/tests/remote/concurrency.remote.test.ts` | hosted, parallel connections | the flow survives simultaneous users |
| `supabase/tests/local/phase5-pentest.test.ts` | PGlite | 477 attack attempts across 33 relations × 9 role states |

The remote suite signs in with real credentials and calls real RPCs over HTTPS. Everything
between PostgREST and the database is verified.

**What no backend test can reach** is therefore what Playwright is actually for:

- whether a rendered screen shows the data the API returned
- whether a Realtime subscription visibly updates the queue without a refresh
- whether an error envelope becomes a sentence a receptionist can act on
- whether a role's navigation actually hides what its RLS policies deny
- whether a PDF opens

That is a UI-correctness gap, not a backend-correctness gap. Worth being precise about it:
the risk Playwright closes here is "the API is right and the screen is wrong."

---

## Environment requirements

- Runs against a **dedicated Supabase project**, never the pilot project. Several scenarios
  below deactivate users and cancel invoices.
- Seeded by `npm run db:seed` — 2 clinics × 4 roles, Sunrise = Tier 1 (OPD only),
  Lotus = Tier 2 (IPD/beds). Credentials from `SEED_USER_PASSWORD`.
- Two clinics are **required**, not convenient: every isolation scenario needs a second
  tenant with real data to fail to see.
- `rules.md` §2 puts Vitest as the unit runner. Playwright is a separate browser-automation
  tool, not a replacement, and adding it is a genuine gap rather than duplicate tooling —
  state that reason when adding the dependency (§2 rule of thumb).

---

## 1. Authentication and onboarding

- [ ] Sign up a new user → lands in a "no clinic yet" state, not a broken dashboard
- [ ] Create a clinic → becomes admin, dashboard renders
- [ ] Admin invites a doctor → invite appears in the list, token is **not** displayed in a shareable place it should not be
- [ ] Invitee accepts → joins with the doctor role, not admin
- [ ] Accept an already-accepted invite → clear message, no crash
- [ ] Accept an expired invite → clear message naming expiry
- [ ] Sign out clears session; a protected route redirects to sign-in rather than flashing data
- [ ] Wrong password → distinguishable from a network failure (`rules.md` §3.5)

## 2. The core OPD journey — register → consult → prescribe → bill

The flow the API suites already prove. Here the question is whether the screens agree.

- [ ] Billing/reception registers a patient → gets a patient number, appears in search
- [ ] Duplicate phone number → warns and offers "register anyway", does not hard-block
- [ ] Check in → a queue token is displayed
- [ ] Second check-in for the same patient → shows the existing visit, does not create a second token
- [ ] Doctor's queue shows the waiting patient **without a manual refresh** (Realtime)
- [ ] Doctor opens the consultation, saves a note **with only a chief complaint filled in** — no mandatory-field block (`rules.md` §1.7, PRD requirement)
- [ ] Doctor adds prescription items, issues the prescription
- [ ] Prescription PDF opens and shows the drugs
- [ ] Doctor marks the visit done → disappears from the queue live
- [ ] Billing sees pending charges including the consultation fee
- [ ] Raise the invoice → totals shown; GST section present for Sunrise (registered)
- [ ] Invoice PDF opens; GST invoice for Sunrise, **plain bill of supply with no tax section** for Lotus (not registered)
- [ ] Raise the invoice a second time → "already raised" message, navigates to the existing invoice, does **not** create a duplicate (the Phase 5 race — see `docs/security-review-phase5.md` §4)
- [ ] Record payment → status reaches paid

## 3. Clinical safety — must be visible, must fail loud

`rules.md` §3.4. A failed safety check must never look like a passed one.

- [ ] Prescribe an interacting pair → interaction warning is visible
- [ ] Prescribe a drug the patient is allergic to → allergy warning is visible
- [ ] Low-severity finding → inline, **not** a blocking modal (PRD)
- [ ] High-severity finding → hard interrupt requiring acknowledgement
- [ ] **Simulate the safety RPC failing** (offline, or a forced error) → UI shows "interaction check unavailable — verify manually", and does **not** render a clean result
- [ ] A critical lab value produces a visible alert without a refresh
- [ ] Acknowledging an alert records who acknowledged it and clears it from the feed

## 4. Role-based UI — the RLS boundary, seen from the browser

The backend proves the data is denied. This proves the UI does not offer the action.

- [ ] Nurse: no billing or invoice navigation
- [ ] Nurse: cannot reach an invoice screen by typing the URL
- [ ] Billing: no vitals, clinical notes or lab results anywhere
- [ ] Doctor: no admin dashboard, no audit log
- [ ] Admin: dashboard shows revenue, volume, staff activity, reconciliation
- [ ] Patient-portal role: reaches nothing clinical or financial
- [ ] Tier 1 clinic (Sunrise): no ward/bed navigation at all
- [ ] Tier 2 clinic (Lotus): ward and bed screens present and usable
- [ ] For each of the above, a **deep link** to the forbidden route is also refused — hiding a button is not access control (`rules.md` §4.3)

## 5. Tenant isolation, from the browser

- [ ] Signed in to Sunrise, deep-link a Lotus patient id → not-found, never data
- [ ] Same for a visit id, invoice id, prescription id
- [ ] Patient search for a Lotus patient's name returns nothing
- [ ] Two browser contexts, one per clinic, side by side → neither shows the other's queue

## 6. Deactivation

- [ ] Admin deactivates a doctor
- [ ] That doctor's **open session** stops being able to read patient data (their JWT is still valid until expiry — the API returns empty, and the UI must say so rather than render blank panels)
- [ ] The doctor sees an explanatory "account deactivated" screen, **not** empty screens — this is what `profiles_select_self` exists for
- [ ] Reactivation restores access
- [ ] An admin cannot deactivate themselves; the UI explains why
- [ ] The last active admin cannot be deactivated

## 7. IPD (Tier 2, Lotus)

- [ ] Admit a patient to an available bed → bed shows occupied
- [ ] Admit a second patient to the same bed → refused with a clear reason
- [ ] Rounds view shows latest vitals per inpatient
- [ ] Nurse records partial vitals (temperature only) → saves without complaint
- [ ] Task board updates live when a task is completed
- [ ] Discharge frees the bed

## 8. Error handling and UX (`rules.md` §3, §6)

- [ ] No raw Postgres text anywhere in the UI — every mapped code becomes a plain sentence
- [ ] Offline: "no internet connection", distinct from an application error
- [ ] Every write shows a loading state and a success/failure confirmation — no silent saves, especially prescriptions and billing
- [ ] Partial-screen actions use localised spinners, not full-page overlays
- [ ] Patient list and visit history are paginated or virtualised, never fetch-all

## 9. Accessibility

Automated checks catch a minority of real barriers. Note honestly: full WCAG conformance
needs manual testing with assistive technology and expert review; this list is a floor.

- [ ] `@axe-core/playwright` on every primary screen, zero critical violations
- [ ] The whole OPD journey is completable by keyboard alone
- [ ] Every form control has a programmatic label
- [ ] Validation errors are announced, not colour-only
- [ ] Focus moves sensibly on route change and when a modal opens/closes

---

## Suggested layout, when it is built

```
apps/web/e2e/
  fixtures/          auth state per role, reused across specs
  auth.spec.ts               §1
  opd-journey.spec.ts        §2   <- the highest-value file
  clinical-safety.spec.ts    §3
  rbac.spec.ts               §4
  tenant-isolation.spec.ts   §5
  deactivation.spec.ts       §6
  ipd.spec.ts                §7
  errors-and-ux.spec.ts      §8
  a11y.spec.ts               §9
```

Store one signed-in `storageState` per role rather than signing in per test; sign-in is
slow and is already covered by §1.

## Priority if time is short

1. **§2** — the journey the clinic cannot operate without
2. **§4 + §5** — the UI half of the security model; the data half is already proven
3. **§3** — clinical safety must be *visible* to count
4. **§6** — the failure mode is a user who believes they still have access
5. §7, §8, §9

## Definition of done

- All of §2, §4, §5 green against a seeded two-clinic project
- Runs headless in CI on a dedicated project, never the pilot
- Failures produce a trace and a screenshot
- Total runtime under 10 minutes, or it stops being run
