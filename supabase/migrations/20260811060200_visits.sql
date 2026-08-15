-- ============================================================================
-- Migration:  visits
-- Purpose:    One OPD encounter. The spine of the phase: the queue view, the
--             clinical note, the prescription and the invoice all hang off a
--             visit row.
--
-- WAIT-TIME (PRD §6.1 wants a wait-time indicator on the doctor's queue)
-- Three timestamps rather than one, because "how long has this patient been
-- waiting" and "how long did the consultation take" are different questions and
-- both matter:
--   checked_in_at            — set at registration/check-in
--   consultation_started_at  — set when the doctor opens the encounter
--   consultation_ended_at    — set when it is marked done
-- Waiting time is therefore `coalesce(consultation_started_at, now()) -
-- checked_in_at`, computable without storing a denormalised counter that would
-- go stale.
--
-- QUEUE NUMBER
-- Per tenant per DAY, not globally — clinics call "token 7", and that resets each
-- morning. Assigned under lock by check_in_patient(); see 20260811060800.
--
-- IPD EXTENSION POINT — Phase 3
-- phases.md Phase 3 extends this table with admit/discharge state. Nothing IPD
-- is built here, but the shape is chosen so Phase 3 is purely additive:
--   * `status` is a text column with a NAMED check constraint
--     (visits_status_valid). Phase 3 drops and recreates that one constraint to
--     admit 'admitted'/'discharged' and adds its own nullable columns. No
--     rename, no data migration, no change to any Phase 2 policy.
--   * The status vocabulary is about encounter LIFECYCLE, not about OPD
--     specifically, so IPD states extend the same axis rather than needing a
--     parallel column.
-- Deliberately NOT designing IPD's columns now.
-- ============================================================================

-- Enables the composite foreign keys below. `id` is already the primary key, so
-- this adds a redundant index — a cheap price for making "assign a doctor who
-- belongs to a different clinic" structurally impossible rather than merely
-- policy-blocked. Note a 'pending' profile has tenant_id NULL and so can never
-- satisfy the FK against a NOT NULL visits.tenant_id, which is the correct
-- outcome: an un-onboarded user cannot be assigned as the treating doctor.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_id_tenant_unique') then
    alter table public.profiles add constraint profiles_id_tenant_unique unique (id, tenant_id);
  end if;
end
$$;


create table if not exists public.visits (
  id                      uuid        primary key default gen_random_uuid(),
  tenant_id               uuid        not null references public.tenants (id) on delete restrict,
  patient_id              uuid        not null,
  doctor_id               uuid        null,

  visit_type              text        not null default 'new',
  status                  text        not null default 'queued',

  -- Queue/token identity. visit_date is stored rather than derived from
  -- checked_in_at so an overnight clinic can keep one logical "session" and so
  -- the uniqueness constraint below is index-friendly.
  visit_date              date        not null default current_date,
  queue_number            integer     not null,

  checked_in_at           timestamptz not null default now(),
  consultation_started_at timestamptz null,
  consultation_ended_at   timestamptz null,

  -- Why a visit was cancelled. Operational free-text, nullable.
  cancellation_reason     text        null,

  created_by              uuid        null references public.profiles (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint visits_visit_type_valid check (visit_type in ('new', 'follow_up')),

  -- NAMED so Phase 3 can extend it additively — see IPD note in the header.
  constraint visits_status_valid check (
    status in ('queued', 'in_consultation', 'done', 'cancelled')
  ),

  constraint visits_queue_number_positive check (queue_number > 0),

  -- Timestamp ordering sanity. Kept loose on purpose: a consultation may be
  -- started without being ended (in progress), and a visit may be cancelled from
  -- any state, so only genuine impossibilities are rejected.
  constraint visits_consultation_after_checkin check (
    consultation_started_at is null or consultation_started_at >= checked_in_at
  ),
  constraint visits_end_after_start check (
    consultation_ended_at is null
    or (consultation_started_at is not null and consultation_ended_at >= consultation_started_at)
  ),

  -- Cross-tenant parenting is impossible by construction, not just by policy.
  constraint visits_patient_same_tenant
    foreign key (patient_id, tenant_id)
    references public.patients (id, tenant_id)
    on delete restrict,

  -- RESTRICT, not SET NULL, for two reasons. Mechanically, SET NULL on a
  -- composite FK would try to null `tenant_id` too, which is NOT NULL — that
  -- fails at delete time, not at DDL time, so it would have been a latent bug.
  -- Substantively, RESTRICT is the behaviour a medical record wants: deleting a
  -- clinician's account must not be able to quietly detach them from the
  -- encounters they treated. Staff are deactivated, not deleted (rules.md §1.6).
  constraint visits_doctor_same_tenant
    foreign key (doctor_id, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict,

  constraint visits_id_tenant_unique unique (id, tenant_id),
  constraint visits_queue_unique_per_day unique (tenant_id, visit_date, queue_number)
);

comment on table public.visits is
  'One OPD encounter. Extension point for Phase 3 IPD admit/discharge via the named visits_status_valid constraint. No client INSERT or status write — see check_in_patient() and set_visit_status().';
comment on column public.visits.queue_number is
  'Per-tenant, per-day token number. Resets daily; assigned under lock by check_in_patient().';
comment on column public.visits.doctor_id is
  'Treating doctor, NULL until assigned. Composite FK guarantees they belong to the same tenant.';

create index if not exists visits_tenant_queue_idx   on public.visits (tenant_id, visit_date, status);
create index if not exists visits_tenant_patient_idx on public.visits (tenant_id, patient_id, created_at desc);
create index if not exists visits_tenant_doctor_idx  on public.visits (tenant_id, doctor_id, visit_date);

drop trigger if exists visits_touch_updated_at on public.visits;
create trigger visits_touch_updated_at
  before update on public.visits
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.visits enable row level security;

revoke all on public.visits from anon, authenticated;

-- `status` and the consultation timestamps are deliberately NOT granted.
-- Advancing a visit has side effects — it stamps timestamps and fires the
-- billing auto-insert trigger — so it goes through set_visit_status(), which
-- validates the transition. Letting a client write `status` directly would allow
-- illegal jumps (done -> queued) and double-billing.
grant select on public.visits to authenticated;
grant update (doctor_id, visit_type) on public.visits to authenticated;

create policy visits_select_staff
  on public.visits
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

create policy visits_update_staff
  on public.visits
  for update
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );
