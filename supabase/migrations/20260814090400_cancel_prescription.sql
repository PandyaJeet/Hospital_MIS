-- ============================================================================
-- Migration:  cancel_prescription
-- Phase:      6 (IPD billing) — 5 of 6
--
-- The write path for a status that has existed, and been checked for, since
-- Phase 2. `prescriptions_status_valid` has allowed 'cancelled' since
-- 20260811060500, `record_medication_administration()` has returned
-- PRESCRIPTION_CANCELLED for it since 20260811070600 ("That prescription was
-- cancelled. Do not administer."), and `issue_prescription()` refuses to issue one.
-- Every reader was ready. Nothing could ever write it: `status` is in no client
-- grant and no RPC set it, so 'cancelled' was reachable in the constraint and
-- unreachable in practice.
--
-- That is a live clinical-safety gap, not just an untidy enum. The one way to
-- retract a prescription a doctor has issued in error was to leave it standing and
-- tell the nurse verbally.
--
-- ---------------------------------------------------------------------------
-- WHO MAY CANCEL, AND WHY IT IS WIDER THAN WHO MAY ISSUE
-- ---------------------------------------------------------------------------
-- issue_prescription() is prescriber-only (`NOT_PRESCRIBER`) — authorising a drug is
-- personal to the doctor who authorised it.
--
-- Cancelling is admin OR the prescriber. Not because cancelling matters less, but
-- because the failure mode is asymmetric: an un-retracted wrong prescription is a
-- drug that may be administered, and if the only person who can retract it has gone
-- home, "wait for the prescriber" is not an acceptable answer in a ward at 2am.
-- Stopping something is safer to over-permit than starting it. A nurse still cannot
-- cancel — the decision is a prescribing one — but they are already protected,
-- because record_medication_administration() refuses a cancelled item.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE REAL DECISION: WHAT HAPPENS TO MEDICINE CHARGES ALREADY CAPTURED
-- ---------------------------------------------------------------------------
-- Issuing a prescription fires autoinsert_medicine_charges(), so by the time it can
-- be cancelled the charges usually exist. Three options were available:
--
--   (a) delete the billing lines
--   (b) leave them and let Phase 4's reconciliation view surface the discrepancy
--   (c) withdraw them only while still uninvoiced, and leave them once invoiced
--
-- **(c), because Phase 3 already settled this exact question** for a different
-- charge. `set_lab_order_status()` (20260811070900) withdraws a cancelled lab
-- order's pending charge, and when the charge has already been pulled onto an
-- invoice it leaves it alone and reports `billing_line_invoiced` — its comment:
-- "an issued tax document cannot be silently rewritten". A cancelled prescription
-- is the same shape of event, so it gets the same answer rather than a new one.
--
-- (a) was rejected because unconditional deletion would silently alter an issued
-- invoice's basis. (b) was rejected because leaving a charge for medicine that was
-- explicitly never dispensed means the patient is billed for it until somebody reads
-- a reconciliation report — the charge is not a discrepancy to investigate, it is
-- known to be wrong the moment the cancellation happens.
--
-- The RPC therefore reports both counts, so the caller can tell the two cases
-- apart: `charges_withdrawn` and `charges_invoiced`. A non-zero
-- `charges_invoiced` is a signal that a credit note is needed — which this system
-- does not model (logged as a scope-out), so it must be visible rather than
-- swallowed.
--
-- Deleting rather than zeroing: the lines are pending, `is_auto`, and the delete
-- policy already permits removing an uninvoiced auto line. A ₹0 line for a
-- cancelled prescription would sit on the bill inviting the question "what was
-- this?", where the honest answer is that the charge should not exist.
-- ============================================================================

create or replace function public.cancel_prescription(
  p_prescription_id uuid,
  p_reason          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_tenant     uuid;
  v_rx         record;
  v_withdrawn  integer := 0;
  v_invoiced   integer := 0;
  v_reason     text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.has_tenant_role(array['doctor', 'admin']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLINICAL_STAFF',
      'message', 'Only a doctor or an admin can cancel a prescription.');
  end if;

  v_tenant := public.current_tenant_id();

  select p.id, p.status, p.doctor_id, p.visit_id, p.notes
    into v_rx
  from public.prescriptions p
  where p.id = p_prescription_id and p.tenant_id = v_tenant
  for update;

  if not found then
    -- Same answer whether the id is unknown or belongs to another clinic, so this
    -- cannot be used to probe for other tenants' rows.
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_NOT_FOUND',
      'message', 'That prescription does not exist at this clinic.');
  end if;

  -- An admin may cancel anyone's; a doctor may cancel only their own. Checked after
  -- the lookup because the not-found answer above must not leak which case it was.
  if not public.is_tenant_admin() and v_rx.doctor_id <> v_uid then
    return jsonb_build_object('ok', false, 'code', 'NOT_PRESCRIBER',
      'message', 'Only the prescribing doctor or an admin can cancel this prescription.');
  end if;

  -- Idempotent no-op success, matching cancel_task()'s shape: a double-tapped
  -- button must not be an error.
  if v_rx.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'prescription_id', p_prescription_id,
      'status', 'cancelled', 'changed', false,
      'charges_withdrawn', 0, 'charges_invoiced', 0);
  end if;

  -- ---- withdraw the pending medicine charges ------------------------------
  -- Only for an issued prescription: a draft never billed anything, so there is
  -- nothing to withdraw and the counts stay 0.
  if v_rx.status = 'issued' then
    -- Already on an invoice: counted and LEFT ALONE. An issued tax document is not
    -- silently rewritten (the rule set by set_lab_order_status()).
    select count(*) into v_invoiced
    from public.billing_line_items b
    where b.tenant_id = v_tenant
      and b.source_type = 'medicine'
      and b.invoice_id is not null
      and b.source_id in (
        select pi.id from public.prescription_items pi
        where pi.prescription_id = p_prescription_id
      );

    with removed as (
      delete from public.billing_line_items b
      where b.tenant_id = v_tenant
        and b.source_type = 'medicine'
        and b.invoice_id is null
        and b.source_id in (
          select pi.id from public.prescription_items pi
          where pi.prescription_id = p_prescription_id
        )
      returning 1
    )
    select count(*) into v_withdrawn from removed;
  end if;

  -- ---- the transition ------------------------------------------------------
  -- issued_at must go back to NULL: prescriptions_issued_has_timestamp pairs the
  -- two, and would reject a cancelled row that still claimed an issue time.
  --
  -- The reason is appended to `notes` rather than stored in a dedicated column.
  -- Deliberate, and consistent with how 20260811090000 recorded its invoice
  -- cancellations: `notes` is already the prescriber's free-text field on this
  -- table, and adding a `cancellation_reason` column here would be a schema change
  -- for something the existing field holds correctly. Note the contrast with
  -- admin_set_user_active(), which takes NO reason at all — there, free text about
  -- a named individual's access was an HR-commentary hazard in a compliance log;
  -- here it is clinical context about a drug, which is exactly what notes is for.
  update public.prescriptions
     set status    = 'cancelled',
         issued_at = null,
         notes     = case
           when v_reason is null then notes
           when notes is null or notes = '' then 'Cancelled: ' || v_reason
           else notes || ' | Cancelled: ' || v_reason
         end
   where id = p_prescription_id and tenant_id = v_tenant;

  return jsonb_build_object(
    'ok', true,
    'prescription_id', p_prescription_id,
    'status', 'cancelled',
    'changed', true,
    'was_issued', v_rx.status = 'issued',
    'charges_withdrawn', v_withdrawn,
    -- Non-zero means a charge for undispensed medicine is sitting on an issued
    -- invoice and needs a credit note, which this system does not model. Surfaced
    -- rather than swallowed.
    'charges_invoiced', v_invoiced,
    'reason', v_reason
  );
end;
$$;

comment on function public.cancel_prescription(uuid, text) is
  'Cancels a prescription, clearing issued_at and appending any reason to notes. Withdraws the medicine charges it captured while they are still uninvoiced, counts and leaves any already pulled onto an invoice (charges_invoiced > 0 means a credit note is needed — not modelled). Doctor-or-admin rather than prescriber-only: an un-retracted wrong prescription is a drug that may be given, so stopping is safer to over-permit than starting. Cancelling twice is an idempotent no-op success.';

revoke execute on function public.cancel_prescription(uuid, text) from public, anon;
grant  execute on function public.cancel_prescription(uuid, text) to authenticated;
