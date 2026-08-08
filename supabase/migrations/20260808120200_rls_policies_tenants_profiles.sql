-- ============================================================================
-- Migration:  rls_policies_tenants_profiles
-- Purpose:    The actual tenant-isolation boundary for the two root tables.
--             Until this migration runs, both tables are RLS-enabled with zero
--             policies == deny-all to anon and authenticated.
--
-- Policy naming: <table>_<command>_<who>, so `\d public.profiles` reads like
-- documentation and a missing policy is obvious by absence.
--
-- Every policy below is scoped `to authenticated`. An unauthenticated (anon)
-- caller matches no policy on either table and therefore sees nothing — there
-- is deliberately no anon-readable surface in the tenancy layer.
--
-- Note on INSERT/DELETE: there are no INSERT or DELETE policies here, on
-- purpose. Combined with the absence of INSERT/DELETE grants in migration
-- 20260808120000, that makes row creation impossible from a client session for
-- both tables. Tenants are created by create_tenant_and_assign_admin(),
-- profiles by the on_auth_user_created trigger. Both are SECURITY DEFINER and
-- both validate authority before writing. Locking the raw table and funnelling
-- writes through audited functions is the whole point.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

-- Read your own profile. This is the very first query the frontend makes after
-- login (to discover role + tenant for routing), so it must work even while
-- the user is still 'pending' with tenant_id NULL.
create policy profiles_select_self
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

-- An admin sees every profile in their own tenant — this is what powers the
-- Admin > Users screen. current_tenant_id() cannot be NULL here because
-- is_tenant_admin() already requires a non-null tenant, but the explicit
-- `tenant_id is not null` guard is kept so the policy is safe to read in
-- isolation: it must never degrade into `tenant_id = NULL` (which matches
-- nothing) or, worse, be edited later into something that matches everything.
create policy profiles_select_tenant_admin
  on public.profiles
  for select
  to authenticated
  using (
    public.is_tenant_admin()
    and tenant_id is not null
    and tenant_id = public.current_tenant_id()
  );

-- Edit your own profile. Column grants restrict this to full_name — see
-- design note 2 in migration 20260808120000. The WITH CHECK repeats the USING
-- condition so a row can never be updated *out of* your own ownership.
create policy profiles_update_self
  on public.profiles
  for update
  to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- An admin may correct the display name of staff in their tenant. The
-- WITH CHECK pins tenant_id to the admin's own tenant on the NEW row as well,
-- so this cannot be used to push a profile into a different tenant even if a
-- column grant on tenant_id were ever added by mistake.
create policy profiles_update_tenant_admin
  on public.profiles
  for update
  to authenticated
  using (
    public.is_tenant_admin()
    and tenant_id is not null
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.is_tenant_admin()
    and tenant_id is not null
    and tenant_id = public.current_tenant_id()
  );

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------

-- Read the tenant you belong to. Drives useTenant() — name, tier, branding.
-- A pending user's current_tenant_id() is NULL, and `id = NULL` matches no
-- row, so a pending user correctly sees zero tenants rather than erroring.
create policy tenants_select_own
  on public.tenants
  for select
  to authenticated
  using (id = public.current_tenant_id());

-- Only an admin may rename their own tenant. Column grants limit the write to
-- `name`, so `tier` is unreachable from a client session even for an admin.
create policy tenants_update_admin
  on public.tenants
  for update
  to authenticated
  using (
    public.is_tenant_admin()
    and id = public.current_tenant_id()
  )
  with check (
    public.is_tenant_admin()
    and id = public.current_tenant_id()
  );
