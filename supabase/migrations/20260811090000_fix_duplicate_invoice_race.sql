-- ============================================================================
-- Migration:  fix_duplicate_invoice_race
-- Phase:      5 (Hardening) — a fix for a real race condition, not a new feature.
--
-- ###########################################################################
-- #  FOUND BY THE PHASE 5 CONCURRENCY SUITE. Two simultaneous                #
-- #  create_invoice_for_visit() calls for the same visit BOTH SUCCEEDED,      #
-- #  producing two invoices for one encounter.                               #
-- ###########################################################################
--
-- ---------------------------------------------------------------------------
-- WHAT HAPPENED, EXACTLY
-- ---------------------------------------------------------------------------
-- `create_invoice_for_visit()` (Phase 2, 20260811061100) does, in order:
--
--   1. check for an existing non-cancelled invoice  -> INVOICE_ALREADY_EXISTS
--   2. count pending charges                        -> NO_PENDING_CHARGES
--   3. pg_advisory_xact_lock(tenant || ':invoice_number')
--   4. allocate invoice_number = max + 1
--   5. insert the invoice, claim the pending lines, compute totals
--
-- **The advisory lock is taken at step 3, but the duplicate check is at step 1.**
-- So two transactions both pass the check, both pass the count, and only then
-- serialise on the lock. Observed on the hosted project:
--
--   invoice #3  ₹500.00  1 line   <- the winner: claimed the pending charge
--   invoice #4  ₹  0.00  0 lines  <- the loser: header inserted, nothing left to claim
--
-- The lock did its stated job correctly — the numbers were 3 and 4, never colliding,
-- and `invoices_number_unique_per_tenant` never fired. It was simply in the right
-- place for gapless numbering and the wrong place to also prevent duplicates.
--
-- WHY THIS MATTERS MORE THAN A STRAY EMPTY ROW. An invoice is a tax document in a
-- legally gapless per-tenant series. The phantom consumed number #4, so an auditor
-- sees a ₹0 invoice with no line items sitting in the middle of the sequence. Worse,
-- **nothing would have flagged it**: Phase 4's reconciliation view checks stored
-- totals against line sums (0 = sum of nothing, so no mismatch) and payment status
-- against amount_paid (draft, 0 paid, so no mismatch). It was silently wrong, and
-- only a genuinely concurrent test could surface it — four phases of sequential
-- suites passed over it.
--
-- ---------------------------------------------------------------------------
-- THE FIX — TWO LAYERS, BECAUSE THEY DO DIFFERENT JOBS
-- ---------------------------------------------------------------------------
-- 1. **A partial unique index** makes "one live invoice per visit" an invariant of
--    the DATABASE rather than a property of one function's control flow. This is the
--    same structural approach used everywhere else in this schema — compare
--    `beds_one_bed_per_visit_idx` — and it holds against any writer: a future RPC, a
--    service-role backfill, a dashboard edit.
--
--    Predicate `status <> 'cancelled'` matches the RPC's own existing check exactly,
--    so the two cannot disagree: a cancelled invoice may legitimately be superseded
--    by a new one for the same visit.
--
-- 2. **Moving the advisory lock to before the duplicate check** so the whole
--    check-then-insert is one serialised critical section per tenant. This is what
--    preserves the CONTRACT: the loser now blocks, then sees the winner's invoice, and
--    returns the documented `{ok:false, code:'INVOICE_ALREADY_EXISTS', invoice_id}`
--    envelope — exactly as it does in the sequential case. Without this the loser
--    would hit the new index and surface a raw 23505, which `billing.md` does not
--    document and Prince's error handling would render as a generic failure.
--
-- Layer 1 alone would fix the data. Layer 2 alone would fix the observed race. Both
-- are needed: the index guarantees the invariant, the lock keeps the API honest.
--
-- No new deadlock risk: it is a single advisory lock, still taken before any row
-- locks, just earlier. Widening the critical section is acceptable here — invoice
-- creation was already serialised per tenant by this same lock for numbering, so the
-- concurrency profile is unchanged.
--
-- Per rules.md §5.6 the applied migration 20260811061100 is NOT edited; the function
-- is redefined here with CREATE OR REPLACE.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Step 1: repair existing duplicates, or the index below cannot be created.
--
-- rules.md §1.6 wants a stated reason for a data-altering migration: these rows are
-- in a state the schema should never have permitted, they were produced by the race
-- documented above, and the unique index cannot be built while they exist.
--
-- CANCELLED, NOT DELETED — deliberately. The phantom consumed a number in a gapless
-- tax series. An auditor seeing #4 marked `cancelled` is reading something normal and
-- expected; a missing #4 is a gap in a statutory sequence, which is worse. Cancelling
-- also moves the row outside the new index's predicate automatically.
--
-- Which one survives: the invoice carrying the most line items, tie-broken on the
-- lowest invoice_number. That keeps the invoice that actually has the charges on it
-- and cancels the empty header, which is what happened in every observed case.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cancelled integer;
begin
  with ranked as (
    select
      i.id,
      i.visit_id,
      row_number() over (
        partition by i.visit_id
        order by (select count(*) from public.billing_line_items b where b.invoice_id = i.id) desc,
                 i.invoice_number asc
      ) as keep_rank
    from public.invoices i
    where i.status <> 'cancelled'
  ),
  repaired as (
    update public.invoices i
       set status = 'cancelled',
           notes = case
             when i.notes is null or i.notes = ''
               then 'Cancelled by migration 20260811090000: duplicate invoice created by a concurrency race (see migration header).'
             else i.notes || ' | Cancelled by migration 20260811090000: duplicate invoice created by a concurrency race.'
           end
      from ranked r
     where r.id = i.id
       and r.keep_rank > 1
    returning 1
  )
  select count(*) into v_cancelled from repaired;

  if v_cancelled > 0 then
    raise notice 'Cancelled % duplicate invoice(s) left behind by the create_invoice_for_visit race.', v_cancelled;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- Step 2: the structural invariant.
