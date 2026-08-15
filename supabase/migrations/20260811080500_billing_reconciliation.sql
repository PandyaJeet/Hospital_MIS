-- ============================================================================
-- Migration:  billing_reconciliation
-- Purpose:    PRD §6.3 "End-of-day reconciliation view" / phases.md "compare
--             billing_line_items vs invoices for discrepancies".
--
-- READ-ONLY BY DESIGN. This finds and explains discrepancies; it does not correct
-- them. phases.md's Definition of Done is "reconciliation view correctly flags
-- billing mismatches", and auto-correcting money without a human deciding what
-- correct means is not something a reporting layer should do. Every finding names the
-- rows involved so a human can act.
--
-- ---------------------------------------------------------------------------
-- ONE ROW PER FINDING, NOT ONE VIEW PER CHECK
-- ---------------------------------------------------------------------------
-- The question staff actually ask at the end of a shift is "is anything off, and
-- what" — one list, sorted by how much it matters. Three separate views would make
-- the frontend ask three questions and merge the answers. So this is a UNION of
-- finding types with a shared shape: `finding_type`, `severity`, the ids involved,
-- and the amounts at stake.
--
-- SEVERITY IS PART OF THE CONTRACT, because "flag mismatches" is useless if a
-- genuinely broken invoice sorts alongside a charge raised four minutes ago:
--   high    — money is definitely wrong. An invoice's stored total disagrees with its
--             lines, or a payment contradicts the document's status.
--   warning — money is probably being lost. A charge has sat uninvoiced long enough
--             that it looks forgotten, or an invoice is fully paid but still says
--             unpaid.
--   info    — normal operation, shown for completeness. A charge raised today that
--             has not been invoiced yet is just an open encounter.
--
-- ---------------------------------------------------------------------------
-- WHY CHECK 2 EXISTS WHEN IT "SHOULD BE IMPOSSIBLE"
-- ---------------------------------------------------------------------------
-- `create_invoice_for_visit()` is the only sanctioned writer of invoice totals, and
-- if it is the only thing that ever writes them the sum check can never fire. That is
-- exactly why it is worth having. The paths that bypass it are real: a service-role
-- backfill, a manual edit in the Supabase dashboard, a future consolidated-invoice
-- feature, or a bug in a later revision of that RPC. A reconciliation view that only
-- catches the errors we already thought of is not a reconciliation view.
--
-- Note `invoices.grand_total` is a GENERATED column (`subtotal + tax_total`), so it
-- cannot drift from its own parts and is not checked. What CAN drift is
-- `subtotal`/`tax_total` versus the sum of the attached lines, and that is what
-- check 2 compares.
--
-- ROUNDING: compared with a 0.01 tolerance. Line amounts are individually rounded to
-- paise before summing, so an exact-equality test would produce false findings from
-- legitimate half-paise rounding on multi-line invoices. A real discrepancy is never
-- one paise.
-- ============================================================================

create or replace view public.billing_reconciliation
with (security_invoker = true) as

-- ---- 1. Charges that have not reached an invoice ---------------------------
-- The revenue leakage PRD §3 is about: work done, chargeable, never billed.
select
  b.tenant_id,
  'pending_charge'::text                                        as finding_type,
  case
    when b.created_at < now() - interval '72 hours' then 'warning'
    when b.created_at < now() - interval '24 hours' then 'warning'
    else 'info'
  end                                                           as severity,
  b.id                                                          as row_id,
  'billing_line_items'::text                                    as table_name,
  b.visit_id,
  b.patient_id,
  null::uuid                                                    as invoice_id,
  null::bigint                                                  as invoice_number,
  b.description                                                 as detail,
  b.amount + b.tax_amount                                       as amount_at_stake,
  null::numeric                                                 as expected_amount,
  round(extract(epoch from (now() - b.created_at)) / 3600.0, 1) as age_hours,
  b.created_at                                                  as occurred_at
from public.billing_line_items b
where b.invoice_id is null
  and public.is_tenant_admin()

union all

-- ---- 2. An invoice whose stored totals disagree with its lines -------------
select
  i.tenant_id,
  'invoice_sum_mismatch'::text,
  'high',
  i.id,
  'invoices'::text,
  i.visit_id,
  i.patient_id,
  i.id,
  i.invoice_number,
  'Stored subtotal/tax_total does not match the sum of attached line items'::text,
  i.grand_total,
  coalesce(l.line_subtotal, 0) + coalesce(l.line_tax, 0),
  round(extract(epoch from (now() - i.created_at)) / 3600.0, 1),
  i.created_at
