-- ============================================================================
-- Migration:  bed_stays
-- Phase:      6 (IPD billing) — 2 of 6
--
-- ###########################################################################
-- #  THE MISSING TABLE. Without this, one of Phase 6's requirements is not    #
-- #  merely unimplemented, it is IMPOSSIBLE:                                  #
-- #                                                                          #
-- #    "Mid-stay ward transfers bill each night at the rate that actually     #
-- #     applied that night."                                                  #
-- #                                                                          #
-- #  `visits.bed_id` holds only the CURRENT bed. admit_patient_to_bed()'s      #
-- #  transfer branch overwrites it. So after a transfer the database has no    #
-- #  record that the earlier stint ever happened, let alone when it ended or   #
-- #  what that ward cost. The history needed to bill it correctly does not     #
-- #  exist yet.                                                               #
-- ###########################################################################
--
-- ---------------------------------------------------------------------------
-- WHAT A `bed_stay` IS
-- ---------------------------------------------------------------------------
-- One continuous occupancy of ONE bed by ONE visit. A straightforward admission is
-- a single stay. An admission with one ward transfer is two stays, back to back.
-- Discharge closes the open one.
--
-- This is the same modelling move Phase 2 made with `prescription_items`: the
-- billable detail lives on a child row, so a billing line can point at it. It is
-- what makes the existing idempotency index work unchanged — see 20260814090200.
--
-- ---------------------------------------------------------------------------
-- WHY THE RATE IS SNAPSHOTTED HERE AND NOT READ FROM `wards` AT INVOICE TIME
-- ---------------------------------------------------------------------------
-- Copied from the ward at the moment the stay STARTS, and never updated.
--
-- The rule is already established in this schema: `invoices.gstin_snapshot` exists
-- because an invoice is a historical record and a clinic correcting its GSTIN must
-- not retroactively rewrite documents already handed to patients. A room rate is
-- the same kind of fact. If a clinic raises the General Ward from ₹1,800 to ₹2,400
-- in October, a stay in September must still bill at ₹1,800 — and if the rate were
-- read live from `wards` at invoice time, it would not.
--
-- `is_critical_care` is snapshotted for the same reason and for a sharper one: it
-- decides GST exemption. Re-deriving it later means a ward re-designated as ICU
-- would retroactively make old taxable stays exempt, which is a tax
-- misstatement, not a rounding difference.
--
-- The ward NAME is snapshotted too, so a renamed ward (the FK cascades, see
-- 20260814090000) does not change what an old invoice line said.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TABLE IS NOT
-- ---------------------------------------------------------------------------
-- Not a replacement for `beds.current_visit_id` or `visits.bed_id`. Those remain
-- exactly as 20260811070400 defined them — live occupancy, and the encounter's
-- bed of record. This is the time series behind them, and it is append-then-close:
-- rows are opened and closed by the RPCs and never edited afterwards, which is why
-- there is no client write path at all.
-- ============================================================================

create table if not exists public.bed_stays (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants (id) on delete restrict,

  visit_id      uuid        not null,
  bed_id        uuid        not null,

  -- ---- snapshots taken at started_at, never updated (see header) ----
  ward_name         text           not null,
  daily_rate        numeric(12, 2) not null,
  is_critical_care  boolean        not null,

  started_at    timestamptz not null default now(),
  -- NULL means "still in this bed". That is what makes "where is this patient now"
  -- and "what has not been billed yet" both a query rather than a status column to
  -- keep in sync — the same reasoning as billing_line_items.invoice_id.
  ended_at      timestamptz null,

  -- Why the stay ended, for the ward record and so the billing line can say so.
  -- NULL while open; required once closed.
  end_reason    text        null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint bed_stays_end_after_start check (
    ended_at is null or ended_at >= started_at
  ),
  constraint bed_stays_daily_rate_non_negative check (daily_rate >= 0),
  constraint bed_stays_ward_not_blank check (length(trim(ward_name)) > 0),

  constraint bed_stays_end_reason_valid check (
    end_reason is null or end_reason in ('discharge', 'transfer')
  ),
  -- A closed stay must say why, and an open one must not pretend to. Paired the
  -- same way prescriptions_issued_has_timestamp pairs status with issued_at.
  constraint bed_stays_closed_has_reason check (
    (ended_at is null and end_reason is null)
    or (ended_at is not null and end_reason is not null)
  ),

  constraint bed_stays_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  constraint bed_stays_bed_same_tenant
    foreign key (bed_id, tenant_id)
    references public.beds (id, tenant_id)
    on delete restrict,

  constraint bed_stays_id_tenant_unique unique (id, tenant_id)
);

