-- ============================================================================
-- Migration:  tier3_placeholders
--             insurance_claims / ot_schedule / blood_units
--
-- ###########################################################################
-- #  STRUCTURE ONLY. THESE ARE NOT WORKING MODULES.                          #
-- #                                                                          #
-- #  phases.md asks for "Schema/RLS for insurance_claims, placeholder schema  #
-- #  for ot_schedule, blood_bank (Tier 3, structure only)". That is what this #
-- #  is: tables, constraints, RLS and tier gating, so a Tier 3 tenant has     #
-- #  somewhere to put data and Prince has a shape to build a form against.    #
-- #                                                                          #
-- #  There is NO claims adjudication, NO theatre scheduling logic, NO         #
-- #  cross-match or compatibility checking, NO inventory workflow, and no RPC #
-- #  for any of them. Do not mistake the presence of a `status` column for a  #
-- #  state machine — nothing validates transitions on these three tables.     #
-- ###########################################################################
--
-- PRD §8 IS A HARD BOUNDARY ON insurance_claims:
--   "Insurance underwriting/claims adjudication (submission-format support only)"
-- So `status` here covers SUBMISSION only — draft / submitted / closed. There is
-- deliberately no `approved`, `rejected`, `appealed`, `settled` or `queried`. Those
-- states would imply this system tracks an adjudication outcome, which PRD §8 rules
-- out entirely rather than merely deferring. If a clinic needs to record what a payer
-- decided, that is a product conversation, not a missing enum value.
--
-- PRD §5.4 places all three at Tier 3: "+ OT scheduling, blood bank, radiology/PACS
-- integration, insurance/TPA claims, multi-department workflows".
--
-- ---------------------------------------------------------------------------
-- ⚠️ READ GATING: READS ARE **NOT** TIER-GATED. WRITES ARE. HERE IS WHY.
-- ---------------------------------------------------------------------------
-- The tempting argument for gating reads too: unlike `beds` — where Phase 3 kept
-- reads open so a downgrade could not hide a bed a patient was lying in — nothing
-- will ever be *in* an OT schedule or a blood bank for a tenant that never had Tier 3,
-- so there is no live state to conceal and gating reads costs nothing.
--
-- That reasoning holds for a tenant that never had the tier. It fails badly for a
-- tenant that HAD it and was downgraded, and that is the case worth designing for:
--
--   * `blood_units` is the strongest example. A unit reserved for a patient currently
--     in theatre must never become invisible because a billing flag changed. Hiding
--     which units exist, which are reserved and which have expired is a patient-safety
--     problem, not a paywall.
--   * `ot_schedule` holds scheduled operations — live clinical commitments with
--     times, a patient and a surgeon attached.
--   * `insurance_claims` is only money, but a submitted claim disappearing from view
--     loses a reimbursement the clinic is owed.
--
-- So: the same rule as `beds`. Tenant-scoped reads for staff, Tier 3 required to
-- create or modify anything. One rule across all three rather than three different
-- ones, because a reader should not have to remember which Tier 3 table behaves
-- which way. Documented in docs/contracts/tier3-placeholders.md.
--
-- NOTE ON THE TIER HELPER: this phase needs no new helper. Phase 3's
-- `tenant_has_tier(integer)` is already generic, so `tenant_has_tier(3)` works as-is
-- — the argument is the required minimum, not a hard-coded 2. Flagged in the report
-- because the prompt for this phase expected a new function.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. insurance_claims — enough to PRODUCE a submission, not to process one
-- ---------------------------------------------------------------------------
create table if not exists public.insurance_claims (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references public.tenants (id) on delete restrict,

  patient_id     uuid        not null,
  visit_id       uuid        not null,
  -- Nullable on purpose: a claim is often prepared before the final bill exists,
  -- particularly for a planned admission where pre-authorisation comes first.
  invoice_id     uuid        null,

  payer_type     text        not null,
  -- The specific scheme or TPA ("Star Health", "CGHS Delhi"). Free text because the
  -- list of Indian TPAs is long, changes, and varies by region — an enum would be
  -- wrong within a month.
  payer_name     text        not null,

  -- ⚠️ PII. A beneficiary/policy number identifies a person and is exactly the kind
  -- of value rules.md §1.3 covers. It is stored because a submission cannot be
  -- produced without it. It must never be logged, and it is excluded from the
  -- audit_log allow-list.
  policy_or_beneficiary_number text not null,

  claim_amount   numeric(12, 2) not null default 0,

  -- SUBMISSION states only. See the header — no adjudication vocabulary.
  status         text        not null default 'draft',
  submitted_at   timestamptz null,

  notes          text        null,
  created_by     uuid        null references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint insurance_claims_payer_type_valid check (
    payer_type in ('cghs', 'esic', 'private_tpa', 'government_scheme', 'other')
  ),
  constraint insurance_claims_status_valid check (status in ('draft', 'submitted', 'closed')),
  constraint insurance_claims_payer_name_not_blank check (length(trim(payer_name)) > 0),
  constraint insurance_claims_beneficiary_not_blank check (
    length(trim(policy_or_beneficiary_number)) > 0
  ),
  constraint insurance_claims_amount_non_negative check (claim_amount >= 0),
  -- A submitted claim must say when. Not both-or-neither: a draft carrying a stale
  -- timestamp is the incoherent case, and this states only that implication.
  constraint insurance_claims_submitted_has_timestamp check (
    status = 'draft' or submitted_at is not null
  ),

  constraint insurance_claims_patient_same_tenant
    foreign key (patient_id, tenant_id) references public.patients (id, tenant_id) on delete restrict,
  constraint insurance_claims_visit_same_tenant
    foreign key (visit_id, tenant_id) references public.visits (id, tenant_id) on delete restrict,
  constraint insurance_claims_invoice_same_tenant
    foreign key (invoice_id, tenant_id) references public.invoices (id, tenant_id) on delete restrict,

  constraint insurance_claims_id_tenant_unique unique (id, tenant_id)
);

