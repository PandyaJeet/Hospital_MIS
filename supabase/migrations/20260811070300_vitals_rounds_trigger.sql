-- ============================================================================
-- Migration:  vitals_rounds_trigger
--
-- This migration is phases.md's Phase 3 line item:
--   "DB trigger: nurse vitals entry -> auto-updates doctor's rounds data
--    (no separate fetch step)."
--
-- ---------------------------------------------------------------------------
-- WHAT "AUTO-UPDATES THE ROUNDS DATA" ACTUALLY HAS TO MEAN
-- ---------------------------------------------------------------------------
-- Read literally, the line could mean "copy the vitals into a rounds table".
-- That is the one design Architecture.md §3 rules out: every persona's view is
-- "just a filtered query or realtime subscription on the same underlying
-- tables", not a second copy of the data. A duplicate can drift, and a drifting
-- copy of a vital sign is a clinical hazard.
--
-- So the rounds view reads `vitals` (through the rounds_overview view added in
-- 20260811071000) and `vitals` stays the sole source of truth. What the trigger
-- maintains is ONE derived, non-clinical field on `visits`:
--
--     visits.last_vitals_at  timestamptz
--
-- It earns its place for two distinct reasons, and the second is the one that
-- makes the phases.md requirement literally true:
--
--   1. FRESHNESS AT A GLANCE, WITHOUT A PER-PATIENT SUBQUERY. A doctor scanning
--      twenty inpatients wants "who has fresh vitals, who is overdue" as a sort
--      and filter over the inpatient list. As a stored column that is one index
--      scan over `visits`; as a derived max(recorded_at) it is a correlated
--      aggregate per row. Filtering and ordering are exactly what a denormalised
--      value is good for.
--
--   2. IT IS WHAT MAKES A REALTIME SUBSCRIPTION FIRE. "No separate fetch step"
--      is only true if the doctor's open rounds list learns about a new
--      observation on its own. The rounds list is a subscription on `visits`
--      (that is where the patient, bed and admission state live). Postgres
--      logical replication only emits a change for the row that changed — a new
--      `vitals` row does not touch `visits`, so a `visits` subscriber would never
--      hear about it. The trigger writing `last_vitals_at` is precisely the thing
--      that turns a nurse's entry into a push on the doctor's screen.
--
-- ---------------------------------------------------------------------------
-- WHY THE VITALS *VALUES* ARE NOT CACHED HERE
-- ---------------------------------------------------------------------------
-- The obvious companion field would be `visits.last_vitals_summary jsonb` with
-- the actual numbers in it. It is deliberately NOT added, and the reason is a
-- security one that is easy to miss:
--
--   `visits` is readable by the BILLING role (billing needs the queue and the
--   encounter to raise an invoice). `vitals` deliberately is NOT — 20260811070100
--   restricts it to admin/doctor/nurse on the same data-minimisation grounds
--   Phase 2 used to keep clinical_notes away from the front desk.
--
--   Postgres has no column-level row security. Caching blood pressures onto
--   `visits` would therefore hand every vital sign to the billing counter
--   through the back door and silently undo the policy next door. Column GRANTs
--   cannot save it either: billing and doctor are the same database role
--   (`authenticated`), so there is no grantee to distinguish.
--
-- The freshness timestamp is the only part of the picture that is BOTH
-- non-clinical (a bare "when", no measurement) and expensive to derive per row.
-- So that is the only part cached. The numbers come from `vitals` through
-- rounds_overview, where the vitals policy applies normally and a billing session
-- simply sees nulls.
--
-- This is a considered adjustment to the prompt's suggested shape, which floated
-- a `last_vitals_summary jsonb`. Documented in docs/contracts/vitals-and-rounds.md.
--
-- ---------------------------------------------------------------------------
-- WHY IT RECOMPUTES INSTEAD OF COPYING NEW.recorded_at
-- ---------------------------------------------------------------------------
-- The cache is derived from the table, not from the triggering row. Copying
-- NEW.recorded_at would be wrong in two ordinary situations: a nurse
-- back-entering an OLDER observation from paper would move `last_vitals_at`
-- backwards, and correcting an old row's typo would clobber the newest reading's
-- timestamp. Recomputing max(recorded_at) for the visit is a single index lookup
-- on vitals_visit_recorded_idx and cannot be wrong.
--
-- SECURITY DEFINER, for the same reason the Phase 2 billing triggers are: the
-- person who causes the update is deliberately not allowed to perform it. A nurse
-- has no grant on visits.last_vitals_at — it must never be client-writable, or
-- the freshness signal a doctor relies on could be forged. Every value written is
-- derived server-side from the vitals row (rules.md §1.2).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- visits: the derived freshness column
-- ---------------------------------------------------------------------------
alter table public.visits
  add column if not exists last_vitals_at timestamptz null;

