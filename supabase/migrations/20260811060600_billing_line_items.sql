-- ============================================================================
-- Migration:  billing_line_items
--
-- WHY TAX LIVES HERE, PER LINE, AND NOT ON THE INVOICE TOTAL
-- A single OPD bill routinely mixes two different GST treatments:
--   * the consultation — a healthcare service by a clinical establishment, which
--     is GST-EXEMPT under Notification 12/2017 (Central Tax – Rate)
--   * dispensed medicines — a taxable supply, most drugs at 5% following the
--     GST Council's September 2025 rationalisation, with a specific list of
--     life-saving drugs fully exempt
--
-- Applying one rate to the invoice total would therefore produce a WRONG bill,
-- not merely an imprecise one: it either taxes an exempt consultation or
-- under-taxes dispensed medicine. Both are compliance failures, and both are
-- invisible once the numbers are summed. So `tax_category` and `tax_rate` are
-- attributes of the line, the invoice sums them per category
-- (invoice_tax_lines), and no code path anywhere applies a rate to a grand total.
--
-- tax_category vocabulary and why 'exempt' is the default:
--   exempt     — healthcare service under Notification 12/2017. rate must be 0
--   taxable    — attracts GST at rate > 0 (medicines, non-clinical supplies)
--   nil_rated  — taxable category, 0% rate (e.g. an exempted life-saving drug)
--   non_gst    — the tenant is not GST-registered, so GST does not apply at all
-- The default is `exempt` because the overwhelmingly common Phase 1 line is a
-- consultation fee, and a mistake that under-declares tax on a consultation is
-- correct rather than harmful. The constraint below makes an inconsistent
-- category/rate pair impossible rather than relying on the trigger being right.
--
-- !! Whether a tenant charges GST AT ALL is tenants.gst_registered, which is a
-- !! business fact Jeet must confirm per clinic — see 20260811060000's header.
-- ============================================================================

create table if not exists public.billing_line_items (
  id            uuid    primary key default gen_random_uuid(),
  tenant_id     uuid    not null references public.tenants (id) on delete restrict,
  patient_id    uuid    not null,
  visit_id      uuid    not null,

  -- NULL until the line is pulled onto an invoice. This is what makes
  -- "pending charges" a query rather than a status field to keep in sync.
  invoice_id    uuid    null,

  -- 'lab' and 'procedure' are accepted now although lab orders are Phase 3, so
  -- that phase adds rows rather than altering this constraint.
  source_type   text    not null,
  -- The row that caused this charge (a visit id, a prescription_item id). Lets
  -- the trigger stay idempotent and lets billing trace a charge to its origin.
  source_id     uuid    null,

  description   text    not null,

  quantity      numeric(10, 2) not null default 1,
  unit_amount   numeric(12, 2) not null default 0,

  -- Generated so the line total can never drift from its parts. Note it cannot
  -- be referenced by the tax_amount expression below (Postgres forbids a
  -- generated column reading another), so that one recomputes the product.
  amount        numeric(12, 2) generated always as (round(quantity * unit_amount, 2)) stored,

  tax_category  text    not null default 'exempt',
  tax_rate      numeric(5, 2) not null default 0,
  tax_amount    numeric(12, 2) generated always as (
                  round(round(quantity * unit_amount, 2) * tax_rate / 100, 2)
                ) stored,

  -- Required on a GST invoice line. Nullable because it is meaningless for a
  -- non-GST bill and unknown for many starter-list drugs.
  hsn_sac_code  text    null,

  -- Distinguishes a charge the system captured automatically from one billing
  -- staff added by hand. Auto lines are the ones that must never need manual
  -- entry; manual lines are the escape hatch for anything not yet modelled.
  is_auto       boolean not null default false,

  created_by    uuid    null references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint billing_source_type_valid check (
    source_type in ('consultation', 'medicine', 'lab', 'procedure', 'other')
  ),
  constraint billing_tax_category_valid check (
    tax_category in ('exempt', 'taxable', 'nil_rated', 'non_gst')
  ),
  constraint billing_quantity_positive check (quantity > 0),
  constraint billing_unit_amount_non_negative check (unit_amount >= 0),
  constraint billing_tax_rate_sane check (tax_rate >= 0 and tax_rate <= 100),

  -- The integrity rule that keeps tax coherent: only a 'taxable' line may carry
  -- a non-zero rate, and a 'taxable' line must actually carry one. This is what
  -- structurally prevents both "exempt consultation with 5% GST attached" and
  -- "taxable medicine silently at 0%".
  constraint billing_tax_category_rate_consistent check (
    (tax_category = 'taxable' and tax_rate > 0)
    or (tax_category in ('exempt', 'nil_rated', 'non_gst') and tax_rate = 0)
  ),

  constraint billing_patient_same_tenant
    foreign key (patient_id, tenant_id)
    references public.patients (id, tenant_id)
    on delete restrict,

  constraint billing_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  constraint billing_line_items_id_tenant_unique unique (id, tenant_id)
);

