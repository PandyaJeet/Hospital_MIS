-- ============================================================================
-- Migration:  phase3_tier_helpers
-- Phase:      3 (Nurse Workflows & IPD Foundations) — foundation migration
--
-- Two jobs, both prerequisites for everything else in the phase:
--   1. Server-side feature-tier resolution, so the Tier 2 IPD gate can be
--      enforced in the database rather than in Prince's UI.
--   2. A composite-uniqueness constraint on prescription_items, so Phase 3's
--      medication_administrations can carry a (parent_id, tenant_id) foreign key
--      like every other child table in this schema.
--
-- WHY A TIER HELPER, AND WHY IT LOOKS LIKE THE PHASE 1 TRIO
-- rules.md §4.3: "Feature-tier gating ... must be checked both in the UI
-- (hide/disable) and — for anything sensitive — reflected in RLS/policy logic,
-- not just hidden in the frontend. Hiding a button in the UI is not access
-- control."
--
-- Architecture.md §6 marks exactly one Phase 3 table as tier-restricted:
-- `beds — IPD bed tracking (Tier 2+)`. So there has to be a way to ask "is this
-- caller's clinic Tier 2 or above?" from inside a policy and from inside an RPC,
-- and it has to be unspoofable.
--
-- These follow the Phase 1 helper pattern exactly, for the same reasons
-- documented at length in 20260808120100:
--   * SECURITY DEFINER — a policy on `beds` that read `tenants` directly would
--     be filtered by the tenants policy, and reading `profiles` from a policy is
--     what produces 42P17 infinite recursion. The definer breaks the cycle.
--   * `set search_path = ''` — a definer function without a pinned search_path
--     can be hijacked by a caller who creates their own `public.tenants`.
--   * `stable` — evaluated once per statement, not once per row.
--   * The caller is always auth.uid(). tenant_has_tier() takes the REQUIRED
--     MINIMUM as its argument, never an identity, so there is nothing a client
--     can pass that makes it answer about a different clinic (rules.md §1.2).
--
-- The gate has teeth because `tenants.tier` is not client-writable at all — the
-- Phase 1 column grants withhold it even from a tenant admin (see
-- 20260808120000's header). An admin who could raise their own tier would make
-- every tier check cosmetic, which is the failure this whole mechanism exists to
-- prevent.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- current_tenant_tier() — the caller's clinic's feature tier, or NULL if the
-- caller belongs to no clinic yet.
--
-- NULL rather than 1 for a pending user, deliberately: "not in a clinic" is a
-- different fact from "in a Tier 1 clinic", and collapsing them would let a
-- pending user's tier read as a legitimate value. Every gate below goes through
-- tenant_has_tier(), which coalesces to false, so the NULL never leaks into a
-- policy decision.
-- ---------------------------------------------------------------------------
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
$$;

comment on function public.current_tenant_tier() is
  'The authenticated caller''s clinic feature tier (1/2/3), resolved server-side from auth.uid(). NULL for a pending (un-onboarded) user. SECURITY DEFINER to avoid RLS recursion, same rationale as the Phase 1 tenancy helpers.';


-- ---------------------------------------------------------------------------
-- tenant_has_tier(integer) — the form policies and RPCs actually use.
--
-- Returns false (never NULL) so it composes safely with AND/OR in a USING
-- clause, matching is_tenant_admin()/is_tenant_staff().
--
-- Parameter is `integer` rather than `smallint` so call sites can write
-- tenant_has_tier(2) without an explicit cast; an unqualified integer literal
-- would not resolve to a smallint overload.
-- ---------------------------------------------------------------------------
create or replace function public.tenant_has_tier(p_min_tier integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select t.tier >= p_min_tier
      from public.profiles p
      join public.tenants t on t.id = p.tenant_id
      where p.id = (select auth.uid())
    ),
    false
  )
$$;

comment on function public.tenant_has_tier(integer) is
  'True when the caller''s clinic is at or above the given feature tier. The argument is the required minimum, never an identity, so a client cannot ask about another clinic. Basis of the Tier 2 IPD/bed gate (rules.md §4.3).';


revoke execute on function public.current_tenant_tier()        from public, anon;
revoke execute on function public.tenant_has_tier(integer)     from public, anon;
grant  execute on function public.current_tenant_tier()        to authenticated;
grant  execute on function public.tenant_has_tier(integer)     to authenticated;


-- ---------------------------------------------------------------------------
-- prescription_items: unique (id, tenant_id)
--
-- Phase 2 gave this constraint to every table that had children
-- (patients, visits, prescriptions, invoices, billing_line_items) but not to
-- prescription_items, which had none. Phase 3 adds one:
-- medication_administrations references a prescription item, and the whole point
-- of the (parent_id, tenant_id) pattern is that a child cannot be parented into
-- another tenant even if a future RLS policy is wrong.
--
-- Purely additive — a redundant index over an existing primary key, which is the
-- same cheap price Phase 2 paid on `profiles` for exactly the same guarantee.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'prescription_items_id_tenant_unique'
  ) then
    alter table public.prescription_items
      add constraint prescription_items_id_tenant_unique unique (id, tenant_id);
  end if;
end
$$;
