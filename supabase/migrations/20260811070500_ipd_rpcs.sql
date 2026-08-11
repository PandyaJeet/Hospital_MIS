-- ============================================================================
-- Migration:  ipd_rpcs
--             admit_patient_to_bed / discharge_patient / set_bed_status
--             + the one-shot admission task trigger
--
-- WHY THESE ARE RPCs AND NOT COLUMN GRANTS
-- Phase 2's dividing line was "RPC when there is branching or a side effect,
-- plain CRUD otherwise". Admission is the clearest possible case for an RPC: it
-- writes two tables that must agree, it has a feature-tier gate, and it has a
-- concurrency hazard (two clerks admitting different patients to bed 4 at the
-- same moment). None of that is expressible as a column grant.
--
-- Accordingly `visits.care_setting/admitted_at/discharged_at/bed_id` and
-- `beds.status/current_visit_id` are outside every client grant, so these
-- functions are the only way in.
--
-- SECURITY DEFINER, and therefore every lookup filters tenant_id explicitly —
-- RLS does not apply to the table owner, so the isolation these functions rely on
-- is written out rather than inherited. Same discipline as the Phase 2 RPCs.
--
-- WHO MAY ADMIT: any onboarded staff member (is_tenant_staff()), matching
-- check_in_patient(). The DECISION to admit is a doctor's, but the RECORDING of
-- it happens at the front desk in every clinic this product targets — the same
-- reason patient registration and check-in are not doctor-only. Restricting the
-- keystroke to a clinician would mean the doctor doing reception's data entry.
--
-- TIER GATE: admit and set_bed_status are gated on tenant_has_tier(2).
-- discharge_patient deliberately is NOT — see its header.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- admit_patient_to_bed(visit, bed)
--
-- Also handles a TRANSFER (already admitted, different bed requested), because
-- the alternative is worse: without it, a bed assigned by mistake could only be
-- undone by discharging the patient, which would falsify the discharge time on a
-- medical record to fix a typo. A transfer frees the old bed to 'cleaning' and
-- occupies the new one in the same transaction.
--
-- Re-admitting to the SAME bed is an idempotent no-op success (changed:false), so
-- a double-tapped button is harmless.
-- ---------------------------------------------------------------------------
create or replace function public.admit_patient_to_bed(
  p_visit_id uuid,
  p_bed_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_tenant    uuid;
  v_visit     record;
  v_bed       record;
  -- Scalars rather than a second `record`: an unassigned plpgsql record cannot be
  -- field-referenced ("record is not assigned yet"), and the transfer branch below
  -- is skipped entirely for a first admission.
  v_old_bed_id     uuid := null;
  v_old_ward       text := null;
  v_old_bed_number text := null;
  v_admitted  timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.is_tenant_staff() then
    return jsonb_build_object('ok', false, 'code', 'NOT_STAFF',
      'message', 'Only clinic staff can admit a patient.');
  end if;

  -- ---- THE TIER GATE (rules.md §4.3) --------------------------------------
  -- Checked here as well as in the `beds` policies, and checked BEFORE anything
  -- is looked up so a Tier 1 caller cannot use the error codes below to probe
  -- which bed ids exist. `TIER_NOT_ENABLED` is deliberately its own code, not a
  -- generic permission failure: the UI must be able to say "upgrade to enable
  -- inpatient management", which is a different message from "you are not
  -- allowed to do this".
  if not public.tenant_has_tier(2) then
    return jsonb_build_object(
      'ok', false,
      'code', 'TIER_NOT_ENABLED',
      'message', 'Inpatient and bed management is a Tier 2 feature and is not enabled for this clinic.',
      'required_tier', 2,
      'current_tier', public.current_tenant_tier()
    );
  end if;

  v_tenant := public.current_tenant_id();

  -- Locks are taken visit-then-bed in every function here, so two concurrent
  -- admissions cannot deadlock against each other.
  select v.id, v.status, v.care_setting, v.admitted_at, v.discharged_at, v.bed_id
    into v_visit
  from public.visits v
  where v.id = p_visit_id and v.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'VISIT_NOT_FOUND',
      'message', 'That visit does not exist at this clinic.');
  end if;

  if v_visit.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'VISIT_CANCELLED',
      'message', 'That visit was cancelled and cannot be admitted.');
  end if;

  if v_visit.discharged_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_DISCHARGED',
      'message', 'That admission has already been discharged. Start a new visit for a re-admission.');
  end if;

  select b.id, b.ward_name, b.bed_number, b.status, b.current_visit_id
    into v_bed
  from public.beds b
  where b.id = p_bed_id and b.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'BED_NOT_FOUND',
      'message', 'That bed does not exist at this clinic.');
  end if;

  -- Already in exactly this bed: nothing to do.
  if v_visit.bed_id = p_bed_id then
    return jsonb_build_object('ok', true, 'visit_id', p_visit_id, 'bed_id', p_bed_id,
      'ward_name', v_bed.ward_name, 'bed_number', v_bed.bed_number,
      'admitted_at', v_visit.admitted_at, 'changed', false);
  end if;

  -- Occupied by somebody else, or out of service. One code covers both, with the
  -- actual status returned so the UI can distinguish "bed 4 is taken" from "bed 4
  -- is being cleaned" without a second round trip. Deliberately does NOT reveal
  -- WHO occupies it — that would be a patient identity leak into an error path.
  if v_bed.status <> 'available' then
    return jsonb_build_object(
      'ok', false,
      'code', 'BED_NOT_AVAILABLE',
      'message', 'That bed is not available.',
      'bed_status', v_bed.status,
      'ward_name', v_bed.ward_name,
      'bed_number', v_bed.bed_number
    );
  end if;

  -- ---- transfer: release the previous bed ---------------------------------
  if v_visit.bed_id is not null then
    select b.id, b.ward_name, b.bed_number
      into v_old_bed_id, v_old_ward, v_old_bed_number
    from public.beds b
    where b.id = v_visit.bed_id and b.tenant_id = v_tenant
    for update;

    -- 'cleaning', not 'available': a bed someone has just left needs turning over
    -- before the next patient. Housekeeping releases it via set_bed_status().
    update public.beds
       set status = 'cleaning', current_visit_id = null
     where id = v_visit.bed_id and tenant_id = v_tenant;
  end if;

  v_admitted := coalesce(v_visit.admitted_at, now());

  update public.visits
     set care_setting = 'ipd',
         admitted_at  = v_admitted,
         bed_id       = p_bed_id
   where id = p_visit_id and tenant_id = v_tenant;

  update public.beds
     set status = 'occupied', current_visit_id = p_visit_id
   where id = p_bed_id and tenant_id = v_tenant;

  return jsonb_build_object(
    'ok', true,
    'visit_id', p_visit_id,
    'bed_id', p_bed_id,
    'ward_name', v_bed.ward_name,
    'bed_number', v_bed.bed_number,
    'admitted_at', v_admitted,
    'changed', true,
    'transferred_from', case
      when v_old_bed_id is null then null
      else jsonb_build_object('bed_id', v_old_bed_id,
                              'ward_name', v_old_ward,
                              'bed_number', v_old_bed_number)
    end
  );
