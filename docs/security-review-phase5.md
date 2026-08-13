# Phase 5 Security Review — RLS Penetration Test & Compliance Sweep

**Project:** `udjvbvtxrgrvpnmfvnbk` (Supabase hosted, `ap-south-1`), Postgres 17.6
**Date:** 2026-08-12
**Scope:** hardening only. No features added. One migration written — `20260811090000` — which fixes a race the testing found.

---

## 1. Result

| | |
|---|---|
| Relations attacked | **33** — 24 tables, 9 views (the entire `public` schema) |
| Hostile role states | **9** |
| Generated attack attempts | **477** |
| **Cross-tenant leaks found** | **0** |
| Concurrency scenarios | 7 |
| **Concurrency defects found** | **1 — duplicate invoices. Fixed.** |
| `rules.md` §1/§4 violations | 0 |

Tenant isolation held under every attack attempted, including nine role states against
every relation, and including a negative control proving the result depends on RLS rather
than on empty fixtures. The single real defect Phase 5 found was not an isolation failure
— it was a **concurrency** failure in invoice creation, invisible to four phases of
sequential testing. It is described in §4 and fixed.

Two findings are *not* clean and are not buried: the backup posture is unverified
(`docs/backup-and-restore.md` §6), and an earlier version of the DELETE attack matrix in
this very suite passed vacuously (§3.3).

---

## 2. Coverage matrix — how it is built, and why that matters

`test:rls`, `test:isolation2`, `test:isolation3` and `test:phase4` already assert
cross-tenant denial with negative controls. They are all **hand-written**: each asserts
the cells its author thought of. "We have a lot of isolation tests" and "every relation ×
operation × role state is covered" are different claims, and only the second is something
a security review can assert.

`supabase/tests/local/phase5-pentest.test.ts` therefore enumerates the attack surface from
`pg_class` **at runtime** and loops. Consequences:

- a table added in a later phase is attacked automatically, and fails here if it has no
  RLS or leaks — instead of being silently untested until someone remembers to write a case;
- the attempt count is a measured number rather than an impression.

### 2.1 The relation axis — 33 relations, enumerated not listed

24 tables, 9 views. Established by the same query the suite runs, and independently
confirmed by `verify:catalog` group 17, which fails if fewer than 24 tables or 9 views are found.

- **All 24 tables have RLS enabled.** Asserted per-table from the catalogue.
- **All 9 views are `security_invoker`.** A view without it executes as its owner
  (`postgres`, exempt from RLS) and would report every clinic's data to whoever asked.
- **`anon` has SELECT on nothing** — no table, no view.
- **Exactly 4 tables have no `tenant_id`**, each for a stated reason:
  `drugs`, `drug_interactions`, `lab_critical_ranges` are shared reference sets (the
  documented exception to `rules.md` §4.1 — paracetamol is paracetamol everywhere; RLS is
  still on and they are read-only to every client), and `tenants` is scoped by its own
  `id`, being the tenant. The suite asserts this list is *exactly* those four, so a table
  that escaped tenant scoping fails immediately.

### 2.2 The role axis — 9 states, and two threat models kept separate

| Role state | Threat model | Legitimately visible |
|---|---|---|
| cross-tenant admin (B) | isolation | nothing |
| cross-tenant doctor (B) | isolation | nothing |
| cross-tenant nurse (B) | isolation | nothing |
| cross-tenant billing (B) | isolation | nothing |
| patient role (A) | in-tenant least privilege | own `profiles` row + own `tenants` row |
| pending user (no tenant) | in-tenant least privilege | own `profiles` row |
| DEACTIVATED admin (A) | in-tenant least privilege | own `profiles` row |
| DEACTIVATED doctor (A) | in-tenant least privilege | own `profiles` row |
| anon | isolation | nothing |

Conflating these two models is what produces false findings. A cross-tenant user must see
**zero** rows. An in-tenant low-privilege user is genuinely a member of the clinic, and a
small, exact set of rows is legitimately theirs:

- `profiles_select_self` deliberately lets **any** user read their own row, including a
  patient-role and a deactivated one. This is load-bearing, not an oversight: it is the
  only thing that lets the UI say "your account was deactivated" instead of rendering
  empty screens.
- A patient-role user may read their clinic's own `tenants` row, which is what drives
  `useTenant()` (name, tier, branding — `Architecture.md` §4).

The suite states each role's allowlist and asserts it is exact **in both directions** — a
role that stopped being able to read its own profile is also a regression. A blanket
"sees nothing" would have produced four false failures and been the weaker assertion.

