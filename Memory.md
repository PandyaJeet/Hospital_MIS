# Memory.md
## Living Project Memory — Hospital MIS

**Purpose:** This is the single file that holds the current, real state of the project — decisions made, what's built, what's pending, what changed and why. Paste this file (or its relevant sections) into any new AI chat/session so the AI has full context instantly, without you re-explaining the project from scratch every time.

**How this file works:**
- This is **not** a static doc — it gets updated every time something real changes (a decision made, a feature shipped, a schema change, a scope cut)
- It is **manually kept in sync** — no tool auto-updates this for you. The protocol in Section 9 tells you exactly when and how to update it, and it's short by design so that's actually sustainable
- Treat it as the project's **short-term + long-term memory combined**: quick-glance current state at the top, full history below

---

## 1. Project Snapshot (always keep this current — read this first)

| Field | Value |
|---|---|
| Project | Hospital MIS for Indian clinics/hospitals |
| Current phase | **Phase 2 — Core OPD Flow** in progress. Phase 1 (Auth & Tenancy) is **complete and live on the hosted project** |
| Stack | Next.js (App Router) + Tailwind + Supabase (Postgres, Auth, Storage) + Vercel |
| Architecture model | Cloud-hosted, single Supabase project, multi-tenant via `tenant_id` + RLS |
| Offline/local-first | Deferred — see PRD Section 9 |
| Developers | Prince (frontend, Supabase client, auth, role UIs) / Jeet (schema, RLS, business logic, Edge Functions) |
| Dev workflow | Contract-first parallel development — see Workflow.md |
| Supabase project (dev) | ref `udjvbvtxrgrvpnmfvnbk` — live, region **ap-south-1 (Mumbai)** confirmed 2026-08-11 |
| Migration access | No personal access token on this machine. `SUPABASE_DB_PASSWORD` is set, so pushes go through the regional pooler: `supabase db push --db-url` against `aws-0-ap-south-1.pooler.supabase.com:5432` (direct `db.<ref>.supabase.co` is IPv6-only and unreachable from WSL) |
| Last updated | 2026-08-11 |

---

## 2. Source-of-Truth Documents (this file summarizes these — refer to them for full detail)

| Doc | Contains |
|---|---|
| `PRD.md` (v2) | Problem, goals, personas, functional requirements, phasing |
| `Architecture.md` | Tech stack, system diagram, folder structure, DB tables overview |
| `rules.md` | AI coding boundaries, error-handling rules, multi-tenancy rules |
| `phases.md` | Full phase breakdown, Prince/Jeet task split, Definition of Done per phase |
| `Workflow.md` | Contract-first parallel dev process, mock-data pattern, git flow |
| `docs/contracts/*.md` | Per-feature contracts (schema + function signatures agreed before building) |

---

## 3. Key Decisions Log (append-only — never delete old entries, they explain "why")

Format: `[Date] Decision — Reason`

- `[Initial]` Chose local-first + CRDT sync architecture (PRD v1) — for true offline resilience across India's connectivity gaps
- `[Revised]` Switched to cloud-hosted Supabase + Vercel (PRD v2) — local-first was too much complexity for a solo/2-dev team to ship fast; offline deferred to post-MVP
- `[Revised]` Rejected PocketBase in favor of Supabase — needed Postgres from day one (no future SQLite concurrency ceiling), cleaner RLS-based multi-tenancy, better Vercel-stack fit
- `[Revised]` Rejected Vercel for backend hosting — Vercel is serverless/stateless, cannot run a persistent process/DB; Supabase handles backend, Vercel handles frontend only
- `[Established]` Multi-tenancy enforced via Postgres RLS + `tenant_id`, not app-layer checks — security boundary must be at the DB level
- `[Established]` Contract-first workflow adopted — Prince and Jeet work in parallel via agreed schema/function contracts + a mock-data switch, not sequential handoff

**Phase 1 — Auth & Tenancy (2026-08-08, Jeet)**