comment on table public.insurance_claims is
  'TIER 3, STRUCTURE ONLY. Holds enough to produce a CGHS/ESIC/TPA submission (PRD §6.3). status covers SUBMISSION only — PRD §8 rules out adjudication entirely, so there is deliberately no approved/rejected/appealed state and no transition validation.';
comment on column public.insurance_claims.policy_or_beneficiary_number is
  'PII — identifies a person. Required to produce a submission. Never log this value; excluded from the audit_log allow-list.';
comment on column public.insurance_claims.status is
  'draft | submitted | closed. SUBMISSION states only. ''closed'' means the clinic has stopped working the claim, NOT that a payer decided anything.';

create index if not exists insurance_claims_tenant_status_idx  on public.insurance_claims (tenant_id, status, created_at desc);
create index if not exists insurance_claims_patient_idx        on public.insurance_claims (tenant_id, patient_id, created_at desc);
create index if not exists insurance_claims_visit_idx          on public.insurance_claims (visit_id);

drop trigger if exists insurance_claims_touch_updated_at on public.insurance_claims;
create trigger insurance_claims_touch_updated_at
  before update on public.insurance_claims
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 2. ot_schedule — a booking record, not a scheduler
--
-- Nothing here prevents double-booking a theatre or a surgeon. That would need
-- overlap constraints (a Postgres exclusion constraint on a tstzrange per room) and a
-- policy on what counts as a conflict — real scheduling logic, explicitly out of
-- scope. Noted in the contract as the first thing to build if this module is ever
-- prioritised.
-- ---------------------------------------------------------------------------
create table if not exists public.ot_schedule (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants (id) on delete restrict,

  patient_id      uuid        not null,
  visit_id        uuid        not null,
  -- Nullable: a slot is often booked before the operating surgeon is confirmed.
  surgeon_id      uuid        null,

  procedure_name  text        not null,
  ot_room         text        null,

  scheduled_start timestamptz not null,
  scheduled_end   timestamptz not null,

  status          text        not null default 'scheduled',
  notes           text        null,

  created_by      uuid        null references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint ot_schedule_status_valid check (
    status in ('scheduled', 'in_progress', 'completed', 'cancelled')
  ),
  constraint ot_schedule_procedure_not_blank check (length(trim(procedure_name)) > 0),
  -- The one thing genuinely worth enforcing structurally: a slot that ends before it
  -- starts is meaningless, and it is the error a date picker actually produces.
  constraint ot_schedule_ends_after_start check (scheduled_end > scheduled_start),

  constraint ot_schedule_patient_same_tenant
    foreign key (patient_id, tenant_id) references public.patients (id, tenant_id) on delete restrict,
  constraint ot_schedule_visit_same_tenant
    foreign key (visit_id, tenant_id) references public.visits (id, tenant_id) on delete restrict,
  constraint ot_schedule_surgeon_same_tenant
    foreign key (surgeon_id, tenant_id) references public.profiles (id, tenant_id) on delete restrict,

  constraint ot_schedule_id_tenant_unique unique (id, tenant_id)
);

