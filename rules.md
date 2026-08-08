# Rules.md
## AI Coding Assistant Rules — Hospital MIS

**Purpose:** This file is the contract for any AI tool (Claude Code, Copilot, Cursor, etc.) working on this codebase. Read this before generating or modifying any code. When in doubt, prefer the simpler, more boring option — this is a solo-developer project on cloud infra with sensitive medical data; cleverness is a liability here, not a feature.

---

## 1. Non-Negotiable Boundaries

These are hard rules. Do not violate them even if a task seems to require it — flag the conflict instead.

1. **Never bypass Row-Level Security (RLS).** No service-role key usage in client-side or Edge Function code unless explicitly instructed for a specific admin-only operation. All tenant data access goes through the authenticated user's session, enforced by RLS — not app-layer `if (tenant_id === ...)` checks.
2. **Never hardcode a `tenant_id` or trust one passed from the client.** It must always be resolved server-side from `auth.uid()` → `profiles.tenant_id`.
3. **Never log or print patient PII/PHI** (name, phone, diagnosis, prescription contents) to console, error trackers, or analytics — not even in development. Use patient IDs or masked identifiers in logs.
4. **Never store secrets, API keys, or Supabase service-role keys in client-side code or in the repo.** Environment variables only, via `.env.local` (gitignored) and Vercel/Supabase project settings.
5. **Never introduce a new backend server, database, or hosting provider** without updating `Architecture.md` first. The stack is Supabase + Vercel — do not add Express servers, separate databases, or alternate hosting "to make something easier."
6. **Never write a migration that drops or alters a column without a stated reason in the commit/PR description.** Medical data — accidental data loss is not an acceptable failure mode.
7. **No mandatory form fields on doctor-facing clinical notes** that would block saving. This is a product requirement, not just a UX preference — enforce at the schema level with nullable columns, not `NOT NULL` constraints, for clinical free-text fields.

---

## 2. Tech Stack — Use This, Not That

