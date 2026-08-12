-- ============================================================================
-- Migration:  audit_triggers
-- Purpose:    Populate audit_log for the four things phases.md's Phase 4 names —
--             role changes, invite lifecycle, deactivation, tenant settings.
--
-- ---------------------------------------------------------------------------
-- SCOPE: FOUR TABLES, NOT EVERY WRITE. STATED PLAINLY.
-- ---------------------------------------------------------------------------
-- Audited: `profiles` (access rights), `invites` (lifecycle), `tenants` (clinic
-- configuration). That covers the Definition of Done exactly.
--
-- NOT audited this phase: every clinical and billing write — notes, prescriptions,
-- vitals, medication administrations, lab results, invoices. That is a much larger
-- job than it looks, and doing it badly is worse than not doing it:
--   * it needs a retention story, because a per-write log on `vitals` grows faster
--     than `vitals` itself;
--   * it needs the redaction boundary applied to ~15 more tables, each with its own
--     judgement about which columns are facts vs content;
--   * and several of those tables are already append-only (medication
--     administrations, lab results), so a change log over them would mostly restate
--     the table.
-- Recorded as remaining work in Memory.md §6 rather than half-built.
--
-- ---------------------------------------------------------------------------
-- WHY TRIGGERS AND NOT CALLS FROM THE RPCs
-- ---------------------------------------------------------------------------
-- `admin_set_user_role()` and `admin_set_user_active()` could each log their own
-- event, and that would read more naturally. Triggers were chosen because they catch
-- **every** path, including the ones that are not RPCs at all: a service-role
-- backfill, a dashboard edit by the platform owner, a future migration, or a second
-- RPC someone adds later. An audit log that only records the writes somebody
-- remembered to instrument is exactly the audit log you cannot rely on.
--
-- Consequence accepted: a trigger knows WHAT changed but not WHY. The `action` is
-- therefore derived from the diff rather than declared by the caller, and there is
-- no free-text reason — see admin_set_user_active()'s header for why that is also
-- the privacy-preferable answer.
--
-- ONE ROW PER STATEMENT, not one per changed field. `accept_invite()` sets
-- `tenant_id` and `role` in a single UPDATE, and that is one event ("joined the
-- clinic"), not two. The action is picked by priority and the full redacted diff
-- rides along in `changes`.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- profiles — access rights
--
-- Fires only when something that governs ACCESS changes: role, is_active,
-- tenant_id. An ordinary `full_name` or `consultation_fee` edit produces no audit
-- row, deliberately — it is not a compliance fact, and logging it would bury the
-- events that are in noise. (If such an edit happens in the same statement as a
-- real change, it still appears in `changes`, redacted.)
-- ---------------------------------------------------------------------------
create or replace function public.audit_profiles_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action  text;
  v_tenant  uuid := coalesce(new.tenant_id, old.tenant_id);
  v_changes jsonb;
begin
  -- Priority order: the most specific, most consequential change names the event.
  if new.is_active is distinct from old.is_active then
    v_action := case when new.is_active then 'user.reactivated' else 'user.deactivated' end;
  elsif new.tenant_id is distinct from old.tenant_id then
    v_action := case
      when old.tenant_id is null then 'user.joined_tenant'
      else 'user.tenant_changed'
    end;
  elsif new.role is distinct from old.role then
    v_action := 'user.role_changed';
  else
    -- Nothing access-governing moved. No row.
    return null;
  end if;

  v_changes := public.audit_diff('profiles', to_jsonb(old), to_jsonb(new));

  perform public.record_audit_event(
    v_tenant, v_action, 'profiles', new.id, v_changes
  );

  return null;
end;
$$;

comment on function public.audit_profiles_change() is
  'AFTER UPDATE on profiles: logs role / is_active / tenant_id changes only — the access-governing facts. Ordinary profile edits are deliberately not audited. One row per statement, action chosen by priority.';

drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit
  after update on public.profiles
  for each row
  execute function public.audit_profiles_change();


-- ---------------------------------------------------------------------------
-- invites — full lifecycle
--
-- Four distinct events, because they answer different questions: who was invited and
-- as what, who actually redeemed it, whether a link was re-issued (which kills the
-- previous token), and whether an invite was withdrawn before use.
--
-- The invitee's EMAIL is never recorded — `audit_diff`'s allow-list excludes it, and
-- `invites.email` remains available on the row itself for anyone authorised. The
-- TOKEN is excluded for a stronger reason: it is a live capability, and copying it
-- into a longer-lived table with different read rules would extend its blast radius.
-- ---------------------------------------------------------------------------
create or replace function public.audit_invites_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.record_audit_event(
      new.tenant_id, 'invite.created', 'invites', new.id,
      -- Not a diff: an insert has no prior image. Records the role granted and the
      -- expiry, which is what an auditor asks about. No email, no token.
      jsonb_build_object(
        'role',       jsonb_build_object('from', null, 'to', to_jsonb(new.role)),
        'expires_at', jsonb_build_object('from', null, 'to', to_jsonb(new.expires_at))
      )
    );
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.record_audit_event(
      old.tenant_id, 'invite.revoked', 'invites', old.id,
      jsonb_build_object('role', jsonb_build_object('from', to_jsonb(old.role), 'to', null))
    );
    return null;
  end if;

  -- UPDATE. Two meaningfully different cases.
  if new.accepted_at is not null and old.accepted_at is null then
    perform public.record_audit_event(
      new.tenant_id, 'invite.accepted', 'invites', new.id,
      public.audit_diff('invites', to_jsonb(old), to_jsonb(new))
    );
  elsif new.token is distinct from old.token then
    -- create_invite() rotating a lapsed invite. Worth its own event because the old
    -- link stops working at this moment.
    perform public.record_audit_event(
      new.tenant_id, 'invite.reissued', 'invites', new.id,
      public.audit_diff('invites', to_jsonb(old), to_jsonb(new))
    );
  end if;

  return null;
end;
$$;

comment on function public.audit_invites_change() is
  'Logs invite.created / invite.accepted / invite.reissued / invite.revoked. Never records the invitee email (personal data, still on the row) or the token (a live capability that must not be copied into a differently-guarded table).';

drop trigger if exists invites_audit on public.invites;
create trigger invites_audit
  after insert or update or delete on public.invites
  for each row
  execute function public.audit_invites_change();


-- ---------------------------------------------------------------------------
-- tenants — clinic configuration
--
-- The GST fields matter most here. `gst_registered` decides whether this clinic
-- issues GST invoices or bills of supply, and `gstin` is snapshotted onto every
-- invoice at issue time. If either is ever wrong, the first question is when it
-- changed and who changed it — and until now nothing recorded that.
--
-- `tier` changes will normally log with actor_is_system = true, because tier is not
-- client-writable and is set by the platform owner via the dashboard or a
-- service-role script. That is correct and is exactly the distinction
-- `actor_is_system` exists to make.
-- ---------------------------------------------------------------------------
create or replace function public.audit_tenants_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.record_audit_event(
      new.id, 'tenant.created', 'tenants', new.id,
      jsonb_build_object(
        'name', jsonb_build_object('from', null, 'to', to_jsonb(new.name)),
        'tier', jsonb_build_object('from', null, 'to', to_jsonb(new.tier))
      )
    );
    return null;
  end if;

  v_changes := public.audit_diff('tenants', to_jsonb(old), to_jsonb(new));

  -- `updated_at` alone is not a settings change. Drop it before deciding whether
  -- anything happened, otherwise the touch trigger makes every write look like one.
  v_changes := v_changes - 'updated_at';

  if v_changes = '{}'::jsonb then
    return null;
  end if;

  perform public.record_audit_event(
    new.id, 'tenant.settings_changed', 'tenants', new.id, v_changes
  );

  return null;
end;
$$;

comment on function public.audit_tenants_change() is
  'Logs tenant.created and tenant.settings_changed. GST registration and GSTIN are the important ones — they determine the legal shape of every invoice, and nothing recorded when they changed before this. Ignores an updated_at-only touch.';

drop trigger if exists tenants_audit on public.tenants;
create trigger tenants_audit
  after insert or update on public.tenants
  for each row
  execute function public.audit_tenants_change();