**Two of these role states had no prior systematic coverage.** Phase 4 introduced
`is_active` as an entirely new access dimension, enforced inside seven tenancy helpers,
and tested a deactivated *doctor* against six tables. A deactivated **admin** — against
the audit log and the seven reporting views, the surfaces only an admin can reach at all
— had never been attempted.

### 2.3 The operation axis

| Operation | How covered | Attempts |
|---|---|---|
| SELECT | generic loop, 33 relations × 9 roles | 297 |
| DELETE | generic loop, 20 tenant-scoped tables × 9 roles | 180 |
| INSERT / UPDATE escalation | hand-written (§7 of the suite) — a generic loop cannot build a valid payload for 33 relations | targeted |
| RPC with cross-tenant argument | hand-written, 16 RPCs | 16 |
| **Total generated** | | **477** |

Outcome breakdown, and it reconciles exactly:

```
empty            264   = 8 authenticated roles x 33 relations (SELECT, nothing unauthorised)
denied-42501     173   =  33 (anon SELECT, all relations)
                       + 140 (DELETE: 20 tables x anon, plus 15 no-grant tables x 8 roles)
blocked-0-rows    40   =   5 DELETE-granted tables x 8 authenticated roles,
                           statement permitted but RLS filtered it to zero rows
LEAKED             0
```

The `denied-42501` / `blocked-0-rows` split is the interesting one. Five tables grant
DELETE to `authenticated` (`beds`, `billing_line_items`, `invites`, `invoices`,
`prescription_items`), so a cross-tenant DELETE there is syntactically allowed and must be
stopped by the *policy* rather than the grant. Those are the 40 cells where RLS is the only
thing standing between an attacker and destroyed patient records, and all 40 held.

### 2.4 Negative control

With RLS disabled, clinic B's doctor reaches clinic A's rows in **20 of 20** tables; with
it restored, zero. Without this, a matrix could report a clean pass because the fixtures
were empty. Every suite in this project carries the same control.

---

## 3. Attacks attempted

### 3.1 Held on the first attempt

Reported plainly, because a clean result is a real result:

| Attack | Outcome |
|---|---|
| Cross-tenant SELECT, 33 relations × 9 roles | 0 rows leaked |
| Cross-tenant DELETE, 20 tables × 9 roles | 0 rows destroyed |
| 16 client RPCs called with another clinic's real ids | every one returned a `*_NOT_FOUND` / `USER_NOT_IN_TENANT` envelope |
| `check_prescription_safety()` on another clinic's patient | `PATIENT_NOT_FOUND`, and `ok:false` — it does **not** return a clean bill of health for a patient it cannot see (`rules.md` §3.4) |
| Reach vitals through `rounds_overview` as billing | no vitals value reachable; billing is excluded from the underlying table and the view does not launder it |
| Reach lab results through `critical_lab_alerts` as billing | 0 rows |
| 7 admin reporting views as doctor / nurse / billing | 0 rows each (21 cells) |
| 7 admin reporting views as a **deactivated admin** | 0 rows each |
| Deactivated admin reading `audit_log` | 0 rows |
| Deactivated admin reactivating themselves | `NOT_ADMIN` |
| Deactivated admin changing another user's role | `NOT_ADMIN` |
| Parent a clinical note onto another clinic's visit using own `tenant_id` | `23503` — the composite FK, not the policy, catches it |
| Parent a lab order onto another clinic's patient | `23503` |
| Delete an **issued** invoice (DELETE is granted on the table) | refused; policy limits DELETE to `status = 'draft'` |
| Delete line items already attached to an invoice | refused |
| Patient role calling `register_patient` / `check_in_patient` / `create_invoice_for_visit` / `admin_set_user_active` | all refused |
| `anon` calling the 7 tenancy helpers | no EXECUTE |
| Tier downgrade 3 → 1: can a write sneak through? | writes refused (`42501`), RPC gate returns `TIER_NOT_ENABLED` |
| Tier downgrade 3 → 1: does existing data vanish? | **no, by design** — see §3.2 |

### 3.2 A design decision that had no test until now

`Memory.md` §3 records that Tier 3 table **reads** are deliberately *not* tier-gated, so a
downgrade cannot hide a blood unit reserved for a patient in theatre. That is a
security-relevant choice, and it was previously only written down. It is now asserted in
both directions: after a 3 → 1 downgrade the existing claims and blood units remain
readable, new writes are refused, and clinic B still cannot see any of it.

### 3.3 A finding in the test suite itself

**The first version of the cross-tenant DELETE matrix passed while attempting nothing.**

