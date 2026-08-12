-- ============================================================================
-- Migration:  audit_log
-- Purpose:    "Who changed what, for compliance" (phases.md Phase 4).
--
-- ###########################################################################
-- #  THE PII BOUNDARY IS THE WHOLE DESIGN. READ THIS BEFORE ADDING A TRIGGER. #
-- #                                                                          #
-- #  `audit_log.changes` records WHICH FIELDS changed, and records their      #
-- #  VALUES only for an explicit allow-list of non-personal, compliance-      #
-- #  bearing columns. For everything else it records that the field changed   #
-- #  and nothing more.                                                        #
-- #                                                                          #
-- #  A clinical note's text, a patient's name or phone, a diagnosis, a        #
-- #  prescription's contents, a lab result value and an invite's email        #
-- #  address are NEVER written here.                                          #
-- ###########################################################################
--
-- WHY, GIVEN AN ADMIN CAN ALREADY READ MOST OF IT
-- The obvious objection: `clinical_notes` is already readable by admin, so what is
-- protected by keeping note text out of an admin-readable audit table? Three things,
-- and the first is the one that actually decides it:
--
--   1. AN AUDIT LOG IS PERMANENT AND A RECORD IS NOT. Notes get corrected, patients
--      get merged, data gets erased. DPDP alignment (PRD §7) includes correction and
--      erasure. A `changes` blob holding the full prior text of every clinical edit
--      is an un-erasable shadow copy of exactly the data those obligations apply to
--      — and it would sit in a table nobody thinks of when honouring a deletion
--      request. Logging *that* a note changed, by whom, when, satisfies the
--      compliance requirement without creating the liability.
--   2. IT IS A SECOND, LESS-GUARDED COPY. The clinical tables carry carefully
--      differentiated policies — billing cannot read `clinical_notes`, `vitals` or
--      `lab_results`. Any future widening of audit read access (a support view, an
--      export, a metrics job) would silently carry PHI with it. Keeping content out
--      means that class of mistake cannot happen.
--   3. UNBOUNDED GROWTH OF THE MOST SENSITIVE CONTENT. Every edit, forever, with no
--      clinical purpose being served by the copy.
--
-- rules.md §1.3 bans logging PII/PHI to "console, error trackers, or analytics". An
-- audit table is none of those literally, so this is applying the rule's intent
-- rather than its letter — the same reasoning Phase 3 used to make vitals nullable
-- under a §1.7 written about doctor's notes.
--
-- WHY THE ALLOW-LIST LIVES IN A FUNCTION BODY AND NOT IN A TABLE
-- A configuration table would be editable by service_role, which means the boundary
-- between "log this value" and "log that a field changed" could be moved without a
-- migration, a diff or a review. Encoding it in `audit_diff()` means widening what
-- gets logged is a schema change that shows up in review. This is security policy,
-- so it belongs where it cannot be quietly reconfigured.
-- ============================================================================


create table if not exists public.audit_log (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants (id) on delete restrict,

  -- NULL is meaningful and expected: a migration, a service-role backfill or any
  -- trigger firing with no JWT has no human actor. Recording NULL is the honest
  -- answer, and it is distinguishable from "we did not capture it" because
  -- `actor_is_system` below states it positively.
  actor_id    uuid        null,
  -- Snapshot of the actor's role AT THE TIME. Roles change; an audit line saying
  -- "a doctor did this" must not silently become "an admin did this" because the
  -- person was later promoted.
  actor_role  text        null,
  -- A positive signal so the UI never has to interpret a NULL actor_id.
  actor_is_system boolean not null default false,

  -- Dotted, stable vocabulary. Documented in docs/contracts/audit-log.md; treat
  -- these as an API, because a dashboard will filter on them.
  action      text        not null,

  table_name  text        not null,
  row_id      uuid        null,

  -- { "role": { "from": "doctor", "to": "nurse" } }            <- allow-listed
  -- { "body":  { "changed": true, "redacted": true } }         <- everything else
  changes     jsonb       not null default '{}'::jsonb,

  created_at  timestamptz not null default now(),

  constraint audit_log_action_not_blank check (length(trim(action)) > 0),
  constraint audit_log_table_name_not_blank check (length(trim(table_name)) > 0),
  -- A system event must not name an actor, and a human event must.
  constraint audit_log_actor_coherent check (
    (actor_is_system and actor_id is null)
    or (not actor_is_system and actor_id is not null)
  ),
  -- NOT a composite FK to (id, tenant_id) on profiles, unlike every other child
  -- table in this schema, and deliberately: an actor may be a user who has since
  -- been moved or whose profile row is gone, and an audit row must survive that.
  -- Cross-tenant integrity is instead guaranteed by construction — `tenant_id` is
  -- always taken from the audited row server-side, never from a caller. A plain
  -- RESTRICT reference would also make a profile undeletable, which is already true
  -- for other reasons but should not be this table's doing.
  constraint audit_log_actor_role_valid check (
    actor_role is null
    or actor_role in ('pending', 'admin', 'doctor', 'nurse', 'billing', 'patient')
  )
);

