-- ============================================================================
-- Migration:  rounds_and_alert_views
--             rounds_overview / critical_lab_alerts
--             + acknowledge_critical_result() / get_critical_lab_alert_payload()
--
-- ---------------------------------------------------------------------------
-- WHY VIEWS, AND WHY security_invoker
-- ---------------------------------------------------------------------------
-- The rounds list needs the latest vitals row PER PATIENT alongside the visit,
-- the bed and a task count. That is a LATERAL join, and a lateral join is not
-- expressible through supabase-js — Prince cannot write it from the client. The
-- options were therefore a view or an RPC, and a view is the better fit: it is a
-- real relation, so PostgREST filtering, ordering, pagination and generated
-- TypeScript types all work on it exactly as they do on a table, and Architecture
-- .md §3's "every persona's view is just a filtered query on the same underlying
-- tables" stays literally true.
--
-- `with (security_invoker = true)` is load-bearing and not optional. A view
-- normally executes with its OWNER's privileges, and the owner here is postgres,
-- which is not subject to RLS — so a plain view over these tables would be a
-- perfect cross-tenant leak dressed up as a convenience. With security_invoker the
-- underlying policies are evaluated as the CALLER, so:
--   * a clinic only ever sees its own rows, enforced by the same policies as a
--     direct query;
--   * and the vitals-minimisation decision from 20260811070100 holds through the
--     view: a BILLING session reading rounds_overview gets the visit, patient and
--     bed columns and NULL for every measurement, because the vitals policy
--     excludes them. Nothing special had to be written to achieve that, which is
--     the point of putting the boundary in RLS rather than in queries.
--
-- Caveat worth stating for Prince: the task and alert COUNTS come from aggregates,
-- so a role that cannot read those tables sees 0 rather than NULL. 0 there means
-- "not visible to you", not "none outstanding". Only admin/doctor/nurse should be
-- shown those numbers.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- rounds_overview
--
-- One row per visit, carrying everything the doctor's rounds list and the nurse's
-- patient header need. Not filtered to inpatients: filtering inside the view would
-- bake a product decision into the schema, and the same shape is useful for an OPD
-- queue card that wants to show triage vitals. Prince filters:
--
--   .eq('care_setting','ipd').is('discharged_at', null)   -- current inpatients
--   .order('last_vitals_at', { ascending: true, nullsFirst: true })  -- most overdue
--
-- `vitals_age_seconds` is computed rather than stored: an "overdue" threshold is a
-- clinical policy that will change, and a stored staleness value would be wrong
-- one second after it was written.
-- ---------------------------------------------------------------------------
create or replace view public.rounds_overview
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

  -- Freshness: the denormalised cache, plus its age at read time.
  v.last_vitals_at,
  case
    when v.last_vitals_at is null then null
    else floor(extract(epoch from (now() - v.last_vitals_at)))::bigint
  end                           as vitals_age_seconds,

  -- Latest observation, straight from `vitals` under the caller's own RLS.
  lv.recorded_at                as vitals_recorded_at,
  lv.recorded_by                as vitals_recorded_by,
  lv.temperature_c,
  lv.pulse_bpm,
  lv.bp_systolic,
  lv.bp_diastolic,
  lv.respiratory_rate,
  lv.spo2_percent,
  lv.blood_glucose,

  tk.pending_tasks,
  tk.overdue_tasks,
  al.unacknowledged_alerts
from public.visits v
join public.patients p
  on p.id = v.patient_id and p.tenant_id = v.tenant_id
left join public.beds b
  on b.id = v.bed_id and b.tenant_id = v.tenant_id