It read each table's baseline row count using `h.asOwner` from *inside* an `h.asUser`
block. `asOwner` is a bare statement runner over the same PGlite connection — not a
role-switching wrapper — so inside a session it inherits that session's
`set local role authenticated` and was counting **as the attacker**. Every count returned
0, the `if (before === 0) continue` guard skipped every table, and all eight
"destroyed zero rows" assertions passed having issued no DELETE at all.

It was detectable only in the §9 tally: 300 recorded attempts, of which 297 were SELECTs,
meaning the entire DELETE matrix had contributed 3.

Fixed by taking the baseline outside any session and adding a **non-vacuity guard** that
asserts the loop fired `populated × roles` times. The corrected matrix runs 180 DELETE
attempts and still finds zero leaks — so the security conclusion is unchanged, but it is
now actually evidenced.

This is worth recording for what it says about generated coverage generally: a loop that
silently generates nothing is worse than no loop, because it reports a pass. Every
generated matrix needs an assertion about its own size.

---

## 4. The one real defect: duplicate invoices under concurrency

Found by `supabase/tests/remote/concurrency.remote.test.ts` scenario 2.

### What happened

Two simultaneous `create_invoice_for_visit()` calls for the same visit **both succeeded**.

```
invoice #3   ₹500.00   1 line    <- winner: claimed the pending charge
invoice #4   ₹  0.00   0 lines   <- loser: header inserted, nothing left to claim
```

Observed twice on the hosted project, on two different visits.

### Root cause

`create_invoice_for_visit()` (Phase 2, `20260811061100`) did, in order:

1. check for an existing non-cancelled invoice → `INVOICE_ALREADY_EXISTS`
2. count pending charges → `NO_PENDING_CHARGES`
3. `pg_advisory_xact_lock(tenant || ':invoice_number')`
4. allocate `invoice_number = max + 1`
5. insert, claim pending lines, compute totals

**The lock was at step 3; the duplicate check was at step 1.** Both transactions passed
the check before either serialised. The lock did its stated job correctly — numbers came
out 3 and 4, and `invoices_number_unique_per_tenant` never fired. It was in the right place
for gapless numbering and the wrong place to also prevent duplicates.

There was **no unique constraint on `invoices(visit_id)`**. The table's only constraints
were `invoices_pkey`, `invoices_id_tenant_unique`, and `invoices_number_unique_per_tenant`.

### Why this mattered more than a stray empty row

An invoice is a tax document in a legally gapless per-tenant series. The phantom consumed
number #4, so an auditor sees a ₹0 invoice with no line items in the middle of the sequence.

**And nothing would have flagged it.** Phase 4's `billing_reconciliation` view checks
stored totals against line sums (0 = the sum of no lines, so no mismatch) and payment
status against `amount_paid` (draft, 0 paid, so no mismatch). It was silently wrong, and
only a genuinely concurrent test could surface it.

### The fix — `20260811090000_fix_duplicate_invoice_race.sql`

Two layers, because they do different jobs:

1. **`invoices_one_live_per_visit_idx`** — a partial unique index on `(visit_id)` where
   `status <> 'cancelled'`. Makes "one live invoice per visit" an invariant of the
   *database* rather than a property of one function's control flow, so it holds against
   any writer: a future RPC, a service-role backfill, a dashboard edit. The predicate
   matches the RPC's own existence check exactly, so the two cannot disagree — a cancelled
   invoice may legitimately be superseded.
2. **The advisory lock moved ahead of the duplicate check**, making the whole
   check-and-insert one serialised critical section per tenant. This preserves the
   **contract**: the loser blocks, then observes the winner's invoice, and returns the
   documented `INVOICE_ALREADY_EXISTS` envelope. Without it the loser would hit the new
   index and surface a raw `23505`, which `docs/contracts/billing.md` does not document.

Layer 1 alone fixes the data; layer 2 alone fixes the observed race. Both are needed: the
index guarantees the invariant, the lock keeps the API honest. No new deadlock risk — it
is one advisory lock, still taken before any row locks, just earlier, and invoice creation
was already serialised per tenant by this same lock.

The two existing duplicates were **cancelled, not deleted**. An auditor seeing #4 marked
`cancelled` is reading something normal; a missing #4 is a gap in a statutory sequence.

### Verified after the fix

| Check | Result |
|---|---|
| `invoices_one_live_per_visit_idx` exists | yes |
| Visits with more than one live invoice | 0 |
| Duplicates cancelled by the repair block | 2 |
| Live invoices with zero line items | 0 |
| Lock precedes the duplicate check in the deployed function body | yes |
| `test:concurrency` scenario 2 | passes |