comment on table public.billing_line_items is
  'Auto-captured and manual charges. Tax is per line (tax_category + tax_rate) because one OPD bill mixes a GST-exempt consultation with taxable medicines; applying one rate to the total would be incorrect, not just imprecise.';
comment on column public.billing_line_items.invoice_id is
  'NULL while the charge is pending. "Pending charges" is therefore a query (invoice_id is null), not a status to keep in sync.';
comment on column public.billing_line_items.is_auto is
  'True when captured automatically by a trigger. Phase 2 DoD requires consultation and medicine charges to appear with zero manual entry, so these should be the norm and manual lines the exception.';
comment on column public.billing_line_items.source_id is
  'Originating row (visit id, prescription_item id). Used to keep the auto-insert triggers idempotent and to trace a charge back to the clinical event.';

create index if not exists billing_tenant_pending_idx on public.billing_line_items (tenant_id, invoice_id)
  where invoice_id is null;
create index if not exists billing_visit_idx   on public.billing_line_items (visit_id);
create index if not exists billing_patient_idx on public.billing_line_items (tenant_id, patient_id, created_at desc);
create index if not exists billing_invoice_idx on public.billing_line_items (invoice_id);

-- Guards against a trigger double-charging for the same clinical event, e.g. if
-- a visit were advanced to in_consultation twice. Partial so that manual lines
-- (source_id NULL) are unconstrained.
create unique index if not exists billing_one_line_per_source_idx
  on public.billing_line_items (tenant_id, source_type, source_id)
  where source_id is not null;

drop trigger if exists billing_line_items_touch_updated_at on public.billing_line_items;
create trigger billing_line_items_touch_updated_at
  before update on public.billing_line_items
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.billing_line_items enable row level security;

revoke all on public.billing_line_items from anon, authenticated;

-- Read: all clinic staff. A doctor being able to see what a patient is being
-- charged is a transparency feature, and the row carries a service description
-- rather than clinical detail.
-- Write: billing and admin only.
-- `invoice_id` is NOT grantable — attaching a line to an invoice happens inside
-- create_invoice_for_visit(), so a line cannot be moved between invoices or
-- silently detached from one that has already been issued.
grant select on public.billing_line_items to authenticated;
grant insert (tenant_id, patient_id, visit_id, source_type, source_id, description,
              quantity, unit_amount, tax_category, tax_rate, hsn_sac_code, created_by)
  on public.billing_line_items to authenticated;
grant update (description, quantity, unit_amount, tax_category, tax_rate, hsn_sac_code)
  on public.billing_line_items to authenticated;
grant delete on public.billing_line_items to authenticated;

create policy billing_line_items_select_staff
  on public.billing_line_items
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

-- Manual lines only: is_auto is not in the INSERT grant, so it takes its FALSE
-- default and a client cannot forge a line that claims to be system-captured.
create policy billing_line_items_insert_billing
  on public.billing_line_items
  for insert
  to authenticated
  with check (
    public.has_tenant_role(array['billing', 'admin'])
    and tenant_id = public.current_tenant_id()
  );

-- Editable only while still pending. Once a line sits on an invoice, changing
-- its amount would silently desynchronise the invoice totals from their parts.
create policy billing_line_items_update_billing_pending
  on public.billing_line_items
  for update
  to authenticated
  using (
    public.has_tenant_role(array['billing', 'admin'])
    and tenant_id = public.current_tenant_id()
    and invoice_id is null
  )
  with check (
    public.has_tenant_role(array['billing', 'admin'])
    and tenant_id = public.current_tenant_id()
  );

-- Same window for deletion. Note this permits removing an auto-captured line:
-- that is intentional — a clinic that does not dispense medicines needs to be
-- able to drop the medicine line — but only before it has been invoiced.
create policy billing_line_items_delete_billing_pending
  on public.billing_line_items
  for delete
  to authenticated
  using (
    public.has_tenant_role(array['billing', 'admin'])
    and tenant_id = public.current_tenant_id()
    and invoice_id is null
  );
