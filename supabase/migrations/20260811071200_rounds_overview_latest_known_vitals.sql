-- ============================================================================
-- Migration:  rounds_overview_latest_known_vitals
-- Purpose:    Fix a real defect in rounds_overview, found by the Phase 3 REMOTE
--             suite: a measurement recorded in an earlier row disappeared from the
--             rounds card.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- 20260811071000 built the view's vitals columns from the single most recent
-- `vitals` ROW:
--
--     order by vt.recorded_at desc, vt.id desc limit 1
--
-- That contradicts the design decision one migration earlier. 20260811070100 made
-- EVERY measurement column nullable precisely so that a partial observation set is
-- normal and always saveable — a nurse with a temperature but no BP yet must be
-- able to save. But if the BP is then recorded as a SECOND row five minutes later,
-- "the latest row" is a row whose only populated field is the BP, and the
-- temperature reads as NULL on the rounds card.
--
-- So the schema said "partial rows are expected" and the view said "the newest row
-- is the whole picture". Both cannot be right. The observed symptom was a rounds
-- card showing a blank temperature for a patient whose temperature had been
-- recorded minutes earlier — and a blank field on a clinical glance view reads as
-- "not measured", which is a misread with real consequences.
--
-- Worth noting how it surfaced: the LOCAL suite missed it because its fixture
-- happened to insert the fullest observation set last, so the newest row was also
-- the most complete one. The remote suite inserted an empty row, then a
-- temperature-only row, then a systolic-only row — the realistic partial-entry
-- sequence — and caught it immediately. That is the argument for having both
-- layers.
--
-- ---------------------------------------------------------------------------
-- THE FIX: LATEST KNOWN VALUE PER MEASUREMENT
-- ---------------------------------------------------------------------------
-- Each measurement column now carries the most recent NON-NULL value for that
-- measurement within the encounter, independently of the others. This is how a
-- paper flowsheet's "most recent" column behaves and what a clinician reads it as.
--
-- After this change a NULL measurement means exactly one thing: it has never been
-- recorded during this encounter. That is the property that makes the card safe to
-- read at a glance, and it is what was missing.
--
-- HONESTY ABOUT THE TRADE-OFF, because this fix introduces its own hazard:
-- assembling values from different points in time means the card can be a
-- composite — a temperature from 06:00 beside a pulse from 11:00. Showing those as
-- if they were one observation would be its own kind of wrong. So the view also
-- returns
--
--     vitals_component_times jsonb   -- { "temperature_c": "<ts>", "pulse_bpm": ... }
--
-- with the exact time behind every populated value, and only for populated ones
-- (jsonb_strip_nulls). Prince can render the age of each figure, or grey out
-- anything older than the ward's expected observation interval. `last_vitals_at`
-- continues to mean "when the most recent observation of any kind happened", which
-- is still the right thing to sort and filter an overdue list by.
--
-- The flat scalar columns are kept as scalars rather than folded into the jsonb so
-- PostgREST can still order and filter on them (`.gte('temperature_c', 38)` for a
-- febrile-patients view). The jsonb is for timing only.
--
-- COST: one lateral over `vitals` per row instead of one, still a single indexed
-- pass on vitals_visit_recorded_idx. `array_agg(... order by ...) filter (where ...)`
-- makes each field's newest non-null value a single aggregate over the same scan,
-- so this is not seven subqueries.
--
-- WHY DROP AND RECREATE RATHER THAN `create or replace view`
-- Postgres permits `create or replace view` only to APPEND columns — it cannot
-- rename, reorder or remove existing ones, and fails with "cannot change name of
-- view column". This revision inserts vitals_row_count into the middle of the
-- column list and adds two more, so the positions shift and a replace is not
-- possible. The drop is safe: a view holds no data, and nothing else in the schema
-- depends on this one (no other view, function or constraint references it).
--
-- The consequence to be deliberate about is that DROP discards privileges and
-- options. Both are therefore restated below in full — the security_invoker option
-- especially, since losing it would silently convert every column here into a
-- cross-tenant leak while the view continued to look correct.
-- ============================================================================

drop view if exists public.rounds_overview;

create view public.rounds_overview
with (security_invoker = true) as
select
  v.id                          as visit_id,
  v.tenant_id,
  v.patient_id,
  v.care_setting,
  v.status                      as visit_status,
  v.visit_type,
  v.visit_date,
  v.queue_number,
  v.doctor_id,
  v.checked_in_at,
  v.admitted_at,
  v.discharged_at,

  v.bed_id,
  b.ward_name,
  b.bed_number,

  p.patient_number,
  p.full_name                   as patient_name,
  p.age_years,
  p.dob,
  p.gender,
  p.allergies,

  -- Freshness of the most recent observation of ANY kind. Unchanged: this is what
  -- the overdue sort uses, and it is the non-clinical timestamp billing may see.
  v.last_vitals_at,
  case
    when v.last_vitals_at is null then null
    else floor(extract(epoch from (now() - v.last_vitals_at)))::bigint
  end                           as vitals_age_seconds,

  -- The most recent vitals ROW's own timestamp and author, for "who last saw this
  -- patient". Distinct from the per-field times below.
  lv.latest_row_at              as vitals_recorded_at,
  lv.latest_row_by              as vitals_recorded_by,
  lv.vitals_row_count,

  -- LATEST KNOWN value per measurement. NULL here now means "never recorded during
  -- this encounter" and nothing else.
  lv.temperature_c,
  lv.pulse_bpm,
  lv.bp_systolic,
  lv.bp_diastolic,
  lv.respiratory_rate,
  lv.spo2_percent,
  lv.blood_glucose,
  lv.vitals_notes,

  -- When each populated value above was actually taken. Absent keys mean absent
  -- values, so this doubles as "which measurements exist for this encounter".
  jsonb_strip_nulls(jsonb_build_object(
    'temperature_c',    lv.temperature_c_at,
    'pulse_bpm',        lv.pulse_bpm_at,
    'bp_systolic',      lv.bp_systolic_at,
    'bp_diastolic',     lv.bp_diastolic_at,
    'respiratory_rate', lv.respiratory_rate_at,
    'spo2_percent',     lv.spo2_percent_at,
    'blood_glucose',    lv.blood_glucose_at
  ))                            as vitals_component_times,

  tk.pending_tasks,
  tk.overdue_tasks,
  al.unacknowledged_alerts
