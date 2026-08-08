-- ============================================================================
-- Migration:  init_tenants_and_profiles
-- Phase:      0 / 1  (Jeet — backend foundation)
-- Purpose:    Create the two root tables of the multi-tenancy model and put
--             them behind Row-Level Security in the SAME migration that
--             creates them (rules.md §4.1 — no table ships without RLS).
--
-- Design notes that matter later:
--
--  1. RLS is ENABLED here but NO policies are added in this migration. That is
--     deliberate and safe: "RLS enabled + zero policies" is deny-all for
--     anon/authenticated. Policies arrive in 20260808120200_*. There is no
--     window in which these tables are readable without a policy.
--
--  2. Writable columns are restricted with COLUMN-LEVEL GRANTS, not just
--     policies. RLS can gate *which rows* you touch but cannot express
--     "you may not change this column", because a policy's WITH CHECK sees
--     only the NEW row and cannot compare it to the OLD one. Without column
--     grants, a plain `update profiles set role='admin' where id=auth.uid()`
--     would satisfy an `id = auth.uid()` policy and let any signed-up user
--     promote themselves to admin — or move themselves into another tenant by
--     writing a different tenant_id. So:
--       * authenticated may UPDATE profiles.full_name  — and nothing else.
--       * authenticated may UPDATE tenants.name        — and nothing else.
--     Every change to profiles.role / profiles.tenant_id goes through a
--     SECURITY DEFINER function that checks authority first.
--
--  3. tenants.tier is intentionally NOT updatable by a tenant admin. Tier is
--     the feature-gating flag (Tier 1/2/3). If an admin could UPDATE it they
--     could unlock Tier 3 modules for themselves, which would defeat
--     rules.md §4.3 ("hiding a button in the UI is not access control").
--     Tier changes are a platform-owner action performed by Jeet via the
--     Supabase dashboard / service role, per PRD §6.6.
--
--  4. We do NOT use `FORCE ROW LEVEL SECURITY`. These tables are owned by
--     postgres, and the SECURITY DEFINER helper functions added in the next
--     migration run as postgres — FORCE would apply RLS to them too and
--     reintroduce the recursion problem those helpers exist to solve.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- tenants — one row per clinic/hospital using the system
-- ---------------------------------------------------------------------------
create table if not exists public.tenants (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  tier       smallint    not null default 1,
  created_at timestamptz not null default now(),

  constraint tenants_name_not_blank check (length(trim(name)) > 0),
  constraint tenants_tier_valid     check (tier in (1, 2, 3))
);

comment on table  public.tenants      is 'One clinic/hospital. Root of the multi-tenancy model; every business table references this via tenant_id.';
comment on column public.tenants.tier is 'Feature-activation level: 1=solo clinic, 2=small hospital, 3=large hospital (PRD §5.4). Platform-owner controlled — NOT updatable by tenant admins.';

-- ---------------------------------------------------------------------------
-- profiles — extends auth.users with tenant membership + role
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid        primary key references auth.users (id) on delete cascade,
  tenant_id  uuid        null     references public.tenants (id) on delete restrict,
  role       text        not null default 'pending',
  full_name  text,
  created_at timestamptz not null default now(),

  constraint profiles_role_valid check (
    role in ('pending', 'admin', 'doctor', 'nurse', 'billing', 'patient')
  ),

  -- A profile is either unaffiliated-and-pending, or affiliated-with-a-real-role.
  -- This makes the onboarding state machine explicit at the schema level and
  -- makes "role assigned but no tenant" (or vice versa) unrepresentable.
  constraint profiles_tenant_role_consistent check (
    (tenant_id is null     and role  = 'pending')
    or
    (tenant_id is not null and role <> 'pending')
  )
);

comment on table  public.profiles           is 'Extends auth.users. Holds the authoritative tenant_id + role for a user. This table is the source of truth every RLS policy resolves against.';
comment on column public.profiles.tenant_id is 'Null until the user creates a tenant or accepts an invite. Never writable directly by a client — see create_tenant_and_assign_admin() / accept_invite().';
comment on column public.profiles.role      is '''pending'' until onboarded. Never writable directly by a client — see admin_set_user_role().';

-- Supporting indexes. profiles is read by every RLS policy in the system via
-- current_tenant_id(), so the id lookup (primary key) is the hot path; these
-- two cover the admin's "list everyone in my tenant" query.
create index if not exists profiles_tenant_id_idx   on public.profiles (tenant_id);
create index if not exists profiles_tenant_role_idx on public.profiles (tenant_id, role);

-- ---------------------------------------------------------------------------
-- Row-Level Security ON (deny-all until policies land in 20260808120200_*)
-- ---------------------------------------------------------------------------
alter table public.tenants  enable row level security;
alter table public.profiles enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges — see design note 2 above. Precise, not blanket.
-- service_role is deliberately untouched: it bypasses RLS and is what the
-- seed script uses to provision dummy users.
-- ---------------------------------------------------------------------------
revoke all on public.tenants  from anon, authenticated;
revoke all on public.profiles from anon, authenticated;

-- tenants: read your own row; an admin may rename it. No insert (creation is
-- via create_tenant_and_assign_admin), no delete, no tier write.
grant select        on public.tenants to authenticated;
grant update (name) on public.tenants to authenticated;

-- profiles: read per policy; you may only ever edit your own display name.
grant select             on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