comment on table public.ot_schedule is
  'TIER 3, STRUCTURE ONLY. A theatre booking record. Does NOT prevent double-booking a room or a surgeon — no overlap constraint, no scheduling logic, no transition validation. See docs/contracts/tier3-placeholders.md.';

create index if not exists ot_schedule_tenant_start_idx on public.ot_schedule (tenant_id, scheduled_start);
create index if not exists ot_schedule_surgeon_idx      on public.ot_schedule (tenant_id, surgeon_id, scheduled_start)
  where surgeon_id is not null;
create index if not exists ot_schedule_visit_idx        on public.ot_schedule (visit_id);

drop trigger if exists ot_schedule_touch_updated_at on public.ot_schedule;
create trigger ot_schedule_touch_updated_at
  before update on public.ot_schedule
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 3. blood_units — inventory with an issue link, and nothing more
--
-- ⚠️ NO COMPATIBILITY CHECKING. Nothing in this schema verifies that a unit's blood
-- group is compatible with the recipient, and nothing should read the presence of
-- `reserved_for_visit_id` as evidence that a cross-match was performed. Transfusion
-- safety is a clinical process with its own checks; a placeholder table must not
-- imply it has absorbed them. This is the single most important caveat on these three
-- tables and it is repeated in the contract.
--
-- One table rather than `blood_units` + `blood_unit_issues`: a unit is issued at most
-- once, so the issue is a property of the unit. The cost is that a
-- reserve → release → re-reserve cycle keeps no history, which is acceptable for
-- groundwork and is recorded as a limitation.
-- ---------------------------------------------------------------------------
create table if not exists public.blood_units (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references public.tenants (id) on delete restrict,

  -- Clinic-facing bag/segment number from the label.
  unit_code             text        not null,
  blood_group           text        not null,
  component_type        text        not null,

  status                text        not null default 'available',

  collected_at          timestamptz null,
  expires_at            timestamptz null,

  -- The link that makes this structurally useful rather than decorative.
  reserved_for_visit_id uuid        null,
  issued_to_visit_id    uuid        null,
  issued_at             timestamptz null,
  issued_by             uuid        null,

  notes                 text        null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint blood_units_group_valid check (
    blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')
  ),
  constraint blood_units_component_valid check (
    component_type in ('whole_blood', 'packed_red_cells', 'plasma', 'platelets', 'cryoprecipitate')
  ),
  constraint blood_units_status_valid check (
    status in ('available', 'reserved', 'issued', 'discarded', 'expired')
  ),
  constraint blood_units_code_not_blank check (length(trim(unit_code)) > 0),
  constraint blood_units_expiry_after_collection check (
    expires_at is null or collected_at is null or expires_at > collected_at
  ),
  -- Status and the link columns must agree, so "issued" always names a recipient.
  constraint blood_units_reserved_has_visit check (
    status <> 'reserved' or reserved_for_visit_id is not null
  ),
  constraint blood_units_issued_has_visit check (
    status <> 'issued' or (issued_to_visit_id is not null and issued_at is not null)
  ),
  constraint blood_units_issued_by_implies_issued_at check (
    issued_by is null or issued_at is not null
  ),
  -- A bag number is unique within a clinic.
  constraint blood_units_code_unique_per_tenant unique (tenant_id, unit_code),

  constraint blood_units_reserved_visit_same_tenant
    foreign key (reserved_for_visit_id, tenant_id) references public.visits (id, tenant_id) on delete restrict,
  constraint blood_units_issued_visit_same_tenant
    foreign key (issued_to_visit_id, tenant_id) references public.visits (id, tenant_id) on delete restrict,
  constraint blood_units_issued_by_same_tenant
    foreign key (issued_by, tenant_id) references public.profiles (id, tenant_id) on delete restrict,

  constraint blood_units_id_tenant_unique unique (id, tenant_id)
);

comment on table public.blood_units is
  'TIER 3, STRUCTURE ONLY. Blood inventory with a reserve/issue link. ⚠️ NO COMPATIBILITY OR CROSS-MATCH CHECKING — a reservation here is NOT evidence that transfusion safety checks were performed. No expiry automation either: `expired` is a status a human sets, nothing sweeps it.';
comment on column public.blood_units.status is
  'available | reserved | issued | discarded | expired. Nothing validates transitions and nothing automatically expires a unit on expires_at — a scheduled job would be required and none exists.';

create index if not exists blood_units_tenant_status_idx on public.blood_units (tenant_id, status, expires_at);
create index if not exists blood_units_tenant_group_idx  on public.blood_units (tenant_id, blood_group, component_type, status);
create index if not exists blood_units_reserved_idx       on public.blood_units (reserved_for_visit_id)
  where reserved_for_visit_id is not null;

drop trigger if exists blood_units_touch_updated_at on public.blood_units;
create trigger blood_units_touch_updated_at
  before update on public.blood_units
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- RLS — reads tenant-scoped and ungated, writes Tier 3 gated
--
-- Enabled in the same migration that creates the tables, no exceptions
-- (rules.md §4.1). See the header for why reads are not tier-gated.
--
-- Write roles, chosen per table rather than uniformly:
--   insurance_claims — billing + admin. PRD §6.3 puts claim-format support with
--                      Reception/Billing, and phases.md gives Prince an
--                      "Insurance/TPA claim form UI (data entry, not adjudication)".
--   ot_schedule      — doctor + admin. Booking a theatre is a clinical decision.
--   blood_units      — nurse + admin. Bank handling is ward/technician work, and
--                      there is no lab_tech role (see the report).
--
-- No DELETE anywhere: these are records of commitments and of physical stock. A
-- cancelled operation is `cancelled`, a discarded unit is `discarded`. Consistent
-- with `visits` and `tasks`.
-- ---------------------------------------------------------------------------
alter table public.insurance_claims enable row level security;
alter table public.ot_schedule      enable row level security;
alter table public.blood_units      enable row level security;

revoke all on public.insurance_claims from anon, authenticated;
revoke all on public.ot_schedule      from anon, authenticated;
revoke all on public.blood_units      from anon, authenticated;

-- ---- insurance_claims ----
grant select on public.insurance_claims to authenticated;
grant insert (tenant_id, patient_id, visit_id, invoice_id, payer_type, payer_name,
              policy_or_beneficiary_number, claim_amount, notes, created_by)
  on public.insurance_claims to authenticated;
grant update (invoice_id, payer_type, payer_name, policy_or_beneficiary_number,
              claim_amount, status, submitted_at, notes)
  on public.insurance_claims to authenticated;

create policy insurance_claims_select_staff
  on public.insurance_claims for select to authenticated
  using (public.is_tenant_staff() and tenant_id = public.current_tenant_id());

create policy insurance_claims_insert_billing_tier3
  on public.insurance_claims for insert to authenticated
  with check (
    public.has_tenant_role(array['admin', 'billing'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  );

create policy insurance_claims_update_billing_tier3
  on public.insurance_claims for update to authenticated
  using (
    public.has_tenant_role(array['admin', 'billing'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.has_tenant_role(array['admin', 'billing'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  );

-- ---- ot_schedule ----
grant select on public.ot_schedule to authenticated;
grant insert (tenant_id, patient_id, visit_id, surgeon_id, procedure_name, ot_room,
              scheduled_start, scheduled_end, notes, created_by)
  on public.ot_schedule to authenticated;
grant update (surgeon_id, procedure_name, ot_room, scheduled_start, scheduled_end,
              status, notes)
  on public.ot_schedule to authenticated;

create policy ot_schedule_select_staff
  on public.ot_schedule for select to authenticated
  using (public.is_tenant_staff() and tenant_id = public.current_tenant_id());

create policy ot_schedule_insert_doctor_tier3
  on public.ot_schedule for insert to authenticated
  with check (
    public.has_tenant_role(array['admin', 'doctor'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  );

create policy ot_schedule_update_doctor_tier3
  on public.ot_schedule for update to authenticated
  using (
    public.has_tenant_role(array['admin', 'doctor'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.has_tenant_role(array['admin', 'doctor'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  );

-- ---- blood_units ----
grant select on public.blood_units to authenticated;
grant insert (tenant_id, unit_code, blood_group, component_type, collected_at,
              expires_at, notes)
  on public.blood_units to authenticated;
grant update (status, collected_at, expires_at, reserved_for_visit_id,
              issued_to_visit_id, issued_at, issued_by, notes)
  on public.blood_units to authenticated;

create policy blood_units_select_staff
  on public.blood_units for select to authenticated
  using (public.is_tenant_staff() and tenant_id = public.current_tenant_id());

create policy blood_units_insert_nurse_tier3
  on public.blood_units for insert to authenticated
  with check (
    public.has_tenant_role(array['admin', 'nurse'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  );

create policy blood_units_update_nurse_tier3
  on public.blood_units for update to authenticated
  using (
    public.has_tenant_role(array['admin', 'nurse'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.has_tenant_role(array['admin', 'nurse'])
    and public.tenant_has_tier(3)
    and tenant_id = public.current_tenant_id()
  );