comment on table public.bed_stays is
  'One continuous occupancy of one bed by one visit. The transfer history visits.bed_id cannot hold, and the row a room_rent billing line points at. ward_name/daily_rate/is_critical_care are SNAPSHOTS taken at started_at so a later ward re-pricing or re-designation cannot rewrite what an earlier stay charged. No client write path: opened and closed only by admit_patient_to_bed()/discharge_patient().';
comment on column public.bed_stays.ended_at is
  'NULL while the patient is still in this bed. Closing a stay is the billable event for room rent (20260814090200), so this column is what fires the charge.';
comment on column public.bed_stays.daily_rate is
  'wards.daily_rate copied at started_at. Deliberately NOT re-read later — same rule as invoices.gstin_snapshot.';
comment on column public.bed_stays.is_critical_care is
  'wards.is_critical_care copied at started_at. Decides GST exemption, so re-deriving it later would retroactively restate tax on closed stays.';

-- One open stay per visit. A patient cannot be in two beds at once, and this is
-- the structural guarantee rather than a property of the RPC being careful —
-- exactly the shape beds_one_bed_per_visit_idx already uses for live occupancy.
create unique index if not exists bed_stays_one_open_per_visit_idx
  on public.bed_stays (visit_id)
  where ended_at is null;

-- ...and one open stay per BED, which is the same invariant from the other side.
create unique index if not exists bed_stays_one_open_per_bed_idx
  on public.bed_stays (bed_id)
  where ended_at is null;

-- The billing walk: every stay for a visit, oldest first.
create index if not exists bed_stays_visit_idx on public.bed_stays (visit_id, started_at);
-- "Who is in a bed right now, across the clinic" — the accrual view's driver.
create index if not exists bed_stays_tenant_open_idx on public.bed_stays (tenant_id, started_at)
  where ended_at is null;

drop trigger if exists bed_stays_touch_updated_at on public.bed_stays;
create trigger bed_stays_touch_updated_at
  before update on public.bed_stays
  for each row
  execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- RLS
--
-- READ: any onboarded staff member, tenant-scoped, NOT tier-gated — identical to
-- `beds`, and for the identical reason: a tier downgrade must not hide the stay of
-- a patient who is still in the ward. Billing is included because an inpatient
-- bill has to be explicable ("3 days, General Ward, ₹1,800/day").
--
-- WRITE: NOBODY. No INSERT, UPDATE or DELETE grant at all, for any role.
--
-- That is stronger than `beds` and it is deliberate. A bed stay is the billing
-- basis for room rent, so a client that could edit started_at/ended_at could
-- lengthen a stay and inflate a bill, or shorten one and suppress a charge. It is
-- also the audit trail of where a patient physically was. Both make it a
-- system-derived record, like `medication_administrations` and `lab_results`,
-- which are equally RPC-only on the way in.
--
-- The rows are written by admit_patient_to_bed() and discharge_patient(), which
-- are SECURITY DEFINER and already the only way to change occupancy at all.
-- ---------------------------------------------------------------------------
alter table public.bed_stays enable row level security;

revoke all on public.bed_stays from anon, authenticated;

grant select on public.bed_stays to authenticated;
-- No grant insert / update / delete. See above.

create policy bed_stays_select_staff
  on public.bed_stays
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );
