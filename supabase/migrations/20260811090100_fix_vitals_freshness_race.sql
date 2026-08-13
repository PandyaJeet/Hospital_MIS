-- ============================================================================
-- Migration:  fix_vitals_freshness_race
-- Phase:      5 (Hardening) — a correctness fix for a lost-update race.
--
-- ###########################################################################
-- #  TWO CHANGES, AND THE SECOND ONE IS NOT OPTIONAL.                        #
-- #                                                                          #
-- #  1. refresh_visit_vitals_freshness() locks the visits row BEFORE it       #
-- #     recomputes max(recorded_at), closing a read-then-write race.          #
-- #                                                                          #
-- #  2. autocomplete_vitals_due_task() — the SIBLING trigger on the same      #
-- #     table — takes that same lock first too. Without this, change 1        #
-- #     introduces a DEADLOCK against discharge_patient(). Reasoning below.   #
-- ###########################################################################
--
-- ---------------------------------------------------------------------------
-- THE RACE
-- ---------------------------------------------------------------------------
-- `visits.last_vitals_at` is a derived cache of max(vitals.recorded_at) for a visit.
-- 20260811070300 is right that it must be RECOMPUTED from the table rather than copied
-- from NEW — copying breaks when a nurse back-enters an older paper reading, or
-- corrects a typo on an old row. That part of the design is unchanged here.
--
-- What was wrong is that the recompute and the write were two separate statements with
-- no lock held between them:
--
--     select max(v.recorded_at) into v_last from public.vitals v where v.visit_id = ...;
--     -- <-- nothing held here
--     update public.visits set last_vitals_at = v_last where id = ... ;
--
-- Two nurses charting the same patient at the same moment:
--
--   1. Both triggers fire in separate concurrent transactions.
--   2. Each `select max(...)` runs on its own transaction's snapshot: each sees its own
--      uncommitted insert but not the other's. One computes NEWER, one computes OLDER.
--   3. Both UPDATEs target the same visits row. One takes the row lock and commits.
--   4. The other was blocked on that lock. When released it does NOT recompute — it
--      applies the v_last it captured back at step 2.
--
-- **The `is distinct from` guard does not save this, and it is worth being precise
-- about why, because it looks like it should.** Under READ COMMITTED, when a blocked
-- UPDATE is released it re-evaluates its WHERE clause against the newly committed row
-- version (EvalPlanQual). The guard asks "is the stored value DIFFERENT from mine",
-- not "is mine NEWER". So the loser re-checks `NEWER is distinct from OLDER`, finds
-- that true, and overwrites the correct value with its stale one. The SET expression
-- is a plpgsql variable, so re-evaluation does not refresh it either.
--
-- ---------------------------------------------------------------------------
-- BLAST RADIUS — deliberately stated, because it is narrow
-- ---------------------------------------------------------------------------
-- `last_vitals_at` holds no measurement (see 20260811070300's header on why the values
-- are deliberately NOT cached here). It is a non-clinical freshness signal used to sort
-- and highlight "who is overdue" on the rounds list, and to make a vitals entry emit a
-- Realtime change on `visits`.
--
-- The failure mode is that the cache LAGS the true latest reading. It cannot be advanced
-- past a value that was never recorded. So the harm is a patient appearing *less*
-- overdue than they are on a ward board — a degraded triage signal, not corrupted
-- clinical data. `rounds_overview` reads `vitals` directly and is unaffected.
--
-- Worth fixing anyway: "who is overdue for observations" is exactly the kind of signal
-- a busy ward delegates to the screen.
--
-- ---------------------------------------------------------------------------
-- WHY `for no key update` AND NOT `for update`
-- ---------------------------------------------------------------------------
-- This is the important detail, and `for update` would have been a regression.
--
-- Every child table here parents onto `visits` with a composite FK — `vitals`,
-- `tasks`, `clinical_notes`, `lab_orders`, `medication_administrations`,
-- `billing_line_items`. Inserting any of those makes Postgres take a **FOR KEY SHARE**
-- lock on the parent visit row to hold the key stable.
--
-- In Postgres's row-lock conflict matrix, FOR KEY SHARE conflicts with FOR UPDATE but
-- NOT with FOR NO KEY UPDATE. And a plain `UPDATE` that touches no key or unique-index
-- column — which is what the existing statement is, since `last_vitals_at` appears only
-- in the non-unique visits_tenant_vitals_freshness_idx — already takes only
-- FOR NO KEY UPDATE.
--
-- So `select ... for update` would have ESCALATED the lock strength and made a single
-- vitals insert block every concurrent insert of a task, lab order, clinical note,
-- medication administration or second vitals row for the same visit. That would work
-- directly against the intent recorded one function below, where
-- `for update skip locked` exists precisely so "two nurses recording at once must not
-- fight over it".
--
-- `for no key update` gives the mutual exclusion this needs — it self-conflicts, so two
-- freshness triggers serialise against each other — while leaving FK child inserts free.
--
-- ---------------------------------------------------------------------------
-- THE DEADLOCK THIS FIX WOULD OTHERWISE HAVE CREATED
-- ---------------------------------------------------------------------------
-- A vitals INSERT fires two AFTER ROW triggers, and Postgres fires them in trigger-NAME
-- order: `vitals_autocomplete_task` before `vitals_refresh_visit_freshness` (a < r).
--
--   * autocomplete_vitals_due_task() locks a `tasks` row (for update skip locked).
--   * refresh_visit_vitals_freshness() then wants the `visits` row.
--
--   => a vitals insert acquires   tasks -> visits
--
-- Meanwhile discharge_patient() (20260811070500) does:
--
--   * `select ... from visits ... for update`
--   * then `update public.tasks set status='cancelled' where visit_id = ...`
--
--   => discharge acquires         visits -> tasks
--
-- Opposite orders on the same two rows is a textbook deadlock (40P01). Note that
-- SKIP LOCKED does not help: it only lets a trigger skip rows already locked when its
-- SELECT runs; once it is the holder, a later transaction blocks on it normally.
--
-- This inversion is arguably live already — today's unguarded `update public.visits`
-- takes the same row lock whenever the value moves, which is the ordinary case. Adding
-- an explicit lock would have made it unconditional and therefore reliably reachable.
--
-- THE FIX IS TO MAKE THE ORDER CONSISTENT, which is the standard remedy and the
-- convention this schema already states: 20260811070500 documents "Locks are taken
-- visit-then-bed in every function here, so two concurrent admissions cannot deadlock
-- against each other." Extending that to "always take `visits` first" makes the whole
-- schema agree.
--
-- Implemented by locking the visits row at the TOP OF BOTH vitals triggers. Doing it in
-- both is what makes it order-INDEPENDENT: whichever fires first takes `visits`, and the
-- second finds the lock already held by its own transaction (a transaction never
-- conflicts with itself), so the acquisition order is `visits -> tasks` either way. That
-- is deliberately more robust than relying on trigger names, which a future rename would
-- silently break.
--
-- After this migration every path that touches both tables agrees:
--   vitals insert          visits -> tasks
--   discharge_patient      visits -> tasks
--   admit_patient_to_bed   visits -> beds -> tasks
--   set_visit_status       visits -> billing_line_items
--   complete/cancel_task   tasks only (never wants visits, so it cannot close a cycle)
--
-- ---------------------------------------------------------------------------
-- HONESTY NOTE ON HOW THIS WAS FOUND
-- ---------------------------------------------------------------------------
-- This is a fix by inspection, not a fix for an observed failure. The race was reported
-- from one run of the Phase 5 concurrency suite, but it did NOT reproduce here in 16
-- attempts across three strategies (2 concurrent writers, 8 concurrent writers with
-- descending timestamps, and 6 writers released together from behind a deliberate
-- `visits` row-lock barrier). On this project at this latency the per-request
-- transactions appear to complete faster than the gap between requests, so they
-- serialise naturally and the window never opens.
--
-- The code is still wrong: a read-then-write pair with no lock is a lost update
-- whenever the window does open, and "it does not open today" is a property of network
-- timing rather than of the schema. Fixed on those grounds, with the severity claim
-- bounded accordingly. Section 5b of concurrency.remote.test.ts keeps the 8-writer
-- probe as a permanent regression guard.
--
-- Per rules.md §5.6 the applied migration 20260811070300 is NOT edited; both functions
-- are redefined here with CREATE OR REPLACE. No schema change, no policy change, no
-- grant change — only the bodies of two trigger functions.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. refresh_visit_vitals_freshness() — lock, then recompute.
--
-- Byte-identical to 20260811070300 apart from the added lock and its comment.
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

  -- ⚠️ THE FIX. Serialise the read-modify-write on this visit's freshness cache.
  --
  -- Taken BEFORE the recompute below, which is the whole point: whichever trigger
  -- execution arrives here second waits until the first has COMMITTED, so its
  -- recompute is guaranteed to see the first one's vitals row. Previously both
  -- recomputed on their own snapshots and the last writer applied a value it had
  -- captured before the other became visible.
  --
  -- FOR NO KEY UPDATE, not FOR UPDATE: last_vitals_at is not a key or unique-index
  -- column, and FOR UPDATE would conflict with the FOR KEY SHARE locks that every FK
  -- child insert (vitals, tasks, lab_orders, clinical_notes, medication_administrations,
  -- billing_line_items) takes on this same row. See the header.
  --
  -- If the visit row is gone (an AFTER DELETE firing during a cascade) this simply
  -- locks nothing and the UPDATE below matches nothing — harmless.
  perform 1 from public.visits where id = v_visit for no key update;

  -- Recomputed from the table, never copied from NEW — see 20260811070300's header.
  -- Now guaranteed to run under the lock, so it observes every committed insert,
  -- update and delete for this visit, including one from a trigger execution that
  -- just released this lock.
  select max(v.recorded_at) into v_last
  from public.vitals v
  where v.visit_id = v_visit;

  -- `is distinct from` rather than `<>`: NULL-safe, and it means an UPDATE that
  -- did not change the newest timestamp writes nothing at all. That keeps the
  -- Realtime stream on `visits` meaningful — a change event there really does
  -- mean the freshness moved — and avoids a pointless updated_at bump.
  --
  -- NOTE this guard was never the thing protecting correctness under concurrency; it
  -- is a write-amplification guard. The lock above is what makes it correct.
  update public.visits vs
     set last_vitals_at = v_last
   where vs.id = v_visit
     and vs.last_vitals_at is distinct from v_last;

  return null;
