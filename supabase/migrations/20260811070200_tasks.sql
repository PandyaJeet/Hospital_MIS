-- ============================================================================
-- Migration:  tasks
-- Purpose:    The nurse task board. Time-bound work items against an encounter:
--             vitals due, medication due, lab sample collection due, or anything
--             a nurse/doctor types in by hand.
--
-- NO RECURRENCE ENGINE IN THIS PHASE — A DELIBERATE GAP, NOT AN OVERSIGHT
-- "Vitals every 4 hours for an admitted patient" is a real requirement and it is
-- NOT built here. A scheduler needs a recurrence rule per task, a generator that
-- materialises occurrences, a catch-up policy for downtime, and a story for what
-- happens to future occurrences when a patient is discharged — all of which is
-- disproportionate to a phase whose job is to make the board real.
--
-- What ships instead: a flat `due_at` per row, created either by hand or by one
-- of two one-shot triggers (admission -> one initial vitals-due task; lab order
-- -> one sample-collection task). That is enough for a working kanban board and
-- honest about what it is. Recorded as a gap in docs/contracts/nurse-tasks.md and
-- Memory.md rather than silently half-built.
--
-- QUERY SHAPE IS THE POINT (Design.md §8)
-- Design.md is explicit that the nurse surface is "card/kanban style, not a data
-- table ... quick visual triage (what's due now)". Rendering is Prince's problem,
-- but it dictates what this table has to make cheap: "group by status, ordered by
-- due time, within my clinic". Hence the (tenant_id, status, due_at) index. A
-- second index on (visit_id, status) backs the per-patient count the rounds view
-- shows.
--
-- is_auto MIRRORS billing_line_items.is_auto
-- Same question, same answer: did the system generate this, or did a person add
-- it? Auto tasks are what make the board populate itself; manual tasks are the
-- escape hatch for everything not yet modelled. And as with billing, `is_auto` is
-- NOT in the client INSERT grant, so a client cannot forge a task that claims to
-- be system-generated.
--
-- IDEMPOTENCY FOR AUTO TASKS
-- (source_type, source_id) + a partial unique index, lifted directly from
-- billing_line_items. An admission re-run or a re-fired trigger must not produce
-- two identical "vitals due" cards, because a duplicated card on a triage board
-- costs a nurse real time. Manual tasks carry NULL source_id and are
-- unconstrained — a nurse legitimately needs to add "recheck BP" twice.
-- ============================================================================

create table if not exists public.tasks (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants (id) on delete restrict,
  visit_id      uuid        not null,

  -- 'sample_collection_due' is named by Architecture.md §3's worked example
  -- ("Realtime on lab_orders -> nurse's task board shows 'sample collection
  -- due'"), so it is a first-class type rather than a 'custom' task with a
  -- hand-typed label.
  task_type     text        not null,

  -- Card label. Required for a custom task, optional otherwise (the UI derives a
  -- label from task_type for the known kinds). See the constraint below.
  title         text        null,

  status        text        not null default 'pending',
  due_at        timestamptz not null default now(),

  -- NULL is normal and expected: an unclaimed, role-based task ("someone take
  -- bed 4's vitals") is the common case on a shared ward board, and forcing an
  -- assignee at creation would mean the triggers had to guess which nurse is on
  -- shift. Nurses claim tasks by setting this.
  assigned_to   uuid        null,

  completed_by  uuid        null,
  completed_at  timestamptz null,

  -- Why a task was dropped. Operational free-text, nullable.
  cancellation_reason text  null,

  is_auto       boolean     not null default false,

  -- What caused an auto task. 'admission' -> visit id, 'lab_order' -> lab order
  -- id. Keeps the generating triggers idempotent and lets the UI link a card back
  -- to the thing that created it.
  source_type   text        null,
  source_id     uuid        null,

  notes         text        null,

  created_by    uuid        null references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint tasks_type_valid check (
    task_type in ('vitals_due', 'medication_due', 'sample_collection_due', 'custom')
  ),
  constraint tasks_status_valid check (status in ('pending', 'done', 'cancelled')),
  constraint tasks_source_type_valid check (
    source_type is null or source_type in ('admission', 'lab_order', 'prescription')
  ),

  -- A custom task with no label is not an incomplete row, it is a meaningless
  -- one — exactly the reasoning Phase 2 applied to prescription_items.drug_name.
  -- The label IS the task; a nurse who has not described it has not created a
  -- task yet. Every other task_type is self-describing, so the label is optional
  -- there.
  constraint tasks_custom_needs_title check (
    task_type <> 'custom' or nullif(trim(coalesce(title, '')), '') is not null
  ),

  -- 'done' is the only status that may carry a completion timestamp, and it must.
  -- A cancelled task is not a completed one.
  constraint tasks_completion_consistent check (
    (status = 'done' and completed_at is not null)
    or (status <> 'done' and completed_at is null)
  ),

  -- Deliberately one-directional rather than both-or-neither. The Phase 1
  -- invites bug (see Memory.md §6) was caused by a both-or-neither constraint
  -- colliding with a foreign key's own SET NULL action, and the lesson was to
  -- state only the implication that is actually required: naming a completer
  -- requires a completion time, but a completion time does not require a named
  -- completer.
  constraint tasks_completed_by_implies_time check (
    completed_by is null or completed_at is not null
  ),

  -- An auto task must say what generated it; a manual one must not claim a
  -- source. This is what keeps the idempotency index below meaningful.
  constraint tasks_auto_has_source check (
    (is_auto and source_type is not null and source_id is not null)
    or (not is_auto and source_type is null and source_id is null)
  ),

  constraint tasks_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  -- RESTRICT for the same two reasons as vitals.recorded_by: SET NULL cannot work
  -- on a composite FK whose tenant_id is NOT NULL, and a completed task must keep
  -- pointing at whoever completed it.
  constraint tasks_assigned_to_same_tenant
    foreign key (assigned_to, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict,
  constraint tasks_completed_by_same_tenant
    foreign key (completed_by, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict
);

comment on table public.tasks is
  'Nurse task board items. Flat due_at only — NO recurrence/scheduling engine this phase (see migration header). Auto tasks come from one-shot triggers on admission and lab order; is_auto and status are not client-writable.';
comment on column public.tasks.assigned_to is
  'NULL means unclaimed, which is the normal state on a shared ward board. Nurses claim a task by setting this; it is the one lifecycle column clients may write directly.';
comment on column public.tasks.is_auto is
  'True when a trigger created the task. Not in the client INSERT grant, so a hand-made task cannot masquerade as system-generated. Mirrors billing_line_items.is_auto.';
comment on column public.tasks.source_id is
  'The row that generated an auto task (visit id for an admission, lab_order id for a sample collection). Backs the idempotency index so a re-fired trigger cannot duplicate a card.';

-- The kanban query: group by status, soonest first, within my clinic.
create index if not exists tasks_tenant_board_idx on public.tasks (tenant_id, status, due_at);
-- Per-encounter counts for the rounds view, and the per-patient card list.
create index if not exists tasks_visit_status_idx on public.tasks (visit_id, status, due_at);
-- "My tasks" for a nurse who has claimed work.
create index if not exists tasks_assignee_idx on public.tasks (tenant_id, assigned_to, status, due_at)
  where assigned_to is not null;

-- One auto task per generating event. Partial, so manual tasks (NULL source_id)
-- are unconstrained.
create unique index if not exists tasks_one_auto_per_source_idx
  on public.tasks (tenant_id, source_type, source_id, task_type)
  where source_id is not null;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row
  execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- RLS
--
-- READ: admin, doctor, nurse. NOT billing, on the same minimisation reasoning as
-- vitals and clinical_notes — a task card says "vitals due for bed 4" or names a
-- lab test, which is clinical context the billing counter has no use for.
--
-- WRITE: admin, doctor, nurse may create tasks. A doctor asking a nurse to do
-- something is an ordinary instruction, not an escalation, so this is not
-- nurse-only.
--
-- NOT GRANTED, and why each one matters:
--   status, completed_by, completed_at  -> completing a task stamps who and when
--       and must validate the transition, so it goes through complete_task().
--       A direct write could mark a task done with no completer, or resurrect a
--       cancelled one.
--   is_auto, source_type, source_id     -> a client-made task must not be able
--       to claim it was system-generated, and must not be able to squat the
--       idempotency slot of a real auto task (which would suppress a genuine
--       "vitals due" card from ever appearing).
--
-- GRANTED for update: assigned_to (claiming), due_at (rescheduling), title,
-- notes. These are the ordinary board interactions Design.md wants to be a tap.
--
-- NO DELETE. Cancel instead, so the board keeps a record that something was
-- raised and dropped — consistent with visits, which are cancelled not deleted.
-- ---------------------------------------------------------------------------
alter table public.tasks enable row level security;

revoke all on public.tasks from anon, authenticated;

grant select on public.tasks to authenticated;
grant insert (tenant_id, visit_id, task_type, title, due_at, assigned_to, notes, created_by)
  on public.tasks to authenticated;
grant update (title, due_at, assigned_to, notes) on public.tasks to authenticated;

create policy tasks_select_clinical
  on public.tasks
  for select
  to authenticated
  using (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
  );

create policy tasks_insert_clinical
  on public.tasks
  for insert
  to authenticated
  with check (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
  );

-- Any clinical staff member may claim, reschedule or annotate any task in their
-- own clinic. Deliberately not restricted to the creator or the assignee: a ward
-- board is shared work, and "only the nurse who made the card may reschedule it"
-- would break the moment a shift changes.
create policy tasks_update_clinical
  on public.tasks
  for update
  to authenticated
  using (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
  );


-- ---------------------------------------------------------------------------
-- complete_task() / cancel_task() — the only sanctioned writers of tasks.status
--
-- Envelope-returning per the Phase 1/2 convention, because both have a real
-- transition to validate and a side effect to stamp. A task already done must not
-- silently re-complete under a different name and time, and a cancelled task must
-- not come back to life.
--
-- Legal moves:  pending -> done | cancelled ;  done and cancelled are terminal.
-- ---------------------------------------------------------------------------
create or replace function public.complete_task(
  p_task_id uuid,
  p_notes   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_tenant uuid;
  v_task   record;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.has_tenant_role(array['admin', 'doctor', 'nurse']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLINICAL_STAFF',
      'message', 'Only nursing, medical or admin staff can complete a task.');
  end if;

  v_tenant := public.current_tenant_id();

  select t.id, t.status, t.task_type into v_task
  from public.tasks t
  where t.id = p_task_id and t.tenant_id = v_tenant
  for update;

  if not found then
    -- Same answer whether the id is unknown or belongs to another clinic, so this
    -- cannot be used to probe for other tenants' rows.
    return jsonb_build_object('ok', false, 'code', 'TASK_NOT_FOUND',
      'message', 'That task does not exist at this clinic.');
  end if;

  if v_task.status = 'done' then
    return jsonb_build_object('ok', false, 'code', 'TASK_ALREADY_DONE',
      'message', 'That task is already marked done.');
  end if;

  if v_task.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'TASK_CANCELLED',
      'message', 'That task was cancelled and cannot be completed.');
  end if;

  update public.tasks
     set status       = 'done',
         completed_by = v_uid,
         completed_at = now(),
         notes        = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes)
   where id = p_task_id and tenant_id = v_tenant;

  return jsonb_build_object('ok', true, 'task_id', p_task_id,
    'status', 'done', 'task_type', v_task.task_type);
end;
$$;

comment on function public.complete_task(uuid, text) is
  'Marks a task done, stamping completed_by/completed_at server-side. The only sanctioned writer of tasks.status alongside cancel_task(). Rejects re-completing a done task and completing a cancelled one.';


create or replace function public.cancel_task(
  p_task_id uuid,
  p_reason  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_tenant uuid;
  v_task   record;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.has_tenant_role(array['admin', 'doctor', 'nurse']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLINICAL_STAFF',
      'message', 'Only nursing, medical or admin staff can cancel a task.');
  end if;

  v_tenant := public.current_tenant_id();

  select t.id, t.status into v_task
  from public.tasks t
  where t.id = p_task_id and t.tenant_id = v_tenant
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'TASK_NOT_FOUND',
      'message', 'That task does not exist at this clinic.');
  end if;

  if v_task.status = 'done' then
    return jsonb_build_object('ok', false, 'code', 'TASK_ALREADY_DONE',
      'message', 'That task is already done and cannot be cancelled.');
  end if;

  if v_task.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'task_id', p_task_id,
      'status', 'cancelled', 'changed', false);
  end if;

  update public.tasks
     set status = 'cancelled',
         cancellation_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_task_id and tenant_id = v_tenant;

  return jsonb_build_object('ok', true, 'task_id', p_task_id,
    'status', 'cancelled', 'changed', true);
end;
$$;

comment on function public.cancel_task(uuid, text) is
  'Cancels a pending task. Cancelling an already-cancelled task is a no-op success (changed:false); a completed task cannot be cancelled.';


revoke execute on function public.complete_task(uuid, text) from public, anon;
revoke execute on function public.cancel_task(uuid, text)   from public, anon;
grant  execute on function public.complete_task(uuid, text) to authenticated;
grant  execute on function public.cancel_task(uuid, text)   to authenticated;
