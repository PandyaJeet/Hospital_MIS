-- ============================================================================
-- Migration:  vitals
-- Purpose:    Nurse-logged observations, time-series per encounter. Feeds the
--             nurse's own record-keeping and the doctor's rounds/trend view.
--
-- ############################################################################
-- #  EVERY MEASUREMENT COLUMN IS NULLABLE. THIS IS A PRODUCT REQUIREMENT.     #
-- #                                                                           #
-- #  rules.md §1.7 is written about doctor-facing clinical notes, so the       #
-- #  letter of the rule does not name this table. The requirement underneath   #
-- #  it — never block a save over an incomplete field — applies here just as   #
-- #  hard, and arguably harder.                                               #
-- #                                                                           #
-- #  A nurse mid-round routinely has some observations and not others: pulse   #
-- #  and temperature taken, BP still pending because the only cuff is in use   #
-- #  two beds down, or SpO2 missing because the patient will not keep the      #
-- #  probe on. If any measurement column were NOT NULL, that nurse could not   #
-- #  save what they DO have. The realistic outcomes are both bad: the reading  #
-- #  is written on paper and never entered, or a placeholder number is typed   #
-- #  to satisfy the form — and an invented vital is worse than a missing one,  #
-- #  because a doctor reads it as fact off a trend graph.                      #
-- #                                                                           #
-- #  So a row with nothing but a temperature is valid and expected. Prince     #
-- #  must not add client-side required-field validation that the schema        #
-- #  deliberately refuses to impose.                                          #
-- ############################################################################
--
-- WHY THE ROW IS SCOPED TO A VISIT AND NOT ALSO TO A PATIENT
-- The prompt's suggested shape is visit-scoped and that is what ships. A
-- denormalised patient_id would be a second source of truth for a fact
-- visits.patient_id already holds, and the two can drift. A cross-admission
-- trend ("this patient's BP over three years") joins through visits, which is
-- one indexed hop; a within-admission trend — which is what a rounds view
-- actually shows — is a single-visit query and needs no join at all.
--
-- SANITY BOUNDS, AND WHERE THE LINE IS
-- The columns carry wide CHECK bounds (see below). That is not in tension with
-- the nullability rule: nullability is about INCOMPLETE data, which must always
-- save, while the bounds are about IMPOSSIBLE data, which is a typo. The ranges
-- are deliberately generous enough that no real measurement can be rejected —
-- they exist to catch a slipped decimal point (temperature 385 instead of 38.5)
-- before it lands on a trend graph a doctor will read at a glance.
--
-- Deliberately NOT constrained: diastolic <= systolic. It is physiologically
-- impossible to invert, but one-sided BP entry is legitimate (a palpated
-- systolic with no diastolic), and a cross-field check interacts confusingly
-- with that. The UI should warn on an inverted pair; the database will not
-- refuse the save.
--
-- UNITS ARE FIXED, NOT STORED
-- Celsius, bpm, mmHg, breaths/min, %, and mg/dL for glucose (the Indian
-- convention; mmol/L is not used here). A per-row unit column would let two
-- nurses record the same measurement in different units and make a trend graph
-- silently wrong, so the unit is part of the column contract instead. Documented
-- in docs/contracts/vitals-and-rounds.md for Prince's input labels.
-- ============================================================================

create table if not exists public.vitals (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants (id) on delete restrict,
  visit_id        uuid        not null,

  -- Structural, not typed into a form: which encounter, whose clinic, who
  -- observed it, when. None of these can block a save.
  recorded_by     uuid        not null,
  recorded_at     timestamptz not null default now(),

  -- ---- measurements: ALL NULLABLE, see the banner above ----
  temperature_c     numeric(4, 1) null,   -- degrees Celsius
  pulse_bpm         smallint      null,   -- beats per minute
  bp_systolic       smallint      null,   -- mmHg
  bp_diastolic      smallint      null,   -- mmHg
  respiratory_rate  smallint      null,   -- breaths per minute
  spo2_percent      smallint      null,   -- % oxygen saturation
  blood_glucose     numeric(6, 1) null,   -- mg/dL

  -- Free-text observation ("patient uncooperative, BP deferred"). Clinical, so
  -- nullable for the same reason as everything above.
  notes           text        null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- ---- impossible-value bounds (see header) ----
  -- 20-45 C spans profound hypothermia to fatal hyperthermia.
  constraint vitals_temperature_sane    check (temperature_c    is null or (temperature_c    between 20  and 45)),
  -- 0 is meaningful: asystole recorded during a resuscitation.
  constraint vitals_pulse_sane          check (pulse_bpm        is null or (pulse_bpm        between 0   and 400)),
  constraint vitals_systolic_sane       check (bp_systolic      is null or (bp_systolic      between 20  and 400)),
  constraint vitals_diastolic_sane      check (bp_diastolic     is null or (bp_diastolic     between 10  and 300)),
  constraint vitals_resp_rate_sane      check (respiratory_rate is null or (respiratory_rate between 0   and 120)),
  -- Definitional, not a judgement call.
  constraint vitals_spo2_sane           check (spo2_percent     is null or (spo2_percent     between 0   and 100)),
  constraint vitals_glucose_sane        check (blood_glucose    is null or (blood_glucose    between 0   and 2000)),

  -- Cross-tenant parenting is impossible by construction, not just by policy —
  -- the same structural guarantee every Phase 2 child table carries.
  constraint vitals_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  -- RESTRICT rather than SET NULL, for both reasons Phase 2 documented on
  -- visits.doctor_id: mechanically, SET NULL on a composite FK would try to null
  -- the NOT NULL tenant_id and fail at delete time; substantively, deleting a
  -- staff account must not silently detach them from observations they recorded.
  constraint vitals_recorded_by_same_tenant
    foreign key (recorded_by, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict
);

comment on table public.vitals is
  'Nurse-logged observations per encounter. EVERY measurement column is nullable on purpose — a partial set of vitals must always save (rules.md §1.7 principle, see migration header). Units are fixed: C, bpm, mmHg, breaths/min, %, mg/dL.';
comment on column public.vitals.blood_glucose is
  'mg/dL, the Indian convention. The unit is part of the column contract rather than a stored per-row value, so a trend graph cannot silently mix units.';
comment on column public.vitals.recorded_at is
  'When the observation was taken. Defaults to now() but is client-writable, because a nurse catching up on paper notes must be able to record the real observation time rather than the data-entry time.';

-- Design.md §8 wants a TREND GRAPH, not a table, which makes the query pattern
-- the thing that matters here: "give me this encounter's series, newest first,
-- cheaply pageable". This index serves that directly and also backs the
-- latest-row lookup the rounds view does per patient.
create index if not exists vitals_visit_recorded_idx on public.vitals (visit_id, recorded_at desc);
-- Tenant-wide recency, for "everything recorded on this ward today".
create index if not exists vitals_tenant_recorded_idx on public.vitals (tenant_id, recorded_at desc);

drop trigger if exists vitals_touch_updated_at on public.vitals;
create trigger vitals_touch_updated_at
  before update on public.vitals
  for each row
  execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- RLS
--
-- READ: admin, doctor, nurse. NOT billing — the same data-minimisation line
-- Phase 2 drew on clinical_notes. An invoice never needs a blood pressure, and a
-- default front-desk grant on clinical measurements is precisely the kind of
-- over-broad access DPDP alignment (PRD §7) is judged on. Note this decision is
-- what forces the rounds view's shape in 20260811070300 — vitals VALUES cannot
-- be cached onto `visits`, because billing can read `visits` and Postgres has no
-- column-level RLS.
--
-- WRITE: nurse, doctor, admin, and recorded_by must be the caller — an
-- observation cannot be attributed to a colleague. Same rule as
-- clinical_notes.author_id.
--
-- CORRECTIONS: the recorder may edit their own row's measurements. Not visit_id
-- and not recorded_by, which are not in the grant, so a row entered against the
-- wrong encounter cannot be moved — see the gap noted in the contract.
--
-- NO DELETE for anyone. A clinical observation is part of the record; the Phase 4
-- audit log is where amendment history belongs.
-- ---------------------------------------------------------------------------
alter table public.vitals enable row level security;

revoke all on public.vitals from anon, authenticated;

grant select on public.vitals to authenticated;
grant insert (tenant_id, visit_id, recorded_by, recorded_at,
              temperature_c, pulse_bpm, bp_systolic, bp_diastolic,
              respiratory_rate, spo2_percent, blood_glucose, notes)
  on public.vitals to authenticated;
grant update (recorded_at, temperature_c, pulse_bpm, bp_systolic, bp_diastolic,
              respiratory_rate, spo2_percent, blood_glucose, notes)
  on public.vitals to authenticated;

create policy vitals_select_clinical
  on public.vitals
  for select
  to authenticated
  using (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
  );

create policy vitals_insert_clinical
  on public.vitals
  for insert
  to authenticated
  with check (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
    and recorded_by = (select auth.uid())
  );

create policy vitals_update_own
  on public.vitals
  for update
  to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and recorded_by = (select auth.uid())
  )
  with check (
    tenant_id = public.current_tenant_id()
    and recorded_by = (select auth.uid())
  );
