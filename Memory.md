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
| Current phase | Phase 1 in progress — frontend building against mocks; backend not yet started |
| Stack | Next.js 16 (App Router) + Tailwind v4 + Supabase (Postgres, Auth, Storage; `@supabase/ssr`) + Vercel; i18n via next-intl |
| Architecture model | Cloud-hosted, single Supabase project, multi-tenant via `tenant_id` + RLS |
| Offline/local-first | Deferred — see PRD Section 9 |
| Team | Two tracks working contract-first in parallel: frontend and backend — see Workflow.md |
| Dev workflow | Contract-first parallel development; frontend runs on mocks via `NEXT_PUBLIC_USE_MOCK` — see Workflow.md |
| Repo | Single repo at root; frontend work on branch `prince/phase-0-frontend` (not yet merged to `main`) |
| Last updated | 2026-08-08 |

---

## 2. Source-of-Truth Documents (this file summarizes these — refer to them for full detail)

| Doc | Contains |
|---|---|
| `PRD.md` (v2) | Problem, goals, personas, functional requirements, phasing |
| `Architecture.md` | Tech stack, system diagram, folder structure, DB tables overview |
| `rules.md` | AI coding boundaries, error-handling rules, multi-tenancy rules |
| `phases.md` | Phase breakdown + Definition of Done per phase |
| `Workflow.md` | Contract-first parallel dev process, mock-data pattern, git flow |
| `docs/contracts/*.md` | Per-feature contracts (schema + function signatures agreed before building) |

---

## 3. Key Decisions Log (append-only — never delete old entries, they explain "why")

Format: `[Date] Decision — Reason`

- `[Initial]` Chose local-first + CRDT sync architecture (PRD v1) — for true offline resilience across India's connectivity gaps
- `[Revised]` Switched to cloud-hosted Supabase + Vercel (PRD v2) — local-first was too much complexity for a small team to ship fast; offline deferred to post-MVP
- `[Revised]` Rejected PocketBase in favor of Supabase — needed Postgres from day one (no future SQLite concurrency ceiling), cleaner RLS-based multi-tenancy, better Vercel-stack fit
- `[Revised]` Rejected Vercel for backend hosting — Vercel is serverless/stateless, cannot run a persistent process/DB; Supabase handles backend, Vercel handles frontend only
- `[Established]` Multi-tenancy enforced via Postgres RLS + `tenant_id`, not app-layer checks — security boundary must be at the DB level
- `[Established]` Contract-first workflow adopted — frontend and backend tracks build in parallel against agreed schema/function contracts + a mock-data switch, not sequential handoff
- `[2026-08-08]` Scaffolded frontend at `apps/web` with Next.js 16 App Router + Tailwind v4 + TypeScript
- `[2026-08-08]` Adopted `@supabase/ssr` for browser + server clients — the legacy auth-helpers are deprecated
- `[2026-08-08]` Implemented Design.md tokens via Tailwind v4 CSS-first `@theme` (no `tailwind.config.js`)
- `[2026-08-08]` Form validation errors styled with `warning` (amber), not `critical` red — Design.md §2 reserves red for clinical urgency
- `[2026-08-08]` Consolidated to a single git repo at root and connected the shared GitHub remote
- `[2026-08-08]` i18n via next-intl, cookie-based (no URL locale segments) — fits an authenticated app without restructuring routes; supports English, Hindi, Gujarati
- `[2026-08-08]` Phase 1 UI built mock-first behind `USE_MOCK` (contract-first); frontend-proposed contracts drafted in `docs/contracts/` for the backend to confirm
- `[2026-08-08]` Two data-fetch patterns in use: a client hook (`useQueue`, ready for Supabase Realtime) and server-component fetch (patient chart)

---

## 4. Current State — What's Actually Built

*(Update this section after every merged feature — this is the "what exists right now" ground truth)*

