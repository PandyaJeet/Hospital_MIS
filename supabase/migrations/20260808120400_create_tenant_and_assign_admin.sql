-- ============================================================================
-- Migration:  create_tenant_and_assign_admin
-- Purpose:    The "first user founds a clinic" path. A pending user calls this
--             once; it creates their tenant and promotes them to its admin,
--             atomically. Architecture.md §7, phases.md Phase 1.
--
-- Called from the frontend as:
--     supabase.rpc('create_tenant_and_assign_admin', { p_tenant_name: 'X' })
--
-- RETURN CONTRACT (shared by all RPCs in this phase):
--   success  -> { "ok": true,  ... }
--   expected -> { "ok": false, "code": "<STABLE_CODE>", "message": "<plain>" }
--     failure
-- Expected business-rule failures are returned as DATA, not raised as errors.
-- Rationale: PostgREST maps an unrecognised SQLSTATE to HTTP 500, so raising
-- custom error codes would force Prince to parse 500s to distinguish "you
-- already have a clinic" from "the database is down" — exactly the confusion
-- rules.md §3.3/§3.5 tells us to avoid. With this split the frontend rule is
-- unambiguous: supabase-js `error` means transport/auth/RLS/bug, `data.ok ===
-- false` means a rule you can explain to the user in plain language.
-- Genuinely exceptional conditions still propagate as real Postgres errors.
--
-- SECURITY DEFINER is required: a pending user has no INSERT grant on tenants
-- and no write grant on profiles.tenant_id/role (see migration ...120000), so
-- they cannot perform either half of this themselves. The function is the only
-- door, and it checks authority before it writes.
--
-- Why the row lock: without `for update` two concurrent calls from the same
-- session both read tenant_id IS NULL, both pass the guard, and both insert —
-- leaving one orphaned tenant with no members. Locking the caller's profile row
-- serialises them; the second call then sees the committed tenant_id and
-- returns ALREADY_IN_TENANT. The whole function body is one transaction, so a
-- failure at any point leaves no tenant behind.
-- ============================================================================

create or replace function public.create_tenant_and_assign_admin(
  p_tenant_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_name      text := nullif(trim(coalesce(p_tenant_name, '')), '');
  v_tenant_id uuid;
  v_existing  uuid;
  v_found     boolean;
begin
  -- ---- authentication ----------------------------------------------------
  if v_uid is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in to create a clinic.'
    );
  end if;

  -- ---- input validation --------------------------------------------------
  if v_name is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'VALIDATION_ERROR',
      'message', 'Clinic name is required.',
      'fields', jsonb_build_array('p_tenant_name')
    );
  end if;

  if length(v_name) > 120 then
    return jsonb_build_object(
      'ok', false,
      'code', 'VALIDATION_ERROR',
      'message', 'Clinic name must be 120 characters or fewer.',
      'fields', jsonb_build_array('p_tenant_name')
    );
  end if;

  -- ---- serialise concurrent calls from the same user ---------------------
  select p.tenant_id, true
    into v_existing, v_found
  from public.profiles p
  where p.id = v_uid
  for update;

  if not coalesce(v_found, false) then
    -- auth.users row exists but the profiles row does not. Only reachable if
    -- the on_auth_user_created trigger was dropped or failed. Surface it as a
    -- distinct code rather than a confusing "already in tenant".
    return jsonb_build_object(
      'ok', false,
      'code', 'PROFILE_MISSING',
      'message', 'Your account is not fully set up. Please contact support.'
    );
  end if;

  if v_existing is not null then
    return jsonb_build_object(
      'ok', false,
      'code', 'ALREADY_IN_TENANT',
      'message', 'You already belong to a clinic.'
    );
  end if;

  -- ---- create the tenant, promote the caller -----------------------------
  insert into public.tenants (name)
  values (v_name)
  returning id into v_tenant_id;

  -- Both columns are set in one statement because the
  -- profiles_tenant_role_consistent CHECK constraint forbids the intermediate
  -- states (tenant with role 'pending', or role 'admin' with no tenant).
  update public.profiles
     set tenant_id = v_tenant_id,
         role      = 'admin'
   where id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'tenant_id', v_tenant_id,
    'tenant_name', v_name,
    'role', 'admin'
  );
end;
$$;

comment on function public.create_tenant_and_assign_admin(text) is
  'Onboarding path 1 of 2: a pending user founds a new tenant and becomes its admin, atomically. Returns jsonb {ok:true,tenant_id,tenant_name,role} or {ok:false,code,message}.';

revoke execute on function public.create_tenant_and_assign_admin(text) from public, anon;
grant  execute on function public.create_tenant_and_assign_admin(text) to authenticated;
