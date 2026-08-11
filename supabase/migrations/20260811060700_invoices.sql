-- ============================================================================
-- Migration:  invoices + invoice_tax_lines
--
-- THE STRUCTURAL POINT: an invoice does NOT carry a tax rate.
-- It carries `subtotal`, `tax_total`, `grand_total` — and a CHILD TABLE of
-- rate-wise tax lines. That child table is the whole reason this migration
-- exists in this shape. A GST invoice is legally required to present tax
-- summarised per rate/category, and a single OPD bill mixes an exempt
-- consultation with taxable medicine, so "the invoice's GST rate" is not a
-- quantity that exists. `tax_total` is the SUM of invoice_tax_lines, never a rate
-- applied to `subtotal`.
--
-- NON-GST TENANTS GET A GENUINELY DIFFERENT DOCUMENT, NOT A ZEROED ONE.
-- When tenants.gst_registered is false, `is_gst_invoice` is false, NO
-- invoice_tax_lines rows are written at all, and a constraint forces tax_total to
-- 0. The PDF then renders a plain bill of supply with no tax section — which is
-- what a clinic below the registration threshold must issue. A GST invoice
-- layout showing 0.00 in every tax box would misrepresent the clinic's status.
--
-- WHY GSTIN IS SNAPSHOTTED
-- `gstin_snapshot` / `gst_state_code_snapshot` copy the tenant's registration
-- details onto the invoice at issue time. A clinic that registers for GST later,
-- or corrects a typo in its GSTIN, must not retroactively rewrite invoices
-- already handed to patients — those are tax documents. The tenant row is
-- current state; the invoice is a historical record.
-- ============================================================================