-- Single indexed lookup per row via vitals_visit_recorded_idx. `id desc` breaks a
-- tie when two observations share a timestamp, so the view is deterministic.
left join lateral (
  select vt.recorded_at, vt.recorded_by, vt.temperature_c, vt.pulse_bpm,
         vt.bp_systolic, vt.bp_diastolic, vt.respiratory_rate,
         vt.spo2_percent, vt.blood_glucose
  from public.vitals vt
  where vt.visit_id = v.id
  order by vt.recorded_at desc, vt.id desc
  limit 1
) lv on true
left join lateral (
  select count(*) filter (where t.status = 'pending')                        as pending_tasks,
         count(*) filter (where t.status = 'pending' and t.due_at < now())    as overdue_tasks
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
  'One row per visit: patient, bed, admission state, vitals freshness, latest observations, task counts and outstanding lab alerts. security_invoker, so every underlying RLS policy applies to the caller — a billing session sees NULL measurements because the vitals policy excludes it. Task/alert counts are aggregates, so 0 can mean "not visible to you".';


-- ---------------------------------------------------------------------------
-- critical_lab_alerts
--
-- Every result that demands attention: critical, or unevaluable. Both, on purpose
-- — "we could not check this" is an outstanding obligation just as much as "this is
-- dangerously high", and a feed that showed only the flagged ones would quietly
-- drop the results nobody has thresholds for.
--
-- Includes acknowledged rows as well; the UI filters `.is('acknowledged_at', null)`
-- for the live banner and can show the rest as history.
--
-- NO PATIENT NAME, deliberately. `patient_number` (the UHID staff already use),
-- the ward and the bed identify the patient well enough to act on, and the name is
-- one join away for a clinician who is authorised to read it. Keeping names out of
-- this shape by construction matters because the SAME shape is what
-- get_critical_lab_alert_payload() hands to the notification dispatcher — and that
-- path will eventually terminate at WhatsApp or SMS. A payload that never contains
-- a name cannot leak one into a third party, whatever a future integration does
-- (rules.md §1.3).
-- ---------------------------------------------------------------------------
create or replace view public.critical_lab_alerts
with (security_invoker = true) as
select
  r.id                          as lab_result_id,
  r.tenant_id,
  r.lab_order_id,

  o.test_name,
  o.priority,
  o.visit_id,
  o.patient_id,
  o.ordered_by,
  o.ordered_at,

  pt.patient_number,

  v.care_setting,
  b.ward_name,
  b.bed_number,

  r.result_value,
  r.result_numeric,
  r.unit,
  r.is_critical,
  r.critical_check_status,
  r.requires_manual_review,
  r.critical_direction,
  r.critical_low_used,
  r.critical_high_used,
  r.reported_at,
  r.reported_by,
  r.acknowledged_at,
  r.acknowledged_by
from public.lab_results r
join public.lab_orders o
  on o.id = r.lab_order_id and o.tenant_id = r.tenant_id
join public.patients pt
  on pt.id = o.patient_id and pt.tenant_id = o.tenant_id
join public.visits v
  on v.id = o.visit_id and v.tenant_id = o.tenant_id
left join public.beds b
  on b.id = v.bed_id and b.tenant_id = v.tenant_id
where r.is_critical or r.requires_manual_review;

comment on view public.critical_lab_alerts is
  'Results that demand attention — critical OR unevaluable. security_invoker, so only admin/doctor/nurse in the owning tenant see rows (the lab_results policy excludes billing). Deliberately carries patient_number/ward/bed but NO patient name, because the same shape feeds the notification dispatcher.';


-- ---------------------------------------------------------------------------
-- View privileges.
--
-- A view has no RLS of its own; with security_invoker the underlying policies do
-- the work, and `authenticated` already holds table-level SELECT on every base
-- relation. anon holds none, and gets none here either.
-- ---------------------------------------------------------------------------
revoke all on public.rounds_overview     from anon, authenticated;
revoke all on public.critical_lab_alerts from anon, authenticated;
grant select on public.rounds_overview     to authenticated;
grant select on public.critical_lab_alerts to authenticated;


-- ---------------------------------------------------------------------------
-- acknowledge_critical_result()
--
-- This is what makes phases.md's "visible alerts, not passive queue entries"
-- verifiable rather than aspirational. Without acknowledgement, an alert is a row
-- that may or may not have been seen and the claim cannot be tested; with it, an
-- unacknowledged critical result is an outstanding obligation with a name attached
-- once someone clears it.
--
-- Only alertable rows can be acknowledged. Acknowledging an ordinary normal result
-- is meaningless, and allowing it would let a UI bug quietly mark everything seen.
-- ---------------------------------------------------------------------------
create or replace function public.acknowledge_critical_result(
  p_lab_result_id uuid,
  p_note          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_tenant uuid;
  v_row    record;
  v_now    timestamptz := now();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  -- Acknowledging a clinical alert is a clinical act — the person clearing it is
  -- asserting they have seen and will act on it. Billing must not be able to make
  -- an alert disappear.
  if not public.has_tenant_role(array['admin', 'doctor', 'nurse']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLINICAL_STAFF',
      'message', 'Only nursing, medical or admin staff can acknowledge a result.');
  end if;

  v_tenant := public.current_tenant_id();

  select r.id, r.is_critical, r.requires_manual_review,
         r.acknowledged_at, r.acknowledged_by
    into v_row
  from public.lab_results r
  where r.id = p_lab_result_id and r.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'LAB_RESULT_NOT_FOUND',
      'message', 'That result does not exist at this clinic.');
  end if;

  if not (v_row.is_critical or v_row.requires_manual_review) then
    return jsonb_build_object('ok', false, 'code', 'NOT_ALERTABLE',
      'message', 'That result raised no alert, so there is nothing to acknowledge.');
  end if;

  if v_row.acknowledged_at is not null then
    -- Idempotent: two clinicians tapping the same banner is not an error.
    return jsonb_build_object('ok', true, 'lab_result_id', p_lab_result_id,
      'acknowledged_at', v_row.acknowledged_at,
      'acknowledged_by', v_row.acknowledged_by,
      'changed', false);
  end if;

  update public.lab_results
     set acknowledged_at = v_now,
         acknowledged_by = v_uid,
         notes = case
           when nullif(trim(coalesce(p_note, '')), '') is null then notes
           else coalesce(notes || ' | ', '') || trim(p_note)
         end
   where id = p_lab_result_id and tenant_id = v_tenant;

  return jsonb_build_object('ok', true, 'lab_result_id', p_lab_result_id,
    'acknowledged_at', v_now, 'acknowledged_by', v_uid, 'changed', true);
end;
$$;

comment on function public.acknowledge_critical_result(uuid, text) is
  'Records that a clinician has seen a critical or unevaluable result. Idempotent. Refuses non-alertable results (NOT_ALERTABLE) so a UI bug cannot mark everything seen. Clinical roles only — billing must not be able to clear an alert.';


-- ---------------------------------------------------------------------------
-- get_critical_lab_alert_payload()
--
-- The assembled alert. This is the "logic-bearing part" the Edge Function
-- deliberately does not own: deciding a value is critical happens in
-- evaluate_lab_critical(), and shaping what an alert says happens here — both in
-- Postgres, both covered by the SQL test suites, both working today with nothing
-- deployed.
--
-- SECURITY INVOKER, which is what lets one function serve two very different
-- callers correctly:
--   * a clinician's session — RLS filters to their own tenant, so this is safe to
--     expose to `authenticated` and is what the in-app alert banner can call for a
--     single alert's detail;
--   * the alert dispatcher — service_role has BYPASSRLS, so a webhook-triggered
--     Edge Function with no user session can still resolve the row it was handed.
-- A SECURITY DEFINER version could not do the second: current_tenant_id() is NULL
-- with no session, so it would resolve nothing.
--
-- PII: no patient name, ever — see the note on critical_lab_alerts. The clinical
-- content (test, value, unit, direction, thresholds) IS included, because
-- conveying it is the entire purpose of the alert; what is excluded is identity
-- beyond the internal UHID.
-- ---------------------------------------------------------------------------
create or replace function public.get_critical_lab_alert_payload(
  p_lab_result_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_a record;
begin
  select * into v_a
  from public.critical_lab_alerts a
  where a.lab_result_id = p_lab_result_id;

  if not found then
    -- Covers all three of: unknown id, another tenant's row (RLS filtered it), and
    -- a result that raised no alert. Deliberately one answer, so this cannot be
    -- used to probe for results the caller may not see.
    return jsonb_build_object('ok', false, 'code', 'ALERT_NOT_FOUND',
      'message', 'No outstanding alert was found for that result.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'alert', jsonb_build_object(
      'lab_result_id',  v_a.lab_result_id,
      'lab_order_id',   v_a.lab_order_id,
      'tenant_id',      v_a.tenant_id,
      'visit_id',       v_a.visit_id,
      'patient_id',     v_a.patient_id,
      -- Identity for staff use only. No name, no phone (rules.md §1.3).
      'patient_number', v_a.patient_number,
      'care_setting',   v_a.care_setting,
      'ward_name',      v_a.ward_name,
      'bed_number',     v_a.bed_number,
      'test_name',      v_a.test_name,
      'priority',       v_a.priority,
      'result_value',   v_a.result_value,
      'value_numeric',  v_a.result_numeric,
      'unit',           v_a.unit,
      'is_critical',    v_a.is_critical,
      'critical_check_status',  v_a.critical_check_status,
      'requires_manual_review', v_a.requires_manual_review,
      'critical_direction',     v_a.critical_direction,
      'critical_low',   v_a.critical_low_used,
      'critical_high',  v_a.critical_high_used,
      'reported_at',    v_a.reported_at,
      'reported_by',    v_a.reported_by,
      'ordered_by',     v_a.ordered_by,
      'acknowledged_at', v_a.acknowledged_at,
      -- Precomputed so a dispatcher never has to interpret the fields itself. A
      -- notification that said the wrong thing about a critical value would be
      -- worse than no notification.
      'severity', case when v_a.is_critical then 'critical' else 'unevaluated' end,
      'headline', case
        when v_a.is_critical and v_a.critical_direction = 'low'
          then v_a.test_name || ' critically LOW'
        when v_a.is_critical and v_a.critical_direction = 'high'
          then v_a.test_name || ' critically HIGH'
        else v_a.test_name || ' could not be evaluated — verify manually'
      end
    )
  );
end;
$$;

comment on function public.get_critical_lab_alert_payload(uuid) is
  'Assembles the alert payload for one lab result: test, value, thresholds, ward/bed, precomputed severity and headline. No patient name. SECURITY INVOKER so a clinician''s session is RLS-scoped while a service_role dispatcher (no user session) can still resolve the row.';


revoke execute on function public.acknowledge_critical_result(uuid, text)      from public, anon;
revoke execute on function public.get_critical_lab_alert_payload(uuid)         from public, anon;
grant  execute on function public.acknowledge_critical_result(uuid, text)      to authenticated;
grant  execute on function public.get_critical_lab_alert_payload(uuid)         to authenticated;