from public.invoices i
left join lateral (
  select sum(b.amount) as line_subtotal, sum(b.tax_amount) as line_tax
  from public.billing_line_items b
  where b.invoice_id = i.id
) l on true
where i.status <> 'cancelled'
  and (
    abs(i.subtotal  - coalesce(l.line_subtotal, 0)) > 0.01
    or abs(i.tax_total - coalesce(l.line_tax, 0))    > 0.01
  )
  and public.is_tenant_admin()

union all

-- ---- 3. Payment state contradicting the document's status ------------------
-- Four distinct contradictions, deliberately not merged: they need different
-- remedies, and an operator seeing "payment mismatch" with no further detail has to
-- open every invoice to find out which. `detail` names the specific contradiction.
select
  i.tenant_id,
  'payment_status_mismatch'::text,
  case
    -- Money that arrived against a document that should not have taken any, or more
    -- money than was ever owed. Both are definitely wrong.
    when i.status in ('draft', 'cancelled') and i.amount_paid > 0 then 'high'
    when i.amount_paid > i.grand_total + 0.01                      then 'high'
    -- Marked settled while short. Wrong, and it hides a debt.
    when i.status = 'paid' and i.amount_paid + 0.01 < i.grand_total then 'high'
    -- Fully collected but never marked paid. Bookkeeping lag, not lost money.
    else 'warning'
  end,
  i.id,
  'invoices'::text,
  i.visit_id,
  i.patient_id,
  i.id,
  i.invoice_number,
  case
    when i.status in ('draft', 'cancelled') and i.amount_paid > 0
      then 'Payment recorded against a ' || i.status || ' invoice'
    when i.amount_paid > i.grand_total + 0.01
      then 'Amount paid exceeds the invoice total'
    when i.status = 'paid' and i.amount_paid + 0.01 < i.grand_total
      then 'Marked paid but the amount collected is less than the total'
    else 'Fully collected but still marked unpaid'
  end,
  i.amount_paid,
  i.grand_total,
  round(extract(epoch from (now() - coalesce(i.issued_at, i.created_at))) / 3600.0, 1),
  coalesce(i.issued_at, i.created_at)
from public.invoices i
where public.is_tenant_admin()
  and (
    (i.status in ('draft', 'cancelled') and i.amount_paid > 0)
    or i.amount_paid > i.grand_total + 0.01
    or (i.status = 'paid'   and i.amount_paid + 0.01 < i.grand_total)
    or (i.status = 'issued' and i.amount_paid >= i.grand_total - 0.01 and i.grand_total > 0)
  );

comment on view public.billing_reconciliation is
  'One row per billing discrepancy: uninvoiced charges, invoices whose stored totals disagree with their lines, and payments contradicting invoice status. Read-only — it reports, it does not correct. severity high/warning/info is part of the contract. Admin only, security_invoker.';


-- ---------------------------------------------------------------------------
-- The badge query: counts and money at stake per finding type.
--
-- Separate view rather than an aggregate the client computes, so "is anything off"
-- is one cheap row instead of fetching every finding to count them. This is what the
-- dashboard's reconciliation tile should read.
-- ---------------------------------------------------------------------------
create or replace view public.billing_reconciliation_summary
with (security_invoker = true) as
select
  r.tenant_id,
  r.finding_type,
  r.severity,
  count(*)                          as finding_count,
  sum(r.amount_at_stake)            as total_amount_at_stake,
  max(r.age_hours)                  as oldest_age_hours,
  min(r.occurred_at)                as oldest_occurred_at
from public.billing_reconciliation r
group by r.tenant_id, r.finding_type, r.severity;

comment on view public.billing_reconciliation_summary is
  'Counts and money at stake per (finding_type, severity) — the reconciliation badge, so "is anything off" costs one row rather than fetching every finding. Inherits admin-only scoping from billing_reconciliation.';


revoke all on public.billing_reconciliation         from anon, authenticated;
revoke all on public.billing_reconciliation_summary from anon, authenticated;
grant select on public.billing_reconciliation         to authenticated;
grant select on public.billing_reconciliation_summary to authenticated;
