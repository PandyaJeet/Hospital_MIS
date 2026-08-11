-- ============================================================================
-- Migration:  prescriptions + prescription_items
--
-- WHY THERE IS A draft -> issued LIFECYCLE (not in the phase brief's sketch)
-- The brief asks for a trigger that bills "when a prescription is saved". Taken
-- literally as "on every item INSERT", that breaks in an ordinary way: a doctor
-- composing a prescription adds a line, mistypes, removes it, adds another. If
-- each insert had already produced a billing line, removing the item would
-- either orphan a charge or require deleting a billing row that may already sit
-- on an invoice. The patient gets billed for a drug they were never given.
--
-- So a prescription is composed as `draft` — items freely added, edited, removed,
-- nothing billed — and `issue_prescription()` transitions it to `issued`, which
-- is the actual chargeable event and what the billing trigger fires on. Items
-- become immutable at that point. This is both closer to how prescribing works
-- and the only version where "auto-billed with zero manual entry" and "no
-- phantom charges" are true at the same time.
--
-- rules.md §1.7 EXTENDED TO THIS TABLE. The rule names clinical notes, but its
-- purpose — no mandatory field may block a doctor-facing save — applies just as
-- much to prescription authoring. So dose, frequency, duration and instructions
-- are all nullable: a half-specified item saves. `drug_name` is the one required
-- content column, because an item naming no drug is not an incomplete row, it is
-- a meaningless one, and a doctor who has not chosen a drug simply has not added
-- an item yet.
--
-- WHO CAN READ — contrast with clinical_notes
-- clinical_notes deliberately excludes billing staff, because an invoice does not
-- require a diagnosis. Prescriptions are the opposite: in an Indian clinic the
-- pharmacy and billing counter are usually the same desk, and dispensing and
-- pricing a medicine require seeing what was prescribed. So all staff can read
-- prescriptions. That is an operational necessity, not a relaxation of the
-- minimisation principle applied next door.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- prescriptions
-- ---------------------------------------------------------------------------
create table if not exists public.prescriptions (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants (id) on delete restrict,
  visit_id    uuid        not null,
  doctor_id   uuid        not null,

  status      text        not null default 'draft',

  -- Prescriber's free-text remarks. Clinical -> nullable.
  notes       text        null,

  issued_at   timestamptz null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint prescriptions_status_valid check (status in ('draft', 'issued', 'cancelled')),

  -- An issued prescription must record when. Structural bookkeeping, not a
  -- clinical field, and it is set by issue_prescription() rather than typed.
  constraint prescriptions_issued_has_timestamp check (
    (status = 'issued' and issued_at is not null)
    or (status <> 'issued' and issued_at is null)
  ),

  constraint prescriptions_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  constraint prescriptions_doctor_same_tenant
    foreign key (doctor_id, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict,

  constraint prescriptions_id_tenant_unique unique (id, tenant_id)
);

comment on table public.prescriptions is
  'A prescription for a visit. Composed as draft (nothing billed), then issue_prescription() moves it to issued, which is the chargeable event the billing trigger fires on. Readable by all clinic staff because dispensing and pricing need it.';
comment on column public.prescriptions.status is
  'draft -> items editable, nothing billed. issued -> items frozen, billing lines created. cancelled -> voided. Not client-writable; use issue_prescription().';

create index if not exists prescriptions_visit_idx  on public.prescriptions (visit_id, created_at desc);
create index if not exists prescriptions_tenant_idx on public.prescriptions (tenant_id, created_at desc);

drop trigger if exists prescriptions_touch_updated_at on public.prescriptions;
create trigger prescriptions_touch_updated_at
  before update on public.prescriptions
  for each row
  execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- prescription_items
--
-- Carries tenant_id per rules.md §4.1 even though it is reachable through its
-- parent, and the composite FK below keeps that denormalised value honest: an
-- item cannot reference a prescription in a different tenant, because no such
-- (id, tenant_id) pair exists.
-- ---------------------------------------------------------------------------
create table if not exists public.prescription_items (
  id              uuid    primary key default gen_random_uuid(),
  prescription_id uuid    not null,
  tenant_id       uuid    not null,

  -- Optional link to the reference table. NULL is a normal, expected state: the
  -- starter drug list is small, and a doctor must never be blocked from
  -- prescribing something it does not contain. An unmatched item is what makes
  -- check_prescription_safety() report `partial`.
  drug_id         uuid    null references public.drugs (id) on delete set null,

  drug_name       text    not null,
  generic_name    text    null,
  is_generic      boolean not null default false,

  -- ---- dosing: ALL NULLABLE, see §1.7 note in the header ----
  dose            text    null,
  frequency       text    null,
  duration        text    null,
  instructions    text    null,

  -- Dispensing/pricing. Both nullable; the billing trigger falls back to the
  -- reference MRP and then to zero rather than inventing a figure.
  quantity        numeric(10, 2) null,
  unit_price      numeric(12, 2) null,

  created_at      timestamptz not null default now(),

  constraint prescription_items_drug_name_not_blank check (length(trim(drug_name)) > 0),
  constraint prescription_items_quantity_positive check (quantity is null or quantity > 0),
  constraint prescription_items_unit_price_non_negative check (unit_price is null or unit_price >= 0),

  constraint prescription_items_parent_same_tenant
    foreign key (prescription_id, tenant_id)
    references public.prescriptions (id, tenant_id)
    on delete cascade
);

comment on table public.prescription_items is
  'Line items of a prescription. dose/frequency/duration/instructions are nullable so a partially-specified item still saves (rules.md §1.7 principle). drug_id NULL is normal — the starter reference list is not exhaustive.';
comment on column public.prescription_items.drug_id is
  'Link to the starter drug reference, or NULL when the prescribed drug is not in it. NULL is what causes check_prescription_safety() to return status=partial rather than implying a clean check.';

create index if not exists prescription_items_parent_idx on public.prescription_items (prescription_id);
create index if not exists prescription_items_tenant_idx on public.prescription_items (tenant_id);


-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.prescriptions      enable row level security;
alter table public.prescription_items enable row level security;

revoke all on public.prescriptions      from anon, authenticated;
revoke all on public.prescription_items from anon, authenticated;

-- `status` and `issued_at` are not grantable: issuing is a chargeable event with
-- billing side effects, so it goes through issue_prescription().
grant select on public.prescriptions to authenticated;
grant insert (tenant_id, visit_id, doctor_id, notes) on public.prescriptions to authenticated;
grant update (notes) on public.prescriptions to authenticated;

grant select on public.prescription_items to authenticated;
grant insert (prescription_id, tenant_id, drug_id, drug_name, generic_name, is_generic,
              dose, frequency, duration, instructions, quantity, unit_price)
  on public.prescription_items to authenticated;
grant update (drug_id, drug_name, generic_name, is_generic, dose, frequency,
              duration, instructions, quantity, unit_price)
  on public.prescription_items to authenticated;
grant delete on public.prescription_items to authenticated;

-- ---- prescriptions ----
create policy prescriptions_select_staff
  on public.prescriptions
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

create policy prescriptions_insert_doctor
  on public.prescriptions
  for insert
  to authenticated
  with check (
    public.has_tenant_role(array['doctor', 'admin'])
    and tenant_id = public.current_tenant_id()
    and doctor_id = (select auth.uid())
  );

-- Only the prescriber, and only while still a draft. Once issued, the record is
-- frozen — it has been handed to a patient and billed.
create policy prescriptions_update_prescriber_draft
  on public.prescriptions
  for update
  to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and doctor_id = (select auth.uid())
    and status = 'draft'
  )
  with check (
    tenant_id = public.current_tenant_id()
    and doctor_id = (select auth.uid())
  );

-- ---- prescription_items ----
create policy prescription_items_select_staff
  on public.prescription_items
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

-- Items may only be added to a draft prescription the caller wrote. The EXISTS
-- against `prescriptions` is evaluated with the caller's own privileges, so it is
-- additionally filtered by that table's SELECT policy — a doctor cannot even
-- probe for the existence of another tenant's prescription this way.
create policy prescription_items_insert_prescriber
  on public.prescription_items
  for insert
  to authenticated
  with check (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.prescriptions p
      where p.id = prescription_id
        and p.tenant_id = public.current_tenant_id()
        and p.doctor_id = (select auth.uid())
        and p.status = 'draft'
    )
  );

create policy prescription_items_update_prescriber_draft
  on public.prescription_items
  for update
  to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.prescriptions p
      where p.id = prescription_id
        and p.doctor_id = (select auth.uid())
        and p.status = 'draft'
    )
  )
  with check (tenant_id = public.current_tenant_id());

-- Removing a mistyped line is only possible before issue, which is exactly the
-- window in which nothing has been billed for it.
create policy prescription_items_delete_prescriber_draft
  on public.prescription_items
  for delete
  to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.prescriptions p
      where p.id = prescription_id
        and p.doctor_id = (select auth.uid())
        and p.status = 'draft'
    )
  );
