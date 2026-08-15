-- ============================================================================
-- Migration:  admin_dashboard_views
-- Purpose:    PRD §6.5 — "Dashboard: patient volume, revenue, occupancy, staff
--             utilization (scoped to their tenant_id)".
--
-- ---------------------------------------------------------------------------
-- VIEWS, NOT RPCs — AND WHY THAT COVERS DATE RANGES TOO
-- ---------------------------------------------------------------------------
-- Every metric here is a plain scoped aggregate, so every one is a view. The prompt
-- for this phase suggested an RPC "for anything needing a date-range parameter", but
-- that is not necessary: PostgREST filters a view like a table, so
--
--     .from('admin_patient_volume_daily').gte('activity_date', from).lte(...)
--
-- gives Prince arbitrary ranges with no server-side parameter, no envelope to
-- unwrap, and generated TypeScript types for free. An RPC would have bought nothing
-- and cost the ability to sort and paginate. There is therefore no dashboard RPC at
-- all in this phase — deliberate, and documented in docs/contracts/admin-dashboard.md.
--
-- ALL FIVE ARE `security_invoker` AND ADMIN-GATED IN THE VIEW BODY.
-- security_invoker for the same reason as `rounds_overview`: a view runs as its
-- owner by default, and the owner (`postgres`) is not subject to RLS, so a plain
-- view over these tables would be a cross-tenant leak wearing a convenience's
-- clothing. On top of that, a view cannot carry an RLS policy of its own, so the
-- admin-only requirement is expressed as `where public.is_tenant_admin()` in each
-- body. Belt and braces: the tenant scoping comes from the underlying policies, the
-- role gate from the predicate. A doctor querying any of these gets zero rows.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE CLINIC "DAY" IS THE UTC CALENDAR DATE. READ THIS BEFORE CHARTING.
-- ---------------------------------------------------------------------------
-- Every daily metric here buckets by the UTC calendar date, because that is what
-- `visits.visit_date` already means: Phase 2 set it with `current_date`, and the
-- Supabase session timezone is UTC.
--
-- Consequence: a clinic day runs 05:30 IST → 05:30 IST, not midnight to midnight.
--
-- That is a pre-existing property of the OPD queue, not something introduced here,
-- and these views deliberately INHERIT it rather than fixing it locally. Bucketing
-- patients and revenue by `Asia/Kolkata` while visits bucket by `visit_date` would
-- make the dashboard's panels disagree with each other AND with the queue screen
-- staff use all day — a worse and much more confusing bug than the 05:30 boundary
-- itself. One definition of "day", even an imperfect one, beats two.
--
-- Fixing it properly means a per-tenant timezone column and changing what
-- `check_in_patient()` writes, which changes queue-numbering behaviour. That is a
-- Phase 5 hardening item, flagged in Memory.md §6, not a thing to slip into a
-- reporting migration.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Patient volume
--
-- Registrations and encounters per day. The two are deliberately in one view: the
-- ratio between them is the interesting number (a clinic seeing 40 patients of whom
-- 35 are new is behaving very differently from one where 35 are follow-ups), and
-- charting them from two endpoints would make that ratio the frontend's problem.
--
-- The date spine is a UNION of both sources so a day with registrations but no
-- visits (or vice versa) still appears. Without it the chart would silently skip
-- days rather than showing a zero.
-- ---------------------------------------------------------------------------
create or replace view public.admin_patient_volume_daily
with (security_invoker = true) as
with spine as (
  select p.tenant_id, (p.created_at)::date as activity_date
  from public.patients p
  union
  select v.tenant_id, v.visit_date
  from public.visits v
)
select
  s.tenant_id,
  s.activity_date,
  coalesce(reg.new_patients, 0)        as new_patients,
  coalesce(vis.visits_total, 0)        as visits_total,
  coalesce(vis.visits_new, 0)          as visits_new,
  coalesce(vis.visits_follow_up, 0)    as visits_follow_up,
  coalesce(vis.visits_completed, 0)    as visits_completed,
  coalesce(vis.visits_cancelled, 0)    as visits_cancelled,
  coalesce(vis.visits_still_open, 0)   as visits_still_open,
  coalesce(vis.unique_patients, 0)     as unique_patients_seen,
  coalesce(vis.ipd_admissions, 0)      as ipd_admissions
from spine s
left join lateral (
  select count(*) as new_patients
  from public.patients p
  where p.tenant_id = s.tenant_id
    and (p.created_at)::date = s.activity_date
) reg on true
left join lateral (
  select
    count(*)                                                        as visits_total,
    count(*) filter (where v.visit_type = 'new')                    as visits_new,
    count(*) filter (where v.visit_type = 'follow_up')               as visits_follow_up,
    count(*) filter (where v.status = 'done')                        as visits_completed,
    count(*) filter (where v.status = 'cancelled')                   as visits_cancelled,
    count(*) filter (where v.status in ('queued', 'in_consultation')) as visits_still_open,
    count(distinct v.patient_id)                                     as unique_patients,
    count(*) filter (where v.admitted_at is not null)                as ipd_admissions
  from public.visits v
  where v.tenant_id = s.tenant_id
    and v.visit_date = s.activity_date
) vis on true
where public.is_tenant_admin();

comment on view public.admin_patient_volume_daily is
  'Registrations and encounters per clinic-day (UTC date, matching visits.visit_date — see migration header). Admin only, security_invoker. Filter with .gte/.lte on activity_date; days with activity in only one source still appear.';


-- ---------------------------------------------------------------------------
-- 2. Revenue
--
-- WHAT COUNTS AS REVENUE HERE: invoices with a non-NULL `issued_at` and a status of
-- `issued` or `paid`. Drafts are excluded (nothing has been billed yet) and so are
-- cancelled invoices. Bucketed by ISSUE date, not creation date — the date a
-- document was issued is the one that matters for a revenue figure, and a draft that
-- sat for two days before being issued belongs to the day it was issued.
--
-- `gross_revenue` sums `grand_total`, which is a GENERATED column
-- (`subtotal + tax_total`), so it can never disagree with its parts. `subtotal` and
-- `tax_total` are exposed separately because a GST-registered clinic needs the tax
-- split, and because it makes this view double as the starting point for GST
-- reporting without being built as a GST report.
--
-- `amount_collected` vs `gross_revenue` is the cash-versus-billed gap. Partial
-- payment is representable (`amount_paid` is a free numeric on `invoices`), so
-- outstanding is a real number and not always zero.
-- ---------------------------------------------------------------------------
create or replace view public.admin_revenue_daily
with (security_invoker = true) as
select
  i.tenant_id,
  (i.issued_at)::date                                          as revenue_date,
  count(*)                                                     as invoices_issued,
  count(*) filter (where i.is_gst_invoice)                     as gst_invoices,
  count(*) filter (where not i.is_gst_invoice)                 as bills_of_supply,
  sum(i.subtotal)                                              as subtotal,
  sum(i.tax_total)                                             as tax_total,
  sum(i.grand_total)                                           as gross_revenue,
  sum(i.amount_paid)                                           as amount_collected,
  sum(i.grand_total - i.amount_paid)                           as outstanding,
  count(*) filter (where i.status = 'paid')                     as invoices_paid,
  count(*) filter (where i.status = 'issued')                   as invoices_unpaid
from public.invoices i
where i.issued_at is not null
  and i.status in ('issued', 'paid')
  and public.is_tenant_admin()
group by i.tenant_id, (i.issued_at)::date;

comment on view public.admin_revenue_daily is
  'Issued (non-draft, non-cancelled) invoice totals per day, bucketed by issue date. Exposes subtotal/tax_total separately so it doubles as GST-reporting groundwork. Admin only, security_invoker.';


-- ---------------------------------------------------------------------------
-- 3. Occupancy — a current snapshot, not a time series
--
-- One row per tenant, always, even for a clinic with no beds: built from `tenants`
-- outward rather than from `beds`, so a Tier 1 clinic gets a row of zeros instead of
-- no row. The UI can then say "no beds configured" rather than having to distinguish
-- an empty result from a failed query.
--
-- DELIBERATELY NOT TIER-GATED, following the `beds` SELECT precedent from Phase 3.
-- A Tier 1 tenant has no beds, so this naturally reports zeros — there is nothing to
-- hide, and gating it would mean a downgraded tenant's dashboard started erroring
-- rather than showing an empty ward. Consistent with the reasoning that kept `beds`
-- reads ungated so a bed a patient is lying in cannot vanish from a screen.
--
-- `current_inpatients` is counted from `visits`, not from occupied beds, and the two
-- can legitimately differ: Phase 3 allows an admitted patient with no bed yet (on a
-- trolley in casualty). That difference is a real operational signal, so both numbers
-- are exposed rather than reconciled away.
-- ---------------------------------------------------------------------------
create or replace view public.admin_occupancy_current
with (security_invoker = true) as
select
  t.id                                    as tenant_id,
  t.tier,
  coalesce(b.total_beds, 0)               as total_beds,
  coalesce(b.occupied, 0)                 as occupied,
  coalesce(b.available, 0)                as available,
  coalesce(b.cleaning, 0)                 as cleaning,
  coalesce(b.maintenance, 0)              as maintenance,
  -- NULL rather than 0 when there are no beds: "0% occupied" and "no beds exist" are
  -- different statements, and a gauge showing 0% for a clinic with no ward is a lie.
  case
    when coalesce(b.total_beds, 0) = 0 then null
    else round((b.occupied::numeric / b.total_beds::numeric) * 100, 1)
  end                                     as occupancy_pct,
  coalesce(v.current_inpatients, 0)       as current_inpatients,
  coalesce(v.admitted_without_bed, 0)     as admitted_without_bed,
  coalesce(v.admissions_today, 0)         as admissions_today,
  coalesce(v.discharges_today, 0)         as discharges_today
from public.tenants t
left join lateral (
  select
    count(*)                                          as total_beds,
    count(*) filter (where bd.status = 'occupied')     as occupied,
    count(*) filter (where bd.status = 'available')    as available,
    count(*) filter (where bd.status = 'cleaning')     as cleaning,
    count(*) filter (where bd.status = 'maintenance')  as maintenance
  from public.beds bd
  where bd.tenant_id = t.id
) b on true
left join lateral (
  select
    count(*) filter (where vs.care_setting = 'ipd' and vs.discharged_at is null)      as current_inpatients,
    count(*) filter (where vs.care_setting = 'ipd' and vs.discharged_at is null
                       and vs.bed_id is null)                                         as admitted_without_bed,
    count(*) filter (where (vs.admitted_at)::date = current_date)                     as admissions_today,
    count(*) filter (where (vs.discharged_at)::date = current_date)                   as discharges_today
  from public.visits vs
  where vs.tenant_id = t.id
) v on true
where public.is_tenant_admin();

comment on view public.admin_occupancy_current is
  'Live bed occupancy plus inpatient counts, one row per tenant even with zero beds. occupancy_pct is NULL (not 0) when no beds exist. Not tier-gated, following the beds SELECT precedent. Admin only, security_invoker.';


-- ---------------------------------------------------------------------------
-- 4. "Staff utilization" — ACTIVITY, and one real time measure
--
-- ⚠️ NAMING HONESTY: this is NOT utilization. Utilization is time-worked over
-- time-available, and this system has no roster, no shifts, no clock-in and no
-- contracted hours — so the denominator does not exist and cannot be inferred.
-- Building one would mean inventing a time-tracking module nobody asked for.
--
-- What IS available, and what this view reports:
--   * ACTIVITY COUNTS per person per day — consultations completed, notes authored,
--     prescriptions issued, vitals recorded, tasks completed, lab orders placed,
--     medications administered.
--   * CONSULTING TIME, which is a genuine time measure rather than a proxy:
--     `visits.consultation_started_at` and `consultation_ended_at` both exist
--     (Phase 2), so minutes actually spent in consultation is computable. This is the
--     closest thing to real utilization here and is the number worth showing.
--
-- What a real utilization metric would additionally need, none of which is in scope:
-- a shift roster per staff member, a definition of billable/clinical vs
-- administrative time, and a policy on how idle time between patients is counted.
-- Stated in docs/contracts/admin-dashboard.md so the dashboard does not label this
-- as something it is not.
--
-- PRIVACY NOTE: this view reports COUNTS AND MINUTES per staff member. It exposes no
-- patient identity, no diagnosis and no clinical content — an admin learns that a
-- doctor completed 24 consultations, not who they were. That keeps a management
-- metric from becoming a back door into clinical records for a role that has one
-- (admin can read notes) and would not otherwise be looking.
-- ---------------------------------------------------------------------------
create or replace view public.admin_staff_activity_daily
with (security_invoker = true) as
with events as (
  -- Doctor: completed consultations, with real elapsed time where both stamps exist.
  select v.tenant_id, v.doctor_id as staff_id, v.visit_date as activity_date,
         'consultation'::text as kind,
         case
           when v.consultation_started_at is not null and v.consultation_ended_at is not null
             then extract(epoch from (v.consultation_ended_at - v.consultation_started_at)) / 60.0
           else null
         end as minutes
  from public.visits v
  where v.status = 'done' and v.doctor_id is not null

  union all
  select n.tenant_id, n.author_id, (n.created_at)::date, 'note', null
  from public.clinical_notes n

  union all
  select pr.tenant_id, pr.doctor_id, (pr.created_at)::date, 'prescription', null
  from public.prescriptions pr
  where pr.status = 'issued'

  union all
  select vt.tenant_id, vt.recorded_by, (vt.recorded_at)::date, 'vitals', null
  from public.vitals vt

  union all
  select tk.tenant_id, tk.completed_by, (tk.completed_at)::date, 'task', null
  from public.tasks tk
  where tk.status = 'done' and tk.completed_by is not null

  union all
  select lo.tenant_id, lo.ordered_by, (lo.ordered_at)::date, 'lab_order', null
  from public.lab_orders lo

  union all
  select ma.tenant_id, ma.administered_by, (ma.administered_at)::date, 'medication', null
  from public.medication_administrations ma
)
select
  e.tenant_id,
  e.staff_id,
  p.full_name                                                as staff_name,
  p.role                                                     as staff_role,
  p.is_active                                                 as staff_is_active,
  e.activity_date,
  count(*) filter (where e.kind = 'consultation')             as consultations_completed,
  count(*) filter (where e.kind = 'note')                     as notes_authored,
  count(*) filter (where e.kind = 'prescription')             as prescriptions_issued,
  count(*) filter (where e.kind = 'vitals')                   as vitals_recorded,
  count(*) filter (where e.kind = 'task')                     as tasks_completed,
  count(*) filter (where e.kind = 'lab_order')                as lab_orders_placed,
  count(*) filter (where e.kind = 'medication')               as medications_administered,
  count(*)                                                    as recorded_actions_total,
  -- Real elapsed consulting time. NULL-safe: visits without both stamps contribute
  -- nothing rather than counting as zero minutes, which would drag the average down
  -- and make a data-capture gap look like fast consulting.
  round(sum(e.minutes) filter (where e.kind = 'consultation')::numeric, 1)  as consulting_minutes,
  round(avg(e.minutes) filter (where e.kind = 'consultation')::numeric, 1)  as avg_consultation_minutes,
  count(*) filter (where e.kind = 'consultation' and e.minutes is null)     as consultations_untimed
from events e
join public.profiles p
  on p.id = e.staff_id and p.tenant_id = e.tenant_id
where e.staff_id is not null
  and public.is_tenant_admin()
group by e.tenant_id, e.staff_id, p.full_name, p.role, p.is_active, e.activity_date;

comment on view public.admin_staff_activity_daily is
  'Per-staff, per-day ACTIVITY COUNTS plus real consulting minutes. NOT utilization — there is no roster or contracted-hours denominator in this system, so none is claimed. Exposes counts and minutes only, never patient identity or clinical content. Admin only, security_invoker.';


