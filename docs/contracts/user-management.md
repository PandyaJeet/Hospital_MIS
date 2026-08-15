# Contract: User & Role Management

**Phase 4** completes the "invite, deactivate, change role" trio `phases.md` asks
for. Invite and role-change already existed (Phase 1); **deactivation is the new
piece**.

One thing to read before building the UI: **deactivating a user revokes their
database access immediately, but does NOT end their session.** Signing them out is
your job, and §4 explains exactly what to do.

---

## 1. What already exists (Phase 1, unchanged)

| Operation | RPC | Contract |
|---|---|---|
| Invite a user | `create_invite(p_email, p_role)` | `auth-tenancy.md` |
| Redeem an invite | `accept_invite(p_token)` | `auth-tenancy.md` |
| Change a role | `admin_set_user_role(p_user_id, p_role)` | `auth-tenancy.md` |
| Revoke a pending invite | `delete from invites` (admin) | `auth-tenancy.md` |

**Users cannot be deleted, and that is deliberate.** Every clinician reference in the
schema is `ON DELETE RESTRICT` — `visits.doctor_id`, `clinical_notes.author_id`,
`vitals.recorded_by`, `medication_administrations.administered_by`,
`lab_results.reported_by` and others — because a medical record must keep pointing at
whoever created it. A doctor who leaves cannot be erased from the notes they wrote.
So "remove access" is deactivation, not deletion. Do not build a delete button.

---

## 2. `profiles` — the two new columns

| Column | Type | Notes |
|---|---|---|
| `is_active` | `boolean not null default true` | False = access revoked. **Not client-writable** |
| `deactivated_at` | `timestamptz` null | Set on deactivation, cleared on reactivation. **Not client-writable** |

Both return `42501` if you try to write them, including as an admin. Use the RPC.

`deactivated_at` always describes the *current* state rather than accumulating
history — the history lives in `audit_log` (see `audit-log.md`).

### Listing staff

```ts
const { data } = await supabase
  .from('profiles')
  .select('id, full_name, role, is_active, deactivated_at, consultation_fee')
  .order('is_active', { ascending: false })
  .order('full_name');
```

An admin sees every profile in their clinic; a non-admin sees only their own row.
Backed by an index on `(tenant_id, is_active, role)`.

---

## 3. `admin_set_user_active()`

```ts
const { data } = await supabase.rpc('admin_set_user_active', {
  p_user_id: userId,
  p_is_active: false,
});
```

Admin only. Takes **no reason parameter** — see §6.

| Response | Meaning |
|---|---|
| `{ ok: true, user_id, is_active, changed: true, role, session_note }` | Changed |
| `{ ok: true, ..., changed: false }` | Already in that state — **idempotent success** |
| `{ ok: false, code: 'CANNOT_DEACTIVATE_SELF' }` | You cannot revoke your own access |
| `{ ok: false, code: 'CANNOT_DEACTIVATE_LAST_ADMIN' }` | Would leave the clinic with no active admin |
| `{ ok: false, code: 'USER_NOT_IN_TENANT' }` | Unknown user, or another clinic's |
| `{ ok: false, code: 'NOT_ADMIN' }` | Caller is not an admin |
| `{ ok: false, code: 'VALIDATION_ERROR', fields: ['p_is_active'] }` | Null flag |
| `{ ok: false, code: 'NOT_AUTHENTICATED' }` | No session |

`session_note` is non-null only on deactivation and carries the plain-language
warning about the JWT. Show it to the admin.

### The two guards, and why they differ

`CANNOT_DEACTIVATE_SELF` is an **unconditional** block, even when other admins exist.
An admin who deactivates themselves is locked out instantly and cannot undo it —
reactivation needs an admin, and they have just stopped being one. It is far more
likely a misclick on the wrong row than an intent, and the correct way for an admin to
leave is for a colleague to revoke them.

`CANNOT_DEACTIVATE_LAST_ADMIN` counts **active** admins, which is why it is not the
same check as Phase 1's `CANNOT_DEMOTE_LAST_ADMIN` (that one counts admins by role
alone). Without both, a clinic could satisfy each individually and still end up with
nobody able to act.

---

## 4. ⚠️ The session question — what the backend does and does not do

**Does, immediately:** every database operation resolves through the tenancy helpers
(`current_tenant_id()`, `is_tenant_staff()`, `has_tenant_role()`, and four more), and
all seven now require `is_active`. So from the next statement onward a deactivated
session:

- reads **zero rows** from every tenant-scoped table (because `current_tenant_id()`
  returns `NULL`, and `tenant_id = NULL` matches nothing)
- cannot write anything
- gets a role/permission failure from every staff-gated RPC

There is no window in which a deactivated user can still act on clinic data.

**Does not:** invalidate the access token. Their JWT stays cryptographically valid
until it expires (Supabase default: 1 hour). It authenticates fine; it just authorises
nothing.

