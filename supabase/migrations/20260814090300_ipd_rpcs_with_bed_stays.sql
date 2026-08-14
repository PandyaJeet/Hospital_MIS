-- ============================================================================
-- Migration:  ipd_rpcs_with_bed_stays
-- Phase:      6 (IPD billing) — 4 of 6
--
-- Redefines admit_patient_to_bed() and discharge_patient() to maintain bed_stays,
-- and fixes the bed-lock ordering defect found in Phase 5.
--
-- Per rules.md §5.6 the applied migration 20260811070500 is NOT edited; both
-- functions are redefined here with CREATE OR REPLACE. Behaviour outside the
-- changes listed below is byte-identical, deliberately: this phase adds billing to
-- working admission logic, and rewriting the surrounding code while doing so is how
-- a second bug gets introduced.
--
-- ---------------------------------------------------------------------------
-- CHANGE 1 — CANONICAL BED LOCK ORDER (the Phase 5 finding, now applied)
-- ---------------------------------------------------------------------------
-- The Phase 5 lock-order audit found this and deliberately left it, because that
-- phase's remit was the race that had actually been reported. It is now fixed.
--
-- The old shape locked the TARGET bed first and then, only on a transfer, the
-- SOURCE bed:
--
--     select ... from beds where id = p_bed_id   for update;     -- target
--     ...
--     select ... from beds where id = v_visit.bed_id for update; -- source
--
-- Two simultaneous mirror-image transfers therefore acquire in opposite orders —
-- moving a patient bed1 -> bed2 while another moves bed2 -> bed1 gives
-- {lock bed2, want bed1} against {lock bed1, want bed2}. Deadlock, 40P01.
--
-- Unlikely (it needs two transfers between the same pair of beds in the same
-- instant) and non-silent when it happens (Postgres detects it and aborts one side,
-- which can retry). But it is a real ordering bug with a known fix, and the fix is
-- the standard one: acquire the two rows in a deterministic order that does not
-- depend on their role in the operation. Ordering by `id` is arbitrary but total,
-- which is all that is required.
--
-- One statement now locks both beds, `order by b.id for update`. When there is no
-- transfer, `v_visit.bed_id` is NULL, `id in (p_bed_id, null)` matches only the
-- target, and the statement degenerates to exactly the single lock the old code
-- took. So first admissions are unaffected.
--
-- This also completes the convention Phase 5 established. That phase settled
-- "always lock `visits` first"; this settles "and then beds in id order".
--
--     admit     : visits -> beds (id order) -> bed_stays -> tasks (via the
--                 admission-task trigger on visits)
--     discharge : visits -> beds -> bed_stays -> tasks
--
-- bed_stays is written only by these two functions, both of which hold the visits
-- row first, so it cannot introduce an inversion. The room-rent trigger fires off
-- bed_stays and writes billing_line_items, and nothing anywhere locks
-- billing_line_items before visits, so that leg cannot close a cycle either.
--
-- ---------------------------------------------------------------------------
-- CHANGE 2 — MAINTAIN bed_stays
-- ---------------------------------------------------------------------------
-- admit: opens a stay, snapshotting the ward's rate and critical-care flag. On a
-- transfer it first CLOSES the outgoing stay with reason 'transfer', which is what
-- bills the outgoing ward at the outgoing ward's rate.
--
-- discharge: closes the open stay with reason 'discharge', which captures the final
-- period. This is the whole of "discharge correctly captures any accrued-but-
-- uncharged partial stay" — there is no separate reconciliation step, because the
-- charge is computed from the stay at close.
--
-- NOTE ON A STATE THAT DELIBERATELY BILLS NOTHING: 20260811070400 permits an
-- admission with no bed (`visits_bed_requires_admission` allows bed_id NULL — a
-- patient on a trolley in casualty). Such an admission has no bed_stays row and so
-- accrues no room rent, which is correct: there is no room to charge for. It starts
-- accruing the moment admit_patient_to_bed() actually gives them a bed.
--
-- ---------------------------------------------------------------------------
-- WHY THE TIER GATE IS NOT TOUCHED (rules.md §4.3 / prompt §7)
-- ---------------------------------------------------------------------------
-- Room rent is Tier 2+ by construction and needs no gate of its own. A bed_stays
-- row can only be created by admit_patient_to_bed(), which already returns
-- TIER_NOT_ENABLED below Tier 2 before looking anything up. No stay, no charge. A
-- second explicit tier check on the billing path would be gating the same thing
-- twice in two places, which is what the prompt asks not to do — and worse, it
-- could disagree with the first one.
--
-- The mirror of that: discharge_patient() stays UN-gated, exactly as
-- 20260811070500 argued, so a tier downgrade cannot trap an admitted patient. A
-- consequence worth being explicit about is that discharging after a downgrade
-- still closes the stay and still bills the room rent already incurred. That is
-- correct — the clinic used the ward — and it is the same "unwinding is always
-- allowed" principle rather than an exception to it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- admit_patient_to_bed(visit, bed)
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
  v_old_bed_id     uuid := null;
  v_old_ward       text := null;
  v_old_bed_number text := null;
  v_admitted  timestamptz;
  v_now       timestamptz := now();
  v_ward      record;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.is_tenant_staff() then
    return jsonb_build_object('ok', false, 'code', 'NOT_STAFF',
      'message', 'Only clinic staff can admit a patient.');
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

  v_tenant := public.current_tenant_id();

  -- Visit first, always (Phase 5 convention).
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

  -- ⚠️ CHANGE 1. Both beds involved, locked in id order, in one statement.
  --
  -- On a first admission v_visit.bed_id is NULL, so `id in (p_bed_id, null)`
  -- matches the target bed alone and this is exactly the single lock the previous
  -- version took. On a transfer it locks both, in an order that does not depend on
  -- which is source and which is target — which is what makes two mirror-image
  -- transfers queue instead of deadlock.
  perform 1
  from public.beds b
  where b.tenant_id = v_tenant
    and b.id in (p_bed_id, v_visit.bed_id)
  order by b.id
  for update;

  select b.id, b.ward_name, b.bed_number, b.status, b.current_visit_id
    into v_bed
  from public.beds b
  where b.id = p_bed_id and b.tenant_id = v_tenant;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'BED_NOT_FOUND',
      'message', 'That bed does not exist at this clinic.');
  end if;

  -- Already in exactly this bed: nothing to do. Note this returns BEFORE touching
  -- bed_stays, so a double-tapped button cannot close and reopen a stay — which
  -- would otherwise bill the same night twice under two different stay ids.
  if v_visit.bed_id = p_bed_id then
    return jsonb_build_object('ok', true, 'visit_id', p_visit_id, 'bed_id', p_bed_id,
      'ward_name', v_bed.ward_name, 'bed_number', v_bed.bed_number,
      'admitted_at', v_visit.admitted_at, 'changed', false);
  end if;

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

  -- ---- transfer: release the previous bed, and CLOSE its stay --------------
  if v_visit.bed_id is not null then
    select b.id, b.ward_name, b.bed_number
      into v_old_bed_id, v_old_ward, v_old_bed_number
    from public.beds b
    where b.id = v_visit.bed_id and b.tenant_id = v_tenant;

    update public.beds
       set status = 'cleaning', current_visit_id = null
     where id = v_visit.bed_id and tenant_id = v_tenant;

    -- ⚠️ CHANGE 2. Closing this fires autoinsert_room_rent_charge(), which bills
    -- the outgoing ward at the rate snapshotted when that stay STARTED. This is
    -- the entire mechanism behind "each night at the rate that applied that
    -- night": the nights are split at the transfer, and each segment carries its
    -- own rate.
    update public.bed_stays
       set ended_at = v_now, end_reason = 'transfer'
     where visit_id = p_visit_id
       and tenant_id = v_tenant
       and ended_at is null;
  end if;

  v_admitted := coalesce(v_visit.admitted_at, v_now);

  update public.visits
     set care_setting = 'ipd',
         admitted_at  = v_admitted,
         bed_id       = p_bed_id
   where id = p_visit_id and tenant_id = v_tenant;

  update public.beds
     set status = 'occupied', current_visit_id = p_visit_id
   where id = p_bed_id and tenant_id = v_tenant;

  -- ---- open the new stay, snapshotting the ward's commercial terms ----------
  -- The ward row is guaranteed to exist: beds_ward_exists is a foreign key, and
  -- ensure_ward_exists() creates the row on bed insert. coalesce is belt and
  -- braces, defaulting to a zero rate and non-critical, which bills a visible ₹0
  -- line rather than skipping the charge.
  select w.daily_rate, w.is_critical_care
    into v_ward
  from public.wards w
  where w.tenant_id = v_tenant and w.name = v_bed.ward_name;

  insert into public.bed_stays (
    tenant_id, visit_id, bed_id,
    ward_name, daily_rate, is_critical_care,
    started_at
  )
  values (
    v_tenant, p_visit_id, p_bed_id,
    v_bed.ward_name,
    coalesce(v_ward.daily_rate, 0),
    coalesce(v_ward.is_critical_care, false),
    -- A transfer's new stay starts when the transfer happens, not when the
    -- admission began. A first admission's stay starts at the admission time, so
    -- an admission back-dated by coalesce(v_visit.admitted_at, ...) does not lose
    -- the nights before the bed was assigned.
    case when v_visit.bed_id is null then v_admitted else v_now end
  );

  return jsonb_build_object(
    'ok', true,
    'visit_id', p_visit_id,
    'bed_id', p_bed_id,
    'ward_name', v_bed.ward_name,
    'bed_number', v_bed.bed_number,
    'admitted_at', v_admitted,
    'changed', true,
    -- New in Phase 6, so the UI can show what the stay will cost per day without
    -- a second round trip. Snapshotted values, i.e. what will actually be billed.
    'daily_rate', coalesce(v_ward.daily_rate, 0),
    'is_critical_care', coalesce(v_ward.is_critical_care, false),
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
  'Admits a visit to a bed, or transfers an already-admitted visit to a different bed. Tier 2 gated server-side (TIER_NOT_ENABLED) per rules.md §4.3. Maintains beds.status/current_visit_id, visits.care_setting/admitted_at/bed_id and bed_stays atomically. Locks the visit, then BOTH beds in id order (20260814090300) so mirror-image transfers cannot deadlock. A transfer closes the outgoing bed_stay, which bills the outgoing ward at its snapshotted rate.';


-- ---------------------------------------------------------------------------
-- discharge_patient(visit, notes)
--
-- Still NOT tier-gated. See the header and 20260811070500's.
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
  v_stays     integer := 0;
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

  if v_visit.bed_id is not null then
    update public.beds
       set status = 'cleaning', current_visit_id = null
     where id = v_visit.bed_id and tenant_id = v_tenant
     returning id into v_freed;
  end if;

  update public.visits
     set discharged_at = v_now
   where id = p_visit_id and tenant_id = v_tenant;

  -- ⚠️ CHANGE 2. Close the open stay. This is what captures the final,
  -- accrued-but-uncharged period: the room-rent trigger computes the whole stay's
  -- days from started_at/ended_at at this moment, so there is nothing left over to
  -- reconcile afterwards.
  --
  -- Ordered BEFORE the task cancellation below to keep the lock order this
  -- function already had — visits, beds, then tasks — with bed_stays inserted
  -- ahead of tasks rather than after it, so nothing about the Phase 5 ordering
  -- convention changes.
  with closed as (
    update public.bed_stays
       set ended_at = v_now, end_reason = 'discharge'
     where visit_id = p_visit_id
       and tenant_id = v_tenant
       and ended_at is null
    returning 1
  )
  select count(*) into v_stays from closed;

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
    -- 0 when the patient was admitted but never given a bed, which is a real
    -- state (20260811070400) and correctly bills no room rent.
    'bed_stays_closed', v_stays,
    'notes', nullif(trim(coalesce(p_notes, '')), '')
  );
end;
$$;

comment on function public.discharge_patient(uuid, text) is
  'Discharges an admission: stamps discharged_at, releases the bed to cleaning, closes the open bed_stay (which captures the final room-rent charge), and cancels the visit''s pending tasks. NOT tier-gated on purpose — a tier downgrade must never trap an admitted patient. Does not touch visits.status.';