end;
$$;

comment on function public.admit_patient_to_bed(uuid, uuid) is
  'Admits a visit to a bed, or transfers an already-admitted visit to a different bed. Tier 2 gated server-side (TIER_NOT_ENABLED) per rules.md §4.3. Maintains beds.status/current_visit_id and visits.care_setting/admitted_at/bed_id atomically; locks visit then bed.';


-- ---------------------------------------------------------------------------
-- discharge_patient(visit)
--
-- !! DELIBERATELY NOT TIER-GATED. !!
-- Every other bed operation is. This one is not, because the failure mode of
-- gating it is unacceptable: if a tenant's tier were lowered while a patient was
-- in a bed, a gated discharge would leave that patient permanently admitted, the
-- bed permanently occupied, and no in-app way out. A feature gate exists to stop
-- a clinic STARTING to use a module it has not paid for, not to trap clinical
-- state it already has. Unwinding is always allowed.
--
-- Side effect: pending tasks for the visit are cancelled. A ward board still
-- showing "vitals due" for a patient who went home costs a nurse a walk to an
-- empty bed, and the card can never legitimately be completed. Done tasks are
-- left exactly as they are — they are the record of care given.
--
-- Does NOT touch visits.status. See 20260811070400's header: admission and the
-- consultation lifecycle are separate axes on purpose, and having discharge stamp
-- 'done' would silently re-couple them.
-- ---------------------------------------------------------------------------
create or replace function public.discharge_patient(
  p_visit_id uuid,
  p_notes    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_tenant    uuid;
  v_visit     record;
  v_freed     uuid;
  v_cancelled integer := 0;
  v_now       timestamptz := now();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.is_tenant_staff() then
    return jsonb_build_object('ok', false, 'code', 'NOT_STAFF',
      'message', 'Only clinic staff can discharge a patient.');
  end if;

  v_tenant := public.current_tenant_id();

  select v.id, v.admitted_at, v.discharged_at, v.bed_id into v_visit
  from public.visits v
  where v.id = p_visit_id and v.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'VISIT_NOT_FOUND',
      'message', 'That visit does not exist at this clinic.');
  end if;

  if v_visit.admitted_at is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_ADMITTED',
      'message', 'That visit is not an admission, so it cannot be discharged.');
  end if;

  if v_visit.discharged_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_DISCHARGED',
      'message', 'That admission has already been discharged.',
      'discharged_at', v_visit.discharged_at);
  end if;

  -- Free the bed. visits.bed_id is intentionally left in place as a record of
  -- where the patient stayed; only live occupancy is cleared.
  if v_visit.bed_id is not null then
    update public.beds
       set status = 'cleaning', current_visit_id = null
     where id = v_visit.bed_id and tenant_id = v_tenant
     returning id into v_freed;
  end if;

  update public.visits
     set discharged_at = v_now
   where id = p_visit_id and tenant_id = v_tenant;

  with cancelled as (
    update public.tasks
       set status = 'cancelled',
           cancellation_reason = 'Patient discharged'
     where visit_id = p_visit_id
       and tenant_id = v_tenant
       and status = 'pending'
    returning 1
  )
  select count(*) into v_cancelled from cancelled;

  return jsonb_build_object(
    'ok', true,
    'visit_id', p_visit_id,
    'discharged_at', v_now,
    'bed_released', v_freed,
    'pending_tasks_cancelled', v_cancelled,
    'notes', nullif(trim(coalesce(p_notes, '')), '')
  );
end;
$$;

comment on function public.discharge_patient(uuid, text) is
  'Discharges an admission: stamps discharged_at, releases the bed to cleaning, and cancels the visit''s pending tasks. NOT tier-gated on purpose — a tier downgrade must never trap an admitted patient. Does not touch visits.status.';


-- ---------------------------------------------------------------------------
-- set_bed_status(bed, status)
--
-- Housekeeping transitions only: available <-> cleaning <-> maintenance.
--
-- 'occupied' is REJECTED as a target. Occupancy is an outcome of admitting
-- somebody, never a state to be typed in — beds_occupancy_consistent would refuse
-- the write anyway (occupied requires current_visit_id), but a constraint
-- violation surfaces as an opaque 23514, and a caller who tried this needs to be
-- told to use admit_patient_to_bed() instead.
--
-- An occupied bed cannot be moved to any other status either. Marking it clean
-- while a patient is in it would free it for a second admission.
--
-- Nursing/admin only: turning a bed over is ward work, not front-desk work.
-- ---------------------------------------------------------------------------
create or replace function public.set_bed_status(
  p_bed_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_tenant uuid;
  v_bed    record;
  v_new    text := lower(trim(coalesce(p_status, '')));
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.has_tenant_role(array['admin', 'nurse']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_WARD_STAFF',
      'message', 'Only nursing or admin staff can change a bed''s status.');
  end if;

  if not public.tenant_has_tier(2) then
    return jsonb_build_object(
      'ok', false,
      'code', 'TIER_NOT_ENABLED',
      'message', 'Inpatient and bed management is a Tier 2 feature and is not enabled for this clinic.',
      'required_tier', 2,
      'current_tier', public.current_tenant_tier()
    );
  end if;

  if v_new = 'occupied' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BED_STATUS',
      'message', 'A bed becomes occupied by admitting a patient to it, not by setting its status.',
      'fields', jsonb_build_array('p_status'));
  end if;

  if v_new not in ('available', 'cleaning', 'maintenance') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Bed status must be available, cleaning or maintenance.',
      'fields', jsonb_build_array('p_status'));
  end if;

  v_tenant := public.current_tenant_id();

  select b.id, b.status, b.current_visit_id into v_bed
  from public.beds b
  where b.id = p_bed_id and b.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'BED_NOT_FOUND',
      'message', 'That bed does not exist at this clinic.');
  end if;

  if v_bed.status = 'occupied' then
    return jsonb_build_object('ok', false, 'code', 'BED_OCCUPIED',
      'message', 'That bed is occupied. Discharge or transfer the patient first.');
  end if;

  if v_bed.status = v_new then
    return jsonb_build_object('ok', true, 'bed_id', p_bed_id, 'status', v_new, 'changed', false);
  end if;

  update public.beds set status = v_new where id = p_bed_id and tenant_id = v_tenant;

  return jsonb_build_object('ok', true, 'bed_id', p_bed_id, 'status', v_new, 'changed', true);
