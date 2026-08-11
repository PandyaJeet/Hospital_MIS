-- ============================================================================
-- Migration:  invoice_and_pdf_payload_rpcs
--             create_invoice_for_visit / get_prescription_for_pdf /
--             get_invoice_for_pdf
--
-- WHY THE PDF PAYLOADS ARE POSTGRES FUNCTIONS AND NOT LOGIC INSIDE THE EDGE
-- FUNCTIONS
-- The obvious shape is an Edge Function that queries the tables it needs and
-- lays out a PDF. Two problems with that:
--
--   1. It would put tenant-scoped data access inside a Deno process, where the
--      easy path is the service-role key and RLS stops being the boundary
--      (rules.md §1.1). Keeping the query in SQL means the isolation guarantee is
--      the same one every other read in the system uses.
--   2. It would make the *data* correctness of an invoice — particularly the
--      rate-wise GST breakdown — only testable by deploying and rendering a PDF.
--      Since Edge Function deployment needs a personal access token that is not
--      available on this machine, that would have left the most compliance-
--      sensitive output in this phase completely unverified.
--
-- Split this way, the Edge Function is a thin renderer: fetch one jsonb payload,
-- draw it. Everything that could be *wrong* — totals, tax buckets, which tenant's
-- data — is in SQL and covered by the test suites.
--
-- Both getters are SECURITY INVOKER: the Edge Function forwards the caller's JWT,
-- so RLS applies exactly as it would in the browser and a cross-tenant id simply
-- resolves to nothing.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- create_invoice_for_visit
--
-- Turns the pending (uninvoiced) charges for a visit into an invoice, computing
-- tax PER CATEGORY. Never applies a rate to a total — see 20260811060700.
--
-- For a tenant that is not GST-registered, `is_gst_invoice` is false and NO
-- invoice_tax_lines rows are written, so the PDF renders a bill of supply rather
-- than a GST invoice full of zeros.
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
  v_tenantrow  record;
  v_existing   uuid;
  v_pending    integer;
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

  -- One live invoice per visit. A cancelled one may be superseded.
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

  -- Gapless per-tenant document series.
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':invoice_number', 0));

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
  'Aggregates a visit''s pending charges into an invoice, computing tax per (category, rate) into invoice_tax_lines. Non-GST tenants get no tax lines at all. Allocates a gapless per-tenant invoice number under advisory lock.';


-- ---------------------------------------------------------------------------
-- get_prescription_for_pdf
--
-- Everything generate-prescription-pdf needs, in one round trip. SECURITY
-- INVOKER so the Edge Function's forwarded JWT still governs access.
--
-- PII note: this payload contains patient name and clinical content by
-- necessity — it is the prescription. The Edge Function must not log it
-- (rules.md §1.3); that constraint is restated in the function's own source.
-- ---------------------------------------------------------------------------
create or replace function public.get_prescription_for_pdf(
  p_prescription_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'ok', true,
    'prescription', jsonb_build_object(
      'id', p.id,
      'status', p.status,
      'notes', p.notes,
      'issued_at', p.issued_at,
      'created_at', p.created_at
    ),
    'clinic', jsonb_build_object(
      'name', t.name,
      'address', t.address,
      'phone', t.phone
    ),
    'doctor', jsonb_build_object(
      'name', doc.full_name
    ),
    'patient', jsonb_build_object(
      'id', pat.id,
      'patient_number', pat.patient_number,
      'name', pat.full_name,
      'age_years', pat.age_years,
      'dob', pat.dob,
      'gender', pat.gender,
      'phone', pat.phone,
      'allergies', pat.allergies
    ),
    'visit', jsonb_build_object(
      'id', v.id,
      'visit_date', v.visit_date,
      'visit_type', v.visit_type,
      'queue_number', v.queue_number
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'drug_name', pi.drug_name,
               'generic_name', pi.generic_name,
               'is_generic', pi.is_generic,
               'dose', pi.dose,
               'frequency', pi.frequency,
               'duration', pi.duration,
               'instructions', pi.instructions,
               'quantity', pi.quantity
             ) order by pi.created_at)
      from public.prescription_items pi
      where pi.prescription_id = p.id
    ), '[]'::jsonb)
  )
    into v_result
  from public.prescriptions p
  join public.visits   v   on v.id = p.visit_id
  join public.patients pat on pat.id = v.patient_id
  join public.tenants  t   on t.id = p.tenant_id
  left join public.profiles doc on doc.id = p.doctor_id
  where p.id = p_prescription_id;

  if v_result is null then
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_NOT_FOUND',
      'message', 'That prescription does not exist at this clinic.');
  end if;

  return v_result;