comment on table public.audit_log is
  'Append-only compliance trail: who changed what, when. `changes` holds field VALUES only for an allow-list of non-personal columns (see audit_diff()); clinical and personal content is recorded as changed-but-redacted, never copied. Admin-readable within the tenant; no client write path at all.';
comment on column public.audit_log.changes is
  'Per-field diff. Allow-listed fields carry {from,to}. Everything else carries {changed:true, redacted:true} — the field name is compliance-relevant, its content is not this table''s business. See the migration header for why.';
comment on column public.audit_log.actor_id is
  'NULL for a system/trigger/service-role change, in which case actor_is_system is true. Deliberately NOT a foreign key: an audit row must outlive the profile it refers to.';

-- The audit trail query: this clinic's events, newest first.
create index if not exists audit_log_tenant_created_idx on public.audit_log (tenant_id, created_at desc);
-- "everything that happened to this row" and "everything of this kind".
create index if not exists audit_log_row_idx    on public.audit_log (tenant_id, table_name, row_id, created_at desc);
create index if not exists audit_log_action_idx on public.audit_log (tenant_id, action, created_at desc);
-- "what did this person do", for a leaver review.
create index if not exists audit_log_actor_idx  on public.audit_log (tenant_id, actor_id, created_at desc)
  where actor_id is not null;


-- ---------------------------------------------------------------------------
-- RLS — admin read, nobody writes
--
-- No INSERT/UPDATE/DELETE grant and no policy for them, so the table is unwritable
-- from any client session including an admin's. Rows arrive only from the
-- SECURITY DEFINER triggers below. Same discipline as `tasks.is_auto` and
-- `lab_results.is_critical`: a log a user can write is not a log.
--
-- Admin-only read: this is oversight data about staff, and a doctor being able to
-- see who changed whose role is a different (and unrequested) thing from an admin
-- being able to. PRD §6.5 puts user/role provisioning with the admin.
-- ---------------------------------------------------------------------------
alter table public.audit_log enable row level security;

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

create policy audit_log_select_admin
  on public.audit_log
  for select
  to authenticated
  using (
    public.is_tenant_admin()
    and tenant_id = public.current_tenant_id()
  );


-- ---------------------------------------------------------------------------
-- audit_diff() — the redaction boundary, in one place
--
-- Returns a per-field diff of two row images, applying the allow-list. Any column
-- not named below is reported as changed without its content, so **the default is
-- redaction** — a new column added to an audited table is redacted automatically
-- rather than leaking until someone remembers to exclude it. That default is the
-- reason this is written as an allow-list and not a deny-list.
--
-- IMMUTABLE-ish and side-effect free, so it is directly unit-testable: the local
-- suite calls it with crafted row images and asserts the redaction, which is much
-- more convincing than inferring the boundary from trigger output.
-- ---------------------------------------------------------------------------
create or replace function public.audit_diff(
  p_table text,
  p_old   jsonb,
  p_new   jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_key    text;
  v_old_v  jsonb;
  v_new_v  jsonb;
  v_allow  text[];
begin
  -- ---- THE ALLOW-LIST ----------------------------------------------------
  -- Values may be recorded ONLY for these (table, column) pairs. Every entry is a
  -- fact about the CLINIC's configuration or a person's ACCESS RIGHTS — never
  -- about a patient, and never free text authored by a clinician.
  v_allow := case p_table
    -- Access rights. These ARE the compliance facts the log exists to hold.
    when 'profiles' then array['role', 'is_active', 'tenant_id', 'deactivated_at']
    -- Clinic configuration and tax posture. Business facts, not personal data.
    -- `tier` included because an entitlement change is exactly what an auditor asks
    -- about; it is set by the platform owner, so it will normally log as a system event.
    when 'tenants'  then array['name', 'tier', 'gst_registered', 'gstin',
                               'gst_state_code', 'default_consultation_fee']
    -- Invite lifecycle. `role` and the timestamps only.
    -- `email` is EXCLUDED — it is personal data, and it is already on the invites
    -- row for anyone authorised to look.
    -- `token` is EXCLUDED — it is a live capability; copying it into a
    -- longer-lived, differently-guarded table would extend its blast radius.
    when 'invites'  then array['role', 'expires_at', 'accepted_at', 'accepted_by']
    else array[]::text[]
  end;

  -- Union of keys present in either image, so additions and removals both show up.
  for v_key in
    select k from jsonb_object_keys(coalesce(p_new, '{}'::jsonb)) as k
    union
    select k from jsonb_object_keys(coalesce(p_old, '{}'::jsonb)) as k
  loop
    v_old_v := p_old -> v_key;
    v_new_v := p_new -> v_key;

    -- `is distinct from` is NULL-safe: a field going NULL -> value, or value -> NULL,
    -- is a change and must be reported.
    if v_old_v is distinct from v_new_v then
      if v_key = any(v_allow) then
        v_result := v_result || jsonb_build_object(
          v_key, jsonb_build_object('from', v_old_v, 'to', v_new_v)
        );
      else
        -- Field name kept, content dropped. `redacted:true` is explicit so a reader
        -- can never mistake an absent value for an empty one.
        v_result := v_result || jsonb_build_object(
          v_key, jsonb_build_object('changed', true, 'redacted', true)
        );
      end if;
    end if;
  end loop;

  return v_result;
end;
$$;

comment on function public.audit_diff(text, jsonb, jsonb) is
  'Per-field diff with an allow-list: records values only for non-personal, compliance-bearing columns and reports everything else as {changed,redacted}. DEFAULT IS REDACTION, so a newly added column is redacted automatically. The allow-list lives in this function body, not a table, so widening it requires a migration and a review.';

revoke execute on function public.audit_diff(text, jsonb, jsonb) from public, anon;
grant  execute on function public.audit_diff(text, jsonb, jsonb) to authenticated;


-- ---------------------------------------------------------------------------
-- record_audit_event() — the only writer
--
-- SECURITY DEFINER because nothing else may insert here. Resolves the actor from
-- `auth.uid()` itself and takes `tenant_id` from the caller (always a trigger
-- passing the audited row's own tenant), never from anything client-supplied
-- (rules.md §1.2).
--
-- `actor_role` is read directly from `profiles` rather than via
-- `current_user_role()`, on purpose: after 20260811080000 that helper returns NULL
-- for a deactivated user, and the one action most likely to be performed *on* a
-- deactivated account is reactivation — where we still want to record the role of
-- whoever did it. The actor's own active state is not what this column is about.
-- ---------------------------------------------------------------------------
create or replace function public.record_audit_event(
  p_tenant_id  uuid,
  p_action     text,
  p_table_name text,
  p_row_id     uuid,
  p_changes    jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := null;
  v_role  text := null;
  v_id    uuid;
  v_note  text := null;
begin
  -- Nothing to attach an event to. Returning NULL rather than raising: an audit
  -- write must never be the reason a legitimate clinical or admin action fails.
  if p_tenant_id is null then
    return null;
  end if;

  -- Actor resolution is wrapped because this function is reached from triggers that
  -- fire in EVERY context, including a service-role or migration write where there is
  -- no JWT at all. If identifying the actor fails for any reason, the event must
  -- still be recorded — an audit trigger that can abort the transaction it is
  -- observing would make the log a liability rather than a safeguard.
  --
  -- This is NOT a swallowed error (rules.md §3.2). Nothing is lost: the row is still
  -- written, `actor_is_system` states positively that no actor was identified, and the
  -- SQLSTATE is preserved under a reserved `_audit_note` key so the cause is
  -- recoverable. Same discipline as flag_lab_result_critical(), which records the
  -- SQLSTATE rather than discarding it.
  begin
    v_actor := (select auth.uid());
  exception
    when others then
      v_actor := null;
      v_note  := 'actor resolution failed (SQLSTATE ' || sqlstate || ')';
  end;

  if v_actor is not null then
    begin
      select p.role into v_role
      from public.profiles p
      where p.id = v_actor;
    exception
      when others then
        v_role := null;
        v_note := coalesce(v_note || '; ', '')
                  || 'role lookup failed (SQLSTATE ' || sqlstate || ')';
    end;
  end if;

  if v_note is not null then
    p_changes := coalesce(p_changes, '{}'::jsonb) || jsonb_build_object('_audit_note', v_note);
  end if;

  insert into public.audit_log (
    tenant_id, actor_id, actor_role, actor_is_system,
    action, table_name, row_id, changes
  )
  values (
    p_tenant_id, v_actor, v_role, (v_actor is null),
    p_action, p_table_name, p_row_id, coalesce(p_changes, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_audit_event(uuid, text, text, uuid, jsonb) is
  'The only writer of audit_log. SECURITY DEFINER; resolves the actor from auth.uid() and marks actor_is_system when there is none. Returns NULL rather than raising on a missing tenant — an audit write must never be why a legitimate action fails.';

-- Not callable by clients. Triggers invoke it as the table owner; exposing it to
-- `authenticated` would let a user forge audit entries, which is strictly worse than
-- having no log.
revoke execute on function public.record_audit_event(uuid, text, text, uuid, jsonb)
  from public, anon, authenticated;
