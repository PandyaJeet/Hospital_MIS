-- ============================================================================
-- Migration:  realtime_publication
-- Purpose:    Put this phase's live-updating tables into the `supabase_realtime`
--             publication, plus `visits`, which Phase 2 deliberately left out.
--
-- WHY THIS LANDS NOW AND NOT IN PHASE 2
-- Memory.md §6 recorded `visits` as intentionally deferred: "the policies support
-- it and Realtime respects RLS, but the queue cannot live-update until a one-line
-- migration adds it. Deliberately deferred until Prince is ready to wire the
-- subscription." Phase 3 is the reason it was waiting — rules.md §6.1 names this
-- module specifically: "use Supabase Realtime subscriptions rather than polling
-- wherever live updates matter (queue status, task board, lab results)". A task
-- board that has to be refreshed by hand is not a task board, and a critical lab
-- value that only appears on a reload is not an alert.
--
-- WHAT EACH TABLE IS FOR
--   visits       — the OPD queue (carried forward from Phase 2) AND the IPD rounds
--                  list. Also the carrier for vitals freshness: the trigger in
--                  20260811070300 writes visits.last_vitals_at precisely so that a
--                  nurse's observation produces a change event on THIS table, which
--                  is what an open rounds view is subscribed to.
--   vitals       — the trend graph appending a point live.
--   tasks        — the kanban board: cards appearing, being claimed, being closed.
--   lab_orders   — the lab tech's queue and the nurse's collection card
--                  (Architecture.md §3's two subscriptions on this table).
--   lab_results  — the critical-value alert. This one is the reason the mechanism
--                  has to be a push: a critical potassium must reach a clinician
--                  without depending on anyone having the right screen open and
--                  refreshing it.
--
-- SECURITY: adding a table to the publication does NOT widen access. Supabase
-- Realtime evaluates RLS per subscriber, so a subscription only ever delivers rows
-- the subscriber could already have selected — which is why the vitals/tasks/
-- lab_results minimisation decisions (billing excluded) survive this migration
-- unchanged. `anon` holds no SELECT on any of these tables and therefore receives
-- nothing.
--
-- REPLICA IDENTITY is left at the default (primary key). That is enough for INSERT
-- and for the new row on UPDATE, which is everything these five surfaces need.
-- `replica identity full` would additionally deliver the OLD row on update/delete
-- at the cost of writing every column of every changed row to the WAL — a real
-- throughput cost on a table like `visits` that now gets touched on every vitals
-- entry. If Prince ever needs old_record (e.g. to animate a status transition), it
-- is a one-line change per table, and it should be a deliberate one.
--
-- IDEMPOTENT AND ENVIRONMENT-TOLERANT. Two shapes have to be handled:
--   * The hosted project already HAS `supabase_realtime` (Supabase creates it), and
--     re-adding a table that is already a member raises 42710. So membership is
--     checked first.
--   * The local PGlite harness has no such publication, because it is Supabase
--     platform scaffolding rather than schema. It is created there so this
--     migration is exercised locally instead of skipped — the point of the harness
--     is that every migration actually runs.
-- ============================================================================

do $$
declare
  v_all_tables boolean;
  v_table      text;
  v_tables     text[] := array['visits', 'vitals', 'tasks', 'lab_orders', 'lab_results'];
begin
  -- ---- 1. make sure the publication exists --------------------------------
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Utility statements go through EXECUTE in plpgsql. No FOR ALL TABLES: this
    -- publication must be an explicit allow-list, so a future table is not
    -- broadcast by accident before anyone has thought about whether it should be.
    execute 'create publication supabase_realtime';
    raise notice 'Created publication supabase_realtime (absent in this environment).';
  end if;

  -- ---- 2. a FOR ALL TABLES publication cannot take individual adds --------
  select p.puballtables into v_all_tables
  from pg_publication p
  where p.pubname = 'supabase_realtime';

  if coalesce(v_all_tables, false) then
    raise notice 'supabase_realtime is FOR ALL TABLES; the Phase 3 tables are already published.';
    return;
  end if;

  -- ---- 3. add each table if it is not already a member --------------------
  foreach v_table in array v_tables loop
    if not exists (
      select 1 from pg_publication_tables pt
      where pt.pubname = 'supabase_realtime'
        and pt.schemaname = 'public'
        and pt.tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
      raise notice 'Added public.% to supabase_realtime.', v_table;
    else
      raise notice 'public.% is already in supabase_realtime.', v_table;
    end if;
  end loop;
end
$$;