| Use | Avoid | Why |
|---|---|---|
| Next.js App Router | Pages Router, Create React App, Vite+React for this app | Matches Architecture.md; consistent patterns |
| Supabase JS client (`@supabase/supabase-js`) | Prisma, Drizzle, raw `pg`, any other ORM | One data-access pattern, RLS-native, less to reason about |
| Tailwind CSS | styled-components, CSS Modules, Sass, MUI, Chakra | Fast, consistent, no design-system overhead |
| React Context + Supabase Realtime | Redux, Zustand, Recoil, React Query (unless a specific caching problem justifies it — ask first) | Avoid state-management sprawl at this scale |
| Native `fetch` / Supabase SDK methods | Axios | One less dependency; Supabase SDK already wraps fetch |
| `date-fns` | `moment.js` | moment is legacy/deprecated; date-fns is lighter |
| Supabase Auth | Firebase Auth, Auth0, NextAuth, custom JWT auth | One auth system, already integrated with RLS |
| Supabase Storage | AWS S3, Cloudinary, Firebase Storage | Keep everything inside one platform for MVP |
| Vitest | Jest | Faster, simpler config, Vite-native |
| next-intl or react-i18next (pick one, don't mix) | Rolling a custom i18n solution | Don't reinvent translation handling |

**Rule of thumb:** if a task seems to need a new library, first check if Supabase, Next.js, or an already-installed package can do it. Only add a new dependency if there's a genuine gap — and state the reason when adding it.

---

## 3. Error Handling Rules

1. **Every Supabase call must check for `error` explicitly** — never assume success. Pattern:
   ```typescript
   const { data, error } = await supabase.from('patients').select('*');
   if (error) {
     // handle explicitly — see below, never swallow silently
   }
   ```
2. **Never swallow errors silently** (no empty `catch {}` blocks, no ignored `error` from Supabase responses). At minimum, surface to a logging utility; user-facing screens must show a clear message.
3. **User-facing error messages must never expose raw database/Postgres error text.** Map known error codes (e.g., RLS violation, unique constraint) to plain-language messages. Example: a unique-constraint violation on patient registration should say "A patient with this phone number already exists" — not the raw Postgres error string.
4. **Clinical-safety-relevant failures must fail loud, not silent.** If a drug-interaction check, allergy check, or critical-lab-value alert fails to load or errors out, the UI must show a visible warning ("Interaction check unavailable — verify manually") rather than silently proceeding as if the check passed. Never let a failed safety check look like a passed one.
5. **Network/offline errors must be distinguished from actual application errors** in the UI copy — since this MVP is cloud-only, a connectivity failure should say so plainly ("No internet connection — please check your network") rather than a generic "Something went wrong."
6. **Every async operation that writes data (insert/update/delete) must show a loading state and a success/failure confirmation.** No silent writes — the user (doctor/nurse/billing) must always know whether their action actually saved, especially for prescriptions and billing entries.
7. **Wrap Edge Functions in try/catch and return structured error responses** (`{ error: { code, message } }`), never raw stack traces to the client.

---

## 4. Multi-Tenancy Rules

1. Every new table **must** include a `tenant_id` column and a corresponding RLS policy before it's used in any code — no table ships without RLS enabled.
2. RLS policies must be tested (manually or via a test script) with at least two different tenant accounts before a feature is considered done — verify tenant A genuinely cannot see tenant B's data.
3. Feature-tier gating (Tier 1/2/3 modules) is read from the `tenants` table and checked **both** in the UI (hide/disable) **and** — for anything sensitive — reflected in RLS/policy logic, not just hidden in the frontend. Hiding a button in the UI is not access control.

---

## 5. Code Style & Structure Rules

1. Follow the folder structure defined in `Architecture.md` — don't introduce parallel structures (e.g., a new `src/` root, a new `components2/` folder) without updating that doc first.
2. Components are role-scoped where they clearly belong to one persona (`components/doctor/`, `components/nurse/`, etc.) — only place something in `components/shared/` if genuinely used by 2+ roles.
3. TypeScript required for all new files. No implicit `any` — if a Supabase table type is missing, generate it via `supabase gen types typescript`, don't hand-write loose types.
4. Keep Supabase queries in `lib/` or `hooks/`, not scattered inline inside components — components call a hook (`usePatientHistory()`), not `supabase.from(...)` directly, so RLS-dependent logic stays centralized and easy to audit.
5. No commented-out code left in commits. No `console.log` left in committed code (use a proper logger utility, and never log PII per Section 1).
6. Every new database migration goes in `supabase/migrations/` with a descriptive filename and is never edited after being applied — write a new migration to change something, don't rewrite history.

---

## 6. Performance & UX Rules (tie back to PRD)

1. Doctor-facing screens (queue, patient history, prescription) must avoid unnecessary re-fetching — use Supabase Realtime subscriptions rather than polling wherever live updates matter (queue status, task board, lab results).
2. No blocking full-page spinners for actions that only affect part of a screen — use localized loading states (e.g., a spinner on the "Save" button, not a full-page overlay) so the rest of the UI stays usable.
3. Any list that could grow large (patient list, visit history) must be paginated or virtualized — never fetch-all by default.
4. Silent-by-default interaction/allergy alerts (per PRD) — do not implement these as blocking modals for low-severity cases; reserve hard interrupts for high-severity only, per the product requirement.

---

## 7. What to Do When Uncertain

- If a task seems to require breaking any rule above, **stop and ask, don't proceed silently.**
- If a library/pattern isn't covered by this file, prefer whatever is already used elsewhere in the codebase over introducing something new.
- If a request conflicts with the PRD or Architecture.md, flag the conflict rather than resolving it unilaterally.
- Default to the simplest implementation that satisfies the requirement — this project prioritizes maintainability by a solo developer over architectural elegance.

---

*This file should be updated whenever a real decision is made that changes tooling, patterns, or boundaries — treat it as a living contract, not a one-time setup doc.*
