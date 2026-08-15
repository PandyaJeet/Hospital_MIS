-- ============================================================================
-- Migration:  auth_helper_functions
-- Purpose:    The three functions every RLS policy in this codebase resolves
--             tenancy through. Adding these before any policy exists is
--             deliberate — the policies in the next migration depend on them.
--
-- WHY THESE EXIST (the single most important thing to understand about this
-- schema): the obvious way to write a tenant policy on `profiles` is
--
--     create policy p on profiles for select
--       using (tenant_id = (select tenant_id from profiles where id = auth.uid()));
--
-- ...which deadlocks on itself. Evaluating the policy on `profiles` requires
-- querying `profiles`, which fires the policy again. Postgres detects it and
-- throws 42P17 "infinite recursion detected in policy for relation profiles",
-- and every query against the table fails — including the ones you'd use to
-- debug it.
--
-- A SECURITY DEFINER function breaks the cycle. It executes as its owner
-- (postgres, the table owner), and RLS is not applied to a table's owner, so
-- the lookup inside the function reads `profiles` directly without
-- re-triggering the policy.
--
-- SECURITY DEFINER is a privilege escalation primitive, so each function below
-- is deliberately constrained:
--   * `set search_path = ''`  — a SECURITY DEFINER function without a pinned
--     search_path can be hijacked: a caller creates `my_schema.profiles`, puts
--     my_schema first on their search_path, and the function reads the
--     attacker's table while running as postgres. Empty search_path forces
--     every reference to be schema-qualified, which is why everything below
--     says `public.profiles` and `auth.uid()` explicitly.
--   * `stable` — lets Postgres evaluate once per statement instead of once per
--     row. On a 10k-row scan this is the difference between one index lookup
--     and ten thousand.
--   * They read ONLY from auth.uid(). No parameters, so there is no argument a
--     caller could pass to make them answer about somebody else. This is what
--     satisfies rules.md §1.2 — tenant_id is derived server-side from the JWT,
--     never accepted from the client.
--   * EXECUTE is revoked from public/anon. Postgres grants EXECUTE to PUBLIC on
--     new functions by default, which would otherwise expose these to
--     unauthenticated callers.
--
-- `(select auth.uid())` rather than bare `auth.uid()` is also intentional: the
-- subselect lets the planner treat it as a one-time InitPlan constant instead
-- of re-invoking the function per row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- current_tenant_id() — the caller's tenant, or NULL if not yet onboarded.
-- ---------------------------------------------------------------------------
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
$$;

comment on function public.current_tenant_id() is
  'The authenticated caller''s tenant_id, resolved server-side from auth.uid(). Returns NULL for a pending (un-onboarded) user. SECURITY DEFINER to avoid RLS recursion on profiles.';

-- ---------------------------------------------------------------------------
-- current_user_role() — the caller's role, or NULL if they have no profile.
-- ---------------------------------------------------------------------------
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
$$;

comment on function public.current_user_role() is
  'The authenticated caller''s role. SECURITY DEFINER to avoid RLS recursion on profiles.';

-- ---------------------------------------------------------------------------
-- is_tenant_admin() — true only for a fully-onboarded admin.
-- Returns false (never NULL) so it can be used directly in a policy USING
-- clause; a NULL there would be treated as "no rows match" but false is
-- clearer to reason about and safer to compose with AND/OR.
-- ---------------------------------------------------------------------------
create or replace function public.is_tenant_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.role = 'admin' and p.tenant_id is not null
      from public.profiles p
      where p.id = (select auth.uid())
    ),
    false
  )
$$;

comment on function public.is_tenant_admin() is
  'True when the caller is an admin of a real tenant. Used by every admin-gated RLS policy and RPC. SECURITY DEFINER to avoid RLS recursion on profiles.';

-- ---------------------------------------------------------------------------
-- Privileges: these are session-scoped identity helpers — only a logged-in
-- user has any use for them. Strip the implicit PUBLIC grant first.
-- ---------------------------------------------------------------------------
revoke execute on function public.current_tenant_id()  from public, anon;
revoke execute on function public.current_user_role()  from public, anon;
revoke execute on function public.is_tenant_admin()    from public, anon;

grant execute on function public.current_tenant_id()  to authenticated;
grant execute on function public.current_user_role()  to authenticated;
grant execute on function public.is_tenant_admin()    to authenticated;