Postgres cannot revoke a GoTrue session. That needs the Auth Admin API
(`auth.admin.signOut(userId)` or a user ban), which requires the service-role key and
cannot be called from SQL. Doing it from a `SECURITY DEFINER` function would mean
embedding a service-role credential in the database, which `rules.md` §1.1 and §1.4
both forbid — to improve on something already fully mitigated at the data layer.

### What Prince should build

The important property: **`profiles_select_self` still works for a deactivated user.**
They can always read their own row. So:

```ts
// In your session/layout guard, alongside the existing role check.
const { data: me } = await supabase
  .from('profiles')
  .select('is_active')
  .eq('id', session.user.id)
  .maybeSingle();

if (me && me.is_active === false) {
  await supabase.auth.signOut();
  redirect('/login?reason=account_deactivated');
}
```

Show a specific message. Without it a deactivated user sees every screen render empty
and will read it as data loss, which generates a support call rather than an
understanding.

Two things worth knowing:
- A deactivated user reading their own profile is the **only** query that still
  returns anything, so this check cannot be starved by RLS.
- If you want a hard cut-off rather than up-to-an-hour, that needs an Auth Admin API
  call from a server action with the service-role key — a deliberate decision to make
  with Jeet, not something to add quietly.

---

## 5. What is audited

Every change here writes an `audit_log` row automatically, via a trigger — not from
the RPC, so a service-role or dashboard edit is caught too:

| Action | Logged as |
|---|---|
| Deactivate | `user.deactivated` |
| Reactivate | `user.reactivated` |
| Role change | `user.role_changed` |
| Joining a clinic | `user.joined_tenant` |

An ordinary `full_name` or `consultation_fee` edit is **not** audited — it is not a
compliance fact, and logging it would bury the events that are. See `audit-log.md`.

---

## 6. Deliberately not built

| Not available | Why |
|---|---|
| **Deleting a user** | `ON DELETE RESTRICT` throughout, on purpose. Deactivate instead |
| **A reason field on deactivation** | A free-text field attached to revoking a named individual's access invites HR commentary ("dismissed for…") into a compliance table with no erasure path, readable by every admin. The log records the fact, the actor and the time. Flagged for Jeet if the pilot needs otherwise |
| **Server-side session termination** | See §4. Needs the Auth Admin API and a service-role key |
| **Bulk deactivation** | One user per call. A loop in the UI is fine and keeps each audit row and each guard check honest |
| **Transferring a departing user's open work** | Their assigned tasks, open visits and draft prescriptions stay assigned to them. Reassignment is manual, per row |
| **`lab_tech` role** | Still not added — see the Phase 4 report. PRD §6 has no lab-technician persona and Architecture.md §6 lists the role set without one |

---

## 7. TypeScript for the mock layer

```ts
export type StaffRole = 'pending' | 'admin' | 'doctor' | 'nurse' | 'billing' | 'patient';

export interface StaffProfile {
  id: string;
  tenant_id: string | null;
  full_name: string | null;
  role: StaffRole;
  is_active: boolean;              // not client-writable
  deactivated_at: string | null;   // not client-writable
  consultation_fee: number | null;
}

export type SetUserActiveResult =
  | {
      ok: true;
      user_id: string;
      is_active: boolean;
      changed: boolean;
      role?: StaffRole;
      /** Non-null only on deactivation: the JWT-still-valid warning. Show it. */
      session_note?: string | null;
    }
  | {
      ok: false;
      code:
        | 'CANNOT_DEACTIVATE_SELF'
        | 'CANNOT_DEACTIVATE_LAST_ADMIN'
        | 'USER_NOT_IN_TENANT'
        | 'NOT_ADMIN'
        | 'NOT_AUTHENTICATED';
      message: string;
    }
  | { ok: false; code: 'VALIDATION_ERROR'; message: string; fields?: string[] };
```

---

## 8. Verification status

| Suite | Command | Result |
|---|---|---|
| Local Phase 4 | `npm run test:phase4` | **211/211** |
| Hosted catalogue | `npm run verify:catalog` | **93/93** |

Covered here specifically: `is_active` and `deactivated_at` refused with `42501` even
for an admin; a nurse calling the RPC gets `NOT_ADMIN`; self-deactivation and
last-active-admin both blocked; cross-tenant returns `USER_NOT_IN_TENANT`; idempotent
repeat returns `changed:false`; **a deactivated doctor resolves to no tenant, no role
and no tier, sees zero rows across six tables where they previously saw data, cannot
write, and is refused by a staff-gated RPC — while still reading their own profile
row**; reactivation restores access immediately and clears `deactivated_at`. The
catalogue suite additionally asserts that all seven tenancy helpers still contain the
`is_active` predicate, so a future rewrite cannot silently disable deactivation.
