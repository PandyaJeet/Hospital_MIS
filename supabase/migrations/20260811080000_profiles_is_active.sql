-- ============================================================================
-- Migration:  profiles_is_active
-- Phase:      4 (Admin, Multi-Branch & Tier 3 Groundwork)
-- Purpose:    User deactivation — a state, not a deletion — plus the change that
--             actually gives it teeth: the tenancy helpers now refuse to resolve
--             for an inactive user.
--
-- ---------------------------------------------------------------------------
-- WHY DEACTIVATION CANNOT BE A DELETE
-- ---------------------------------------------------------------------------
-- `phases.md` Phase 4 asks for "invite, deactivate, change role". Deleting is not
-- available and that is deliberate, not a limitation: every clinician reference in
-- this schema is ON DELETE RESTRICT —
--   visits.doctor_id, clinical_notes.author_id, prescriptions.doctor_id,
--   vitals.recorded_by, tasks.assigned_to/completed_by,
--   medication_administrations.administered_by, lab_orders.ordered_by,
--   lab_results.reported_by/acknowledged_by
-- — because a medical record must keep pointing at whoever created it. A doctor who
-- leaves the clinic cannot be erased from the notes they wrote. So "remove this
-- person's access" has to be a flag.
--
-- ---------------------------------------------------------------------------
-- WHERE THE FLAG IS ENFORCED, AND WHY THERE
-- ---------------------------------------------------------------------------
-- Enforced in the seven tenancy helpers rather than in ~100 individual policies.
--
-- `current_tenant_id()` returning NULL for an inactive user is the single change
-- that does almost all the work: every tenant-scoped policy in the database is of
-- the form `tenant_id = public.current_tenant_id()`, and `tenant_id = NULL` matches
-- no row. So an inactive user's SELECTs return zero rows and their INSERTs fail
-- WITH CHECK, across every table, with no policy edited and nothing to keep in sync.
-- The role helpers get the same predicate for defence in depth, so a policy that
-- gates only on `has_tenant_role(...)` without a tenant comparison is covered too.
--
-- Deliberately NOT changed: `profiles_select_self` (`id = auth.uid()`). A
-- deactivated user must still be able to read their own row, or the frontend cannot
-- tell them *why* everything is empty — it would look like data loss rather than a
-- revoked account. This is the one thing they can still see, and it is the thing
-- they need to see.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE SESSION QUESTION, ANSWERED EXPLICITLY
-- ---------------------------------------------------------------------------
-- Deactivating a user does NOT terminate their existing JWT. Their access token
-- stays cryptographically valid until it expires (Supabase default 1 hour).
--
-- What the flag guarantees, immediately and with no cooperation from the client:
-- every subsequent DATABASE operation resolves through these helpers, so from the
-- next statement onward the session can read nothing tenant-scoped and write
-- nothing at all. There is no window in which a deactivated user can still act on
-- clinic data.
--
-- What it does NOT do: invalidate the token itself. A deactivated user's browser
-- keeps a token that authenticates successfully; it simply authorises nothing.
-- Postgres has no way to revoke a GoTrue session — that needs the Auth Admin API
-- (`auth.admin.signOut(userId)` / user ban), which requires the service-role key
-- and cannot be called from SQL. Doing it from a `SECURITY DEFINER` function would
-- mean embedding a service-role credential in the database, which rules.md §1.1 and
-- §1.4 both forbid, to buy an improvement on something already fully mitigated at
-- the data layer.
--
-- SO: session invalidation is deliberately OUT OF SCOPE for the backend and is
-- flagged for Prince. Recommended client-side handling is in
-- docs/contracts/user-management.md §4 — briefly, the app should treat "my own
-- profile says is_active = false" as a forced sign-out, and that check is cheap
-- because `profiles_select_self` still works. Recorded as a risk in Memory.md §6
-- rather than silently assumed away.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_active      boolean     not null default true,
  add column if not exists deactivated_at timestamptz null;

comment on column public.profiles.is_active is
  'False means access revoked. Enforced through the tenancy helpers, so an inactive user resolves to no tenant and can neither read tenant data nor write anything. Not client-writable — use admin_set_user_active(). Does NOT invalidate an existing JWT; see the migration header.';
comment on column public.profiles.deactivated_at is
  'When access was revoked. Cleared on reactivation, so it always describes the current state rather than accumulating history — the audit_log holds the history.';

do $$
begin
  -- One-directional: an active profile must not carry a stale deactivation
  -- timestamp. Deliberately not both-or-neither — that is the shape that caused the
  -- Phase 1 invites bug, where a constraint collided with an FK's own action.
  if not exists (select 1 from pg_constraint where conname = 'profiles_active_has_no_deactivated_at') then
    alter table public.profiles
      add constraint profiles_active_has_no_deactivated_at
      check (not is_active or deactivated_at is null);
  end if;
end
$$;

-- "Who is on staff here" — the admin user-management list, and the last-admin guard.
create index if not exists profiles_tenant_active_idx
  on public.profiles (tenant_id, is_active, role);

-- NOTE ON GRANTS: `authenticated` holds only
--   grant update (full_name)        [20260808120000]
--   grant update (consultation_fee) [20260811060000]
-- on this table. Neither new column is added to either, so both are unwritable from
-- a client session — including by an admin, who must go through
-- admin_set_user_active(). A direct write gets 42501.


-- ---------------------------------------------------------------------------
-- The seven helpers, now active-aware.
--
-- Each keeps its existing signature, volatility, SECURITY DEFINER and pinned
-- search_path — the only change is `and p.is_active` (or `p.is_active and ...`).
-- Rewritten in full rather than patched so each function reads correctly on its own.
-- ---------------------------------------------------------------------------

-- The load-bearing one. NULL for an inactive user, exactly as it is NULL for a
-- pending one — in both cases the honest answer to "which clinic may this session
-- act for" is "none".
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.tenant_id
  from public.profiles p
  where p.id = (select auth.uid())
    and p.is_active
$$;

comment on function public.current_tenant_id() is
  'The caller''s clinic, or NULL if they are pending OR DEACTIVATED. Every tenant-scoped policy compares against this, so returning NULL revokes all tenant data access at once (tenant_id = NULL matches no row).';

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.is_active
$$;

create or replace function public.is_tenant_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.is_active and p.role = 'admin' and p.tenant_id is not null
      from public.profiles p
      where p.id = (select auth.uid())
    ),
    false
  )
$$;

create or replace function public.is_tenant_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.is_active
         and p.tenant_id is not null
         and p.role in ('admin', 'doctor', 'nurse', 'billing')
      from public.profiles p
      where p.id = (select auth.uid())
    ),
    false
  )
$$;

create or replace function public.has_tenant_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.is_active
         and p.tenant_id is not null
         and p.role = any(p_roles)
      from public.profiles p
      where p.id = (select auth.uid())
    ),
    false
  )
$$;

create or replace function public.current_tenant_tier()
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select t.tier
  from public.profiles p
  join public.tenants t on t.id = p.tenant_id
  where p.id = (select auth.uid())
    and p.is_active
$$;

create or replace function public.tenant_has_tier(p_min_tier integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.is_active and t.tier >= p_min_tier
      from public.profiles p
      join public.tenants t on t.id = p.tenant_id
      where p.id = (select auth.uid())
    ),
    false
  )
$$;