### Regression guards added

So this cannot come back silently:

- **`phase4-admin.test.ts` §0c** (12 assertions, local): the index exists, is unique, is
  partial on `cancelled`, and is keyed on `visit_id`; the lock position in `pg_proc.prosrc`
  precedes the duplicate check; a second RPC call returns `INVOICE_ALREADY_EXISTS` naming
  the existing invoice; a direct owner-context INSERT is rejected with `23505` **by that
  index specifically** (using a free invoice number, so the number-series constraint cannot
  cause a false pass); and after cancelling, the visit *can* be invoiced again — which is
  what proves the index is partial rather than over-broad.
- **`verify:catalog` group 16** (3 checks, hosted): the same index and lock-ordering
  properties on the live project, plus a data check that no visit currently holds two live
  invoices.

The lock-ordering assertion reads the function source deliberately. PGlite has a single
backend and cannot reproduce a race, so a future `CREATE OR REPLACE` that moved the lock
back would reintroduce the exact bug with nothing to notice it.

---

## 5. Concurrency results — the other six scenarios

All against the real hosted project with independent connections, because PGlite runs one
in-process backend behind a single connection and cannot produce genuine contention. **35
assertions, 0 failures.**

| # | Scenario | Result |
|---|---|---|
| 1 | Two simultaneous `check_in_patient()`, same patient | exactly one visit; loser got `VISIT_ALREADY_OPEN` with the existing `visit_id` |
| 2 | Two simultaneous `create_invoice_for_visit()` | **failed before the fix**; now exactly one invoice, totals matching lines |
| 3 | Two patients, one bed, simultaneous admits | exactly one admission; loser got `BED_NOT_AVAILABLE`; bed occupied by exactly one visit |
| 4 | 8 simultaneous check-ins (busy OPD morning) | all 8 succeeded, no duplicate tokens, contiguous 3..10 — the lock serialised cleanly |
| 5 | Two nurse sessions writing vitals to one visit, out of order | both rows landed; `visits.last_vitals_at` equalled `max(recorded_at)`, so the older concurrent write did not clobber the newer freshness |
| 6 | Deactivation racing 6 in-flight writes | every write either committed or was cleanly refused; every row that landed was structurally complete; access gone afterwards |
| 7 | Both clinics writing simultaneously | no cross-tenant visibility mid-concurrency |

Scenario 5 is worth noting: the freshness trigger recomputes `max(recorded_at)` from the
table rather than copying `NEW`, and this is the first test that proves the recompute holds
when the writes arrive out of order rather than merely reading correct in sequence.

Scenario 4's contiguous token run is evidence the queue-number lock serialised rather than
collided. Gaplessness is not strictly required — a rolled-back allocation could legitimately
skip — but a contiguous 3..10 under eight-way contention is a strong signal.

---

## 6. `rules.md` §1 / §4 compliance sweep

Every row below was checked by grep or catalogue query, not by recollection.

### §1 — Non-negotiable boundaries

| Rule | Finding |
|---|---|
| **§1.1** never bypass RLS; no service-role in client/Edge code without a stated reason | **PASS.** `SUPABASE_SERVICE_ROLE_KEY` appears in exactly 5 places: `scripts/env.ts` (declaration + accessor), `scripts/seed.ts` (consumer), `scripts/audit-error-codes.ts` (a name in an ignore-list, not a use), and `functions/notify-critical-lab-value/index.ts` — the one stated exception, because a database webhook carries no user JWT. `functions/_shared/supabase.ts` mentions it **only in a comment explaining why it is not used**; it builds an anon client and forwards the caller's bearer token. No other Edge Function holds authority of its own. |
| **§1.2** never trust a client-supplied `tenant_id` | **PASS.** All 7 tenancy helpers resolve from `auth.uid()`, and `verify:catalog` group 13 asserts each is `is_active`-aware. `profiles.tenant_id` is not client-updatable (group 12). |
| **§1.3** never log patient PII/PHI | **PASS, verified line by line.** All 9 `console.*` calls in `supabase/functions/` emit only a request id plus an error *code* or a generic error *kind* — never a message, never a value, never an identifier. The one success log in `notify-critical-lab-value` emits request id, tenant id and a severity label. Caught errors deliberately log `err.name`, not `err.message`, because a PostgREST error body can carry row content. In `supabase/scripts/`, 49 `console.*` calls log fixture emails (`*@hmis-seed.example.com`), tenant names, tenant uuids and counts — **no patient names, phone numbers, or clinical content**, and the seed script never touches patient tables. |
| **§1.4** no secrets in the repo | **PASS.** A pattern scan for `eyJ…` JWTs, `sbp_`, `sb_secret_` and credentialed connection strings across all *tracked* files returns 3 hits, all benign: `.env.example` (literal `xxxx` placeholders), `scripts/db.ts` (a template literal that interpolates from env), `scripts/env.ts` (a doc-string naming the key prefix). `.env` is gitignored and untracked. `db.ts` scrubs the password from all captured CLI output. |
| **§1.5** no new backend/database/host | **PASS.** Dependencies unchanged: `@supabase/supabase-js`, and dev-only `pglite`, `supabase`, `tsx`, `typescript`, `@types/node`. |
| **§1.6** no column drop/alter without a stated reason | **PASS.** `20260811090000` alters data (cancelling 2 duplicate invoices) and drops nothing; the reason, the alternative considered, and why cancel-not-delete, are all in the migration header. |
| **§1.7** no mandatory clinical free-text fields | **PASS.** `verify:catalog` group 7 asserts no `vitals` measurement column is `NOT NULL`, and — so the check is not vacuous — that the four structural columns *are*. |

