-- ============================================================================
-- Migration:  lab_triggers_and_rpcs
--
-- This is Architecture.md §3's fan-out, built. One insert into `lab_orders`, and
-- without the doctor remembering to tell anybody:
--
--   * billing gets a pending charge          (autoinsert_lab_charge)
--   * the nurse board gets a collection card (autoinsert_lab_sample_task)
--   * Realtime carries the row to the lab queue and the task board
--     (publication, 20260811071100)
--
-- Plus the part that has to be right rather than merely convenient: every result
-- is evaluated against the critical-value reference on the way in
-- (flag_lab_result_critical), by a trigger, so it cannot be skipped by whichever
-- path wrote the row.
--
-- WHY THE TRIGGERS ARE SECURITY DEFINER — same reason as Phase 2's billing
-- triggers, stated again because it is the phase's only sanctioned RLS bypass and
-- should not have to be inferred: the person whose action causes the write is
-- deliberately not allowed to perform it. A doctor has no INSERT on
-- billing_line_items (billing/admin only, so clinicians cannot hand-write
-- charges), and no client at all may write tasks.is_auto or lab_results.is_critical.
-- A trigger running as the invoker would therefore fail the policy and the test
-- would go unbilled and uncollected — the revenue leakage PRD §3 names. Every value
-- written is derived server-side from the triggering row (rules.md §1.2).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Lab order -> pending billing charge
--
-- PRICE IS ZERO, ON PURPOSE. There is no lab price list in the schema — a test
-- catalogue with per-tenant pricing is real work and belongs with the Tier 2/3
-- billing surface, not here. The choice is therefore between a visible ₹0 line
-- that the billing counter prices, and no line at all. Phase 2 already settled
-- this exact question for a drug with no MRP on file: a zero-amount line is honest
-- and gets completed, while silently omitting the charge is the failure mode the
-- whole auto-capture mechanism exists to prevent. Same answer here.
--
-- TAX: a diagnostic test performed by a clinical establishment is a healthcare
-- service, so it takes the same treatment as a consultation — exempt when the
-- clinic is GST-registered, non_gst when it is not. resolve_tax_treatment() is
-- reused rather than duplicated so lab lines cannot drift from consultation lines.
-- ---------------------------------------------------------------------------
create or replace function public.autoinsert_lab_charge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category text;
  v_rate     numeric;
begin
  select r.tax_category, r.tax_rate
    into v_category, v_rate
  from public.resolve_tax_treatment(new.tenant_id, false, null) r;

  insert into public.billing_line_items (
    tenant_id, patient_id, visit_id,
    source_type, source_id, description,
    quantity, unit_amount, tax_category, tax_rate, is_auto
  )
  values (
    new.tenant_id, new.patient_id, new.visit_id,
    -- 'lab' was already reserved in the Phase 2 source_type constraint precisely
    -- so this phase would add rows, not alter a constraint. See billing.md.
    'lab', new.id,
    -- Test name only. No clinical indication, no diagnosis: this string is read by
    -- front-desk staff and printed on an invoice the patient may hand to somebody
    -- else.
    'Lab test — ' || new.test_name,
    1, 0, v_category, v_rate, true
  )
  on conflict do nothing;   -- billing_one_line_per_source_idx: never double-charge

  return null;
end;
$$;

comment on function public.autoinsert_lab_charge() is
  'AFTER INSERT on lab_orders: raises a pending billing line (source_type=''lab'') at zero amount for billing to price. SECURITY DEFINER because the ordering doctor deliberately has no INSERT on billing_line_items. Idempotent via billing_one_line_per_source_idx.';

drop trigger if exists lab_orders_autoinsert_charge on public.lab_orders;
create trigger lab_orders_autoinsert_charge
  after insert on public.lab_orders
  for each row
  execute function public.autoinsert_lab_charge();