### Done (frontend, all against mocks)
- **Phase 0 scaffold**: Next.js 16 + Tailwind v4 + TS at `apps/web`; six role route groups; Supabase client/server boilerplate; role-based app shell (sidebar + top bar).
- **i18n**: next-intl (cookie-based), English + Hindi + Gujarati, top-bar language switcher, translation-driven shell.
- **Design system + primitives** (`components/ui`): Button, Card, Badge, Input, Textarea, Skeleton, Spinner, EmptyState.
- **Auth screens** (mock): login, onboarding.
- **Feature screens** (mock): patient registration (billing), OPD queue (doctor; `useQueue` hook), patient chart (server-rendered, read-only), prescribe (doctor; dynamic medication list).
- **Contracts drafted** (frontend-proposed) in `docs/contracts/`: auth-tenancy, patient-registration, opd-queue, patient-chart, prescriptions.
- **Navigable slice**: register → queue → chart → prescribe.

### In Progress
- Awaiting direction / backend availability. Frontend is unblocked via mocks.

### Not Started
- **Backend** (all pending): Supabase project, schema, migrations, RLS policies, triggers, Edge Functions (incl. PDF generation), seed data.
- Real auth session + `middleware.ts` role route guards (routes currently reachable directly; mock UI only).
- Screens: billing/invoice, reconciliation, nurse tasks, admin (dashboard/users/settings).
- Vercel deploy + CI/CD confirmation (Phase 0 remaining item).
- **Integration**: flipping `USE_MOCK` off and wiring `lib/data/*` to the real backend.

---

## 5. Active Contracts (mirrors `docs/contracts/` — keep in sync)

Statuses: contract *drafted* = frontend-proposed spec exists; *mock built* = UI works against a mock; backend *not started*.

| Feature | Contract | Backend | Frontend | Integrated? |
|---|---|---|---|---|
| Auth & Tenancy | drafted | not started | mock built | no |
| Patient Registration | drafted | not started | mock built | no |
| OPD Queue | drafted | not started | mock built | no |
| Patient Chart | drafted | not started | mock built | no |
| Prescriptions | drafted | not started | mock built | no |
| Billing | not started | not started | not started | no |
| Nurse Tasks | not started | not started | not started | no |

Each contract lists open questions for the backend that must be resolved before integration.

---

## 6. Known Issues / Open Risks

*(Running list — add when discovered, remove when resolved with a note on how)*

- The five drafted contracts are **frontend-proposed and awaiting backend confirmation** — their open questions (session/JWT claims, drug catalog, visit linkage, etc.) must be settled before integration, or `lib/data/*` will need rework.
- Hindi + Gujarati strings are developer-written — need a native-speaker review before the pilot (especially domain terms like "reconciliation").
- No real auth session or route guards yet — every role route is directly reachable. This is expected until the backend + middleware land.
- `prince/phase-0-frontend` is several commits deep and not yet merged to `main` (which is only the initial README). Consider opening a PR as a checkpoint.
- Supabase project not yet created; frontend not yet integrated with real data.
- Turbopack prints a "root" warning (a stray `package-lock.json` in the home directory). Harmless; set `turbopack.root` if it becomes annoying.

---

## 7. Scope Changes / Cut Features

*(When something planned in the PRD/phases gets deferred or cut, log it here so it's not silently forgotten or silently rebuilt later)*

- ABDM integration confirmed deferred past MVP — see PRD Section 9.
- Offline/local-first operation deferred past MVP — see PRD Section 9.

---

## 8. Glossary / Project-Specific Terms

*(Add terms as they come up, so any new AI session or new team member doesn't have to guess)*

- **Tenant** — one clinic/hospital using the system
- **Tier 1/2/3** — feature-activation levels (solo clinic / small hospital / large hospital), same codebase, gated by tenant flag
- **Contract** — a short agreed spec (schema + function signature) written before a feature is built, enabling parallel work
- **RLS** — Postgres Row-Level Security, the enforcement mechanism for multi-tenant data isolation
- **USE_MOCK** — `NEXT_PUBLIC_USE_MOCK` flag; when true the UI runs against mock data in `lib/data/*` instead of the real backend

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

*Last updated: 2026-08-08*
