-- ============================================================================
-- Migration:  billing_autoinsert_triggers
-- Purpose:    The Phase 2 Definition of Done says "Billing charges auto-appear
--             with zero manual entry by billing staff." This migration is that
--             requirement. It is also Architecture.md §3's "one event, many
--             views" applied to money: the doctor never has to remember to tell
--             billing anything.
--
-- Two chargeable events:
--   1. a consultation actually happening  (visits.status enters in_consultation)
--   2. a prescription being issued        (prescriptions.status becomes issued)
--
-- WHY THESE FUNCTIONS ARE SECURITY DEFINER
-- The user who triggers the charge is the wrong person to be authoring it. A
-- doctor advancing a visit has no INSERT rights on billing_line_items — the
-- policy there requires the billing or admin role, deliberately, so that staff
-- cannot hand-write charges outside their remit. A trigger running as the
-- invoking doctor would therefore fail the policy and the consultation would go
-- unbilled, which is precisely the revenue leakage the PRD calls out (§3).
--
-- So these run as the owner and insert on the system's behalf, stamping
-- is_auto = true. Every value written is derived server-side from the triggering
-- row — tenant_id, patient_id and amounts all come from the database, never from
-- anything the client sent (rules.md §1.2). This is a narrow, stated exception
-- to the "no bypassing RLS" boundary and the only one in this phase.
--
-- IDEMPOTENCY
-- Both inserts use ON CONFLICT DO NOTHING against
-- billing_one_line_per_source_idx (tenant_id, source_type, source_id). A visit
-- bounced in_consultation -> queued -> in_consultation, or a prescription
-- re-issued after a correction, must not charge the patient twice. Relying on the
-- index rather than on the trigger's own guard means even an unexpected path
-- cannot produce a duplicate charge.
--
-- TAX ASSIGNMENT — the two-axis decision
-- Whether GST applies at all is the TENANT's registration status; what rate
-- applies is the SUPPLY's nature. Both are consulted:
--
--   tenant not GST-registered  -> every line is 'non_gst' @ 0
--   tenant GST-registered:
--       consultation           -> 'exempt' @ 0   (healthcare service,
--                                                 Notification 12/2017)
--       medicine, rate > 0     -> 'taxable' @ drugs.gst_rate, default 5%
--       medicine, rate = 0     -> 'nil_rated' @ 0 (exempt life-saving drug)
--
-- 'non_gst' and 'exempt' both carry a zero rate but mean different things, and
-- the invoice renders them differently: a non-registered clinic issues a bill of
-- supply with no tax section, while a registered clinic must show the
-- consultation as an exempt supply.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Shared helper: resolve a tenant's GST posture once, so both triggers and the
-- invoice builder agree. Returns the category/rate a line should carry.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_tax_treatment(
  p_tenant_id     uuid,
  p_is_medicine   boolean,
  p_drug_gst_rate numeric default null
)
returns table (tax_category text, tax_rate numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_gst_registered boolean;
  v_rate           numeric;
begin
  select t.gst_registered into v_gst_registered
  from public.tenants t
  where t.id = p_tenant_id;

  -- Unknown tenant should never happen (FK-protected), but defaulting to
  -- "no GST" is the safe direction if it somehow does.
  if not coalesce(v_gst_registered, false) then
    return query select 'non_gst'::text, 0::numeric;
    return;
  end if;

  if not p_is_medicine then
    -- Core healthcare service: exempt.
    return query select 'exempt'::text, 0::numeric;
    return;
  end if;

  v_rate := coalesce(p_drug_gst_rate, 5.00);

  if v_rate <= 0 then
    return query select 'nil_rated'::text, 0::numeric;
  else
    return query select 'taxable'::text, v_rate;
  end if;
end;
$$;

comment on function public.resolve_tax_treatment(uuid, boolean, numeric) is
  'Single source of truth for line-level tax treatment. Combines the tenant''s GST registration status with the nature of the supply. Used by the billing triggers so tax assignment cannot drift between them.';

revoke execute on function public.resolve_tax_treatment(uuid, boolean, numeric) from public, anon;
grant  execute on function public.resolve_tax_treatment(uuid, boolean, numeric) to authenticated;


-- ---------------------------------------------------------------------------
-- 1. Consultation charge
--
-- Fires on entry into in_consultation OR done. Firing on both matters: a busy
-- clinic may mark a short visit straight from queued to done, and that patient
-- was still seen. The unique index guarantees only the first of the two creates
-- a line.
--
-- The fee is the treating doctor's own rate if set, else the tenant default. A
-- zero fee still produces a line — a visible ₹0 consultation line that billing
-- can price is honest, whereas silently omitting the charge is the failure mode
-- this whole mechanism exists to prevent.
-- ---------------------------------------------------------------------------
create or replace function public.autoinsert_consultation_charge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fee      numeric(12, 2);
  v_category text;
  v_rate     numeric;
  v_doctor   text;
begin
  if new.status not in ('in_consultation', 'done')
     or old.status in ('in_consultation', 'done') then
    return new;
  end if;

  select coalesce(p.consultation_fee, t.default_consultation_fee, 0),
         coalesce(p.full_name, 'the doctor')
    into v_fee, v_doctor
  from public.tenants t
  left join public.profiles p on p.id = new.doctor_id
  where t.id = new.tenant_id;

  v_fee := coalesce(v_fee, 0);

  select r.tax_category, r.tax_rate
    into v_category, v_rate
  from public.resolve_tax_treatment(new.tenant_id, false, null) r;

  insert into public.billing_line_items (
    tenant_id, patient_id, visit_id,
    source_type, source_id, description,
    quantity, unit_amount, tax_category, tax_rate, is_auto
  )
  values (
    new.tenant_id, new.patient_id, new.id,
    'consultation', new.id,
    case when new.visit_type = 'follow_up'
         then 'Consultation (follow-up)'
         else 'Consultation' end,
    1, v_fee, v_category, v_rate, true
  )
  on conflict do nothing;

  return new;
end;
$$;

comment on function public.autoinsert_consultation_charge() is
  'AFTER UPDATE on visits: captures the consultation fee the first time a visit enters in_consultation or done. SECURITY DEFINER because the treating doctor deliberately has no INSERT rights on billing_line_items.';

drop trigger if exists visits_autoinsert_consultation on public.visits;
create trigger visits_autoinsert_consultation
  after update of status on public.visits
  for each row
  execute function public.autoinsert_consultation_charge();


-- ---------------------------------------------------------------------------
-- 2. Medicine charges
--
-- Fires once, when a prescription is issued, and captures every item on it. Not
-- per-item-insert: see the draft/issued rationale in 20260811060500. Pricing
-- falls back item.unit_price -> drugs.mrp -> 0, and a 0 leaves a visible line for
-- billing rather than a guessed amount.
-- ---------------------------------------------------------------------------
create or replace function public.autoinsert_medicine_charges()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient_id uuid;
  v_item       record;
  v_price      numeric(12, 2);
  v_qty        numeric(10, 2);
  v_category   text;
  v_rate       numeric;
begin
  if new.status <> 'issued' or old.status = 'issued' then
    return new;
  end if;

  select v.patient_id into v_patient_id
  from public.visits v
  where v.id = new.visit_id;

  for v_item in
    select pi.id, pi.drug_name, pi.dose, pi.quantity, pi.unit_price,
           d.mrp, d.gst_rate
    from public.prescription_items pi
    left join public.drugs d on d.id = pi.drug_id
    where pi.prescription_id = new.id
  loop
    v_qty   := coalesce(v_item.quantity, 1);
    v_price := coalesce(v_item.unit_price, v_item.mrp, 0);

    select r.tax_category, r.tax_rate
      into v_category, v_rate
    from public.resolve_tax_treatment(new.tenant_id, true, v_item.gst_rate) r;

    insert into public.billing_line_items (
      tenant_id, patient_id, visit_id,
      source_type, source_id, description,
      quantity, unit_amount, tax_category, tax_rate, is_auto
    )
    values (
      new.tenant_id, v_patient_id, new.visit_id,
      'medicine', v_item.id,
      -- Drug name and dose only. No diagnosis, no clinical note content: a
      -- billing line is seen by front-desk staff who do not need it, and this
      -- description ends up on a printed invoice the patient may share.
      v_item.drug_name || coalesce(' — ' || v_item.dose, ''),
      v_qty, v_price, v_category, v_rate, true
    )
    on conflict do nothing;
  end loop;

  return new;
end;
$$;

comment on function public.autoinsert_medicine_charges() is
  'AFTER UPDATE on prescriptions: captures a billing line per item when the prescription is issued. Prices from item.unit_price -> drugs.mrp -> 0. SECURITY DEFINER; all values derived server-side.';

drop trigger if exists prescriptions_autoinsert_medicine on public.prescriptions;
create trigger prescriptions_autoinsert_medicine
  after update of status on public.prescriptions
  for each row
  execute function public.autoinsert_medicine_charges();
