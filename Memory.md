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
| Current phase | Phase 0 — Scaffolding (frontend foundation largely done; backend not yet started) |
| Stack | Next.js 16 (App Router) + Tailwind v4 + Supabase (Postgres, Auth, Storage; `@supabase/ssr`) + Vercel |
| Architecture model | Cloud-hosted, single Supabase project, multi-tenant via `tenant_id` + RLS |
| Offline/local-first | Deferred — see PRD Section 9 |
| Team | Two tracks working contract-first in parallel: frontend and backend — see Workflow.md |
| Dev workflow | Contract-first parallel development — see Workflow.md |
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
- `[2026-08-08]` Scaffolded frontend at `apps/web` with Next.js 16 App Router + Tailwind v4 + TypeScript — matches Architecture.md folder structure (monorepo with `apps/web`)
- `[2026-08-08]` Adopted `@supabase/ssr` for browser + server clients — the legacy auth-helpers are deprecated; SSR package is the current App Router pattern
- `[2026-08-08]` Implemented Design.md tokens via Tailwind v4 CSS-first `@theme` (no `tailwind.config.js`) — v4 uses CSS-based config; same token values as Design.md §10
- `[2026-08-08]` Form validation errors styled with `warning` (amber), not `critical` red — Design.md §2 reserves red exclusively for clinical urgency
- `[2026-08-08]` Consolidated to a single git repo at the workspace root and connected it to the shared GitHub remote — replaces the nested per-app repo left by create-next-app

---

## 4. Current State — What's Actually Built

*(Update this section after every merged feature — this is the "what exists right now" ground truth)*

### Done
- **Frontend scaffold** (`apps/web`): Next.js 16 (App Router) + Tailwind v4 + TypeScript; six role route groups `(auth)/(doctor)/(nurse)/(billing)/(admin)/(patient)` with placeholder pages; temporary `/` route index and `/ui-preview` page.
- **Supabase client boilerplate** (`lib/supabase/`): `client.ts` (browser), `server.ts` (server, cookie-based via `@supabase/ssr`), placeholder `types.ts` (to be replaced by generated types). `.env.example` documents required env vars.
- **Design system**: Design.md tokens in Tailwind v4 `@theme`; Inter + Noto Sans Devanagari fonts; `cn()` util; shared UI primitives in `components/ui/` (Button, Card, Badge, Input, Skeleton, Spinner, EmptyState).
- **App shell**: responsive sidebar + top bar (`components/shared/app-shell.tsx`) with per-role nav (`lib/navigation.ts`), wrapping the doctor/nurse/billing/admin route groups; minimal patient layout; auth pages standalone.
- **Mock-data switch** (`lib/data/`): `USE_MOCK` flag + shared `AppError`/`Result<T>` types (Workflow.md §3).

### In Progress
- Git consolidation + first push of Phase 0 frontend to the shared repo.

### Not Started
- **Backend** (all pending): Supabase project creation, schema, migrations, RLS policies, triggers, Edge Functions, seed data.
- **Phase 1**: real auth (login/onboarding UI wired to Supabase Auth), `middleware.ts` role routing, `useTenant()` against real data, i18n scaffold (Hindi + English).
- **Vercel deploy** + CI/CD confirmation (Phase 0 remaining item).
- Everything in Phase 2+.

---

## 5. Active Contracts (mirrors `docs/contracts/` — keep in sync)

No feature contracts written yet. First contract to draft at the start of Phase 1 (Auth & Tenancy).

| Feature | Contract status | Backend | Frontend | Integrated? |
|---|---|---|---|---|
| Auth & Tenancy | not started | not started | not started | no |
| Patient Registration | not started | not started | not started | no |
| OPD Queue | not started | not started | not started | no |
| Prescriptions | not started | not started | not started | no |
| Billing | not started | not started | not started | no |
| Nurse Tasks | not started | not started | not started | no |

---

## 6. Known Issues / Open Risks

*(Running list — add when discovered, remove when resolved with a note on how)*

- Frontend is not yet integrated with a real backend — everything runs against mock data / placeholders. Supabase project does not exist yet.
- Turbopack prints a "root" warning during build (a stray `package-lock.json` in the home directory was picked up). Should clear after git consolidation; set `turbopack.root` in `next.config.ts` if it persists.
- Design.md token naming produces doubled text-color utilities (`text-text-primary` / `-secondary` / `-disabled`) — intentional but slightly awkward; rename later if desired.
- Pushing to the shared repo requires collaborator write access + configured git credentials.
- Supabase free-tier limits for pilot scale still unknown — open question from PRD Section 10.

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