### §4 — Multi-tenancy

| Rule | Finding |
|---|---|
| **§4.1** every table has `tenant_id` + RLS; no table ships without RLS | **PASS with 4 documented exceptions on the `tenant_id` half.** All **24** tables have RLS enabled — asserted from the catalogue in two independent places (`verify:catalog` group 17, pentest §1), so this cannot drift. The 4 without `tenant_id` are the 3 shared reference sets and `tenants` itself; the pentest asserts the list is *exactly* those four. |
| **§4.2** RLS tested with two tenant accounts before a feature is done | **PASS, and strengthened.** Previously satisfied by four hand-written suites; now also by a 477-attempt matrix over two fully populated clinics, with a negative control. |
| **§4.3** tier gating in RLS, not just the UI | **PASS.** `beds` carries `tenant_has_tier(2)` in 4 policies plus 2 RPC guards; the 3 Tier 3 tables carry `tenant_has_tier(3)` across 9 policies. SELECT is deliberately ungated with a stated reason, and §3.2 now tests that decision. |

### One explicit non-finding

`rules.md` §5.5 says no `console.log` in committed code. The 49 `console.*` calls in
`supabase/scripts/` are **not** a violation: these are CLI tools whose stdout *is* their
interface — a seed script that printed nothing would be unusable. §5.5 governs application
code, where a logger utility belongs. Recorded here so a future sweep does not "fix" it by
silencing the tooling.

---

## 7. Open risks — not closed by Phase 5

| # | Risk | Severity |
|---|---|---|
| 1 | **Backup posture unverified.** Plan tier / PITR state cannot be read without a `SUPABASE_ACCESS_TOKEN`. If the project is on Free there are no backups at all. `docs/backup-and-restore.md` §6 R1. | **blocker for pilot** |
| 2 | **No off-platform copy of the data, and no working way to make one.** `pg_dump`/`psql` absent, Docker down, so `supabase db dump` fails. R2/R4. | high |
| 3 | **Restore has never been rehearsed.** R3. | high |
| 4 | `supabase/types/database.types.ts` is stale — `db:types` needs Docker. Pre-existing since Phase 4. | medium |
| 5 | Edge Functions (2 PDF renderers + the critical-value dispatcher) are written, typed and committed but **never deployed or executed** — `functions deploy` needs the same missing access token. The in-app critical-value alert does not depend on them. | medium |
| 6 | Playwright E2E is **blocked**: it needs `apps/web`, which is Prince's track. `docs/playwright-e2e-spec.md` is the specification; no stub app was built. | medium |
| 7 | `db:seed:reset` bypasses RLS with the service-role key and can delete tenants. Correct as written and scoped to seed fixtures, but it should refuse to run against a project containing non-seed tenants before a pilot. Not changed — a behaviour change, not hardening. | medium |

---

## 8. Verification commands

```bash
npm run test:local      # 8 suites, includes test:pentest — 131 pentest assertions
npm run test:pentest    # 131 passed, 0 failed; 477 attack attempts, 0 leaks
npm run verify:catalog  # 165 checks, 0 failures
npm run audit:codes     # 67/67 error codes documented
npm run db:seed && npm run test:remote   # rls + opd + phase3 + concurrency, hosted
npm run test:concurrency # 35 passed, 0 failed
```

`test:pentest` was added to the `test:local` chain in this phase — it existed but was not
wired in, which is the same class of gap as an untested table. `test:remote` was likewise
only running two of its four suites; `test:phase3:remote` and `test:concurrency` are now
included.