from public.visits v
join public.patients p
  on p.id = v.patient_id and p.tenant_id = v.tenant_id
left join public.beds b
  on b.id = v.bed_id and b.tenant_id = v.tenant_id
left join lateral (
  select
    count(*)                                                            as vitals_row_count,
    max(vt.recorded_at)                                                 as latest_row_at,
    (array_agg(vt.recorded_by order by vt.recorded_at desc, vt.id desc))[1] as latest_row_by,

    -- Newest non-null value for each measurement, and the time it was taken.
    (array_agg(vt.temperature_c    order by vt.recorded_at desc, vt.id desc) filter (where vt.temperature_c    is not null))[1] as temperature_c,
    (array_agg(vt.recorded_at      order by vt.recorded_at desc, vt.id desc) filter (where vt.temperature_c    is not null))[1] as temperature_c_at,
    (array_agg(vt.pulse_bpm        order by vt.recorded_at desc, vt.id desc) filter (where vt.pulse_bpm        is not null))[1] as pulse_bpm,
    (array_agg(vt.recorded_at      order by vt.recorded_at desc, vt.id desc) filter (where vt.pulse_bpm        is not null))[1] as pulse_bpm_at,
    (array_agg(vt.bp_systolic      order by vt.recorded_at desc, vt.id desc) filter (where vt.bp_systolic      is not null))[1] as bp_systolic,
    (array_agg(vt.recorded_at      order by vt.recorded_at desc, vt.id desc) filter (where vt.bp_systolic      is not null))[1] as bp_systolic_at,
    (array_agg(vt.bp_diastolic     order by vt.recorded_at desc, vt.id desc) filter (where vt.bp_diastolic     is not null))[1] as bp_diastolic,
    (array_agg(vt.recorded_at      order by vt.recorded_at desc, vt.id desc) filter (where vt.bp_diastolic     is not null))[1] as bp_diastolic_at,
    (array_agg(vt.respiratory_rate order by vt.recorded_at desc, vt.id desc) filter (where vt.respiratory_rate is not null))[1] as respiratory_rate,
    (array_agg(vt.recorded_at      order by vt.recorded_at desc, vt.id desc) filter (where vt.respiratory_rate is not null))[1] as respiratory_rate_at,
    (array_agg(vt.spo2_percent     order by vt.recorded_at desc, vt.id desc) filter (where vt.spo2_percent     is not null))[1] as spo2_percent,
    (array_agg(vt.recorded_at      order by vt.recorded_at desc, vt.id desc) filter (where vt.spo2_percent     is not null))[1] as spo2_percent_at,
    (array_agg(vt.blood_glucose    order by vt.recorded_at desc, vt.id desc) filter (where vt.blood_glucose    is not null))[1] as blood_glucose,
    (array_agg(vt.recorded_at      order by vt.recorded_at desc, vt.id desc) filter (where vt.blood_glucose    is not null))[1] as blood_glucose_at,

    -- The newest non-empty free-text observation, same rule.
    (array_agg(vt.notes order by vt.recorded_at desc, vt.id desc) filter (where nullif(trim(coalesce(vt.notes, '')), '') is not null))[1] as vitals_notes
  from public.vitals vt
  where vt.visit_id = v.id
) lv on true
left join lateral (
  select count(*) filter (where t.status = 'pending')                     as pending_tasks,
         count(*) filter (where t.status = 'pending' and t.due_at < now()) as overdue_tasks
  from public.tasks t
  where t.visit_id = v.id
) tk on true
left join lateral (
  select count(*) as unacknowledged_alerts
  from public.lab_results r
  join public.lab_orders o
    on o.id = r.lab_order_id and o.tenant_id = r.tenant_id
  where o.visit_id = v.id
    and r.acknowledged_at is null
    and (r.is_critical or r.requires_manual_review)
) al on true;

comment on view public.rounds_overview is
  'One row per visit: patient, bed, admission state, vitals and outstanding work. Each measurement is the LATEST KNOWN NON-NULL value for the encounter, so NULL means "never recorded" rather than "absent from the newest row" — see 20260811071200 for the defect this fixed. vitals_component_times gives the exact time behind each populated value, because the set can be a composite of different moments. security_invoker: a billing session sees NULL measurements because the vitals policy excludes it. Task/alert counts are aggregates, so 0 can mean "not visible to you".';

-- Required, not merely tidy: the DROP above discarded the grants from
-- 20260811071000, so without these the view would exist and be unreadable by every
-- client.
revoke all on public.rounds_overview from anon, authenticated;
grant select on public.rounds_overview to authenticated;