end;
$$;

comment on function public.refresh_visit_vitals_freshness() is
  'AFTER INSERT/UPDATE/DELETE on vitals: recomputes visits.last_vitals_at from the vitals table. Takes FOR NO KEY UPDATE on the visit row BEFORE recomputing (added 20260811090100) so concurrent nurses cannot lose the newer timestamp; FOR NO KEY UPDATE specifically, so FK child inserts taking FOR KEY SHARE are not blocked. SECURITY DEFINER because the recording nurse deliberately has no grant on that column.';


-- ---------------------------------------------------------------------------
-- 2. autocomplete_vitals_due_task() — same lock, first, for lock ORDER only.
--
-- The body is otherwise unchanged from 20260811070300. This function does not need
-- the visits row for its own work; it takes the lock so that a vitals insert acquires
-- `visits` before `tasks`, matching discharge_patient() and admit_patient_to_bed()
-- and removing the deadlock cycle described in the header.
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
  -- ⚠️ LOCK ORDER, not a data dependency. Nothing below reads `visits`.
  --
  -- This trigger fires BEFORE vitals_refresh_visit_freshness (Postgres orders AFTER
  -- triggers by name, and 'vitals_autocomplete_task' < 'vitals_refresh_visit_freshness'),
  -- and it locks a `tasks` row. Without this line a vitals insert would acquire
  -- tasks-then-visits while discharge_patient() acquires visits-then-tasks — opposite
  -- orders on the same two rows, i.e. a deadlock.
  --
  -- Taking it here rather than renaming the triggers makes the ordering hold whichever
  -- trigger fires first, so a future rename cannot silently reintroduce the cycle. The
  -- sibling trigger re-requesting the same lock in the same transaction is free.
  perform 1 from public.visits where id = new.visit_id for no key update;

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
  'AFTER INSERT on vitals: closes the single oldest pending vitals_due task for that visit, attributed to the recording nurse. Takes FOR NO KEY UPDATE on the visit row first (added 20260811090100) purely to fix lock ORDER — a vitals insert must acquire visits before tasks, because discharge_patient() does, and the opposite order deadlocks. SECURITY DEFINER because tasks.status is not client-writable.';