-- ---------------------------------------------------------------------------
-- 2. Lab order -> nurse "sample collection due" task
--
-- Named verbatim in Architecture.md §3, which is why 'sample_collection_due' is a
-- first-class task_type rather than a hand-labelled custom task.
--
-- due_at is now() for every priority. That is not an oversight: there is no
-- scheduling engine this phase (see 20260811070200's header), so inventing "routine
-- means due in 4 hours" would be the system asserting a turnaround policy no clinic
-- has told it. The priority goes on the card's LABEL, where a human reads it and
-- triages — which is exactly what Design.md §8 says the board is for.
-- ---------------------------------------------------------------------------
create or replace function public.autoinsert_lab_sample_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tasks (
    tenant_id, visit_id, task_type, title, status, due_at,
    is_auto, source_type, source_id
  )
  values (
    new.tenant_id, new.visit_id, 'sample_collection_due',
    'Collect sample — ' || new.test_name
      || case when new.priority = 'routine' then '' else ' (' || upper(new.priority) || ')' end,
    'pending', new.ordered_at,
    true, 'lab_order', new.id
  )
  on conflict do nothing;   -- tasks_one_auto_per_source_idx

  return null;
end;
$$;

comment on function public.autoinsert_lab_sample_task() is
  'AFTER INSERT on lab_orders: puts a sample_collection_due card on the nurse board, labelled with the test and (when not routine) the priority. Architecture.md §3 names this fan-out explicitly.';

drop trigger if exists lab_orders_autoinsert_task on public.lab_orders;
create trigger lab_orders_autoinsert_task
  after insert on public.lab_orders
  for each row
  execute function public.autoinsert_lab_sample_task();


-- ---------------------------------------------------------------------------
-- 3. Result -> critical-value flag
--
-- A TRIGGER rather than logic inside the RPC, deliberately. The flag must be a
-- property of the row, not of the code path that produced it: a future importer, a
-- service_role backfill from a lab machine's HL7 feed, or a second RPC must all
-- produce a flagged row. Putting it only in record_lab_result() would mean the one
-- safety guarantee in this table depends on nobody ever writing another writer.
--
-- FAIL-LOUD IS THE WHOLE POINT. Three ways this can decline to answer, and none of
-- them may look like "checked and normal":
--   * no thresholds on file      -> 'no_reference'
--   * value is not a number      -> 'unparseable_value'
--   * unit contradicts reference -> 'unit_mismatch'
-- and if the evaluation itself throws, 'evaluation_failed'. All four set the
-- generated requires_manual_review = true. is_critical can only be true when the
-- status is 'evaluated', enforced by a table constraint rather than by trusting
-- this function.
-- ---------------------------------------------------------------------------
create or replace function public.flag_lab_result_critical()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_test text;
  v_eval jsonb;
begin
  select lo.test_name into v_test
  from public.lab_orders lo
  where lo.id = new.lab_order_id;

  begin
    v_eval := public.evaluate_lab_critical(v_test, new.result_value, new.unit);
  exception
    when others then
      -- Deliberately does NOT swallow (rules.md §3.2) and deliberately does not
      -- guess. The row is stored with an explicit "the check broke" status, which
      -- requires_manual_review turns into a visible prompt. Only the SQLSTATE goes
      -- into the note — never the message, which could contain patient data
      -- (rules.md §1.3).
      new.is_critical           := false;
      new.critical_check_status := 'evaluation_failed';
      new.critical_direction    := null;
      new.result_numeric        := null;
      new.critical_low_used     := null;
      new.critical_high_used    := null;
      new.notes := coalesce(new.notes || ' | ', '')
                   || 'Critical-value check failed (SQLSTATE ' || sqlstate || ') — verify manually.';
      return new;
  end;

  new.critical_check_status := v_eval ->> 'status';
  new.is_critical           := coalesce((v_eval ->> 'is_critical')::boolean, false);
  new.critical_direction    := v_eval ->> 'direction';
  new.result_numeric        := nullif(v_eval ->> 'value_numeric', '')::numeric;
  new.critical_low_used     := nullif(v_eval ->> 'critical_low', '')::numeric;
  new.critical_high_used    := nullif(v_eval ->> 'critical_high', '')::numeric;

  return new;
end;
$$;

comment on function public.flag_lab_result_critical() is
  'BEFORE INSERT on lab_results: sets is_critical / critical_check_status / direction / numeric value / threshold snapshot from evaluate_lab_critical(). A trigger rather than RPC logic so any future writer (HL7 importer, backfill) is flagged too. An internal fault yields critical_check_status = ''evaluation_failed'', never a silent non-critical.';

drop trigger if exists lab_results_flag_critical on public.lab_results;
create trigger lab_results_flag_critical
  before insert on public.lab_results
  for each row
  execute function public.flag_lab_result_critical();


-- ---------------------------------------------------------------------------
-- Internal: close the sample-collection card for an order.
--
-- Shared by both paths that imply the sample was in fact collected, so the two
-- cannot drift. Not granted to anyone — it exists only to be called from the two
-- RPCs below.
-- ---------------------------------------------------------------------------
create or replace function public.close_lab_sample_task(
  p_lab_order_id uuid,
  p_tenant_id    uuid,
  p_by           uuid,
  p_outcome      text   -- 'done' | 'cancelled'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  with touched as (
    update public.tasks t
       set status       = p_outcome,
           completed_by = case when p_outcome = 'done' then p_by else null end,
           completed_at = case when p_outcome = 'done' then now() else null end,
           cancellation_reason = case
             when p_outcome = 'cancelled' then 'Lab order cancelled' else null end
     where t.tenant_id   = p_tenant_id
       and t.source_type = 'lab_order'
       and t.source_id   = p_lab_order_id
       and t.task_type   = 'sample_collection_due'
       and t.status      = 'pending'
    returning 1
  )
  select count(*) into v_count from touched;

  return v_count;
end;
$$;

comment on function public.close_lab_sample_task(uuid, uuid, uuid, text) is
  'Internal helper: completes or cancels the pending sample_collection_due task for a lab order. Shared by set_lab_order_status() and record_lab_result() so the two paths cannot drift. Not granted to any client role.';

revoke execute on function public.close_lab_sample_task(uuid, uuid, uuid, text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- set_lab_order_status()
--
-- The only sanctioned writer of lab_orders.status, for the same reason
-- set_visit_status() is for visits: the transitions have side effects.
--
--   pending          -> sample_collected | cancelled
--   sample_collected -> in_progress | completed | cancelled
--   in_progress      -> completed | cancelled
--   completed        -> (terminal)
--   cancelled        -> (terminal)
--
-- Two side effects worth knowing:
--   * 'sample_collected' closes the nurse's collection card. The nurse who
--     collected it does not tick a second thing (Design.md §8: select/tap, not
--     type).
--   * 'cancelled' WITHDRAWS THE PENDING CHARGE. A cancelled test must not appear
--     on a patient's bill. If the charge has already been pulled onto an invoice
--     it is left alone — an issued tax document cannot be silently rewritten
--     (Phase 2's invoice-immutability rule) — and the response says so via
--     `billing_line_invoiced` so billing can raise a credit deliberately.
-- ---------------------------------------------------------------------------
create or replace function public.set_lab_order_status(
  p_lab_order_id uuid,
  p_status       text,
  p_reason       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_tenant    uuid;
  v_new       text := lower(trim(coalesce(p_status, '')));
  v_current   text;
  v_allowed   boolean := false;
  v_tasks     integer := 0;
  v_removed   integer := 0;
  v_invoiced  boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  -- Clinical staff, not billing. NOTE: there is no `lab_tech` role in `profiles`
  -- (the enum is admin/doctor/nurse/billing/patient/pending), although
  -- Architecture.md §3 talks about a lab tech's queue view. In a clinic of the size
  -- this phase targets the nurse does the sample handling and result entry, so that
  -- is who is authorised here. A dedicated role is flagged for Phase 4 — see the
  -- report and Memory.md §6.
  if not public.has_tenant_role(array['admin', 'doctor', 'nurse']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLINICAL_STAFF',
      'message', 'Only nursing, medical or admin staff can update a lab order.');
  end if;

  if v_new not in ('pending', 'sample_collected', 'in_progress', 'completed', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Unknown lab order status.',
      'fields', jsonb_build_array('p_status'));
  end if;

  v_tenant := public.current_tenant_id();

  select lo.status into v_current
  from public.lab_orders lo
  where lo.id = p_lab_order_id and lo.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'LAB_ORDER_NOT_FOUND',
      'message', 'That lab order does not exist at this clinic.');
  end if;

  if v_current = v_new then
    return jsonb_build_object('ok', true, 'lab_order_id', p_lab_order_id,
      'status', v_new, 'changed', false);
  end if;

  v_allowed := (v_current = 'pending'          and v_new in ('sample_collected', 'cancelled'))
            or (v_current = 'sample_collected' and v_new in ('in_progress', 'completed', 'cancelled'))
            or (v_current = 'in_progress'      and v_new in ('completed', 'cancelled'));

  if not v_allowed then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_STATUS_TRANSITION',
      'message', 'That lab order cannot move from its current state to the requested one.',
      'from', v_current,
      'to', v_new
    );
  end if;

  update public.lab_orders
     set status = v_new,
         cancellation_reason = case
           when v_new = 'cancelled' then nullif(trim(coalesce(p_reason, '')), '')
           else cancellation_reason end
   where id = p_lab_order_id and tenant_id = v_tenant;

  if v_new = 'sample_collected' then
    v_tasks := public.close_lab_sample_task(p_lab_order_id, v_tenant, v_uid, 'done');
  end if;

  if v_new = 'cancelled' then
    v_tasks := public.close_lab_sample_task(p_lab_order_id, v_tenant, v_uid, 'cancelled');

    select exists (
      select 1 from public.billing_line_items b
      where b.tenant_id = v_tenant
        and b.source_type = 'lab'
        and b.source_id = p_lab_order_id
        and b.invoice_id is not null
    ) into v_invoiced;

    with dropped as (
      delete from public.billing_line_items b
       where b.tenant_id = v_tenant
         and b.source_type = 'lab'
         and b.source_id = p_lab_order_id
         and b.invoice_id is null
      returning 1
    )
    select count(*) into v_removed from dropped;
  end if;

  return jsonb_build_object(
    'ok', true,
    'lab_order_id', p_lab_order_id,
    'status', v_new,
    'changed', true,
    'tasks_closed', v_tasks,
    'pending_charges_removed', v_removed,
    'billing_line_invoiced', v_invoiced
  );
end;
$$;

comment on function public.set_lab_order_status(uuid, text, text) is
  'Validated lab order lifecycle transitions. sample_collected closes the nurse''s collection card; cancelled also withdraws the pending (uninvoiced) lab charge and reports billing_line_invoiced when the charge is already on an invoice and must be credited deliberately.';


-- ---------------------------------------------------------------------------
-- record_lab_result()
--
-- Records the result, lets the trigger flag it, completes the order, and — the
-- part that matters — RETURNS THE CRITICALITY DECISION TO THE PERSON ENTERING IT.
--
-- rules.md §3.4 and PRD's alerting philosophy both point the same way: a critical
-- value must be impossible to enter without seeing that it is critical. The
-- asynchronous alert (database webhook -> Edge Function, see
-- 20260811071000/supabase/functions/notify-critical-lab-value) is for everyone who
-- is NOT looking at this screen. The envelope below is for the one person who is,
-- and it does not depend on any of that machinery being deployed.
--
-- `requires_acknowledgement` is the same convenience field check_prescription_safety()
-- returns, computed the same way and for the same reason: it is true both for a
-- critical result AND for one that could not be evaluated, because "we could not
-- check" is information the clinician must actively see.
-- ---------------------------------------------------------------------------
create or replace function public.record_lab_result(
  p_lab_order_id    uuid,
  p_result_value    text,
  p_unit            text default null,
  p_reference_range text default null,
  p_notes           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_tenant uuid;
  v_order  record;
  v_value  text := trim(coalesce(p_result_value, ''));
  v_id     uuid;
  v_row    record;
  v_tasks  integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.has_tenant_role(array['admin', 'doctor', 'nurse']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLINICAL_STAFF',
      'message', 'Only nursing, medical or admin staff can record a lab result.');
  end if;

  if v_value = '' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'A result value is required.',
      'fields', jsonb_build_array('p_result_value'));
  end if;

  v_tenant := public.current_tenant_id();

  select lo.id, lo.status, lo.test_name, lo.visit_id, lo.patient_id
    into v_order
  from public.lab_orders lo
  where lo.id = p_lab_order_id and lo.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'LAB_ORDER_NOT_FOUND',
      'message', 'That lab order does not exist at this clinic.');
  end if;

  if v_order.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'LAB_ORDER_CANCELLED',
      'message', 'That lab order was cancelled; a result cannot be recorded against it.');
  end if;

  insert into public.lab_results (
    lab_order_id, tenant_id, result_value, unit, reference_range,
    reported_by, notes
  )
  values (
    p_lab_order_id, v_tenant, v_value,
    nullif(trim(coalesce(p_unit, '')), ''),
    nullif(trim(coalesce(p_reference_range, '')), ''),
    v_uid,
    nullif(trim(coalesce(p_notes, '')), '')
  )
  returning id into v_id;

  -- Read back what the trigger decided, rather than recomputing it here. If these
  -- two ever disagreed, the stored row would be the one that alerts and the
  -- returned envelope would be the one the clinician saw — so there is only one
  -- source.
  select r.is_critical, r.critical_check_status, r.requires_manual_review,
         r.critical_direction, r.result_numeric,
         r.critical_low_used, r.critical_high_used
    into v_row
  from public.lab_results r
  where r.id = v_id;

  -- A result implies the sample was collected, whatever the order's paperwork says.
  v_tasks := public.close_lab_sample_task(p_lab_order_id, v_tenant, v_uid, 'done');

  if v_order.status <> 'completed' then
    update public.lab_orders
       set status = 'completed'
     where id = p_lab_order_id and tenant_id = v_tenant;
  end if;

  return jsonb_build_object(
    'ok', true,
    'lab_result_id', v_id,
    'lab_order_id', p_lab_order_id,
    'test_name', v_order.test_name,
    'visit_id', v_order.visit_id,
    'lab_order_status', 'completed',
    'tasks_closed', v_tasks,

    -- ---- the safety payload ----
    'is_critical', v_row.is_critical,
    'critical_check_status', v_row.critical_check_status,
    'requires_manual_review', v_row.requires_manual_review,
    'critical_direction', v_row.critical_direction,
    'value_numeric', v_row.result_numeric,
    'critical_low', v_row.critical_low_used,
    'critical_high', v_row.critical_high_used,
    -- True for a critical result AND for one that could not be evaluated. Not
    -- coalesced by accident: both inputs are NOT NULL columns, so unlike the Phase
    -- 2 near-miss this cannot ship a NULL in a safety-critical boolean.
    'requires_acknowledgement', (v_row.is_critical or v_row.requires_manual_review),
    'reference_disclaimer',
      'Starter reference set, adult ranges only, not clinically reviewed. Absence of a critical flag is not confirmation that a result is safe.'
  );
end;
$$;

comment on function public.record_lab_result(uuid, text, text, text, text) is
  'Records a result, completes the order, closes the collection task, and returns the criticality decision to the person entering it — so a critical value cannot be saved without being seen, independently of whether the alert Edge Function is deployed. requires_acknowledgement covers both critical and could-not-evaluate.';


revoke execute on function public.set_lab_order_status(uuid, text, text)         from public, anon;
revoke execute on function public.record_lab_result(uuid, text, text, text, text) from public, anon;
grant  execute on function public.set_lab_order_status(uuid, text, text)          to authenticated;
grant  execute on function public.record_lab_result(uuid, text, text, text, text) to authenticated;
