-- ============================================================================
-- Migration:  admin_set_user_active
-- Purpose:    The "deactivate" half of phases.md's "invite, deactivate, change
--             role". Sibling of admin_set_user_role(), same shape and same guards.
--
-- WHY AN RPC AND NOT A COLUMN GRANT — the same reason role assignment is an RPC
-- (see 20260808120700's header). An RLS `WITH CHECK` only sees the NEW row, so it
-- cannot express "you may deactivate a colleague but not yourself, and not if you
-- are the last admin". Those are the guards that matter, so the write goes through a
-- function and `profiles.is_active` stays outside every client grant.
--
-- NO `p_reason` PARAMETER, deliberately.
-- The obvious signature takes a reason and stores it. It is not here, because a free
-- text field attached to revoking a named individual's access is an invitation to
-- write HR commentary about a person ("dismissed for…") into a compliance table
-- that has no erasure path and is read by every admin. The audit log records the
-- fact, the actor and the timestamp, which is what "who changed what, for
-- compliance" asks for. Where a reason genuinely needs recording, it belongs in
-- whatever HR system the clinic already uses, not here. Flagged in the report as a
-- decision Jeet may want to revisit.
-- ============================================================================

create or replace function public.admin_set_user_active(
  p_user_id   uuid,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid          uuid := (select auth.uid());
  v_tenant       uuid;
  v_target       record;
  v_active_admins integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.is_tenant_admin() then
    return jsonb_build_object('ok', false, 'code', 'NOT_ADMIN',
      'message', 'Only a clinic admin can change a user''s access.');
  end if;

  if p_is_active is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Specify whether the account should be active.',
      'fields', jsonb_build_array('p_is_active'));
  end if;

  -- An admin who deactivates themselves is locked out instantly and cannot undo it —
  -- reactivation needs an admin, and they have just stopped being one. Blocked
  -- outright rather than allowed-when-another-admin-exists: it is far more likely a
  -- misclick on the wrong row than a deliberate act, and the correct way for an
  -- admin to leave is for a colleague to revoke them.
  if p_user_id = v_uid and not p_is_active then
    return jsonb_build_object('ok', false, 'code', 'CANNOT_DEACTIVATE_SELF',
      'message', 'You cannot deactivate your own account. Ask another admin to do it.');
  end if;

  v_tenant := public.current_tenant_id();

  select p.id, p.role, p.is_active into v_target
  from public.profiles p
  where p.id = p_user_id and p.tenant_id = v_tenant
  for update;

  if not found then
    -- Same answer whether the id is unknown or belongs to another clinic, so this
    -- cannot be used to probe for users elsewhere. Matches admin_set_user_role().
    return jsonb_build_object('ok', false, 'code', 'USER_NOT_IN_TENANT',
      'message', 'That user is not part of your clinic.');
  end if;

  if v_target.is_active = p_is_active then
    return jsonb_build_object('ok', true, 'user_id', p_user_id,
      'is_active', p_is_active, 'changed', false);
  end if;

  -- The sibling of CANNOT_DEMOTE_LAST_ADMIN, and it exists for the same reason: a
  -- clinic with zero *active* admins can never invite anyone, change a role, or edit
  -- its own settings again, and only the platform owner could repair it from the
  -- dashboard. Note this counts ACTIVE admins — the Phase 1 role guard counts admins
  -- by role alone, so without this check the two could be satisfied simultaneously
  -- while leaving the clinic with no one who can actually act.
  if not p_is_active and v_target.role = 'admin' then
    select count(*) into v_active_admins
    from public.profiles p
    where p.tenant_id = v_tenant
      and p.role = 'admin'
      and p.is_active;

    if v_active_admins <= 1 then
      return jsonb_build_object('ok', false, 'code', 'CANNOT_DEACTIVATE_LAST_ADMIN',
        'message', 'This is the clinic''s only active admin. Promote another admin first.');
    end if;
  end if;

  update public.profiles
     set is_active      = p_is_active,
         deactivated_at = case when p_is_active then null else now() end
   where id = p_user_id and tenant_id = v_tenant;

  -- No explicit audit call: the profiles_audit trigger records
  -- user.deactivated / user.reactivated for this UPDATE whichever path performed it.

  return jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'is_active', p_is_active,
    'changed', true,
    'role', v_target.role,
    -- So the UI can be honest about what just happened. See 20260811080000's header:
    -- database access stops immediately, the JWT does not.
    'session_note', case
      when p_is_active then null
      else 'Database access is revoked immediately. Any signed-in session keeps a valid token until it expires — sign the user out client-side.'
    end
  );
end;
$$;

comment on function public.admin_set_user_active(uuid, boolean) is
  'Deactivates or reactivates a user in the caller''s clinic. Admin only. Refuses self-deactivation (CANNOT_DEACTIVATE_SELF) and refuses to leave the clinic with no active admin (CANNOT_DEACTIVATE_LAST_ADMIN). Takes no free-text reason on purpose — see the migration header.';

revoke execute on function public.admin_set_user_active(uuid, boolean) from public, anon;
grant  execute on function public.admin_set_user_active(uuid, boolean) to authenticated;
