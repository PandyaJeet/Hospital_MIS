-- ============================================================================
-- Migration:  invite_rpcs
-- Purpose:    create_invite()  — admin mints a capability token for a new hire
--             accept_invite()  — the invitee spends it and joins the tenant
--
-- Same return contract as create_tenant_and_assign_admin: expected failures
-- come back as { ok:false, code, message } in `data`; only bugs and RLS/
-- transport problems surface through supabase-js `error`.
-- ============================================================================


-- ============================================================================
-- create_invite
-- ----------------------------------------------------------------------------
-- Returns the token to the admin, because the admin's client is what builds
-- the invite link to send out. That is safe: the caller is already proven to be
-- an admin of the tenant the invite belongs to.
--
-- Stale-invite refresh: the invites_one_open_per_email_idx unique index cannot
-- exclude expired rows (immutability), so re-inviting someone whose link lapsed
-- would otherwise fail with a confusing duplicate error. Instead we detect that
-- case and rotate the token + expiry in place. Rotating rather than reusing
-- matters: the old link must stop working, otherwise "resend invite" would
-- silently extend the life of a token that may have leaked.
-- ============================================================================
create or replace function public.create_invite(
  p_email            text,
  p_role             text,
  p_expires_in_hours integer default 168   -- 7 days
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_tenant_id  uuid;
  v_email      text := lower(trim(coalesce(p_email, '')));
  v_role       text := lower(trim(coalesce(p_role, '')));
  v_hours      integer := coalesce(p_expires_in_hours, 168);
  v_expires_at timestamptz;
  v_existing   public.invites;
  v_invite     public.invites;
begin
  if v_uid is null then
    return jsonb_build_object(
      'ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in to invite staff.'
    );
  end if;

  -- Authority check. is_tenant_admin() reads the caller's own profile, so this
  -- cannot be influenced by anything the client sends.
  if not public.is_tenant_admin() then
    return jsonb_build_object(
      'ok', false, 'code', 'NOT_ADMIN',
      'message', 'Only a clinic admin can invite staff.'
    );
  end if;

  v_tenant_id := public.current_tenant_id();

  -- ---- validation --------------------------------------------------------
  if v_email = '' or position('@' in v_email) < 2 then
    return jsonb_build_object(
      'ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'A valid email address is required.',
      'fields', jsonb_build_array('p_email')
    );
  end if;

  if v_role not in ('admin', 'doctor', 'nurse', 'billing', 'patient') then
    return jsonb_build_object(
      'ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Role must be one of: admin, doctor, nurse, billing, patient.',
      'fields', jsonb_build_array('p_role')
    );
  end if;

  if v_hours < 1 or v_hours > 720 then   -- 1 hour .. 30 days
    return jsonb_build_object(
      'ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Invite validity must be between 1 hour and 30 days.',
      'fields', jsonb_build_array('p_expires_in_hours')
    );
  end if;

  v_expires_at := now() + make_interval(hours => v_hours);

  -- ---- already on staff? -------------------------------------------------
  -- Checked against auth.users because a person is identified by their login
  -- email, not by anything in profiles. Reachable only from inside this
  -- SECURITY DEFINER function; auth.users is never client-readable.
  if exists (
    select 1
    from auth.users u
    join public.profiles p on p.id = u.id
    where lower(u.email) = v_email
      and p.tenant_id = v_tenant_id
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'ALREADY_MEMBER',
      'message', 'That person is already part of your clinic.'
    );
  end if;

  -- ---- outstanding invite for this email? --------------------------------
  select * into v_existing
  from public.invites i
  where i.tenant_id = v_tenant_id
    and i.email = v_email
    and i.accepted_at is null
  for update;

  if found then
    if v_existing.expires_at > now() then
      -- Still-valid invite already out there. Don't silently mint a second one.
      return jsonb_build_object(
        'ok', false, 'code', 'INVITE_ALREADY_EXISTS',
        'message', 'An invite for this email is already pending.',
        'invite_id', v_existing.id,
        'expires_at', v_existing.expires_at
      );
    end if;

    -- Lapsed: rotate the token so the old link dies, and extend.
    update public.invites
       set token      = gen_random_uuid(),
           role       = v_role,
           invited_by = v_uid,
           expires_at = v_expires_at,
           created_at = now()
     where id = v_existing.id
    returning * into v_invite;

    return jsonb_build_object(
      'ok', true,
      'invite_id', v_invite.id,
      'token', v_invite.token,
      'email', v_invite.email,
      'role', v_invite.role,
      'expires_at', v_invite.expires_at,
      'refreshed', true
    );
  end if;

  -- ---- fresh invite ------------------------------------------------------
  insert into public.invites (tenant_id, email, role, invited_by, expires_at)
  values (v_tenant_id, v_email, v_role, v_uid, v_expires_at)
  returning * into v_invite;

  return jsonb_build_object(
    'ok', true,
    'invite_id', v_invite.id,
    'token', v_invite.token,
    'email', v_invite.email,
    'role', v_invite.role,
    'expires_at', v_invite.expires_at,
    'refreshed', false
  );
end;
$$;

comment on function public.create_invite(text, text, integer) is
  'Admin-only. Mints (or refreshes) an invite token for an email + role in the caller''s tenant. Returns jsonb {ok:true,token,...} or {ok:false,code,message}.';

revoke execute on function public.create_invite(text, text, integer) from public, anon;
grant  execute on function public.create_invite(text, text, integer) to authenticated;


-- ============================================================================
-- accept_invite
-- ----------------------------------------------------------------------------
-- Called by a freshly-signed-up 'pending' user who holds a token. This is the
-- one place in the schema where an unprivileged user causes their own
-- tenant_id/role to be written, so the checks here are the whole security
-- story of the invite flow:
--
--   1. token must exist                    -> INVITE_NOT_FOUND
--   2. token must be unspent               -> INVITE_ALREADY_ACCEPTED
--   3. token must be unexpired             -> INVITE_EXPIRED
--   4. caller's email must be CONFIRMED    -> EMAIL_NOT_CONFIRMED
--   5. caller's email must match the invite -> INVITE_EMAIL_MISMATCH
--   6. caller must not already have a tenant -> ALREADY_IN_TENANT
--
-- Check 5 is what stops a leaked/forwarded token from being redeemed by the
-- wrong person. Check 4 is what stops check 5 from being trivially bypassed:
-- without it, an attacker who saw a token could sign up *as* that email address
-- and match it without ever proving they control the inbox. Confirmation is
-- therefore load-bearing, not hygiene.
--
--   !! OPERATIONAL DEPENDENCY !! Check 4 only has teeth if Supabase Auth has
--   "Confirm email" ENABLED. With auto-confirm on, Supabase stamps
--   email_confirmed_at immediately and the check passes without the user
--   proving anything. This is recorded as an open risk in Memory.md §6 and must
--   be verified in the dashboard before any real clinic is onboarded.
--
-- Ordering note: "already accepted" is reported before "expired" because a
-- spent token is the more informative answer when a link is both. Distinct
-- codes per failure are safe to expose here because the token is unguessable —
-- there is no enumeration attack to protect against, and Prince needs the
-- distinction to write a useful message (rules.md §3.3).
--
-- Locks are always taken invites-then-profiles, matching every other function,
-- so concurrent acceptances cannot deadlock against each other.
-- ============================================================================
create or replace function public.accept_invite(
  p_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_invite         public.invites;
  v_caller_email   text;
  v_confirmed_at   timestamptz;
  v_current_tenant uuid;
  v_profile_found  boolean;
  v_tenant_name    text;
begin
  if v_uid is null then
    return jsonb_build_object(
      'ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in to accept an invite.'
    );
  end if;

  if p_token is null then
    return jsonb_build_object(
      'ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Invite token is required.',
      'fields', jsonb_build_array('p_token')
    );
  end if;

  -- ---- 1. token exists ---------------------------------------------------
  select * into v_invite
  from public.invites i
  where i.token = p_token
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'INVITE_NOT_FOUND',
      'message', 'This invite link is not valid. Ask your admin to send a new one.'
    );
  end if;

  -- ---- 2. token unspent --------------------------------------------------
  if v_invite.accepted_at is not null then
    return jsonb_build_object(
      'ok', false, 'code', 'INVITE_ALREADY_ACCEPTED',
      'message', 'This invite has already been used. Ask your admin to send a new one.'
    );
  end if;

  -- ---- 3. token unexpired ------------------------------------------------
  if v_invite.expires_at <= now() then
    return jsonb_build_object(
      'ok', false, 'code', 'INVITE_EXPIRED',
      'message', 'This invite link has expired. Ask your admin to send a new one.'
    );
  end if;

  -- ---- 4 & 5. the caller is who the invite was addressed to --------------
  select lower(u.email), u.email_confirmed_at
    into v_caller_email, v_confirmed_at
  from auth.users u
  where u.id = v_uid;

  if v_confirmed_at is null then
    return jsonb_build_object(
      'ok', false, 'code', 'EMAIL_NOT_CONFIRMED',
      'message', 'Please confirm your email address before accepting this invite.'
    );
  end if;

  if v_caller_email is distinct from v_invite.email then
    -- Deliberately does not echo either address back: the caller does not need
    -- to be told which email the invite was for (rules.md §1.3 — no PII in
    -- messages that could reach a log or an error tracker).
    return jsonb_build_object(
      'ok', false, 'code', 'INVITE_EMAIL_MISMATCH',
      'message', 'This invite was sent to a different email address. Sign in with that address to accept it.'
    );
  end if;

  -- ---- 6. caller is not already in a tenant ------------------------------
  select p.tenant_id, true
    into v_current_tenant, v_profile_found
  from public.profiles p
  where p.id = v_uid
  for update;

  if not coalesce(v_profile_found, false) then
    return jsonb_build_object(
      'ok', false, 'code', 'PROFILE_MISSING',
      'message', 'Your account is not fully set up. Please contact support.'
    );
  end if;

  if v_current_tenant is not null then
    return jsonb_build_object(
      'ok', false, 'code', 'ALREADY_IN_TENANT',
      'message', 'You already belong to a clinic.'
    );
  end if;

  -- ---- commit the join ---------------------------------------------------
  -- tenant_id and role are set in one statement to satisfy the
  -- profiles_tenant_role_consistent CHECK constraint.
  update public.profiles
     set tenant_id = v_invite.tenant_id,
         role      = v_invite.role
   where id = v_uid;

  update public.invites
     set accepted_at = now(),
         accepted_by = v_uid
   where id = v_invite.id;

  select t.name into v_tenant_name
  from public.tenants t
  where t.id = v_invite.tenant_id;

  return jsonb_build_object(
    'ok', true,
    'tenant_id', v_invite.tenant_id,
    'tenant_name', v_tenant_name,
    'role', v_invite.role
  );
end;
$$;

comment on function public.accept_invite(uuid) is
  'Onboarding path 2 of 2: a pending user spends an invite token to join an existing tenant. Validates token existence/spent/expiry and that the caller''s confirmed email matches the invite. Returns jsonb {ok:true,tenant_id,tenant_name,role} or {ok:false,code,message}.';

revoke execute on function public.accept_invite(uuid) from public, anon;
grant  execute on function public.accept_invite(uuid) to authenticated;
