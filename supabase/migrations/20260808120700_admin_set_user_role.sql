-- ============================================================================
-- Migration:  admin_set_user_role
-- Purpose:    The admin-only "assign role" operation from phases.md Phase 1.
--
-- WHY THIS IS A FUNCTION AND NOT AN RLS-GATED UPDATE
-- The prompt/plan describes admins updating profiles directly. That cannot be
-- done safely with RLS alone. A policy's WITH CHECK only sees the NEW row, so
-- it cannot express "you may change role but not tenant_id", and it cannot
-- express "you may not promote yourself". Granting authenticated an UPDATE
-- privilege on profiles.role is therefore enough for any user to run
--
--     update profiles set role = 'admin' where id = auth.uid();
--
-- and satisfy an `id = auth.uid()` self-update policy. That is a total
-- privilege-escalation hole, so migration 20260808120000 grants authenticated
-- UPDATE on profiles.full_name only, and role changes come through here where
-- the caller's authority is checked before the write.
--
-- Guards beyond "is an admin":
--   * target must be in the caller's own tenant  -> USER_NOT_IN_TENANT
--     (doubles as a non-enumeration property: an admin cannot discover whether
--      a uuid exists in another tenant, they get the same answer either way)
--   * cannot set 'pending'  -> that is the un-onboarded state, and writing it
--     with a non-null tenant_id would violate profiles_tenant_role_consistent
--   * cannot remove the last admin -> a tenant with zero admins can never
--     invite anyone or change its own settings again, and only Jeet could
--     repair it from the dashboard. Cheap to prevent, expensive to fix.
-- ============================================================================

create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid          uuid := (select auth.uid());
  v_tenant_id    uuid;
  v_role         text := lower(trim(coalesce(p_role, '')));
  v_target_role  text;
  v_target_found boolean;
  v_admin_count  integer;
begin
  if v_uid is null then
    return jsonb_build_object(
      'ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.'
    );
  end if;

  if not public.is_tenant_admin() then
    return jsonb_build_object(
      'ok', false, 'code', 'NOT_ADMIN',
      'message', 'Only a clinic admin can change staff roles.'
    );
  end if;

  v_tenant_id := public.current_tenant_id();

  if p_user_id is null then
    return jsonb_build_object(
      'ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'A user must be selected.',
      'fields', jsonb_build_array('p_user_id')
    );
  end if;

  -- 'pending' is excluded: it is the "belongs to nobody" state and is only
  -- valid alongside a NULL tenant_id.
  if v_role not in ('admin', 'doctor', 'nurse', 'billing', 'patient') then
    return jsonb_build_object(
      'ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Role must be one of: admin, doctor, nurse, billing, patient.',
      'fields', jsonb_build_array('p_role')
    );
  end if;

  -- Target must already be a member of the caller's tenant. Lock the row so a
  -- concurrent role change cannot race the last-admin count below.
  select p.role, true
    into v_target_role, v_target_found
  from public.profiles p
  where p.id = p_user_id
    and p.tenant_id = v_tenant_id
  for update;

  if not coalesce(v_target_found, false) then
    return jsonb_build_object(
      'ok', false, 'code', 'USER_NOT_IN_TENANT',
      'message', 'That user is not part of your clinic.'
    );
  end if;

  if v_target_role = v_role then
    return jsonb_build_object(
      'ok', true, 'user_id', p_user_id, 'role', v_role, 'changed', false
    );
  end if;

  -- Don't strand the tenant without an admin.
  if v_target_role = 'admin' and v_role <> 'admin' then
    select count(*) into v_admin_count
    from public.profiles p
    where p.tenant_id = v_tenant_id
      and p.role = 'admin';

    if v_admin_count <= 1 then
      return jsonb_build_object(
        'ok', false, 'code', 'CANNOT_DEMOTE_LAST_ADMIN',
        'message', 'Your clinic must have at least one admin. Promote someone else first.'
      );
    end if;
  end if;

  update public.profiles
     set role = v_role
   where id = p_user_id
     and tenant_id = v_tenant_id;

  return jsonb_build_object(
    'ok', true, 'user_id', p_user_id, 'role', v_role, 'changed', true
  );
end;
$$;

comment on function public.admin_set_user_role(uuid, text) is
  'Admin-only. Changes the role of an existing member of the caller''s tenant. The only sanctioned path for writing profiles.role — authenticated has no UPDATE privilege on that column.';

revoke execute on function public.admin_set_user_role(uuid, text) from public, anon;
grant  execute on function public.admin_set_user_role(uuid, text) to authenticated;
