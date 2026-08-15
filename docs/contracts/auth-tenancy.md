# Contract: Auth & Tenancy

**Feature:** signup, tenant creation, staff invites, role assignment
**Owner (backend):** Jeet · **Owner (frontend):** Prince
**Phase:** 1 (phases.md) · **Format:** Workflow.md §1
**Backend status:** implemented and tested locally against real Postgres. **Not yet applied to the hosted project** — see [Applying this](#applying-this).
**Contract status:** final for Phase 1. If reality diverges, whoever finds it updates this file and pings the other (Workflow.md §4).

---

## 1. What this covers

A person can sign up, then either **found a clinic** (becoming its admin) or **join one they were invited to**. An admin can invite staff and change their roles. Everything is scoped to a tenant by Postgres RLS, so a query that returns nothing is usually correct behaviour, not a bug.

Prince can build the whole onboarding/login UI against this document with `NEXT_PUBLIC_USE_MOCK=true` and never wait for the backend (Workflow.md §3). The TypeScript types in §9 are copy-pasteable into the mock layer.

---

## 2. Tables

All three have RLS enabled. `anon` has **no** access to any of them.

### `tenants` — one clinic/hospital

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `name` | `text` not null | non-blank; trimmed by the RPC |
| `tier` | `smallint` not null | default `1`, constrained to `1..3`. Feature-gating flag (PRD §5.4) |
| `created_at` | `timestamptz` not null | `now()` |

**Client access:** `select` your own tenant. An **admin** may `update` **`name` only**.

> `tier` is **not** writable by anyone through the app, including admins. It is a plan/entitlement flag; if an admin could raise it they would unlock Tier 2/3 modules for themselves, which would make the tier gate cosmetic (rules.md §4.3). Tier changes are a platform-owner action Jeet performs in the Supabase dashboard (PRD §6.6). Read it for feature gating, never try to write it.

**No client `insert`.** Tenants are created only by `create_tenant_and_assign_admin()`.

### `profiles` — extends `auth.users`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | FK → `auth.users(id)` `on delete cascade` |
| `tenant_id` | `uuid` nullable | FK → `tenants(id)`. **NULL until onboarded** |
| `role` | `text` not null | default `'pending'`; one of `pending, admin, doctor, nurse, billing, patient` |
| `full_name` | `text` nullable | lifted from signup metadata `full_name` / `name` |
| `created_at` | `timestamptz` not null | `now()` |

**Client access:** `select` your own row, plus — if you are an **admin** — every row in your tenant. You may `update` **`full_name` only** (your own row; an admin may also fix names within their tenant).

> `role` and `tenant_id` are **not** client-writable, for anyone. An `update profiles set role='admin' where id=auth.uid()` would satisfy a self-update policy, so the privilege is withheld at the column level instead. Use `admin_set_user_role()` for roles; membership is set only by the two onboarding RPCs. A write attempt returns a permission error, not a silent no-op — surface it as an unexpected error, since the UI should never attempt it.

**Invariant:** either (`tenant_id IS NULL` **and** `role='pending'`) or (`tenant_id IS NOT NULL` **and** `role<>'pending'`). There is no half-onboarded state to render.

### `invites` — pending staff invitations

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` not null | FK → `tenants(id)` `on delete cascade` |
| `email` | `text` not null | **stored lowercased + trimmed** (trigger) |
| `role` | `text` not null | one of `admin, doctor, nurse, billing, patient` (never `pending`) |
| `token` | `uuid` not null unique | the capability handed to the invitee |
| `invited_by` | `uuid` not null | FK → `auth.users(id)`, defaults to `auth.uid()` |
| `created_at` | `timestamptz` not null | `now()` |
| `expires_at` | `timestamptz` not null | default `now() + 7 days` |
| `accepted_at` | `timestamptz` nullable | non-null ⇒ spent |
| `accepted_by` | `uuid` nullable | who spent it |

**Client access:** an **admin** may `select` and `delete` (revoke) their own tenant's invites, and `insert` into their own tenant. Everyone else gets nothing — including the invitee.

> The invitee **never reads this table.** At the moment they accept they are still `pending` with `tenant_id IS NULL`, so every tenant-scoped policy correctly excludes them. Opening up read access would expose staff emails and roles per clinic. Instead they hold the unguessable `token` (uuid v4, 122 bits) delivered by email and pass it to `accept_invite()`, which does the lookup on their behalf.

**Constraint:** at most **one outstanding** (unaccepted) invite per `(tenant_id, email)`. Accepted invites remain as history.

---

## 3. Who can see what

Useful when a query returns `[]` and you need to know whether that's a bug.

| Session | `tenants` | `profiles` | `invites` |
|---|---|---|---|
| anon (no JWT) | denied | denied | denied |
| `pending` (signed up, no tenant) | 0 rows | own row only | 0 rows |
| `doctor` / `nurse` / `billing` / `patient` | own tenant (1 row) | own row only | 0 rows |
| `admin` | own tenant (1 row) | all rows in own tenant | own tenant's invites |

A non-admin staff member seeing only themselves in `profiles` is intended. Any "team list" screen is admin-only.

---

## 4. Two error channels — read this before writing error handling

Every RPC below returns a **JSON envelope**, and the two failure modes are deliberately separated:

```ts
const { data, error } = await supabase.rpc('accept_invite', { p_token: token });

if (error)      → transport / auth / RLS / a bug.   Generic message + log it.
if (!data.ok)   → a business rule you can explain.  Map data.code (§6) to copy.
else            → success; data holds the payload.
```

**Why not raise Postgres errors?** PostgREST maps an unrecognised SQLSTATE to **HTTP 500**, so "you already belong to a clinic" would arrive looking identical to "the database is down". Returning expected failures as data keeps them distinguishable, which is what rules.md §3.3 and §3.5 require. `error` is always genuinely exceptional; `data.ok === false` is always something a user can act on.

Both `error` and `!data.ok` must be handled — never assume success (rules.md §3.1).

---

## 5. RPC signatures

### `create_tenant_and_assign_admin(p_tenant_name text) → jsonb`

The "found a clinic" path. Caller must be signed in and **not** already in a tenant. Creates the tenant and promotes the caller to its admin in one transaction.

```ts
const { data, error } = await supabase.rpc('create_tenant_and_assign_admin', {
  p_tenant_name: 'Sunrise Clinic',
});
// success: { ok: true, tenant_id: uuid, tenant_name: string, role: 'admin' }
```

Name is trimmed; max 120 chars; blank rejected.
Failure codes: `NOT_AUTHENTICATED`, `VALIDATION_ERROR`, `ALREADY_IN_TENANT`, `PROFILE_MISSING`.

> After success the caller's `profiles` row has changed. Re-fetch it (or refresh `useTenant()`) before routing — the JWT itself carries no role, so nothing invalidates automatically.

### `create_invite(p_email text, p_role text, p_expires_in_hours int = 168) → jsonb`

Admin-only. Mints a token for the admin's own tenant and returns it so the client can build the invite link.

```ts
const { data, error } = await supabase.rpc('create_invite', {
  p_email: 'nurse@clinic.example',
  p_role: 'nurse',
  // p_expires_in_hours: 72,   // optional, 1..720
});
// success: { ok: true, invite_id, token: uuid, email, role, expires_at, refreshed: boolean }
```

`p_role` ∈ `admin | doctor | nurse | billing | patient`. Email is lowercased/trimmed, so duplicate detection is case-insensitive.

`refreshed: true` means an earlier invite for that address had **expired** and was reissued with a **new token** — the old link is now dead. Say "invite resent", not "invite created".

Failure codes: `NOT_AUTHENTICATED`, `NOT_ADMIN`, `VALIDATION_ERROR`, `ALREADY_MEMBER`, `INVITE_ALREADY_EXISTS`.

**Delivery is not built.** The RPC returns a token; nothing emails it. For Phase 1, show the admin a copyable invite link. Wiring real email/WhatsApp is Phase 2 (see §8).

### `accept_invite(p_token uuid) → jsonb`

Called by a signed-up, **email-confirmed**, still-`pending` user holding a token.

```ts
const { data, error } = await supabase.rpc('accept_invite', { p_token: token });
// success: { ok: true, tenant_id, tenant_name, role }
```

Failure codes: `NOT_AUTHENTICATED`, `VALIDATION_ERROR`, `INVITE_NOT_FOUND`, `INVITE_ALREADY_ACCEPTED`, `INVITE_EXPIRED`, `EMAIL_NOT_CONFIRMED`, `INVITE_EMAIL_MISMATCH`, `ALREADY_IN_TENANT`, `PROFILE_MISSING`.

The invite's email must match the caller's **confirmed** address, so a forwarded link cannot be redeemed by the wrong person. Suggested flow: `/invite/[token]` stores the token, sends the user through signup/login, then calls this on return.

### `admin_set_user_role(p_user_id uuid, p_role text) → jsonb`

Admin-only. Changes the role of an existing member of the caller's tenant. **The only sanctioned way to write `profiles.role`.**

```ts
const { data, error } = await supabase.rpc('admin_set_user_role', {
  p_user_id: userId,
  p_role: 'billing',
});
// success: { ok: true, user_id, role, changed: boolean }
```

`changed: false` means it already had that role — treat as success, no toast needed.
Cannot set `pending`. Cannot remove the tenant's **last** admin (promote a replacement first).
Failure codes: `NOT_AUTHENTICATED`, `NOT_ADMIN`, `VALIDATION_ERROR`, `USER_NOT_IN_TENANT`, `CANNOT_DEMOTE_LAST_ADMIN`.

### Plain table operations (no RPC needed)

```ts
// current user's role + tenant — the first call after login
await supabase.from('profiles').select('id, tenant_id, role, full_name').maybeSingle();

// tenant name + tier for useTenant()
await supabase.from('tenants').select('id, name, tier').maybeSingle();

// admin: staff list
await supabase.from('profiles').select('id, role, full_name').order('role');

// admin: pending invites
await supabase.from('invites')
  .select('id, email, role, expires_at, created_at')
  .is('accepted_at', null);

// admin: revoke an invite
await supabase.from('invites').delete().eq('id', inviteId);

// anyone: edit own display name (the only writable profile column)
await supabase.from('profiles').update({ full_name: name }).eq('id', userId);
```

---

## 6. Error codes → user-facing messages

`code` values are stable; treat them as the contract. Never show raw Postgres text (rules.md §3.3).

| Code | Channel | When | Suggested copy |
|---|---|---|---|
| `VALIDATION_ERROR` | `data` | Bad input. May include `fields: string[]` | Field-level message; highlight `fields` |
| `NOT_AUTHENTICATED` | `data` | No/expired session | "Your session has expired. Please sign in again." |
| `NOT_ADMIN` | `data` | Admin-only action attempted by non-admin | "Only a clinic admin can do this." |
| `ALREADY_IN_TENANT` | `data` | Caller already belongs to a clinic | "You already belong to a clinic." → route to their dashboard |
| `PROFILE_MISSING` | `data` | Account has no `profiles` row (trigger failure) | "Your account isn't fully set up. Please contact support." → **alert Jeet** |
| `ALREADY_MEMBER` | `data` | Inviting someone already on staff | "That person is already part of your clinic." |
| `INVITE_ALREADY_EXISTS` | `data` | A valid invite is already outstanding | "An invite is already pending for this email." Offer revoke + resend |
| `INVITE_NOT_FOUND` | `data` | Unknown/revoked/rotated token | "This invite link isn't valid. Ask your admin for a new one." |
| `INVITE_EXPIRED` | `data` | Past `expires_at` | "This invite link has expired. Ask your admin to resend it." |
| `INVITE_ALREADY_ACCEPTED` | `data` | Token already spent | "This invite has already been used." → offer sign-in |
| `INVITE_EMAIL_MISMATCH` | `data` | Signed-in address ≠ invited address | "This invite was sent to a different email address." |
| `EMAIL_NOT_CONFIRMED` | `data` | `email_confirmed_at` is null | "Please confirm your email address first." → offer resend |
| `USER_NOT_IN_TENANT` | `data` | Target user not in caller's tenant | "That user isn't part of your clinic." |
| `CANNOT_DEMOTE_LAST_ADMIN` | `data` | Would leave the tenant admin-less | "Your clinic needs at least one admin. Promote someone else first." |
| `42501` | `error.code` | RLS/privilege denial | "You don't have permission to do that." → log; usually a UI bug |
| `23505` | `error.code` | Unique violation (e.g. duplicate raw invite insert) | "An invite is already pending for this email." |
| `23514` | `error.code` | Check-constraint violation | Generic error → log; indicates a UI bug |
| `PGRST116` | `error.code` | `.single()` matched 0 rows | Usually means RLS filtered it — treat as empty, not an error |
| *network* | `error` | Fetch failed | "No internet connection — please check your network." (rules.md §3.5 — must be distinguishable from an app error) |

Every code above except the `error.code` rows has an assertion in `supabase/tests/local/onboarding-flow.test.ts`, so none of them are hypothetical.

---

## 7. Onboarding state machine (routing)

```
signUp()  →  trigger creates profiles row (tenant_id NULL, role 'pending')
                       │
        ┌──────────────┴───────────────┐
        │                              │
  no invite token              arrived via /invite/[token]
        │                              │
 create_tenant_and_assign_admin   accept_invite(token)
        │                              │
   role='admin'                 role = invited role
        └──────────────┬───────────────┘
                       ▼
            middleware routes by role
```

For `middleware.ts`: read `profiles.role` server-side.

| Role | Landing |
|---|---|
| `pending` | `/onboarding` — offer "create a clinic" or "enter invite code" |
| `admin` | `/dashboard` |
| `doctor` | `/queue` |
| `nurse` | `/tasks` |
| `billing` | `/register` |
| `patient` | `/queue-status` |

`pending` is a normal state, not an error — a user can sit there indefinitely. Don't redirect-loop it.

---

## 8. Deliberately not in Phase 1

| Not available | Why / when |
|---|---|
| Invite **email delivery** | RPC returns a token; nothing sends it. Show a copyable link. WhatsApp/SMS is Phase 2 (Architecture.md §1) |
| Removing a user from a tenant | No RPC yet. `tenants` delete is blocked while members exist. Phase 4 user management |
| A user belonging to **two** tenants | Out of scope: `profiles.tenant_id` is single-valued (Architecture.md §9). A second clinic can mint an invite, but redeeming it returns `ALREADY_IN_TENANT` |
| Changing `tenants.tier` from the app | Platform-owner action via dashboard (PRD §6.6) |
| Password reset / OTP flows | Standard Supabase Auth, no custom backend needed |
| Generated DB types | `npm run db:types` needs a linked project — blocked, see below |

---

## 9. TypeScript types for the mock layer

Hand-written here **only** so Prince is unblocked today. Once the migrations are pushed, `npm run db:types` generates `supabase/types/database.types.ts` and that becomes authoritative (rules.md §5.3).

```ts
export type Role = 'pending' | 'admin' | 'doctor' | 'nurse' | 'billing' | 'patient';
export type AssignableRole = Exclude<Role, 'pending'>;
export type Tier = 1 | 2 | 3;

export interface Tenant  { id: string; name: string; tier: Tier; created_at: string }
export interface Profile { id: string; tenant_id: string | null; role: Role; full_name: string | null; created_at: string }
export interface Invite {
  id: string; tenant_id: string; email: string; role: AssignableRole; token: string;
  invited_by: string; created_at: string; expires_at: string;
  accepted_at: string | null; accepted_by: string | null;
}

/** Every RPC in this contract returns this envelope. */
export type RpcResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: AuthTenancyErrorCode; message: string; fields?: string[] };

