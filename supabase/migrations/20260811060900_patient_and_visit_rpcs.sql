-- ============================================================================
-- Migration:  patient_and_visit_rpcs
--             register_patient / check_in_patient / set_visit_status /
--             issue_prescription
--
-- WHICH OPERATIONS GET AN RPC AND WHICH ARE PLAIN CRUD
-- The phase brief asks for this call to be made explicitly, so:
--
--   RPC (envelope-returning), because there is real business-rule branching:
--     register_patient     — soft duplicate detection + per-tenant numbering
--     check_in_patient     — per-day queue numbering + open-visit rule
--     set_visit_status     — transition validation + billing side effect
--     issue_prescription   — freeze + billing side effect
--     check_prescription_safety, create_invoice_for_visit  (later migrations)
--
--   Plain table operations, because they are ordinary CRUD with nothing to decide:
--     reading the queue, patient search, editing demographics,
--     writing/editing a clinical note, composing prescription items,
--     editing a pending billing line, recording payment on an invoice
--
-- The dividing line is side effects and invariants, not importance. Note-taking
-- is the clearest case: it must be the frictionless path (rules.md §1.7), so
-- wrapping it in an RPC that could reject something would work against the
-- product requirement.
--
-- All RPCs keep the Phase 1 envelope: { ok: true, ... } or
-- { ok: false, code, message }. Reasoning unchanged — PostgREST maps an
-- unrecognised SQLSTATE to HTTP 500, so raising would make "this phone number
-- already exists" indistinguishable from "the database is down".
--
-- PII (rules.md §1.3): no function here puts a patient name, phone or clinical
-- text into an exception message or a log line. register_patient does RETURN
-- matching patient records for the duplicate prompt, but only to a caller who is
-- already authorised to read those exact rows, and never via a raise.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- register_patient
--
-- Duplicate handling is SOFT by design — see the header of 20260811060100 for
-- why a unique index on phone is the wrong tool. The flow the UI implements:
--   1. submit -> { ok:false, code:'DUPLICATE_PATIENT', matches:[...] }
--   2. "is it one of these?" -> either open the existing record,
--      or resubmit with p_allow_duplicate_phone => true
-- ---------------------------------------------------------------------------
create or replace function public.register_patient(
  p_full_name              text,
  p_phone                  text    default null,
  p_dob                    date    default null,
  p_age_years              smallint default null,
  p_gender                 text    default null,
  p_address                text    default null,
  p_allergies              text    default null,
  p_allow_duplicate_phone  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_tenant    uuid;
  v_name      text := nullif(trim(coalesce(p_full_name, '')), '');
  v_phone     text := nullif(trim(coalesce(p_phone, '')), '');
  v_norm      text;
  v_matches   jsonb;
  v_number    bigint;
  v_id        uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.is_tenant_staff() then
    return jsonb_build_object('ok', false, 'code', 'NOT_STAFF',
      'message', 'Only clinic staff can register patients.');
  end if;

  v_tenant := public.current_tenant_id();

  -- ---- validation ------------------------------------------------------
  if v_name is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Patient name is required.',
      'fields', jsonb_build_array('p_full_name'));
  end if;

  if length(v_name) > 200 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Patient name must be 200 characters or fewer.',
      'fields', jsonb_build_array('p_full_name'));
  end if;

  if p_gender is not null and p_gender not in ('male', 'female', 'other', 'unknown') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Gender must be male, female, other or unknown.',
      'fields', jsonb_build_array('p_gender'));
  end if;

  if p_dob is not null and p_dob > current_date then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Date of birth cannot be in the future.',
      'fields', jsonb_build_array('p_dob'));
  end if;

  if p_age_years is not null and (p_age_years < 0 or p_age_years > 130) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Age must be between 0 and 130.',
      'fields', jsonb_build_array('p_age_years'));
  end if;

  -- Last 10 digits, matching the generated column's rule so detection and
  -- storage agree.
  v_norm := nullif(right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10), '');

  if v_phone is not null and v_norm is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Phone number must contain at least one digit.',
      'fields', jsonb_build_array('p_phone'));
  end if;

  -- ---- soft duplicate check -------------------------------------------
  -- Only when a phone was actually given: two patients with no phone are not
  -- duplicates of each other in any useful sense.
  if v_norm is not null and not coalesce(p_allow_duplicate_phone, false) then
    select jsonb_agg(jsonb_build_object(
             'id', pt.id,
             'patient_number', pt.patient_number,
             'full_name', pt.full_name,
             'phone', pt.phone,
             'dob', pt.dob,
             'age_years', pt.age_years,
             'gender', pt.gender,
             'created_at', pt.created_at
           ) order by pt.created_at desc)
      into v_matches
    from public.patients pt
    where pt.tenant_id = v_tenant       -- explicit: this function is DEFINER
      and pt.phone_normalized = v_norm;

    if v_matches is not null then
      return jsonb_build_object(
        'ok', false,
        'code', 'DUPLICATE_PATIENT',
        'message', 'A patient with this phone number already exists.',
        'matches', v_matches,
        -- Tells the UI this is an overridable prompt, not a dead end: a child on
        -- a parent's number is a real case that must stay registrable.
        'can_override', true
      );
    end if;
  end if;

  -- ---- allocate the per-tenant patient number -------------------------
  -- Advisory lock rather than locking the tenants row, so concurrent
  -- registrations serialise against each other without blocking unrelated
  -- writes that touch the tenant. Released automatically at commit.
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':patient_number', 0));

  select coalesce(max(pt.patient_number), 0) + 1
    into v_number
  from public.patients pt
  where pt.tenant_id = v_tenant;

  insert into public.patients (
    tenant_id, patient_number, full_name, phone, dob, age_years,
    gender, address, allergies, registered_by
  )
  values (
    v_tenant, v_number, v_name, v_phone, p_dob, p_age_years,
    p_gender, nullif(trim(coalesce(p_address, '')), ''),
    nullif(trim(coalesce(p_allergies, '')), ''), v_uid
  )
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'patient_id', v_id,
    'patient_number', v_number,
    'full_name', v_name
  );