- `[2026-08-08]` **Invite mechanism: unguessable token + `accept_invite()` RPC, invitee never reads the `invites` table** — the invitee has to consume the invite *before* they belong to the tenant, when every tenant-scoped policy correctly excludes them. Opening read access on `invites` so they could find their own row would expose staff emails and roles per clinic. Instead the `token` (uuid v4, 122 bits, delivered out-of-band) is a capability, and a `SECURITY DEFINER` function does the lookup for them. Table stays admin-only
- `[2026-08-08]` **`accept_invite()` requires `email_confirmed_at IS NOT NULL`** — the email-match check is what stops a forwarded token being redeemed by the wrong person, and without confirmation that check is bypassable by simply signing up *as* the invited address. Confirmation is load-bearing, not hygiene (see risk in §6)
- `[2026-08-08]` **Stale invites are refreshed with a *rotated* token, not reused** — "resend invite" must kill the old link, otherwise it silently extends the life of a token that may have leaked
- `[2026-08-08]` **`profiles.role` / `profiles.tenant_id` / `tenants.tier` are not client-writable at all; column-level `GRANT`s enforce it** — an RLS `WITH CHECK` only sees the NEW row, so it cannot express "you may change role but not tenant_id". Granting `authenticated` UPDATE on `role` therefore lets *any* user run `update profiles set role='admin' where id=auth.uid()` and satisfy a self-update policy. `authenticated` now holds UPDATE on `profiles.full_name` and `tenants.name` only
- `[2026-08-08]` **Role assignment moved from a raw admin UPDATE to `admin_set_user_role()`** — consequence of the above. Deviates from phases.md/prompt, which described an RLS-gated update; that shape cannot be made safe
- `[2026-08-08]` **`tenants.tier` is deliberately not admin-writable** — an admin who could raise their own tier would unlock Tier 2/3 modules for free, making the tier gate cosmetic (rules.md §4.3). Tier changes are a platform-owner action via the dashboard (PRD §6.6)
- `[2026-08-08]` **RLS tenancy lookups go through three `SECURITY DEFINER` helpers (`current_tenant_id()`, `current_user_role()`, `is_tenant_admin()`)** — the obvious self-referencing policy on `profiles` throws `42P17 infinite recursion` and makes the table completely unqueryable. Reproduced empirically before settling on this. All three take no arguments and read only `auth.uid()`, so nothing a client sends can influence them (rules.md §1.2)
- `[2026-08-08]` **RPCs return a `jsonb {ok, code, message}` envelope instead of raising** — PostgREST maps an unrecognised SQLSTATE to HTTP 500, so raising would make "you already belong to a clinic" indistinguishable from "the database is down". Split is now: supabase-js `error` = transport/auth/RLS/bug, `data.ok === false` = explainable business rule (rules.md §3.3, §3.5)
- `[2026-08-08]` **Seed is a TypeScript script (`supabase/scripts/seed.ts`), not `seed.sql`** — GoTrue owns `auth.users`; SQL-inserted rows lack the expected password hash format and companion `auth.identities` row, so the accounts exist but cannot log in, which defeats the entire purpose of a dataset meant for multi-session RLS testing. Script drives the real RPCs, so seeding is itself an end-to-end flow check
- `[2026-08-08]` **`CANNOT_DEMOTE_LAST_ADMIN` guard added** — a tenant with zero admins can never invite anyone or change its own settings again, and only Jeet could repair it from the dashboard. Cheap to prevent, expensive to fix
- `[2026-08-08]` **Verification uses PGlite (real PostgreSQL 17.5 compiled to WASM) rather than `supabase start`** — Docker is unavailable on the dev machine and applying migrations to the hosted project needs a personal access token we don't have yet. Without this there would have been zero *executed* verification of ~700 lines of security-critical SQL. The harness reproduces Supabase's roles, `auth` schema and permissive default privileges; seams are documented in `supabase/tests/harness/supabase-preamble.sql`
- `[2026-08-08]` **Supabase CLI + PGlite added as devDependencies at the repo root, pinned exactly** — CLI is the documented migration tool (Architecture.md §8); PGlite exists solely for the offline test harness. Neither is a new backend/ORM/host, so rules.md §1.5 is not engaged

**Phase 2 — Core OPD Flow (2026-08-11, Jeet)**

- `[2026-08-11]` **Tax lives on the LINE ITEM (`tax_category` + `tax_rate`), and an invoice carries a rate-wise summary child table (`invoice_tax_lines`) — never a rate applied to a total.** A single OPD bill mixes a GST-exempt consultation (Notification 12/2017) with taxable medicines (5% after the Sept 2025 GST Council rationalisation, some life-saving drugs exempt). One blended rate on the total produces a *wrong* bill, not an imprecise one — it either taxes an exempt consultation or under-taxes medicine, and the error is invisible once summed. A DB constraint makes an inconsistent category/rate pair unrepresentable
- `[2026-08-11]` **`tenants.gst_registered` defaults to FALSE, and a non-registered tenant gets NO tax lines at all — a bill of supply, not a GST invoice showing zeros.** Whether a clinic charges GST depends on its registration, which depends on turnover (₹20 lakh threshold, ₹10 lakh in some special-category states). A solo doctor below it legitimately issues a non-GST bill. Printing zeroed tax boxes would misrepresent registration status. **This is a per-clinic business decision Jeet must confirm — see §6**
- `[2026-08-11]` **GSTIN is snapshotted onto each invoice at creation.** An invoice is a tax document; a clinic registering later or fixing a GSTIN typo must not retroactively rewrite invoices already handed to patients
- `[2026-08-11]` **`check_prescription_safety()` returns a severity per finding plus an explicit `status` of `complete` | `partial`, never a boolean.** Severity is what lets the UI be silent-by-default and interrupt only on high (PRD §6.1, rules.md §6.4) — a boolean would have made that decision on the frontend's behalf. `partial` exists because an empty findings array is ambiguous in the worst direction: it fires on unresolved drugs (`UNKNOWN_DRUGS`) **and on an empty allergy field** (`NO_ALLERGIES_RECORDED`), because a blank allergy history means nobody asked, not that the patient has none. Genuine failure is a third state (`ok:false, SAFETY_CHECK_UNAVAILABLE`)
- `[2026-08-11]` **`drugs` / `drug_interactions` deliberately have NO `tenant_id`** — a documented exception to rules.md §4.1. That rule governs tenant *business* data; this is shared reference data (paracetamol is paracetamol everywhere). Per-tenant copies would multiply storage, require N-fold corrections, and let clinics silently disagree about an interaction. Isolation is honoured in the other direction: RLS on, read-only to every client including admins, maintained only by migration/service_role
- `[2026-08-11]` **`drugs.interaction_generics` array added** so fixed-dose combinations match single-molecule interaction pairs. Indian prescribing is combination-heavy; matching on `generic_name` alone would mean 'ibuprofen + paracetamol' matches no pair and the ibuprofen–warfarin interaction is silently missed — a false negative of exactly the kind rules.md §3.4 warns about
- `[2026-08-11]` **`drug_interactions` pairs are stored in canonical order (`generic_a < generic_b`), enforced by CHECK.** Without it {warfarin, aspirin} and {aspirin, warfarin} are two rows and a single-ordering lookup misses the interaction
- `[2026-08-11]` **Prescriptions have a `draft` → `issued` lifecycle, and billing fires on `issued`, not per item insert.** Billing per insert breaks ordinarily: a doctor adds a line, mistypes, removes it — and the patient has already been charged for a drug never given. `issued` is the real chargeable event; items are frozen at that point
- `[2026-08-11]` **NO unique index on `patients.phone`.** Two cases break it: a walk-in with no number, and genuinely different people sharing one (a child on a parent's mobile). A hard constraint makes the second unregistrable and pushes the receptionist into inventing fake numbers, which corrupts data far worse than a duplicate. Instead: a generated `phone_normalized` (last 10 digits), soft detection in `register_patient()` returning `DUPLICATE_PATIENT` + the matching records, and an explicit `p_allow_duplicate_phone` override. INSERT is withheld from clients so the check cannot be bypassed
- `[2026-08-11]` **`patients.age_years` alongside nullable `dob`** — many Indian patients state an age, not a date of birth, and back-computing a DOB invents precision nobody gave
- `[2026-08-11]` **Composite FKs `(parent_id, tenant_id)` against a parent `unique (id, tenant_id)` on every Phase 2 child table.** Makes cross-tenant parenting *structurally* impossible rather than merely policy-blocked — the guarantee that survives a future RLS mistake. Verified by attempting the write as the table owner with RLS out of the picture
- `[2026-08-11]` **`clinical_notes` is readable by admin/doctor/nurse but NOT billing, while `prescriptions` IS readable by billing.** Billing does not need a diagnosis to raise an invoice, and a default front-desk grant on clinical notes is what DPDP alignment gets judged on (PRD §7). Prescriptions are the opposite: in an Indian clinic the pharmacy and billing counter are the same desk, and dispensing needs the drug list. Same minimisation principle, different answers
- `[2026-08-11]` **The billing auto-insert triggers are SECURITY DEFINER; nothing else in the write path is.** The user who triggers a charge is the wrong person to author it — a doctor deliberately has no INSERT on `billing_line_items`, so a trigger running as them would fail the policy and the consultation would go unbilled, which is the revenue leakage PRD §3 calls out. Every value written is derived server-side. This is the phase's only stated exception to the no-bypassing-RLS boundary
- `[2026-08-11]` **`check_prescription_safety()` and the two `get_*_for_pdf()` payload functions are SECURITY INVOKER, unlike the rest.** They need no elevated privilege — the caller can already read everything they touch — so least privilege is available and taken. A cross-tenant id simply resolves to nothing
- `[2026-08-11]` **PDF *data* assembly lives in Postgres (`get_prescription_for_pdf` / `get_invoice_for_pdf`), and the Edge Functions are thin renderers that forward the caller's JWT.** Keeps tenant-scoped access under RLS instead of tempting a service-role key inside Deno, and — decisively — means the compliance-sensitive part (totals, tax buckets, whose data) is testable in SQL without deploying anything
- `[2026-08-11]` **Envelope vs plain CRUD, decided per operation.** RPCs where there is branching or a side effect (`register_patient`, `check_in_patient`, `set_visit_status`, `issue_prescription`, `check_prescription_safety`, `create_invoice_for_visit`). Plain table operations for ordinary CRUD — notably **note-taking**, because rules.md §1.7 wants that path frictionless and an RPC that could reject something would work against the requirement
- `[2026-08-11]` **Migrations applied via `supabase db push --db-url` against the `aws-0-ap-south-1` pooler, not `supabase link`.** Only a DB password is available on this machine, not a personal access token; and the direct host `db.<ref>.supabase.co` is IPv6-only and unreachable from WSL. Wrapped in `supabase/scripts/db.ts` so the password comes from `.env` rather than a command line and is scrubbed from all output

---

## 4. Current State — What's Actually Built

*(Update this section after every merged feature — this is the "what exists right now" ground truth)*

### Done
**Backend / Jeet — Phase 0**
- `supabase/` structure scaffolded at repo root per Architecture.md §5 (`migrations/`, `functions/`, `tests/`, `scripts/`, `types/`, `seed.sql`, `config.toml`)
- Supabase CLI wired up (`npm run db:link` / `db:push` / `db:types`); `.env.example` documents every variable; `.gitignore` added covering `.env*` (verified `.env` was never committed)

**Backend / Jeet — Phase 1 (Auth & Tenancy) — COMPLETE AND LIVE**
- All 8 migrations applied to the hosted project; `supabase migration list` shows local and remote in lockstep (`20260808120000`–`20260808120700`)
- `supabase/types/database.types.ts` generated from the hosted schema (3 tables + 7 functions)
- Seed dataset live on the project: 2 tenants (`Sunrise Clinic (seed)`, `Lotus Hospital (seed)`), 4 roles each
- **Remote suite: 39/39 passing** against real GoTrue sessions and real PostgREST — independently re-run, not just re-reported
- Verified on the hosted project that `anon` is correctly denied `EXECUTE` on all 6 public functions (`42501`), i.e. the Phase 1 grant revocations survived the push
- Phase 1 Definition of Done (phases.md) is met end-to-end, including hosted-project verification
- `tenants` + `profiles` tables, RLS enabled in the same migration that creates them
- 9 RLS policies across `tenants` / `profiles` / `invites`; three `SECURITY DEFINER` tenancy helpers
- `on_auth_user_created` trigger: new `auth.users` row → `profiles` row (`tenant_id` NULL, `role` `'pending'`)
- `create_tenant_and_assign_admin()` — first user founds a clinic, becomes admin, one transaction
- `invites` table + `create_invite()` / `accept_invite()` — full admin-invite flow
- `admin_set_user_role()` — the only sanctioned path for writing `profiles.role`
- Column-level grants locking `role`, `tenant_id` and `tier` against client writes
- Seed script producing 2 tenants × 4 roles by driving the real RPCs
- **Cross-tenant isolation suite: 57/57 passing** (incl. a negative control that disables RLS, confirms the leak appears, re-enables, re-asserts)
- **Onboarding + invite suite: 71/71 passing** — every documented error code has an assertion
- `docs/contracts/auth-tenancy.md` written — table shapes, RPC signatures, error-code table, routing map, mock-layer types

**Backend / Jeet — Phase 2 (Core OPD Flow) — SCHEMA COMPLETE AND LIVE**
- 14 migrations (`20260811060000`–`20260811061300`) applied to the hosted project; `supabase migration list` shows all 22 local/remote in lockstep
- 10 new tables, every one with RLS enabled in the migration that creates it: `patients`, `visits`, `clinical_notes`, `drugs`, `drug_interactions`, `prescriptions`, `prescription_items`, `billing_line_items`, `invoices`, `invoice_tax_lines`
- Two more tenancy helpers (`is_tenant_staff()`, `has_tenant_role()`); per-tenant GST/billing settings on `tenants`, per-doctor fee on `profiles`
- RPCs: `register_patient` (soft duplicate detection + per-tenant UHID), `check_in_patient` (per-day token), `set_visit_status` (validated transitions), `issue_prescription`, `check_prescription_safety` (severity per finding), `create_invoice_for_visit` (rate-wise GST), `get_prescription_for_pdf`, `get_invoice_for_pdf`
- Billing auto-capture: consultation charge on entering consultation, medicine charges on issuing a prescription — idempotent, zero manual entry
- Starter drug reference seeded: 50 common Indian OPD drugs, 25 interaction pairs (explicitly **not** a certified database)
- `supabase/types/database.types.ts` regenerated from the live schema: 13 tables, 18 functions
- Edge Functions **written but not deployed** (needs a PAT): `generate-prescription-pdf`, `generate-invoice-pdf`, plus `_shared/{http,pdf,supabase}.ts`
- 4 contract files written: `patient-registration.md`, `opd-queue.md`, `prescriptions.md`, `billing.md`
- **Tests: 381 local assertions + 141 remote, all passing.** Local `test:opd` 131/131, `test:isolation2` 122/122 (incl. a negative control across all 8 Phase 2 tables); remote `test:opd:remote` 102/102 against real GoTrue sessions and real PostgREST
- Two real bugs found and fixed by these suites — see §6

### In Progress
- **Phase 2 integration** — backend done and live; waiting on Prince's UI for the Workflow.md §4 checkpoint. Nothing is blocked on the backend
- Prince: login/signup + onboarding UI, buildable now against `docs/contracts/auth-tenancy.md`. The Phase 1 backend is live, so he can flip `NEXT_PUBLIC_USE_MOCK=false` for auth whenever he's ready

### Not Started
- `apps/web` — nothing exists yet (Prince's track: Next.js scaffold, route groups, Vercel deploy, `middleware.ts`, `useTenant()`, i18n). No integration checkpoint (Workflow.md §4) has happened for any feature yet, because that requires a frontend to flip off the mock
- Invite **email delivery** — RPC returns a token, nothing sends it. Still deferred; explicitly out of scope for Phase 2 (see §7)
- phases.md Phase 3+ (nurse tasks, vitals, IPD/beds, lab orders, admin dashboards)

---

## 5. Active Contracts (mirrors `docs/contracts/` — keep in sync)

| Feature | Contract status | Backend (Jeet) | Frontend (Prince) | Integrated? |
|---|---|---|---|---|
| Auth & Tenancy | **final** — `auth-tenancy.md` | **done & LIVE on hosted project** (128 local + 39 remote assertions passing) | not started | backend verified against the hosted project; the two-sided Workflow.md §4 checkpoint still needs Prince's UI to exist |
| Patient Registration | **final** — `patient-registration.md` | done, tested | not started | pending Prince |
| OPD Queue | **final** — `opd-queue.md` | done, tested | not started | pending Prince |
| Prescriptions | **final** — `prescriptions.md` | done, tested | not started | pending Prince |
| Billing | **final** — `billing.md` | done, tested | not started | pending Prince |
| Nurse Tasks | not written — Phase 3 | not started | not started | no |

*(Add rows as new features get contracts. This table is the fastest way for either dev — or a new AI session — to see exactly what's real vs. planned.)*

---

## 6. Known Issues / Open Risks

*(Running list — add when discovered, remove when resolved with a note on how)*

**Blockers**
- ~~Migrations not applied to the hosted project~~ — **RESOLVED 2026-08-11.** Jeet supplied `SUPABASE_DB_PASSWORD`; all Phase 1 migrations are pushed and `database.types.ts` is generated. Note the resolution was a **DB password, not an access token**: `supabase link` and the Management API still do not work on this machine, so pushes use `--db-url` against the `aws-0-ap-south-1` pooler
- **No personal access token (`sbp_…`) on this machine.** Consequences: (a) Supabase **Edge Functions cannot be deployed** — `supabase functions deploy` requires a token, so the two Phase 2 PDF functions are written and committed but not live; (b) Auth/project *settings* cannot be changed programmatically, only read

**Phase 2 — business decisions needed from Jeet**
- **`tenants.gst_registered` must be confirmed per real pilot clinic.** It defaults to FALSE, which is the safe default (no tax lines computed, invoice renders as a bill of supply). Whether a clinic actually charges GST depends on its registration, which depends on turnover — ₹20 lakh threshold generally, ₹10 lakh in some special-category states. **This cannot be determined from code.** Getting it wrong in either direction produces a legally incorrect invoice: a non-registered clinic issuing a GST invoice, or a registered one omitting tax. Confirm before any clinic bills a real patient
- **HSN/SAC codes are not populated on the seeded drugs.** The column exists and prints on the invoice, but the starter drug list leaves it null. A GST invoice for medicines really wants it. Needs a data pass, not a code change

**Phase 2 — bugs found and fixed (recorded because both were near-misses)**
- ~~`check_prescription_safety()` returned `requires_acknowledgement: null` on a clean check~~ — **FIXED.** `NULL = 'high' OR false` evaluates to NULL in SQL, so the one field that must never be ambiguous was shipping a null in a safety-critical boolean. Now `coalesce`d. Caught by the local suite
- ~~Deleting any user who had accepted an invite was impossible~~ — **FIXED in `20260811061300`.** A latent Phase 1 bug: `invites.accepted_by` is `ON DELETE SET NULL` while `invites_acceptance_consistent` required `accepted_at`/`accepted_by` both-or-neither, so the FK's own cascade action was guaranteed to violate a constraint on the same row. GoTrue surfaced it only as "Database error deleting user". Relaxed to "accepted_by set implies accepted_at set"; the spent-token guarantee is unchanged. **It stayed hidden because a first `db:seed:reset` has no users to cascade — it only appears on the second run.** Lesson: idempotent tooling has to be run twice to actually be tested
- Related: `db:seed:reset` now dismantles Phase 2 clinical/billing data in dependency order before deleting users, because the `ON DELETE RESTRICT` protecting medical records (correctly) blocks user deletion. Verified by running `--reset` twice

**Phase 2 — known limitations**
- **The drug reference is a starter dataset, not clinically reviewed.** 50 drugs, 25 interaction pairs. Absence of a finding is not evidence of safety — which is why the check returns `partial` the moment a prescribed drug falls outside the list. **Needs clinical review or a licensed data source before a real clinic prescribes against it**
- **Allergy matching is textual** against free-text `patients.allergies`, so it can false-positive (a note reading "no penicillin allergy" matches the penicillin tag). Deliberately biased that way — a spurious warning beats a missed allergy — and every finding carries `match_basis` so the clinician can judge. Structured allergy capture is the real fix
- **PDF rendering cannot display Devanagari.** pdf-lib's standard fonts are WinAnsi-encoded; unrepresentable characters degrade to `?` rather than throwing, so the document still generates. PRD §7 requires Hindi in the UI, so the app will be localised before its PDFs are. Needs an embedded Unicode font (Noto Sans Devanagari + fontkit) — a real bundle-size decision, Phase 3
- **PDF rendering itself is unverified.** The data layer behind both PDFs is covered by the suites; the layout code has never executed, because deploying needs a PAT and running locally needs Docker
- **`visits` is not in the `supabase_realtime` publication yet.** Policies support it and Realtime respects RLS, but the queue cannot live-update until a one-line migration adds it. Deliberately deferred until Prince is ready to wire the subscription
- **Clinical note edits overwrite in place** — no amendment history. Belongs with the Phase 4 audit log

**Security / correctness risks**
- ~~"Confirm email" must be ENABLED~~ — **VERIFIED ENABLED 2026-08-11.** `GET /auth/v1/settings` reports `mailer_autoconfirm: false`, i.e. auto-confirm is off and confirmation is required, so `accept_invite()`'s email-match check has teeth. No change was needed. Re-check if anyone edits Auth settings, since the guarantee is a project setting and not enforceable from SQL
- **Local verification uses a PGlite harness with a hand-written `auth` schema stub**, so it does not cover the real GoTrue signup HTTP path, PostgREST's error serialisation, or Supabase's actual `auth` internals. Seams are listed in `supabase/tests/harness/supabase-preamble.sql`. The remote suites now close this gap for both phases and are passing
- **Signup trigger is a hard dependency of onboarding.** If `on_auth_user_created` ever fails, the user gets an account with no `profiles` row and is locked out of every policy. Surfaced as `PROFILE_MISSING`, which the UI should treat as "alert Jeet", not a normal error

**Open questions carried forward**
- ~~Project region unconfirmed~~ — **RESOLVED 2026-08-11: `ap-south-1` (Mumbai)**, which is what PRD §5.1/§7 want. Determined two independent ways without a management token: `db.<ref>.supabase.co` resolves to `2406:da1a:…`, which AWS's published `ip-ranges.json` maps to `2406:da1a::/35 → ap-south-1`; and only the `aws-0-ap-south-1` pooler recognises this project's tenant (other regions' poolers reject it). No action needed
- Supabase free-tier limits for pilot scale still unresolved (PRD §10 Q1) — not yet a constraint at 2 tenants × 4 users
- No audit log yet (planned Phase 4). Role changes and invite acceptances are currently only reconstructible from `invites.accepted_at`/`accepted_by`; there is no record of who changed whose role. Worth revisiting earlier if DPDP compliance work starts before Phase 4

---

## 7. Scope Changes / Cut Features

*(When something planned in the PRD/phases gets deferred or cut, log it here so it's not silently forgotten or silently rebuilt later)*

- ABDM integration confirmed deferred past MVP — see PRD Section 9
- `[2026-08-08]` **Invite email/SMS delivery deferred to Phase 2.** `create_invite()` returns a token; nothing sends it. Phase 1 UI shows the admin a copyable invite link. Logged so it is not mistaken for a bug or silently rebuilt
- `[2026-08-08]` **Multi-tenant membership (one user in two clinics) confirmed out of scope.** `profiles.tenant_id` is single-valued per Architecture.md §9. A second clinic can mint an invite for someone already affiliated, but redeeming it returns `ALREADY_IN_TENANT`. Revisit alongside cross-tenant referrals (PRD §9)
- `[2026-08-08]` **"Remove user from tenant" not built in Phase 1.** No RPC exists, and deleting a tenant is blocked while members remain. Belongs with Phase 4 user management
- `[2026-08-11]` **Invite email/SMS delivery still NOT built, and no longer nominally "Phase 2".** The 2026-08-08 note guessed Phase 2; `phases.md`'s actual Phase 2 charter does not include it, so it was correctly left out. `create_invite()` returns a token and the admin UI shows a copyable link. Revisit alongside the WhatsApp/SMS work
- `[2026-08-11]` **Patient-portal access to clinical data deliberately not built.** The `patient` role matches **zero rows** on every Phase 2 table. That is an explicit deny, not an oversight — a "my own record" view needs its own narrow policy matching a verified link between `auth.uid()` and a patient row, not a widening of the staff policy
- `[2026-08-11]` **Patient merge/delete not built.** Duplicates are preventable-but-permitted by design (shared phone numbers are legitimate), so merging is a real future need — but it has to reconcile visits, prescriptions and invoices already attached. Phase 4
- `[2026-08-11]` **End-of-day reconciliation (PRD §6.3) not built in Phase 2** — `phases.md` places the aggregation work in Phase 4. The data it needs (`billing_line_items` vs `invoices`) is all present
- `[2026-08-11]` **Cancelling an issued prescription has no RPC.** `cancelled` exists in the status enum but nothing transitions into it yet

---

## 8. Glossary / Project-Specific Terms

*(Add terms as they come up, so any new AI session or new team member doesn't have to guess)*

- **Tenant** — one clinic/hospital using the system
- **Tier 1/2/3** — feature-activation levels (solo clinic / small hospital / large hospital), same codebase, gated by tenant flag
- **Contract** — a short agreed spec (schema + function signature) written before a feature is built, enabling parallel work
- **RLS** — Postgres Row-Level Security, the enforcement mechanism for multi-tenant data isolation
- **Pending user** — signed up but not yet in a tenant (`profiles.tenant_id IS NULL`, `role = 'pending'`). A normal, indefinitely valid state, not an error
- **SECURITY DEFINER** — a Postgres function that runs as its owner rather than its caller. Used here to read `profiles` from inside `profiles` policies without triggering infinite RLS recursion, and to perform writes clients are deliberately not granted
- **Envelope** — the `jsonb {ok, code, message}` shape every Phase 1 RPC returns. `ok:false` is an explainable business failure; a supabase-js `error` is a transport/auth/RLS problem or a bug
- **Invite token** — a uuid v4 in `invites.token`, delivered out-of-band, acting as a capability: possession plus a matching confirmed email is what authorises joining a tenant
- **PGlite** — PostgreSQL compiled to WebAssembly, run in-process by the local test suites so RLS can be verified with no Docker and no credentials
- **UHID / `patient_number`** — the per-tenant serial patients are identified by at the front desk. Restarts at 1 for each clinic; a uuid is unusable for someone reading a paper slip
- **Token / `queue_number`** — the per-tenant, per-**day** OPD queue number. Resets each morning
- **Pending charge** — a `billing_line_items` row with `invoice_id IS NULL`. "Pending charges" is therefore a query, not a status field that could drift
- **`is_auto`** — marks a charge captured automatically by a trigger rather than typed by billing staff. Phase 2's Definition of Done means these should be the norm and manual lines the exception
- **Bill of supply** — the document a clinic that is *not* GST-registered must issue: no GSTIN, no tax section at all. Distinct from a GST invoice showing zeros, which would misrepresent registration status
- **`exempt` vs `non_gst`** — both carry a zero rate but mean different things. `exempt` = a GST-registered clinic supplying an exempt healthcare service. `non_gst` = the clinic is not registered, so GST does not apply at all
- **Rate-wise tax summary** — `invoice_tax_lines`, one row per (category, rate) on an invoice. `invoices.tax_total` is the sum of these, never a rate applied to `subtotal`
- **`partial` safety check** — the check ran but could not see everything (a drug outside the reference list, or an empty allergy history). Must be surfaced as "verify manually"; it is not a clean result
- **Negative control** — the step in each isolation suite that disables RLS, confirms the cross-tenant leak actually appears, then re-enables it. Proves the passing assertions are not vacuous

---

## 9. Update Protocol — When and How to Update This File

Update this file whenever any of the following happens:

1. **A real decision is made** (tech choice, scope change, architecture change) → add to Section 3
2. **A feature is completed/merged** → move it from "In Progress" to "Done" in Section 4, mark integrated in Section 5
3. **A new contract is written** → add a row to Section 5
4. **A bug/risk is discovered or resolved** → update Section 6
5. **Something planned gets cut or deferred** → log it in Section 7, don't just delete it from other docs silently
6. **At the start of a new AI chat session working on this project** → paste this file in first, so the AI has full context before you ask it to do anything

**Keep entries short.** This file is meant to be skimmed in under 2 minutes to fully re-orient anyone (including a fresh AI session) on where the project stands. Long explanations belong in the source-of-truth docs (Section 2) — this file just points to them and logs the headline.

---

*Last updated: 2026-08-11 — Phase 1 confirmed live end-to-end; Phase 2 (Core OPD Flow) backend built, pushed to the hosted project, and verified with 381 local + 141 remote assertions. Outstanding: Edge Function deployment (needs a personal access token) and the per-clinic GST-registration decision.*