--
-- Partial, because a cancelled invoice must not block re-invoicing the visit.
-- ---------------------------------------------------------------------------
create unique index if not exists invoices_one_live_per_visit_idx
  on public.invoices (visit_id)
  where status <> 'cancelled';

comment on index public.invoices_one_live_per_visit_idx is
  'One live (non-cancelled) invoice per visit, enforced structurally rather than by create_invoice_for_visit()''s control flow. Added in 20260811090000 after the Phase 5 concurrency suite proved two simultaneous calls could both succeed. Predicate matches the RPC''s own existence check so the two cannot disagree.';


-- ---------------------------------------------------------------------------
-- Step 3: redefine the RPC with the lock moved ahead of the duplicate check.
--
-- Byte-for-byte identical to 20260811061100 apart from the position of the
-- pg_advisory_xact_lock call, which now guards the whole critical section. Kept
-- otherwise unchanged on purpose: this is a hardening fix, and rewriting working
-- billing logic while fixing a race is how a second bug gets introduced.
-- ---------------------------------------------------------------------------
create or replace function public.create_invoice_for_visit(
  p_visit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_tenant     uuid;
  v_visit      record;
  v_existing   uuid;
  v_pending    integer;
  v_tenantrow  record;
  v_number     bigint;
  v_invoice_id uuid;
  v_subtotal   numeric(12, 2);
  v_tax_total  numeric(12, 2);
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.has_tenant_role(array['billing', 'admin']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_BILLING_STAFF',
      'message', 'Only billing staff or an admin can raise an invoice.');
  end if;

  v_tenant := public.current_tenant_id();

  select v.id, v.patient_id into v_visit
  from public.visits v
  where v.id = p_visit_id and v.tenant_id = v_tenant;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'VISIT_NOT_FOUND',
      'message', 'That visit does not exist at this clinic.');
  end if;

  -- ⚠️ THE FIX. This lock used to be taken further down, immediately before the
  -- number allocation. Two concurrent callers therefore both passed the existence
  -- check below before either had serialised, and both created an invoice. Taking it
  -- here makes check-and-insert atomic per tenant, so the second caller blocks and
  -- then correctly observes the first caller's invoice.
  --
  -- Same lock key as before: invoice creation was already serialised per tenant for
  -- numbering, so nothing about the concurrency profile changes.
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':invoice_number', 0));

  -- One live invoice per visit. A cancelled one may be superseded.
  -- Also enforced structurally by invoices_one_live_per_visit_idx (20260811090000),
  -- so this check is the friendly path rather than the guarantee.
  select i.id into v_existing
  from public.invoices i
  where i.visit_id = p_visit_id
    and i.tenant_id = v_tenant
    and i.status <> 'cancelled'
  limit 1;

  if v_existing is not null then
    return jsonb_build_object('ok', false, 'code', 'INVOICE_ALREADY_EXISTS',
      'message', 'An invoice has already been raised for this visit.',
      'invoice_id', v_existing);
  end if;

  select count(*) into v_pending
  from public.billing_line_items b
  where b.visit_id = p_visit_id
    and b.tenant_id = v_tenant
    and b.invoice_id is null;

  if v_pending = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_PENDING_CHARGES',
      'message', 'There are no pending charges for this visit.');
  end if;

  select t.gst_registered, t.gstin, t.gst_state_code
    into v_tenantrow
  from public.tenants t
  where t.id = v_tenant;

  -- Gapless per-tenant document series. The lock guarding this is now taken above.
  select coalesce(max(i.invoice_number), 0) + 1
    into v_number
  from public.invoices i
  where i.tenant_id = v_tenant;

  insert into public.invoices (
    tenant_id, patient_id, visit_id, invoice_number, status,
    is_gst_invoice, gstin_snapshot, gst_state_code_snapshot,
    subtotal, tax_total, created_by
  )
  values (
    v_tenant, v_visit.patient_id, p_visit_id, v_number, 'draft',
    coalesce(v_tenantrow.gst_registered, false),
    case when coalesce(v_tenantrow.gst_registered, false) then v_tenantrow.gstin end,
    case when coalesce(v_tenantrow.gst_registered, false) then v_tenantrow.gst_state_code end,
    0, 0, v_uid
  )
  returning id into v_invoice_id;

  -- Claim the pending lines.
  update public.billing_line_items b
     set invoice_id = v_invoice_id
   where b.visit_id = p_visit_id
     and b.tenant_id = v_tenant
     and b.invoice_id is null;

  -- Rate-wise summary. Only for a GST invoice: a non-registered clinic gets no
  -- tax section at all, which is the whole point of the distinction.
  if coalesce(v_tenantrow.gst_registered, false) then
    insert into public.invoice_tax_lines (
      invoice_id, tenant_id, tax_category, tax_rate, taxable_amount, tax_amount
    )
    select v_invoice_id, v_tenant, b.tax_category, b.tax_rate,
           sum(b.amount), sum(b.tax_amount)
    from public.billing_line_items b
    where b.invoice_id = v_invoice_id
    group by b.tax_category, b.tax_rate;
  end if;

  select coalesce(sum(b.amount), 0),
         coalesce(sum(b.tax_amount), 0)
    into v_subtotal, v_tax_total
  from public.billing_line_items b
  where b.invoice_id = v_invoice_id;

  -- A non-GST bill must carry no tax. The lines already have rate 0 in that
  -- case, so this is belt-and-braces against a mis-tagged line slipping through
  -- and violating invoices_non_gst_has_no_tax.
  if not coalesce(v_tenantrow.gst_registered, false) then
    v_tax_total := 0;
  end if;

  update public.invoices
     set subtotal = v_subtotal,
         tax_total = v_tax_total
   where id = v_invoice_id;

  return jsonb_build_object(
    'ok', true,
    'invoice_id', v_invoice_id,
    'invoice_number', v_number,
    'is_gst_invoice', coalesce(v_tenantrow.gst_registered, false),
    'line_count', v_pending,
    'subtotal', v_subtotal,
    'tax_total', v_tax_total,
    'grand_total', round(v_subtotal + v_tax_total, 2),
    'status', 'draft'
  );
end;
$$;

comment on function public.create_invoice_for_visit(uuid) is
  'Raises a draft invoice for a visit, claiming its pending charges and building the rate-wise tax summary. The per-tenant advisory lock guards the ENTIRE check-and-insert section (moved there in 20260811090000 after a concurrency race produced duplicate invoices), and invoices_one_live_per_visit_idx enforces the same invariant structurally.';