end;
$$;

comment on function public.register_patient(text, text, date, smallint, text, text, text, boolean) is
  'Registers a patient. Soft-detects a duplicate phone and returns the matches so the UI can prompt; p_allow_duplicate_phone overrides for legitimate shared numbers. Allocates the per-tenant patient_number under an advisory lock.';


-- ---------------------------------------------------------------------------
-- check_in_patient — puts a patient in today's queue.
--
-- Refuses to create a second open visit for the same patient on the same day.
-- Without that, a double-click at the front desk produces two queue tokens and,
-- once both are consulted, two consultation charges.
-- ---------------------------------------------------------------------------
create or replace function public.check_in_patient(
  p_patient_id uuid,
  p_visit_type text default 'new',
  p_doctor_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_tenant   uuid;
  v_type     text := lower(trim(coalesce(p_visit_type, 'new')));
  v_existing record;
  v_queue    integer;
  v_id       uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.is_tenant_staff() then
    return jsonb_build_object('ok', false, 'code', 'NOT_STAFF',
      'message', 'Only clinic staff can check patients in.');
  end if;

  v_tenant := public.current_tenant_id();

  if v_type not in ('new', 'follow_up') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Visit type must be new or follow_up.',
      'fields', jsonb_build_array('p_visit_type'));
  end if;

  if p_patient_id is null
     or not exists (
       select 1 from public.patients pt
       where pt.id = p_patient_id and pt.tenant_id = v_tenant
     ) then
    -- Same answer whether the id is unknown or belongs to another clinic, so
    -- this cannot be used to probe for the existence of other tenants' records.
    return jsonb_build_object('ok', false, 'code', 'PATIENT_NOT_FOUND',
      'message', 'That patient is not registered at this clinic.');
  end if;

  if p_doctor_id is not null
     and not exists (
       select 1 from public.profiles pr
       where pr.id = p_doctor_id
         and pr.tenant_id = v_tenant
         and pr.role in ('doctor', 'admin')
     ) then
    return jsonb_build_object('ok', false, 'code', 'DOCTOR_NOT_FOUND',
      'message', 'That doctor is not part of this clinic.');
  end if;

  -- Already waiting or mid-consultation today?
  select v.id, v.queue_number, v.status
    into v_existing
  from public.visits v
  where v.tenant_id = v_tenant
    and v.patient_id = p_patient_id
    and v.visit_date = current_date
    and v.status in ('queued', 'in_consultation')
  limit 1;

  if found then
    return jsonb_build_object(
      'ok', false,
      'code', 'VISIT_ALREADY_OPEN',
      'message', 'This patient is already in today''s queue.',
      'visit_id', v_existing.id,
      'queue_number', v_existing.queue_number,
      'status', v_existing.status
    );
  end if;

  -- Per-tenant, per-day token allocation.
  perform pg_advisory_xact_lock(
    hashtextextended(v_tenant::text || ':queue:' || current_date::text, 0)
  );

  select coalesce(max(v.queue_number), 0) + 1
    into v_queue
  from public.visits v
  where v.tenant_id = v_tenant
    and v.visit_date = current_date;

  insert into public.visits (
    tenant_id, patient_id, doctor_id, visit_type, status,
    visit_date, queue_number, created_by
  )
  values (
    v_tenant, p_patient_id, p_doctor_id, v_type, 'queued',
    current_date, v_queue, v_uid
  )
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'visit_id', v_id,
    'queue_number', v_queue,
    'visit_type', v_type,
    'status', 'queued'
  );
end;
$$;

comment on function public.check_in_patient(uuid, text, uuid) is
  'Adds a patient to today''s queue and allocates the per-day token number. Refuses a second open visit for the same patient on the same day, which would otherwise double-bill.';


