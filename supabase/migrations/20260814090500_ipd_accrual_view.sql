-- ============================================================================
-- Migration:  ipd_accrual_view
-- Phase:      6 (IPD billing) — 6 of 6
--
-- `ipd_accrual_current` — what an ongoing admission has run up so far.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS: IT IS THE HALF OF THE TRADE-OFF THAT WOULD OTHERWISE BE LOST
-- ---------------------------------------------------------------------------
-- Room rent bills when a bed stay CLOSES (20260814090200). That choice needs no
-- scheduler, which is why it was taken — nothing in this stack runs on a schedule
-- and pg_cron is not installed on this project (see the Phase 6 report). But it has
-- one real cost: while a patient is still in the ward, `billing_line_items` holds
-- no room-rent line for them, so "what does this admission owe so far" is not
-- answerable from the billing tables.
--
-- For a three-day stay that is fine. For a two-week ICU admission, billing staff
-- being unable to see the accruing total until discharge is not fine — families ask,
-- and interim deposits get collected against it.
--
-- This view answers it WITHOUT charging anything. It is a projection, not a ledger:
-- reading it creates no rows, moves no money and has no side effect. The charge
-- still lands exactly once, at close.
--
-- ---------------------------------------------------------------------------
-- WHY A VIEW AND NOT A NIGHTLY JOB WRITING PARTIAL LINES
-- ---------------------------------------------------------------------------
-- A nightly job posting one line per night would make the accrual visible in
-- `billing_line_items` directly. It would also need a scheduler this project cannot
-- currently verify, and it would multiply an N-day stay into N rows that all have to
-- be kept consistent with a mid-stay transfer or a corrected admission time. The
-- view computes the same number from the stay rows on demand, and cannot drift from
-- them because it has no state of its own.
--
-- ---------------------------------------------------------------------------
-- SECURITY: security_invoker, like every other view in this schema
-- ---------------------------------------------------------------------------
-- Without it the view would execute as its owner (postgres, exempt from RLS) and
-- report every clinic's inpatients to whoever asked. With it, the underlying
-- `bed_stays` / `visits` / `patients` policies apply to the caller, so this is
-- tenant-scoped for free and a non-staff session sees nothing.
--
-- Deliberately NOT tier-gated, matching `beds` and `bed_stays`: a tier downgrade
-- must not hide what a patient still in the ward has run up.
--
-- Note who can read it: `patients` is staff-readable and `bed_stays` is
-- staff-readable, so billing can see this — which is the point. It carries the
-- patient's NAME, because a billing counter discussing a running total needs to know
-- whose it is; that is the same disclosure `patients` already permits and no more.
-- No diagnosis, no reason for admission, no clinical content.
-- ============================================================================

create or replace view public.ipd_accrual_current
with (security_invoker = true)
as
select
  bs.tenant_id,
  bs.id                      as bed_stay_id,
  bs.visit_id,
  v.patient_id,
  p.patient_number,
  p.full_name                as patient_name,
  bs.bed_id,
  b.bed_number,
  bs.ward_name,
  bs.is_critical_care,
  bs.daily_rate,
  bs.started_at,
  v.admitted_at,

  -- Days accrued if the stay were closed right now. Same function the charge uses,
  -- so the projection and the eventual line cannot disagree about how a day is
  -- counted.
  public.bed_stay_days(bs.started_at, now(), t.billing_timezone) as days_so_far,

  round(bs.daily_rate
        * public.bed_stay_days(bs.started_at, now(), t.billing_timezone), 2)
                             as accrued_amount,

  -- The tax that WOULD apply, resolved through the same single source of truth, so
  -- an ICU stay shows exempt here exactly as it will on the invoice.
  tx.tax_category,
  tx.tax_rate,
  round(round(bs.daily_rate
        * public.bed_stay_days(bs.started_at, now(), t.billing_timezone), 2)
        * tx.tax_rate / 100, 2) as accrued_tax,

  -- An explicit flag rather than making every caller know the rule. A ward nobody
  -- priced accrues nothing, and that is worth surfacing in the UI as a warning
  -- instead of a silently plausible ₹0.
  (bs.daily_rate = 0)       as ward_unpriced

from public.bed_stays bs
join public.visits   v on v.id = bs.visit_id  and v.tenant_id = bs.tenant_id
join public.patients p on p.id = v.patient_id and p.tenant_id = bs.tenant_id
join public.beds     b on b.id = bs.bed_id    and b.tenant_id = bs.tenant_id
join public.tenants  t on t.id = bs.tenant_id
cross join lateral public.resolve_tax_treatment(
  p_tenant_id       => bs.tenant_id,
  p_supply_kind     => 'room_rent',
  p_drug_gst_rate   => null,
  p_room_daily_rate => bs.daily_rate,
  p_room_critical   => bs.is_critical_care
) tx
-- Open stays only. A closed stay has a real billing line; showing it here as well
-- would invite double-counting.
where bs.ended_at is null;

comment on view public.ipd_accrual_current is
  'Room rent an ongoing admission has run up so far, computed on demand from open bed_stays. A PROJECTION, not a ledger — reading it charges nothing; the actual line is written once when the stay closes. Exists because room rent bills at stay-close (no scheduler in this stack), which would otherwise leave a long admission with no visible running total. security_invoker, so tenant-scoped by the underlying policies; not tier-gated, so a downgrade cannot hide a patient still in the ward.';

-- Explicit revoke first, matching every other view in this schema. Not decoration:
-- Supabase's default privileges on `public` can be permissive, so a freshly created
-- view is not reliably private to `authenticated` by omission. verify:catalog group
-- 17 asserts no anon SELECT on any relation, and this is what keeps that true.
revoke all on public.ipd_accrual_current from anon, authenticated;
grant select on public.ipd_accrual_current to authenticated;