end;
$$;

comment on function public.set_bed_status(uuid, text) is
  'Housekeeping bed transitions (available/cleaning/maintenance), nursing or admin only, Tier 2 gated. Refuses ''occupied'' as a target and refuses to touch an occupied bed — occupancy is an outcome of admit_patient_to_bed()/discharge_patient().';


-- ---------------------------------------------------------------------------
-- Admission -> one initial "vitals due" task
--
-- The whole of this phase's task generation, and deliberately no more than this.
-- A newly admitted patient needs a baseline set of observations, so the board
-- should already have that card by the time the nurse looks at it — a task board
-- that starts empty and has to be filled in by hand is not a task board, it is a
-- notepad.
--
-- What this is NOT: a scheduler. There is exactly one task per admission, not
-- "every 4 hours". See 20260811070200's header for why a recurrence engine is out
-- of scope, and docs/contracts/nurse-tasks.md for the gap as Prince needs to
-- understand it.
--
-- Idempotent via tasks_one_auto_per_source_idx: a transfer, a correction, or any
-- other update that leaves admitted_at set cannot mint a second card. The guard
-- below fires only on the null -> not-null edge, and the unique index is the
-- backstop if some future path gets there another way.
--
-- SECURITY DEFINER because tasks.is_auto/source_type/source_id/status are outside
-- every client grant by design.
-- ---------------------------------------------------------------------------
create or replace function public.autoinsert_admission_vitals_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.admitted_at is null or old.admitted_at is not null then
    return null;
  end if;

  insert into public.tasks (
    tenant_id, visit_id, task_type, title, status, due_at,
    is_auto, source_type, source_id
  )
  values (
    new.tenant_id, new.id, 'vitals_due', 'Baseline vitals on admission',
    'pending', new.admitted_at,
    true, 'admission', new.id
  )
  on conflict do nothing;

  return null;
end;
$$;

comment on function public.autoinsert_admission_vitals_task() is
  'AFTER UPDATE on visits: creates one baseline vitals_due task the first time a visit is admitted. Not a scheduler — exactly one task per admission. Idempotent via tasks_one_auto_per_source_idx.';

drop trigger if exists visits_autoinsert_admission_task on public.visits;
create trigger visits_autoinsert_admission_task
  after update of admitted_at on public.visits
  for each row
  execute function public.autoinsert_admission_vitals_task();


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.admit_patient_to_bed(uuid, uuid) from public, anon;
revoke execute on function public.discharge_patient(uuid, text)    from public, anon;
revoke execute on function public.set_bed_status(uuid, text)       from public, anon;

grant execute on function public.admit_patient_to_bed(uuid, uuid) to authenticated;
grant execute on function public.discharge_patient(uuid, text)    to authenticated;
grant execute on function public.set_bed_status(uuid, text)       to authenticated;