comment on column public.visits.last_vitals_at is
  'Server-derived cache of max(vitals.recorded_at) for this visit. Maintained only by refresh_visit_vitals_freshness(); never client-writable. Two jobs: cheap "fresh vs overdue" sort on the rounds list, and making a nurse''s vitals entry emit a Realtime change on visits so an open rounds view updates with no separate fetch. The vitals rows remain the source of truth — this is a cache, not a copy, and holds no measurement values (see migration header).';

-- The rounds list's default ordering: within a clinic, who is most overdue.
-- NULLS FIRST matters — a patient with no vitals at all is the most overdue
-- patient on the ward, not the least.
create index if not exists visits_tenant_vitals_freshness_idx
  on public.visits (tenant_id, last_vitals_at asc nulls first);

-- Explicitly NOT added to any client UPDATE grant. The Phase 2 grant on this
-- table is `grant update (doctor_id, visit_type)`, and this column stays outside
-- it, so a client attempting to write it gets 42501 rather than silently
-- succeeding.


-- ---------------------------------------------------------------------------
-- refresh_visit_vitals_freshness()
-- ---------------------------------------------------------------------------
create or replace function public.refresh_visit_vitals_freshness()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_visit uuid := coalesce(new.visit_id, old.visit_id);
  v_last  timestamptz;
begin
  if v_visit is null then
    return null;
  end if;

  -- Recomputed from the table, never copied from NEW — see the header.
  select max(v.recorded_at) into v_last
  from public.vitals v
  where v.visit_id = v_visit;

  -- `is distinct from` rather than `<>`: NULL-safe, and it means an UPDATE that
  -- did not change the newest timestamp writes nothing at all. That keeps the
  -- Realtime stream on `visits` meaningful — a change event there really does
  -- mean the freshness moved — and avoids a pointless updated_at bump.
  update public.visits vs
     set last_vitals_at = v_last
   where vs.id = v_visit
     and vs.last_vitals_at is distinct from v_last;

  return null;
end;
$$;

comment on function public.refresh_visit_vitals_freshness() is
  'AFTER INSERT/UPDATE/DELETE on vitals: recomputes visits.last_vitals_at from the vitals table. SECURITY DEFINER because the recording nurse deliberately has no grant on that column. Writes only when the value actually moves, so a Realtime change on visits genuinely signals new observations.';

drop trigger if exists vitals_refresh_visit_freshness on public.vitals;
create trigger vitals_refresh_visit_freshness
  after insert or update or delete on public.vitals
  for each row
  execute function public.refresh_visit_vitals_freshness();


-- ---------------------------------------------------------------------------
-- autocomplete_vitals_due_task()
--
-- "One event, many views" applied to the task board: recording the observation IS
-- doing the task, so the nurse should not have to tick a second card afterwards.
-- Design.md §8 asks for "minimal text entry, most nurse interactions should be
-- select/tap"; making them tap twice for one action works against that, and a
-- board full of stale "vitals due" cards that were in fact done is worse than no
-- board.
--
-- Scope is deliberately narrow:
--   * INSERT only. Correcting an existing row is not a new observation.
--   * The SINGLE oldest pending vitals_due task for that visit. Not all of them —
--     if a ward genuinely has two outstanding vitals rounds queued, one set of
--     observations satisfies one of them.
--   * Whatever the task's origin. A vitals_due card a charge nurse added by hand
--     is satisfied by the same act as one a trigger created.
--   * completed_by is the recording nurse, because that is who actually did it.
--
-- SECURITY DEFINER: tasks.status/completed_by/completed_at are not client-
-- writable by design (see 20260811070200), so a trigger running as the nurse
-- would fail. Same narrow, stated exception as the billing triggers.
-- ---------------------------------------------------------------------------
create or replace function public.autocomplete_vitals_due_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_id uuid;
begin
  select t.id into v_task_id
  from public.tasks t
  where t.visit_id  = new.visit_id
    and t.tenant_id = new.tenant_id
    and t.task_type = 'vitals_due'
    and t.status    = 'pending'
  order by t.due_at asc, t.created_at asc
  limit 1
  for update skip locked;   -- two nurses recording at once must not fight over it

  if v_task_id is null then
    return null;
  end if;

  update public.tasks
     set status       = 'done',
         completed_by = new.recorded_by,
         completed_at = new.recorded_at
   where id = v_task_id;

  return null;
end;
$$;

comment on function public.autocomplete_vitals_due_task() is
  'AFTER INSERT on vitals: closes the single oldest pending vitals_due task for that visit, attributed to the recording nurse. Recording the observation IS doing the task, so the nurse does not tick a second card. SECURITY DEFINER because tasks.status is not client-writable.';

drop trigger if exists vitals_autocomplete_task on public.vitals;
create trigger vitals_autocomplete_task
  after insert on public.vitals
  for each row
  execute function public.autocomplete_vitals_due_task();