-- ---------------------------------------------------------------------------
-- 5. Dashboard summary — the headline cards, in one round trip
--
-- Exists purely so the top of the admin dashboard is one query rather than four.
-- Everything here is derivable from the views above; this is a convenience, and it
-- is the only place in this migration where a number is presented over a fixed
-- window (today, and trailing 30 days) rather than as a filterable series.
--
-- 30 days is a stated choice, not a magic number: it is the shortest window that
-- smooths weekly clinic rhythm (a Sunday with no OPD should not make a card read as
-- a collapse), and long enough to be meaningful for a pilot clinic that has only
-- been live for weeks.
-- ---------------------------------------------------------------------------
create or replace view public.admin_dashboard_summary
with (security_invoker = true) as
select
  t.id                                              as tenant_id,
  t.name                                            as tenant_name,
  t.tier,
  t.gst_registered,
  current_date                                      as as_of_date,

  coalesce(today.visits_total, 0)                   as visits_today,
  coalesce(today.visits_completed, 0)               as visits_completed_today,
  coalesce(today.visits_still_open, 0)              as visits_open_now,
  coalesce(today.new_patients, 0)                   as new_patients_today,
  coalesce(rev_today.gross_revenue, 0)              as revenue_today,
  coalesce(rev_today.amount_collected, 0)           as collected_today,

  coalesce(m.visits_total, 0)                       as visits_30d,
  coalesce(m.new_patients, 0)                       as new_patients_30d,
  coalesce(rev_month.gross_revenue, 0)              as revenue_30d,
  coalesce(rev_month.outstanding, 0)                as outstanding_30d,

  coalesce(staff.active_staff, 0)                   as active_staff,
  coalesce(staff.inactive_staff, 0)                 as inactive_staff,
  coalesce(pt.total_patients, 0)                    as total_patients
from public.tenants t
left join lateral (
  select
    count(*)                                                          as visits_total,
    count(*) filter (where v.status = 'done')                          as visits_completed,
    count(*) filter (where v.status in ('queued', 'in_consultation'))   as visits_still_open,
    (select count(*) from public.patients p
      where p.tenant_id = t.id and (p.created_at)::date = current_date) as new_patients
  from public.visits v
  where v.tenant_id = t.id and v.visit_date = current_date
) today on true
left join lateral (
  select
    count(*) as visits_total,
    (select count(*) from public.patients p
      where p.tenant_id = t.id and p.created_at >= now() - interval '30 days') as new_patients
  from public.visits v
  where v.tenant_id = t.id and v.visit_date > current_date - 30
) m on true
left join lateral (
  select sum(i.grand_total) as gross_revenue, sum(i.amount_paid) as amount_collected
  from public.invoices i
  where i.tenant_id = t.id and i.status in ('issued', 'paid')
    and (i.issued_at)::date = current_date
) rev_today on true
left join lateral (
  select sum(i.grand_total) as gross_revenue,
         sum(i.grand_total - i.amount_paid) as outstanding
  from public.invoices i
  where i.tenant_id = t.id and i.status in ('issued', 'paid')
    and i.issued_at >= now() - interval '30 days'
) rev_month on true
left join lateral (
  select count(*) filter (where p.is_active)     as active_staff,
         count(*) filter (where not p.is_active) as inactive_staff
  from public.profiles p
  where p.tenant_id = t.id and p.role <> 'patient'
) staff on true
left join lateral (
  select count(*) as total_patients
  from public.patients p
  where p.tenant_id = t.id
) pt on true
where public.is_tenant_admin();

comment on view public.admin_dashboard_summary is
  'One row per tenant: today and trailing-30-day headline figures for the dashboard cards, so the top of the page is one query rather than four. Everything here is derivable from the other admin_ views. Admin only, security_invoker.';


-- ---------------------------------------------------------------------------
-- Privileges. A view has no RLS of its own; `security_invoker` plus the
-- `is_tenant_admin()` predicate in each body do the work, and `authenticated`
-- already holds SELECT on every base relation.
-- ---------------------------------------------------------------------------
revoke all on public.admin_patient_volume_daily  from anon, authenticated;
revoke all on public.admin_revenue_daily         from anon, authenticated;
revoke all on public.admin_occupancy_current     from anon, authenticated;
revoke all on public.admin_staff_activity_daily  from anon, authenticated;
revoke all on public.admin_dashboard_summary     from anon, authenticated;

grant select on public.admin_patient_volume_daily  to authenticated;
grant select on public.admin_revenue_daily         to authenticated;
grant select on public.admin_occupancy_current     to authenticated;
grant select on public.admin_staff_activity_daily  to authenticated;
grant select on public.admin_dashboard_summary     to authenticated;