create table if not exists public.invoices (
  id                      uuid    primary key default gen_random_uuid(),
  tenant_id               uuid    not null references public.tenants (id) on delete restrict,
  patient_id              uuid    not null,

  -- One invoice per visit in Phase 2. Kept NOT NULL deliberately: OPD billing is
  -- per encounter. Consolidated multi-visit invoicing (an IPD stay, a package)
  -- is a Phase 3 concern and would relax this to nullable plus a join table
  -- rather than change the meaning of this column.
  visit_id                uuid    not null,

  -- Per-tenant sequential document number. Tax documents need a gapless,
  -- human-quotable series; a uuid is not acceptable on a printed bill.
  invoice_number          bigint  not null,

  status                  text    not null default 'draft',

  -- Snapshot of the tenant's GST posture at issue time — see header.
  is_gst_invoice          boolean not null default false,
  gstin_snapshot          text    null,
  gst_state_code_snapshot text    null,

  subtotal                numeric(12, 2) not null default 0,
  tax_total               numeric(12, 2) not null default 0,
  -- Generated, so the printed total can never disagree with its components.
  grand_total             numeric(12, 2) generated always as (round(subtotal + tax_total, 2)) stored,

  amount_paid             numeric(12, 2) not null default 0,
  payment_mode            text    null,
  notes                   text    null,

  issued_at               timestamptz null,
  created_by              uuid    null references public.profiles (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint invoices_status_valid check (status in ('draft', 'issued', 'paid', 'cancelled')),
  constraint invoices_payment_mode_valid check (
    payment_mode is null or payment_mode in ('cash', 'upi', 'card', 'insurance', 'other')
  ),
  constraint invoices_number_positive check (invoice_number > 0),
  constraint invoices_amounts_non_negative check (
    subtotal >= 0 and tax_total >= 0 and amount_paid >= 0
  ),

  -- A GST invoice must identify the supplier's registration.
  constraint invoices_gst_requires_gstin check (
    not is_gst_invoice or gstin_snapshot is not null
  ),
  -- A non-GST bill of supply cannot carry tax. This is what makes "render a real
  -- non-GST bill" enforceable rather than a convention the PDF code has to
  -- remember.
  constraint invoices_non_gst_has_no_tax check (
    is_gst_invoice or tax_total = 0
  ),

  constraint invoices_patient_same_tenant
    foreign key (patient_id, tenant_id)
    references public.patients (id, tenant_id)
    on delete restrict,

  constraint invoices_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  constraint invoices_id_tenant_unique unique (id, tenant_id),
  constraint invoices_number_unique_per_tenant unique (tenant_id, invoice_number)
);

comment on table public.invoices is
  'Patient invoice. tax_total is the SUM of invoice_tax_lines (rate-wise), never a rate applied to subtotal. is_gst_invoice=false produces a bill of supply with no tax lines at all, not a GST invoice showing zeros.';
comment on column public.invoices.gstin_snapshot is
  'Tenant GSTIN copied at issue time. Invoices are tax documents; later changes to the tenant record must not rewrite them.';
comment on column public.invoices.invoice_number is
  'Per-tenant sequential series for the printed document. Assigned under lock by create_invoice_for_visit().';

create index if not exists invoices_tenant_created_idx on public.invoices (tenant_id, created_at desc);
create index if not exists invoices_tenant_status_idx  on public.invoices (tenant_id, status);
create index if not exists invoices_visit_idx          on public.invoices (visit_id);
create index if not exists invoices_patient_idx        on public.invoices (tenant_id, patient_id, created_at desc);

drop trigger if exists invoices_touch_updated_at on public.invoices;
create trigger invoices_touch_updated_at
  before update on public.invoices
  for each row
  execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- Now that invoices exists, close the loop on billing_line_items.invoice_id.
-- Composite FK so a line can only ever be attached to an invoice in its own
-- tenant. ON DELETE SET NULL is safe here because invoice_id is nullable — a
-- deleted draft invoice releases its lines back to "pending" rather than
-- destroying the charges.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_invoice_same_tenant') then
    alter table public.billing_line_items
      add constraint billing_invoice_same_tenant
      foreign key (invoice_id, tenant_id)
      references public.invoices (id, tenant_id)
      on delete set null;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- invoice_tax_lines — the rate-wise GST summary
--
-- One row per (category, rate) present on the invoice. For a typical OPD bill
-- with a consultation and two medicines this is two rows: exempt @ 0% and
-- taxable @ 5%. This is the shape a compliant GST invoice must print.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_tax_lines (
  id             uuid    primary key default gen_random_uuid(),
  invoice_id     uuid    not null,
  tenant_id      uuid    not null,

  tax_category   text    not null,
  tax_rate       numeric(5, 2) not null,
  -- Sum of line `amount` in this bucket (the taxable value).
  taxable_amount numeric(12, 2) not null default 0,
  -- Sum of line `tax_amount` in this bucket.
  tax_amount     numeric(12, 2) not null default 0,

  created_at     timestamptz not null default now(),

  constraint invoice_tax_lines_category_valid check (
    tax_category in ('exempt', 'taxable', 'nil_rated', 'non_gst')
  ),
  constraint invoice_tax_lines_rate_sane check (tax_rate >= 0 and tax_rate <= 100),
  constraint invoice_tax_lines_amounts_non_negative check (
    taxable_amount >= 0 and tax_amount >= 0
  ),
  -- Mirrors the line-item rule so a summary bucket cannot claim tax on an exempt
  -- category or zero tax on a taxable one.
  constraint invoice_tax_lines_category_rate_consistent check (
    (tax_category = 'taxable' and tax_rate > 0)
    or (tax_category in ('exempt', 'nil_rated', 'non_gst') and tax_rate = 0 and tax_amount = 0)
  ),

  constraint invoice_tax_lines_invoice_same_tenant
    foreign key (invoice_id, tenant_id)
    references public.invoices (id, tenant_id)
    on delete cascade,

  constraint invoice_tax_lines_bucket_unique unique (invoice_id, tax_category, tax_rate)
);

comment on table public.invoice_tax_lines is
  'Rate-wise tax summary for an invoice — one row per (tax_category, tax_rate). invoices.tax_total is the sum of these. Empty for a non-GST tenant, which is what makes the PDF a bill of supply rather than a zeroed GST invoice.';

create index if not exists invoice_tax_lines_invoice_idx on public.invoice_tax_lines (invoice_id);


-- ---------------------------------------------------------------------------
-- Status transition guard.
--
-- `subtotal`/`tax_total` are not client-grantable, so the monetary figures
-- cannot be edited from a session. What a client CAN change is status and
-- payment, and those need ordering rules: a cancelled invoice must not come back
-- to life, and an issued document must not revert to draft (it has been given to
-- a patient and its number is spent).
-- ---------------------------------------------------------------------------
create or replace function public.guard_invoice_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'cancelled' then
    raise exception 'A cancelled invoice cannot change status'
      using errcode = 'check_violation';
  end if;

  if old.status in ('issued', 'paid') and new.status = 'draft' then
    raise exception 'An issued invoice cannot revert to draft'
      using errcode = 'check_violation';
  end if;

  if old.status = 'paid' and new.status = 'issued' then
    raise exception 'A paid invoice cannot revert to issued'
      using errcode = 'check_violation';
  end if;

  -- Stamp issue time on the way out of draft, so it is never client-supplied.
  if new.status in ('issued', 'paid') and new.issued_at is null then
    new.issued_at := now();
  end if;

  return new;
end;
$$;

comment on function public.guard_invoice_status_transition() is
  'BEFORE UPDATE on invoices: rejects illegal status regressions and stamps issued_at server-side.';

drop trigger if exists invoices_guard_status on public.invoices;
create trigger invoices_guard_status
  before update on public.invoices
  for each row
  execute function public.guard_invoice_status_transition();


-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.invoices          enable row level security;
alter table public.invoice_tax_lines enable row level security;

revoke all on public.invoices          from anon, authenticated;
revoke all on public.invoice_tax_lines from anon, authenticated;

-- No INSERT grant on either table: invoices are produced by
-- create_invoice_for_visit(), which is the only place that can compute the
-- rate-wise tax correctly and allocate an invoice number without a gap.
-- Monetary columns are not updatable; only status/payment/notes are.
grant select on public.invoices to authenticated;
grant update (status, amount_paid, payment_mode, notes) on public.invoices to authenticated;
grant delete on public.invoices to authenticated;

grant select on public.invoice_tax_lines to authenticated;

create policy invoices_select_staff
  on public.invoices
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

create policy invoices_update_billing
  on public.invoices
  for update
  to authenticated
  using (
    public.has_tenant_role(array['billing', 'admin'])
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.has_tenant_role(array['billing', 'admin'])
    and tenant_id = public.current_tenant_id()
  );

-- Only a draft may be deleted, and doing so releases its lines back to pending
-- via the ON DELETE SET NULL above. An issued invoice is cancelled, never
-- deleted — its number has been used on a document.
create policy invoices_delete_draft_billing
  on public.invoices
  for delete
  to authenticated
  using (
    public.has_tenant_role(array['billing', 'admin'])
    and tenant_id = public.current_tenant_id()
    and status = 'draft'
  );

create policy invoice_tax_lines_select_staff
  on public.invoice_tax_lines
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );
