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
| Current phase | **Phase 1 — Foundation (Auth & Tenancy)** — backend built & locally verified; awaiting migration push to hosted project |
| Stack | Next.js (App Router) + Tailwind + Supabase (Postgres, Auth, Storage) + Vercel |
| Architecture model | Cloud-hosted, single Supabase project, multi-tenant via `tenant_id` + RLS |
| Offline/local-first | Deferred — see PRD Section 9 |
| Developers | Prince (frontend, Supabase client, auth, role UIs) / Jeet (schema, RLS, business logic, Edge Functions) |
| Dev workflow | Contract-first parallel development — see Workflow.md |
| Supabase project (dev) | ref `udjvbvtxrgrvpnmfvnbk` — live, region unconfirmed (see §6) |
| Last updated | 2026-08-08 |

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

---

## 4. Current State — What's Actually Built

*(Update this section after every merged feature — this is the "what exists right now" ground truth)*

### Done
**Backend / Jeet — Phase 0**
- `supabase/` structure scaffolded at repo root per Architecture.md §5 (`migrations/`, `functions/`, `tests/`, `scripts/`, `types/`, `seed.sql`, `config.toml`)
- Supabase CLI wired up (`npm run db:link` / `db:push` / `db:types`); `.env.example` documents every variable; `.gitignore` added covering `.env*` (verified `.env` was never committed)

**Backend / Jeet — Phase 1 (schema + logic written and locally verified)**
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

### In Progress
- **Auth & Tenancy integration** — backend done pending one blocker: migrations are **not yet applied to the hosted project**, because the supplied credentials are the publishable + secret API keys, which authorise data access but not schema changes. Needs `SUPABASE_ACCESS_TOKEN` (`sbp_…`) or the DB password from Jeet, then `npm run db:push && npm run db:seed:reset && npm run test:rls:remote`
- Prince: login/signup + onboarding UI, buildable now against `docs/contracts/auth-tenancy.md` with `NEXT_PUBLIC_USE_MOCK=true`

### Not Started
- `apps/web` — nothing exists yet (Prince's track: Next.js scaffold, route groups, Vercel deploy, `middleware.ts`, `useTenant()`, i18n)
- Generated DB types (`npm run db:types`) — needs a linked project
- Invite **email delivery** — RPC returns a token, nothing sends it; deliberately Phase 2
- Everything in phases.md Phase 2+ (patients, visits, prescriptions, billing, nurse tasks, IPD, admin dashboards)

---

## 5. Active Contracts (mirrors `docs/contracts/` — keep in sync)

| Feature | Contract status | Backend (Jeet) | Frontend (Prince) | Integrated? |
|---|---|---|---|---|
| Auth & Tenancy | **final** — `docs/contracts/auth-tenancy.md` | **done, locally verified** (128 assertions passing; not yet pushed to hosted project) | not started | no — blocked on migration push |
| Patient Registration | | | | |
| OPD Queue | | | | |
| Prescriptions | | | | |
| Billing | | | | |
| Nurse Tasks | | | | |

*(Add rows as new features get contracts. This table is the fastest way for either dev — or a new AI session — to see exactly what's real vs. planned.)*

---

## 6. Known Issues / Open Risks

*(Running list — add when discovered, remove when resolved with a note on how)*

**Blockers**
- **Migrations not applied to the hosted project.** The `.env` credentials are the publishable + secret API keys; schema changes need a personal access token (`sbp_…`, dashboard → Account → Access Tokens) or the DB password. Until then `tenants`/`profiles`/`invites` do not exist on `udjvbvtxrgrvpnmfvnbk`, the remote RLS suite cannot run, `npm run db:types` cannot run, and Prince must keep `NEXT_PUBLIC_USE_MOCK=true`. Interim workaround: paste the 8 migration files into the dashboard SQL editor in filename order

**Security / correctness risks**
- **"Confirm email" must be ENABLED in Supabase Auth settings.** `accept_invite()` checks that the caller's email is confirmed *and* matches the invite. With auto-confirm on, Supabase stamps `email_confirmed_at` immediately without the user proving inbox ownership, so an attacker who obtained a token could sign up as the invited address and redeem it. Verify in the dashboard before any real clinic is onboarded
- **Local verification uses a PGlite harness with a hand-written `auth` schema stub**, so it does not cover the real GoTrue signup HTTP path, PostgREST's error serialisation, or Supabase's actual `auth` internals. Seams are listed in `supabase/tests/harness/supabase-preamble.sql`. The remote suite exists to close these and has not run yet
- **Signup trigger is a hard dependency of onboarding.** If `on_auth_user_created` ever fails, the user gets an account with no `profiles` row and is locked out of every policy. Surfaced as `PROFILE_MISSING`, which the UI should treat as "alert Jeet", not a normal error

**Open questions carried forward**
- **Project region unconfirmed.** PRD §5.1/§7 want Mumbai (ap-south-1). Set at project creation and not visible from the API keys alone — Jeet to confirm in the dashboard. Moving region later means recreating the project, so worth checking before real data lands
- Supabase free-tier limits for pilot scale still unresolved (PRD §10 Q1) — not yet a constraint at 2 tenants × 4 users
- No audit log yet (planned Phase 4). Role changes and invite acceptances are currently only reconstructible from `invites.accepted_at`/`accepted_by`; there is no record of who changed whose role. Worth revisiting earlier if DPDP compliance work starts before Phase 4

---

## 7. Scope Changes / Cut Features

*(When something planned in the PRD/phases gets deferred or cut, log it here so it's not silently forgotten or silently rebuilt later)*

- ABDM integration confirmed deferred past MVP — see PRD Section 9
- `[2026-08-08]` **Invite email/SMS delivery deferred to Phase 2.** `create_invite()` returns a token; nothing sends it. Phase 1 UI shows the admin a copyable invite link. Logged so it is not mistaken for a bug or silently rebuilt
- `[2026-08-08]` **Multi-tenant membership (one user in two clinics) confirmed out of scope.** `profiles.tenant_id` is single-valued per Architecture.md §9. A second clinic can mint an invite for someone already affiliated, but redeeming it returns `ALREADY_IN_TENANT`. Revisit alongside cross-tenant referrals (PRD §9)
- `[2026-08-08]` **"Remove user from tenant" not built in Phase 1.** No RPC exists, and deleting a tenant is blocked while members remain. Belongs with Phase 4 user management

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

*Last updated: 2026-08-08 — Phase 1 backend (auth & tenancy) built and locally verified; awaiting migration push to the hosted project.*