export type AuthTenancyErrorCode =
  | 'VALIDATION_ERROR' | 'NOT_AUTHENTICATED' | 'NOT_ADMIN'
  | 'ALREADY_IN_TENANT' | 'PROFILE_MISSING' | 'ALREADY_MEMBER'
  | 'INVITE_ALREADY_EXISTS' | 'INVITE_NOT_FOUND' | 'INVITE_EXPIRED'
  | 'INVITE_ALREADY_ACCEPTED' | 'INVITE_EMAIL_MISMATCH' | 'EMAIL_NOT_CONFIRMED'
  | 'USER_NOT_IN_TENANT' | 'CANNOT_DEMOTE_LAST_ADMIN';

export type CreateTenantResult = RpcResult<{ tenant_id: string; tenant_name: string; role: 'admin' }>;
export type CreateInviteResult = RpcResult<{
  invite_id: string; token: string; email: string;
  role: AssignableRole; expires_at: string; refreshed: boolean;
}>;
export type AcceptInviteResult = RpcResult<{ tenant_id: string; tenant_name: string; role: AssignableRole }>;
export type SetUserRoleResult  = RpcResult<{ user_id: string; role: AssignableRole; changed: boolean }>;
```

---

## 10. Applying this

Migrations live in `supabase/migrations/` (8 files, `20260808120000`–`20260808120700`), applied in filename order.

```bash
npm install
npm run db:link      # needs SUPABASE_ACCESS_TOKEN
npm run db:push
npm run db:seed:reset
```

**Currently blocked:** the credentials in `.env` are the publishable and secret API keys, which authorise data access but **not** schema changes. `db:link`/`db:push` need a **personal access token** (`sbp_…`, from Supabase dashboard → Account → Access Tokens) or the database password. Until Jeet supplies one, the tables do not exist on the hosted project and `USE_MOCK` must stay on.

Interim option: paste the 8 migration files into the dashboard SQL editor in filename order.

### Test dataset

`npm run db:seed:reset` creates 2 tenants × 4 roles (admin, doctor, nurse, billing) — see `supabase/scripts/fixtures.ts` for the exact emails. All share `SEED_USER_PASSWORD` from `.env`. The seed drives the real RPCs, so a successful seed is itself an end-to-end check.

### Verification status

| Suite | Command | Result |
|---|---|---|
| Cross-tenant isolation (local, real Postgres via PGlite) | `npm run test:rls` | **57/57 passing** |
| Onboarding + invite flow (local) | `npm run test:onboarding` | **71/71 passing** |
| Cross-tenant isolation (hosted project, real sessions) | `npm run test:rls:remote` | **not yet run** — blocked on the above |

The local isolation suite includes a negative control: it disables RLS, confirms the cross-tenant leak appears, then re-enables and re-asserts — so the passes are known not to be vacuous.

---

## 11. Deviations from the original Phase 1 plan

Recorded here because the plan described a shape that turned out to be unsafe.

1. **Admins do not raw-`UPDATE` `profiles`.** The plan had admins updating profiles under an RLS policy. An RLS `WITH CHECK` can only see the **new** row, so it cannot express "you may change `role` but not `tenant_id`", and granting `UPDATE` on `role` lets *any* user self-promote. Roles now go through `admin_set_user_role()`; `authenticated` holds `UPDATE` on `full_name` only.
2. **`tenants.tier` is not admin-writable** — it would make tier gating cosmetic.
3. **RPCs return `{ok, code}` envelopes instead of raising**, so expected failures don't arrive as HTTP 500.
4. **`create_invite()` added** beyond the plan's raw-insert approach: it normalises email, returns the token, and maps the duplicate/stale cases. The admin raw `insert` policy still exists as the plan specified.
5. **Stale invites are refreshed with a rotated token** rather than erroring, so "resend" works without leaving the old link alive.
6. **`accept_invite()` requires a confirmed email**, without which the email-match check could be bypassed by signing up as the invited address.
7. **`CANNOT_DEMOTE_LAST_ADMIN` guard added** — a tenant with no admin is unrecoverable without Jeet.
8. **Seed is TypeScript, not `seed.sql`** — SQL-inserted `auth.users` rows cannot log in, which defeats the dataset's purpose.