end;
$$;

comment on function public.get_prescription_for_pdf(uuid) is
  'Single-payload read for generate-prescription-pdf. SECURITY INVOKER so the Edge Function''s forwarded user JWT governs access and RLS remains the boundary.';


-- ---------------------------------------------------------------------------
-- get_invoice_for_pdf
--
-- Includes the rate-wise tax breakdown so the renderer never has to compute
-- tax — it only formats what SQL already summed. `is_gst_invoice` tells the
-- renderer which document to draw.
-- ---------------------------------------------------------------------------
create or replace function public.get_invoice_for_pdf(
  p_invoice_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'ok', true,
    'invoice', jsonb_build_object(
      'id', i.id,
      'invoice_number', i.invoice_number,
      'status', i.status,
      'is_gst_invoice', i.is_gst_invoice,
      'gstin', i.gstin_snapshot,
      'gst_state_code', i.gst_state_code_snapshot,
      'subtotal', i.subtotal,
      'tax_total', i.tax_total,
      'grand_total', i.grand_total,
      'amount_paid', i.amount_paid,
      'payment_mode', i.payment_mode,
      'notes', i.notes,
      'issued_at', i.issued_at,
      'created_at', i.created_at
    ),
    'clinic', jsonb_build_object(
      'name', t.name,
      'address', t.address,
      'phone', t.phone,
      'gstin', i.gstin_snapshot
    ),
    'patient', jsonb_build_object(
      'id', pat.id,
      'patient_number', pat.patient_number,
      'name', pat.full_name,
      'phone', pat.phone,
      'address', pat.address
    ),
    'visit', jsonb_build_object(
      'id', v.id,
      'visit_date', v.visit_date,
      'queue_number', v.queue_number
    ),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'description', b.description,
               'source_type', b.source_type,
               'hsn_sac_code', b.hsn_sac_code,
               'quantity', b.quantity,
               'unit_amount', b.unit_amount,
               'amount', b.amount,
               'tax_category', b.tax_category,
               'tax_rate', b.tax_rate,
               'tax_amount', b.tax_amount
             ) order by b.created_at)
      from public.billing_line_items b
      where b.invoice_id = i.id
    ), '[]'::jsonb),
    -- The rate-wise summary block a GST invoice must print. Empty array for a
    -- non-GST bill of supply.
    'tax_summary', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tax_category', tl.tax_category,
               'tax_rate', tl.tax_rate,
               'taxable_amount', tl.taxable_amount,
               'tax_amount', tl.tax_amount
             ) order by tl.tax_category, tl.tax_rate)
      from public.invoice_tax_lines tl
      where tl.invoice_id = i.id
    ), '[]'::jsonb)
  )
    into v_result
  from public.invoices i
  join public.visits   v   on v.id = i.visit_id
  join public.patients pat on pat.id = i.patient_id
  join public.tenants  t   on t.id = i.tenant_id
  where i.id = p_invoice_id;

  if v_result is null then
    return jsonb_build_object('ok', false, 'code', 'INVOICE_NOT_FOUND',
      'message', 'That invoice does not exist at this clinic.');
  end if;

  return v_result;
end;
$$;

comment on function public.get_invoice_for_pdf(uuid) is
  'Single-payload read for generate-invoice-pdf, including the rate-wise tax summary so the renderer never computes tax. tax_summary is empty for a non-GST bill of supply.';


-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.create_invoice_for_visit(uuid)   from public, anon;
revoke execute on function public.get_prescription_for_pdf(uuid)   from public, anon;
revoke execute on function public.get_invoice_for_pdf(uuid)        from public, anon;

grant execute on function public.create_invoice_for_visit(uuid)    to authenticated;
grant execute on function public.get_prescription_for_pdf(uuid)    to authenticated;
grant execute on function public.get_invoice_for_pdf(uuid)         to authenticated;
