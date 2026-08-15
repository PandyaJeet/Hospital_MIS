-- ============================================================================
-- Migration:  ipd_beds_and_visits
-- Purpose:    The IPD surface — bed inventory, and the admit/discharge state on
--             `visits` that Phase 2 left an extension point for.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW `care_setting` COLUMN AND NOT A WIDER `visits.status` ENUM
-- ---------------------------------------------------------------------------
-- !! CONSCIOUS DEVIATION FROM A PHASE 2 NOTE — flagged, not silent. !!
--
-- 20260811060200's header and docs/contracts/opd-queue.md §9 both anticipated
-- that Phase 3 would extend the named `visits_status_valid` constraint to admit
-- 'admitted'/'discharged'. On building it, that shape does not hold up:
--
--   `visits.status` is one axis — where the patient is in the CONSULTATION
--   lifecycle (queued -> in_consultation -> done / cancelled). Admission is an
--   orthogonal axis. A patient can be admitted AND mid-consultation on a ward
--   round; a patient can be admitted and the encounter still open. Folding the
--   two axes into one enum forces impossible-to-name states ("in_consultation
--   AND admitted") to be represented as a single value, and every query that
--   currently asks "is this visit still open" would have to learn about IPD
--   states it does not care about.
--
-- So the extension is a new column, and `visits_status_valid` is left exactly as
-- Phase 2 wrote it. Nothing promised as additive was broken — the addition simply
-- landed as a column rather than as a wider constraint, and every existing Phase 2
-- policy, RPC, trigger and index on `status` is untouched. docs/contracts/
-- opd-queue.md is corrected to point here.
--
-- Consequence worth stating: a discharge does NOT write `visits.status`.
-- "Currently an inpatient" is `care_setting = 'ipd' and discharged_at is null`,
-- and the consultation lifecycle continues to be driven only by
-- set_visit_status(). Keeping discharge out of `status` is the whole point of
-- splitting the axes; having discharge quietly stamp 'done' would re-couple them.
--
-- ---------------------------------------------------------------------------
-- TIER 2 GATING — WHAT IS GATED, WHAT IS NOT, AND WHY
-- ---------------------------------------------------------------------------
-- Architecture.md §6 marks exactly one table in this phase as tier-restricted:
-- `beds — IPD bed tracking (Tier 2+)`. `vitals`, `tasks`, `lab_orders` and
-- `lab_results` are listed with no tier annotation, alongside `patients` and
-- `visits`.
--
-- That is the line drawn here, and it is a judgement call the prompt explicitly
-- asked to be made and documented:
--
--   GATED (Tier 2+):  creating/editing bed inventory, changing a bed's status,
--                     and admitting a patient to a bed.
--   NOT GATED:        vitals, tasks, medication administration, lab orders and
--                     results.
--
-- Reasoning for leaving nurse work ungated: a solo Tier 1 clinic that employs a
-- nurse who takes vitals at the OPD desk before the doctor sees the patient is
-- completely ordinary in India — that is triage, not inpatient care. Gating
-- vitals behind Tier 2 would break OPD triage for exactly the pilot-sized clinic
-- Phase 2 was built for, to enforce a boundary the product does not actually
-- want. The same holds for a task board ("call this patient back for a dressing
-- change") and for recording a lab result that came back from an outside
-- pathology lab. None of those require a ward.
--
-- What genuinely requires Tier 2 is the thing that presupposes a ward at all:
-- beds. So beds is where the gate goes.
--
-- TWO EXCEPTIONS TO THE GATE, both deliberate:
--   * SELECT on `beds` is tenant-scoped but NOT tier-gated. If a tenant were
--     downgraded from Tier 2 to Tier 1 while a patient was in a bed, a tier-gated
--     read would make that patient's bed vanish from every screen while they were
--     still lying in it. Hiding a read is not what the gate is for; the gate is on
--     the ability to run an inpatient service, which is the write path.
--   * discharge_patient() is NOT tier-gated (see 20260811070500). A downgrade must
--     never trap an admitted patient with no way to discharge them.
--
-- Enforcement is in RLS *and* in the RPC, per rules.md §4.3 — a UI check alone is
-- not access control, and an RPC check alone would leave a direct PostgREST insert
-- on `beds` ungated.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- beds
--
-- Created before the `visits.bed_id` foreign key below, because the two tables
-- reference each other. Both reference columns are nullable, so there is no
-- chicken-and-egg problem at write time: a bed is created unoccupied, and the
-- admit RPC sets both sides inside one transaction.
-- ---------------------------------------------------------------------------
create table if not exists public.beds (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants (id) on delete restrict,

  -- Free text rather than a `wards` table. A nursing-home-scale tenant has a
  -- handful of ward names that never change; a lookup table would add a join and
  -- an admin screen to maintain for no gain this phase. If ward-level attributes
  -- (per-day rate, gender restriction, nurse station) are ever needed, that is
  -- when a `wards` table earns its place.
  ward_name    text        not null,
  bed_number   text        not null,   -- text, not integer: '12A', 'ICU-3' are real

  status       text        not null default 'available',

  -- LIVE occupancy. Distinct in meaning from visits.bed_id — see the comment on
  -- that column. Never client-writable; maintained only by the admit/discharge
  -- RPCs.
  current_visit_id uuid    null,

  notes        text        null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint beds_status_valid check (
    status in ('available', 'occupied', 'cleaning', 'maintenance')
  ),
  constraint beds_ward_not_blank   check (length(trim(ward_name)) > 0),
  constraint beds_number_not_blank check (length(trim(bed_number)) > 0),

  -- The invariant that makes occupancy trustworthy, enforced structurally rather
  -- than by trusting the RPC: 'occupied' means exactly "someone is in it", and no
  -- other status may carry an occupant. Without this, a bed could read
  -- 'available' while still pointing at a visit and be double-booked.
  constraint beds_occupancy_consistent check (
    (status = 'occupied' and current_visit_id is not null)
    or (status <> 'occupied' and current_visit_id is null)
  ),

  constraint beds_visit_same_tenant
    foreign key (current_visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  constraint beds_id_tenant_unique unique (id, tenant_id),
  -- A ward cannot have two bed 4s.
  constraint beds_number_unique_per_ward unique (tenant_id, ward_name, bed_number)
);

comment on table public.beds is
  'IPD bed inventory. Tier 2+ per Architecture.md §6: all write paths are gated on tenant_has_tier(2) in RLS and in the RPCs. SELECT is deliberately NOT tier-gated so a tier downgrade cannot hide a bed a patient is still occupying. status and current_visit_id are not client-writable.';
comment on column public.beds.current_visit_id is
  'LIVE occupancy — who is in this bed right now. Cleared on discharge. Distinct from visits.bed_id, which records which bed an admission used and is retained after discharge. Both are written only by admit_patient_to_bed()/discharge_patient().';
comment on column public.beds.status is
  'available | occupied | cleaning | maintenance. Not client-writable; use set_bed_status(). occupied is implied by current_visit_id and enforced by beds_occupancy_consistent.';

-- The ward board: group by ward, ordered by bed, filtered by status.
create index if not exists beds_tenant_ward_idx   on public.beds (tenant_id, ward_name, bed_number);
create index if not exists beds_tenant_status_idx on public.beds (tenant_id, status);

-- One visit occupies at most one bed. Partial, because plenty of beds are empty
-- and NULLs are not distinct enough to constrain.
create unique index if not exists beds_one_bed_per_visit_idx
  on public.beds (current_visit_id)
  where current_visit_id is not null;

drop trigger if exists beds_touch_updated_at on public.beds;
create trigger beds_touch_updated_at
  before update on public.beds
  for each row
  execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- visits: the IPD extension
-- ---------------------------------------------------------------------------
alter table public.visits
  add column if not exists care_setting  text        not null default 'opd',
  add column if not exists admitted_at   timestamptz null,
  add column if not exists discharged_at timestamptz null,
  add column if not exists bed_id        uuid        null;

comment on column public.visits.care_setting is
  'opd | ipd. A separate axis from visits.status, which tracks the consultation lifecycle — see the migration header for why these are not one enum. Not client-writable; set by admit_patient_to_bed().';
comment on column public.visits.bed_id is
  'Which bed this admission used. RETAINED after discharge as part of the encounter record, unlike beds.current_visit_id which is cleared. Not client-writable.';
comment on column public.visits.discharged_at is
  'Discharge time. "Currently an inpatient" is care_setting = ''ipd'' and discharged_at is null. Deliberately does NOT drive visits.status.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'visits_care_setting_valid') then
    alter table public.visits
      add constraint visits_care_setting_valid check (care_setting in ('opd', 'ipd'));
  end if;

  -- An admission timestamp on an OPD visit is incoherent. Named separately from
  -- the status constraint so it can be reasoned about (and, if ever needed,
  -- changed) independently.
  if not exists (select 1 from pg_constraint where conname = 'visits_admission_requires_ipd') then
    alter table public.visits
      add constraint visits_admission_requires_ipd check (
        admitted_at is null or care_setting = 'ipd'
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'visits_discharge_after_admit') then
    alter table public.visits
      add constraint visits_discharge_after_admit check (
        discharged_at is null
        or (admitted_at is not null and discharged_at >= admitted_at)
      );
  end if;

  -- You cannot occupy a bed without being admitted. The converse is allowed:
  -- admitted with no bed yet is a real state (patient on a trolley in casualty
  -- waiting for a bed to be cleaned), and refusing it would push staff into
  -- assigning a bed they have not actually got.
  if not exists (select 1 from pg_constraint where conname = 'visits_bed_requires_admission') then
    alter table public.visits
      add constraint visits_bed_requires_admission check (
        bed_id is null or admitted_at is not null
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'visits_bed_same_tenant') then
    alter table public.visits
      add constraint visits_bed_same_tenant
        foreign key (bed_id, tenant_id)
        references public.beds (id, tenant_id)
        on delete restrict;
  end if;
end
$$;

-- The rounds list: current inpatients in this clinic. Partial index, because the
-- overwhelming majority of visits are OPD and will never be scanned by this query.
create index if not exists visits_tenant_inpatients_idx
  on public.visits (tenant_id, admitted_at desc)
  where care_setting = 'ipd' and discharged_at is null;

-- NOTE ON GRANTS: the Phase 2 grant on this table is
--   grant update (doctor_id, visit_type) on public.visits to authenticated;
-- and none of the four columns added above is added to it. care_setting,
-- admitted_at, discharged_at and bed_id are therefore unwritable from a client
-- session, which is what forces admission and discharge through the RPCs where
-- the tier gate and the bed-occupancy invariant live. A direct write gets 42501.


-- ---------------------------------------------------------------------------
-- RLS on beds
--
-- READ: any onboarded staff member, tenant-scoped, NOT tier-gated (see header).
-- Billing is included on purpose: a ward/bed label is operational, not clinical,
-- and an inpatient bill needs to say which bed. This is the same distinction that
-- keeps billing out of clinical_notes and vitals but inside the billing tables.
--
-- WRITE: admin only, AND Tier 2+. Building ward inventory is a clinic-
-- configuration act, not a nursing one.
--
-- NOT GRANTED: status and current_visit_id. Occupancy is an outcome of admitting
-- and discharging, never something typed in — a client that could write
-- current_visit_id could put two patients in one bed or free an occupied one.
-- ---------------------------------------------------------------------------
alter table public.beds enable row level security;

revoke all on public.beds from anon, authenticated;

grant select on public.beds to authenticated;
grant insert (tenant_id, ward_name, bed_number, notes) on public.beds to authenticated;
grant update (ward_name, bed_number, notes) on public.beds to authenticated;
grant delete on public.beds to authenticated;

create policy beds_select_staff
  on public.beds
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

create policy beds_insert_admin_tier2
  on public.beds
  for insert
  to authenticated
  with check (
    public.is_tenant_admin()
    and public.tenant_has_tier(2)
    and tenant_id = public.current_tenant_id()
  );

create policy beds_update_admin_tier2
  on public.beds
  for update
  to authenticated
  using (
    public.is_tenant_admin()
    and public.tenant_has_tier(2)
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.is_tenant_admin()
    and public.tenant_has_tier(2)
    and tenant_id = public.current_tenant_id()
  );

-- Deleting a bed a patient is lying in is not a decommissioning, it is a bug. The
-- FK from visits.bed_id (ON DELETE RESTRICT) would also stop it for any bed with
-- admission history; the status predicate makes the common case a clean policy
-- miss (0 rows) rather than a foreign-key error.
create policy beds_delete_admin_tier2_unoccupied
  on public.beds
  for delete
  to authenticated
  using (
    public.is_tenant_admin()
    and public.tenant_has_tier(2)
    and tenant_id = public.current_tenant_id()
    and status <> 'occupied'
  );
