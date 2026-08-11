-- ============================================================================
-- Migration:  lab_orders + lab_results
--
-- Architecture.md §3's worked example IS a lab order, so most of this design was
-- already decided there and this migration implements it rather than reinventing
-- it:
--
--   Doctor orders a lab test
--     -> INSERT into lab_orders (tenant_id, patient_id, ordered_by, status='pending')
--        |-- Realtime on lab_orders  -> lab tech's queue updates
--        |-- Realtime on lab_orders  -> nurse's task board shows "sample collection due"
--        |-- DB trigger              -> billing_line_items (source_type='lab')
--        `-- Edge Function           -> notify patient
--
-- Which is why the INSERT here is PLAIN CRUD and not an RPC. Architecture.md
-- describes an insert, and there is nothing to decide at insert time: no numbering
-- to allocate, no duplicate to detect, no transition to validate. The three
-- downstream effects are triggers (20260811070900), which fire whichever way the
-- row arrives. This follows Phase 2's stated dividing line — RPC for branching or
-- a side effect the caller must be told about, plain CRUD otherwise — and it keeps
-- ordering a test as frictionless as writing a note.
--
-- The patient-notification Edge Function is NOT built: WhatsApp/SMS integration
-- does not exist yet (phases.md puts it with the third-party work). Nothing here
-- blocks it — a row insert with a patient_id and a tenant_id is exactly what a
-- future database webhook would need.
--
-- WHO CAN READ WHAT — the order and the result are split on purpose
--   lab_orders   -> ALL staff, including billing.
--   lab_results  -> admin, doctor, nurse. NOT billing.
--
-- This is the same line Phase 2 drew between `prescriptions` (billing can read it,
-- because the pharmacy and billing counter are one desk and dispensing needs the
-- drug list) and `clinical_notes` (billing cannot). A lab ORDER is a chargeable
-- service, and in an Indian clinic payment is very often collected before the
-- sample is drawn — so the billing counter genuinely needs to see that a test was
-- ordered. A lab RESULT is a clinical finding. "Sodium 118" or a reactive serology
-- report is not something the front desk needs to raise an invoice, and handing it
-- to them by default is the kind of over-broad grant DPDP alignment (PRD §7) gets
-- judged on.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- lab_orders
-- ---------------------------------------------------------------------------
create table if not exists public.lab_orders (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null references public.tenants (id) on delete restrict,

  -- Both, and both NOT NULL. Architecture.md §3 names patient_id (the lab tech's
  -- and the patient portal's view are patient-oriented); visit_id is required
  -- because billing_line_items.visit_id is NOT NULL and because an order belongs
  -- to an encounter. Composite FKs keep the pair tenant-consistent, so the
  -- denormalisation cannot drift across tenants.
  visit_id             uuid        not null,
  patient_id           uuid        not null,

  ordered_by           uuid        not null,

  -- Free text, matching how `prescription_items.drug_name` works: the reference
  -- set (lab_critical_ranges) is not exhaustive and a doctor must never be blocked
  -- from ordering a test it does not contain. The normalised form is what the
  -- critical-value lookup matches on.
  test_name            text        not null,
  test_name_normalized text        generated always as (lower(trim(test_name))) stored,

  priority             text        not null default 'routine',
  status               text        not null default 'pending',

  ordered_at           timestamptz not null default now(),

  -- Clinical context for the lab ("fasting sample", "repeat after transfusion").
  notes                text        null,
  cancellation_reason  text        null,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint lab_orders_test_name_not_blank check (length(trim(test_name)) > 0),
  constraint lab_orders_priority_valid check (priority in ('routine', 'urgent', 'stat')),
  constraint lab_orders_status_valid check (
    status in ('pending', 'sample_collected', 'in_progress', 'completed', 'cancelled')
  ),

  constraint lab_orders_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,
  constraint lab_orders_patient_same_tenant
    foreign key (patient_id, tenant_id)
    references public.patients (id, tenant_id)
    on delete restrict,
  constraint lab_orders_ordered_by_same_tenant
    foreign key (ordered_by, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict,

  constraint lab_orders_id_tenant_unique unique (id, tenant_id)
);

comment on table public.lab_orders is
  'Diagnostic orders. Plain INSERT by a doctor (Architecture.md §3), with triggers fanning out to billing and the nurse task board. status is not client-writable — use set_lab_order_status(). Readable by all staff including billing, because a lab order is a chargeable service; results are not (see lab_results).';
comment on column public.lab_orders.status is
  'pending -> sample_collected -> in_progress -> completed, or cancelled from any non-terminal state. Not client-writable; recording a result advances it automatically.';
comment on column public.lab_orders.priority is
  'routine | urgent | stat. Carried onto the generated nurse task''s label. There is no scheduling engine this phase, so priority informs humans rather than driving a due-time calculation.';

-- The lab queue: what is outstanding in this clinic, most urgent-looking first.
create index if not exists lab_orders_tenant_queue_idx   on public.lab_orders (tenant_id, status, ordered_at);
create index if not exists lab_orders_visit_idx          on public.lab_orders (visit_id, ordered_at desc);
create index if not exists lab_orders_tenant_patient_idx on public.lab_orders (tenant_id, patient_id, ordered_at desc);

drop trigger if exists lab_orders_touch_updated_at on public.lab_orders;
create trigger lab_orders_touch_updated_at
  before update on public.lab_orders
  for each row
  execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- lab_results
--
-- ###########################################################################
-- #  THE CRITICAL FLAG IS TWO FIELDS, NOT ONE, AND NEITHER IS NULLABLE.      #
-- #                                                                         #
-- #  A single `is_critical boolean` cannot express the state that matters    #
-- #  most: "we could not tell". If a result arrives for a test with no       #
-- #  thresholds on file, is_critical = false would be a lie by omission —    #
-- #  indistinguishable from a value that was checked and found normal.       #
-- #  rules.md §3.4: never let a failed safety check look like a passed one.  #
-- #                                                                         #
-- #  A nullable boolean was considered and rejected: Phase 2 already learned #
-- #  that lesson the hard way when check_prescription_safety() shipped a     #
-- #  NULL requires_acknowledgement, and the conclusion recorded then was     #
-- #  that a safety-critical boolean must never be three-valued.              #
-- #                                                                         #
-- #  So the shape mirrors check_prescription_safety()'s complete/partial     #
-- #  split, with two positive signals and no nulls:                          #
-- #                                                                         #
-- #    critical_check_status   evaluated | no_reference | unparseable_value  #
-- #                            | unit_mismatch | evaluation_failed          #
-- #    is_critical             true only when status = 'evaluated'           #
-- #    requires_manual_review  GENERATED: status <> 'evaluated'              #
-- #                                                                         #
-- #  is_critical = true  -> alert loudly.                                    #
-- #  requires_manual_review = true -> "could not evaluate, check by hand".   #
-- #  Both false -> and only then -> genuinely checked and not critical.      #
-- #                                                                         #
-- #  Prince must read BOTH. A UI that only reads is_critical will silently   #
-- #  render every unevaluable result as reassuring.                          #
-- ###########################################################################
-- ---------------------------------------------------------------------------
create table if not exists public.lab_results (
  id                     uuid        primary key default gen_random_uuid(),
  lab_order_id           uuid        not null,
  tenant_id              uuid        not null references public.tenants (id) on delete restrict,

  -- As reported. Text, because plenty of real results are not numbers:
  -- 'Reactive', 'Trace', 'No growth after 48h', '<0.01'.
  result_value           text        not null,

  -- Server-derived numeric interpretation, when one exists. Set by the flagging
  -- trigger, never by a client — so the number the threshold comparison used is
  -- the number stored, and a chart plotting result_numeric cannot disagree with
  -- the flag beside it.
  result_numeric         numeric     null,

  unit                   text        null,
  -- The lab's own printed normal range, free text ('3.5 - 5.1 mmol/L'). For
  -- display. Deliberately not parsed: the critical decision uses
  -- lab_critical_ranges, so a differently-formatted string from one lab cannot
  -- change whether an alert fires.
  reference_range        text        null,

  -- ---- server-derived criticality, see the banner above ----
  is_critical            boolean     not null default false,
  critical_check_status  text        not null default 'no_reference',
  requires_manual_review boolean     generated always as (critical_check_status <> 'evaluated') stored,
  critical_direction     text        null,

  -- The thresholds actually used, snapshotted. Same reasoning as the GSTIN
  -- snapshot on invoices: the reference set will be corrected and extended over
  -- time, and a later correction must not silently rewrite the basis on which a
  -- past clinical alert did or did not fire.
  critical_low_used      numeric     null,
  critical_high_used     numeric     null,

  reported_by            uuid        not null,
  reported_at            timestamptz not null default now(),
  notes                  text        null,

  -- ---- alert acknowledgement ----
  -- phases.md's Definition of Done says critical values must "trigger visible
  -- alerts, not passive queue entries". Acknowledgement is what makes that
  -- distinction real and, more importantly, testable on the server: without it,
  -- an alert is just a row that somebody may or may not have looked at, and the
  -- claim is unfalsifiable. With it, an unacknowledged critical result is an
  -- outstanding obligation that a clinician has to actively clear, and
  -- critical_lab_alerts (20260811071000) can show exactly which ones nobody has
  -- seen. Written only by acknowledge_critical_result().
  acknowledged_at        timestamptz null,
  acknowledged_by        uuid        null,

  created_at             timestamptz not null default now(),

  constraint lab_results_value_not_blank check (length(trim(result_value)) > 0),
  -- 'evaluation_failed' exists so that an unexpected fault inside the flagging
  -- logic cannot be laundered into one of the ordinary "could not evaluate"
  -- reasons, and above all cannot become a silent is_critical = false. It is the
  -- lab-result analogue of check_prescription_safety()'s SAFETY_CHECK_UNAVAILABLE:
  -- a third state, reported louder rather than more quietly (rules.md §3.2, §3.4).
  constraint lab_results_check_status_valid check (
    critical_check_status in (
      'evaluated', 'no_reference', 'unparseable_value', 'unit_mismatch', 'evaluation_failed'
    )
  ),
  constraint lab_results_direction_valid check (
    critical_direction is null or critical_direction in ('low', 'high')
  ),

  -- Only a check that actually ran may raise the flag. Without this, a bug
  -- elsewhere could set is_critical on an unevaluated result and the alert would
  -- carry no thresholds to explain itself.
  constraint lab_results_critical_requires_evaluation check (
    not is_critical or critical_check_status = 'evaluated'
  ),
  -- ...and a raised flag must say which way.
  constraint lab_results_critical_has_direction check (
    (is_critical and critical_direction is not null)
    or (not is_critical and critical_direction is null)
  ),

  -- One-directional on purpose, the lesson from the Phase 1 invites bug: state
  -- only the implication actually required, so a foreign key's own action can
  -- never be guaranteed to violate a constraint on the same row.
  constraint lab_results_ack_by_implies_time check (
    acknowledged_by is null or acknowledged_at is not null
  ),

  constraint lab_results_order_same_tenant
    foreign key (lab_order_id, tenant_id)
    references public.lab_orders (id, tenant_id)
    on delete restrict,
  constraint lab_results_reported_by_same_tenant
    foreign key (reported_by, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict,
  constraint lab_results_ack_by_same_tenant
    foreign key (acknowledged_by, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict
);

comment on table public.lab_results is
  'Reported results. Criticality is server-derived into TWO non-nullable fields — is_critical and requires_manual_review — so "could not evaluate" is never indistinguishable from "checked and normal" (rules.md §3.4). Written only by record_lab_result(). Not readable by billing.';
comment on column public.lab_results.critical_check_status is
  'evaluated | no_reference | unparseable_value | unit_mismatch | evaluation_failed. Only ''evaluated'' means the threshold comparison actually happened. Set by evaluate_lab_critical() via a BEFORE INSERT trigger; not client-writable.';
comment on column public.lab_results.requires_manual_review is
  'Generated: true whenever the critical check did not complete. The UI MUST surface this — a screen that reads only is_critical will present every unevaluable result as reassuring.';
comment on column public.lab_results.critical_low_used is
  'The threshold in force when this result was flagged, snapshotted. A later correction to lab_critical_ranges must not retroactively change the basis of a past alert.';

create index if not exists lab_results_order_idx on public.lab_results (lab_order_id, reported_at desc);
-- The critical-results feed: small, hot, and the one query an alerting surface runs.
create index if not exists lab_results_tenant_critical_idx
  on public.lab_results (tenant_id, reported_at desc)
  where is_critical;
-- The "somebody has to look at these by hand" queue.
create index if not exists lab_results_tenant_review_idx
  on public.lab_results (tenant_id, reported_at desc)
  where requires_manual_review;
-- The outstanding-alert feed: unacknowledged results that demand attention. Kept
-- deliberately narrow so the alert banner's query stays trivial however large the
-- results table grows.
create index if not exists lab_results_unacknowledged_idx
  on public.lab_results (tenant_id, reported_at desc)
  where acknowledged_at is null and (is_critical or requires_manual_review);


-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.lab_orders  enable row level security;
alter table public.lab_results enable row level security;

revoke all on public.lab_orders  from anon, authenticated;
revoke all on public.lab_results from anon, authenticated;

-- ---- lab_orders ----
-- `status` is not grantable: advancing an order has side effects (recording a
-- result completes it; cancelling it withdraws the pending billing line), so it
-- goes through set_lab_order_status().
grant select on public.lab_orders to authenticated;
grant insert (tenant_id, visit_id, patient_id, ordered_by, test_name, priority, notes)
  on public.lab_orders to authenticated;
grant update (notes) on public.lab_orders to authenticated;

create policy lab_orders_select_staff
  on public.lab_orders
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

-- Ordering a diagnostic test is a clinical decision, so doctor/admin only —
-- the same authorship rule as prescriptions. `ordered_by` must be the caller, so
-- an order cannot be attributed to a colleague.
create policy lab_orders_insert_doctor
  on public.lab_orders
  for insert
  to authenticated
  with check (
    public.has_tenant_role(array['doctor', 'admin'])
    and tenant_id = public.current_tenant_id()
    and ordered_by = (select auth.uid())
  );

create policy lab_orders_update_orderer
  on public.lab_orders
  for update
  to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and (ordered_by = (select auth.uid()) or public.is_tenant_admin())
  )
  with check (
    tenant_id = public.current_tenant_id()
  );

-- ---- lab_results ----
-- SELECT only, and not for billing. No INSERT/UPDATE/DELETE at all: the criticality
-- fields are derived and the order's status has to move in the same transaction, so
-- record_lab_result() is the only door. A client that could insert here could
-- write is_critical = false onto a critical potassium.
grant select on public.lab_results to authenticated;

create policy lab_results_select_clinical
  on public.lab_results
  for select
  to authenticated
  using (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
  );