-- ---------------------------------------------------------------------------
-- set_visit_status — the only way to move a visit through its lifecycle.
--
-- Advancing a visit fires the consultation billing trigger, so an unvalidated
-- status write could bill twice or bill a cancelled visit. Legal moves:
--     queued          -> in_consultation | cancelled
--     in_consultation -> done | cancelled
--     done            -> (terminal)
--     cancelled       -> (terminal)
-- ---------------------------------------------------------------------------
create or replace function public.set_visit_status(
  p_visit_id uuid,
  p_status   text,
  p_cancellation_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_tenant  uuid;
  v_current text;
  v_new     text := lower(trim(coalesce(p_status, '')));
  v_allowed boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.is_tenant_staff() then
    return jsonb_build_object('ok', false, 'code', 'NOT_STAFF',
      'message', 'Only clinic staff can update a visit.');
  end if;

  v_tenant := public.current_tenant_id();

  if v_new not in ('queued', 'in_consultation', 'done', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Unknown visit status.',
      'fields', jsonb_build_array('p_status'));
  end if;

  select v.status into v_current
  from public.visits v
  where v.id = p_visit_id and v.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'VISIT_NOT_FOUND',
      'message', 'That visit does not exist at this clinic.');
  end if;

  if v_current = v_new then
    return jsonb_build_object('ok', true, 'visit_id', p_visit_id,
      'status', v_new, 'changed', false);
  end if;

  v_allowed := (v_current = 'queued'          and v_new in ('in_consultation', 'cancelled'))
            or (v_current = 'in_consultation' and v_new in ('done', 'cancelled'));

  if not v_allowed then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_STATUS_TRANSITION',
      'message', 'That visit cannot move from its current state to the requested one.',
      'from', v_current,
      'to', v_new
    );
  end if;

  update public.visits v
     set status = v_new,
         consultation_started_at = case
           when v_new = 'in_consultation' then coalesce(v.consultation_started_at, now())
           else v.consultation_started_at end,
         consultation_ended_at = case
           when v_new = 'done' then coalesce(v.consultation_ended_at, now())
           else v.consultation_ended_at end,
         -- A visit going into consultation without an assigned doctor is
         -- attributed to whoever opened it, so the consultation fee resolves to
         -- a real practitioner rather than the tenant default.
         doctor_id = case
           when v_new = 'in_consultation' and v.doctor_id is null
                and public.has_tenant_role(array['doctor', 'admin'])
           then v_uid else v.doctor_id end,
         cancellation_reason = case
           when v_new = 'cancelled' then nullif(trim(coalesce(p_cancellation_reason, '')), '')
           else v.cancellation_reason end
   where v.id = p_visit_id and v.tenant_id = v_tenant;

  return jsonb_build_object('ok', true, 'visit_id', p_visit_id,
    'status', v_new, 'changed', true);
end;
$$;

comment on function public.set_visit_status(uuid, text, text) is
  'Validated visit lifecycle transitions. The only sanctioned writer of visits.status, because advancing a visit fires the consultation billing trigger.';


-- ---------------------------------------------------------------------------
-- issue_prescription — freezes a draft and triggers medicine billing.
-- ---------------------------------------------------------------------------
create or replace function public.issue_prescription(
  p_prescription_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_tenant    uuid;
  v_rx        record;
  v_items     integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  v_tenant := public.current_tenant_id();

  select p.id, p.status, p.doctor_id, p.visit_id
    into v_rx
  from public.prescriptions p
  where p.id = p_prescription_id and p.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_NOT_FOUND',
      'message', 'That prescription does not exist at this clinic.');
  end if;

  if v_rx.doctor_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'NOT_PRESCRIBER',
      'message', 'Only the prescribing doctor can issue this prescription.');
  end if;

  if v_rx.status = 'issued' then
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_ALREADY_ISSUED',
      'message', 'This prescription has already been issued.');
  end if;

  if v_rx.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_CANCELLED',
      'message', 'This prescription was cancelled and cannot be issued.');
  end if;

  select count(*) into v_items
  from public.prescription_items pi
  where pi.prescription_id = p_prescription_id;

  if v_items = 0 then
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_EMPTY',
      'message', 'Add at least one medicine before issuing.');
  end if;

  -- The billing trigger on this table turns the items into charges.
  update public.prescriptions
     set status = 'issued', issued_at = now()
   where id = p_prescription_id and tenant_id = v_tenant;

  return jsonb_build_object('ok', true, 'prescription_id', p_prescription_id,
    'status', 'issued', 'item_count', v_items);
end;
$$;

comment on function public.issue_prescription(uuid) is
  'Moves a draft prescription to issued, freezing its items and firing the medicine billing trigger. Prescriber-only; rejects an empty prescription.';


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.register_patient(text, text, date, smallint, text, text, text, boolean) from public, anon;
revoke execute on function public.check_in_patient(uuid, text, uuid)                                     from public, anon;
revoke execute on function public.set_visit_status(uuid, text, text)                                     from public, anon;
revoke execute on function public.issue_prescription(uuid)                                               from public, anon;

grant execute on function public.register_patient(text, text, date, smallint, text, text, text, boolean) to authenticated;
grant execute on function public.check_in_patient(uuid, text, uuid)                                      to authenticated;
grant execute on function public.set_visit_status(uuid, text, text)                                      to authenticated;
grant execute on function public.issue_prescription(uuid)                                                to authenticated;
