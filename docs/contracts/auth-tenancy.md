# Contract: Auth & Tenancy

- **Status:** Draft (frontend-proposed) — awaiting backend confirmation
- **Phase:** 1
- **Frontend (mock):** `apps/web/lib/data/auth.ts` (behind `USE_MOCK`), consumed by `app/(auth)/login` and `app/(auth)/onboarding`
- **Backend:** not started

## Purpose

A user can sign up (creating a clinic = tenant), sign in, receive a role + tenant, and land on their role's home screen. Multi-tenant isolation is enforced by Postgres RLS, never by app-layer checks (rules.md §1, §4).

## Tables (backend to finalize)

### `tenants`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | `default gen_random_uuid()` |
| `name` | text, not null | clinic / hospital name |
| `tier` | int, not null, default 1 | feature tier 1/2/3 |
| `created_at` | timestamptz | `default now()` |

### `profiles`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | equals `auth.users.id` (FK) |
| `tenant_id` | uuid, not null | FK → `tenants.id` |
| `role` | text, not null | one of `doctor` / `nurse` / `billing` / `admin` |
| `full_name` | text | |
| `created_at` | timestamptz | `default now()` |

- **RLS:** every tenant-scoped table carries `tenant_id`; policies restrict rows to the caller's `tenant_id`.
- A DB trigger should insert a `profiles` row when a new `auth.users` row is created.

## Shared types (frontend)

```ts
type Role = "doctor" | "nurse" | "billing" | "admin";
interface AuthUser { userId: string; role: Role; tenantId: string; }
```

## Functions (frontend-facing)

All return `{ data, error }` (`Result<T>`); `error` is `{ code, message, fields? }`.

| function | input | success | error codes |
|---|---|---|---|
| `signIn` | `{ email, password }` | `AuthUser` | `INVALID_CREDENTIALS` |
| `createTenantAndOwner` | `{ clinicName, fullName, email, password }` | `AuthUser` (role = `admin`) | `EMAIL_TAKEN`, `WEAK_PASSWORD` |
| `signOut` | — | `void` | — (to be added) |

**Session:** cookie-based via `@supabase/ssr`. A `middleware.ts` guard (Phase 1, pending) redirects unauthenticated users to `/login` and sends authenticated users to their role home (`lib/roles.ts` → `roleHomePath`).

## Error codes → UI message keys

| code | meaning | UI key |
|---|---|---|
| `INVALID_CREDENTIALS` | wrong email/password | `auth.login.invalidCredentials` |
| `EMAIL_TAKEN` | email already registered | `auth.onboarding.emailTaken` |
| `WEAK_PASSWORD` | fails password policy | `auth.validation.passwordTooShort` |

The UI maps `code` → a translated message and never displays raw Postgres/Supabase error text (rules.md §3).

## Current mock behavior (`lib/data/auth.ts`)

- `signIn`: password `"password"` succeeds; role derived from the email prefix (`admin@… → admin`, `nurse@…`, `billing@…`), defaulting to `doctor`. Any other password → `INVALID_CREDENTIALS`.
- `createTenantAndOwner`: succeeds as `admin`; email `taken@clinic.test` → `EMAIL_TAKEN`.

## Open questions for backend

1. Session/JWT: confirm the `@supabase/ssr` cookie approach. Are `tenant_id` and `role` exposed as JWT claims, or resolved by querying `profiles` on each request?
2. Is `role` a single column on `profiles`, or should we plan for multi-role staff (a `user_roles` join table)?
3. Onboarding: one atomic RPC (`create_tenant_and_owner`) or `auth.signUp` followed by a tenant-creation call?
4. Is email confirmation required for the pilot, or should new users be auto-confirmed?
5. Where is the password policy enforced (Supabase Auth settings), and what is the minimum length? (UI currently assumes ≥ 6.)
