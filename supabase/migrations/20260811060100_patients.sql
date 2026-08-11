-- ============================================================================
-- Migration:  patients
-- Purpose:    Patient master data, the first table in this system to hold real
--             PII/PHI. rules.md §1.3 stops being hypothetical here.
--
-- DUPLICATE HANDLING — the design decision this table turns on
-- Workflow.md's own worked example specifies "duplicate phone number within
-- tenant → DUPLICATE_PATIENT". The obvious implementation is a unique index on
-- (tenant_id, phone). That is wrong here, in two distinct ways:
--
--   1. NULL phone. A walk-in with no number is normal. Postgres treats NULLs as
--      distinct so a plain unique index tolerates many NULLs, but any "phone is
--      required to dedupe" logic built on top of it would misbehave.
--   2. Shared phone. A child registered on a parent's number, a spouse, an
--      elderly patient using a son's mobile — these are DIFFERENT PEOPLE who
--      legitimately share one number. A hard unique constraint makes registering
--      them impossible, and the receptionist's only escape is to invent a fake
--      phone number, which corrupts the data far worse than a duplicate would.
--
-- So there is deliberately NO unique constraint on phone. Instead:
--   * `phone_normalized` (generated) makes matching reliable regardless of how
--     the number was typed.
--   * register_patient() SOFT-detects a same-number match, returns
--     DUPLICATE_PATIENT along with the matching records, and the UI asks "is it
--     one of these?".
--   * The caller can then re-submit with p_allow_duplicate_phone => true to
--     deliberately register the second person on that number.
--
-- That keeps the DUPLICATE_PATIENT contract Workflow.md asked for while leaving
-- the legitimate case reachable. Because the check lives in the RPC rather than
-- in an index, INSERT is withheld from clients entirely (see privileges below)
-- so the check cannot be bypassed by writing to the table directly.
--
-- NOT NULL on full_name: this is an identity column, not doctor-facing clinical
-- free-text. rules.md §1.7 forbids mandatory fields that block saving a
-- CLINICAL NOTE; a patient record with no name is unusable at the front desk and
-- cannot be found again. `allergies`, the one clinical field here, is nullable.
-- ============================================================================

create table if not exists public.patients (
  id             uuid           primary key default gen_random_uuid(),
  tenant_id      uuid           not null references public.tenants (id) on delete restrict,

  -- Human-facing per-tenant serial (the OPD/UHID number on the slip). Staff
  -- search by this constantly; a uuid is unusable for that. Assigned under lock
  -- by register_patient().
  patient_number bigint         not null,

  full_name      text           not null,
  phone          text           null,

  -- Last 10 digits of whatever was typed. Collapses +91XXXXXXXXXX,
  -- 0XXXXXXXXXX, 0091-XXXXX-XXXXX and XXXXXXXXXX to one comparable value, so
  -- duplicate detection does not depend on data-entry style. India-centric by
  -- design; revisit if the product ever serves non-10-digit numbering.
  phone_normalized text generated always as (
    nullif(right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10), '')
  ) stored,

  -- dob OR age_years. Many Indian patients state an age, not a date of birth,
  -- and back-computing a fake DOB from an age silently invents precision that
  -- was never given. Both nullable; whichever was captured is the truthful one.
  dob            date           null,
  age_years      smallint       null,

  gender         text           null,
  address        text           null,

  -- Clinical free-text -> nullable (rules.md §1.7). Free text is adequate for
  -- this phase; the allergy check in check_prescription_safety() matches against
  -- it textually and reports when it could not be certain.
  allergies      text           null,

  registered_by  uuid           null references public.profiles (id) on delete set null,
  created_at     timestamptz    not null default now(),
  updated_at     timestamptz    not null default now(),

  constraint patients_full_name_not_blank check (length(trim(full_name)) > 0),
  constraint patients_gender_valid check (
    gender is null or gender in ('male', 'female', 'other', 'unknown')
  ),
  constraint patients_age_sane check (
    age_years is null or (age_years >= 0 and age_years <= 130)
  ),
  constraint patients_dob_not_future check (dob is null or dob <= current_date),
  constraint patients_patient_number_positive check (patient_number > 0),

  -- Lets child tables (visits) carry a composite FK, which makes it
  -- structurally impossible to attach a visit to a patient in another tenant —
  -- a guarantee independent of RLS being correct.
  constraint patients_id_tenant_unique unique (id, tenant_id),
  constraint patients_number_unique_per_tenant unique (tenant_id, patient_number)
);

comment on table public.patients is
  'Patient master, scoped by tenant_id. Holds PII/PHI: never log any column of this table (rules.md §1.3). No client INSERT — registration goes through register_patient() so duplicate detection cannot be bypassed.';
comment on column public.patients.phone_normalized is
  'Generated: last 10 digits of `phone`. Used for duplicate detection and lookup so matching is independent of formatting.';
comment on column public.patients.allergies is
  'Clinical free-text, deliberately nullable. Consumed textually by check_prescription_safety(), which reports partial results rather than implying a clean check.';

create index if not exists patients_tenant_phone_idx    on public.patients (tenant_id, phone_normalized);
create index if not exists patients_tenant_name_idx     on public.patients (tenant_id, lower(full_name));
create index if not exists patients_tenant_created_idx  on public.patients (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance. Done in a trigger rather than trusted from the client
-- so it cannot be back-dated, and so it is correct no matter which path wrote.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.touch_updated_at() is
  'Generic BEFORE UPDATE trigger setting updated_at = now(). Shared by Phase 2 tables that track modification time.';

drop trigger if exists patients_touch_updated_at on public.patients;
create trigger patients_touch_updated_at
  before update on public.patients
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.patients enable row level security;

revoke all on public.patients from anon, authenticated;

-- SELECT and UPDATE only. Note what is absent:
--   * No INSERT — register_patient() is the only way in (see header).
--   * No DELETE — medical records are not deleted from the app. Correcting a
--     mistaken registration is an admin/database action, deliberately not a
--     one-click operation for front-desk staff (rules.md §1.6's spirit).
--   * No UPDATE on tenant_id or patient_number — a patient cannot be moved
--     between clinics or renumbered from a client session.
grant select on public.patients to authenticated;
grant update (full_name, phone, dob, age_years, gender, address, allergies)
  on public.patients to authenticated;

-- All clinic staff can see all patients in their own tenant. A shared patient
-- master is the point: reception registers, the doctor consults, billing
-- invoices — all against one record.
--
-- is_tenant_staff() excludes the 'patient' role, so a patient-portal login
-- matches no row here at all. A patient-facing "my own record" view is out of
-- scope for this phase; when it arrives it needs its own narrowly-scoped policy
-- (matching on a verified link between auth.uid() and a patient row), not a
-- widening of this one.
create policy patients_select_staff
  on public.patients
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

create policy patients_update_staff
  on public.patients
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
