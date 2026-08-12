-- ============================================================================
-- CATALOGUE VERIFICATION against the HOSTED project.
--
--   npm run verify:catalog
--
-- WHY THIS EXISTS ALONGSIDE THE REMOTE TEST SUITES
-- The remote suites in this directory verify BEHAVIOUR through real GoTrue
-- sessions and real PostgREST — what a user can and cannot do. A handful of this
-- project's guarantees are not behavioural, though: they live in the Postgres
-- catalogue and are invisible to supabase-js entirely.
--
--   * Realtime publication membership. A table absent from `supabase_realtime`
--     produces no error and no missing data — a subscription simply never fires.
--     That is a silent failure, and Phase 3's whole premise (live task board, live
--     rounds view, pushed critical-value alerts) rests on it.
--   * Whether a REVOKE actually landed. `close_lab_sample_task()` is an internal
--     helper whose EXECUTE is revoked from every client role. If that revoke were
--     lost in a push, nothing would break — a client would simply gain the ability
--     to close tasks it should not.
--   * Whether column-level GRANTs survived. These are what withhold system-derived
--     columns (`visits.last_vitals_at`, `beds.status`, `tasks.is_auto`,
--     `lab_results.is_critical`) from clients. The behavioural suites do assert
--     42501 on each, but reading the privilege directly is the primary source and
--     catches a partially-applied grant the behaviour tests might mask.
--   * That RLS is actually ENABLED. `alter table ... enable row level security` is
--     one line per table and a table with policies but RLS off is wide open while
--     looking correct in every policy listing.
--
-- Every check is expressed so that PASS means the hosted project matches what the
-- migrations intended. Read-only: nothing here writes.
-- ============================================================================

with checks as (

  -- ---- 1. Realtime publication (Phase 3 DoD) ------------------------------
  select 1 as grp,
         'realtime: public.' || t || ' is in supabase_realtime' as check_name,
         case when exists (
           select 1 from pg_publication_tables pt
           where pt.pubname = 'supabase_realtime'
             and pt.schemaname = 'public'
             and pt.tablename = t
         ) then 'PASS' else 'FAIL' end as status
  from unnest(array['visits', 'vitals', 'tasks', 'lab_orders', 'lab_results']) as t

  union all

  -- ---- 2. RLS enabled on every Phase 3 table ------------------------------
  select 2,
         'rls enabled: public.' || t,
         case when coalesce((
           select c.relrowsecurity from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = t
         ), false) then 'PASS' else 'FAIL' end
  from unnest(array['vitals', 'tasks', 'beds', 'medication_administrations',
                    'lab_orders', 'lab_results', 'lab_critical_ranges']) as t

  union all

  -- ---- 3. Views must be security_invoker ----------------------------------
  -- A view without it executes as its owner (postgres, not subject to RLS), which
  -- would turn both of these into cross-tenant leaks that look like conveniences.
  select 3,
         'security_invoker: public.' || t,
         case when exists (
           select 1 from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = t
             and c.reloptions @> array['security_invoker=true']
         ) then 'PASS' else 'FAIL' end
  from unnest(array['rounds_overview', 'critical_lab_alerts']) as t

  union all

  -- ---- 4. The internal helper is not callable by clients ------------------
  select 4,
         'no client EXECUTE: close_lab_sample_task()',
         case when not has_function_privilege(
           'authenticated',
           'public.close_lab_sample_task(uuid,uuid,uuid,text)',
           'EXECUTE'
         ) then 'PASS' else 'FAIL' end

  union all

  select 4,
         'no anon EXECUTE: ' || f,
         case when not has_function_privilege('anon', f, 'EXECUTE')
              then 'PASS' else 'FAIL' end
  from unnest(array[
    'public.admit_patient_to_bed(uuid,uuid)',
    'public.discharge_patient(uuid,text)',
    'public.set_bed_status(uuid,text)',
    'public.complete_task(uuid,text)',
    'public.cancel_task(uuid,text)',
    'public.record_medication_administration(uuid,text,text,text,boolean)',
    'public.record_lab_result(uuid,text,text,text,text)',
    'public.set_lab_order_status(uuid,text,text)',
    'public.evaluate_lab_critical(text,text,text)',
    'public.acknowledge_critical_result(uuid,text)',
    'public.get_critical_lab_alert_payload(uuid)',
    'public.tenant_has_tier(integer)',
    'public.current_tenant_tier()'
  ]) as f

  union all

  -- ---- 5. System-derived columns are withheld from clients ----------------
  -- Each of these is the difference between a value the server derives and a value
  -- a client could forge. `last_vitals_at` is the freshness signal a doctor trusts;
  -- `is_critical` is a safety flag; `is_auto` is what distinguishes a
  -- system-generated task from a hand-made one.
  select 5,
         'no client UPDATE: ' || tbl || '.' || col,
         case when not has_column_privilege('authenticated', 'public.' || tbl, col, 'UPDATE')
              then 'PASS' else 'FAIL' end
  from (values
    ('visits', 'last_vitals_at'),
    ('visits', 'care_setting'),
    ('visits', 'admitted_at'),
    ('visits', 'discharged_at'),
    ('visits', 'bed_id'),
    ('visits', 'status'),
    ('beds', 'status'),
    ('beds', 'current_visit_id'),
    ('tasks', 'status'),
    ('tasks', 'is_auto'),
    ('tasks', 'completed_by'),
    ('tasks', 'completed_at'),
    ('tasks', 'source_type'),
    ('tasks', 'source_id'),
    ('lab_orders', 'status'),
    ('lab_results', 'is_critical'),
    ('lab_results', 'critical_check_status'),
    ('lab_results', 'acknowledged_at'),
    ('lab_results', 'acknowledged_by'),
    ('vitals', 'visit_id'),
    ('vitals', 'recorded_by'),
    ('tenants', 'tier')
  ) as t(tbl, col)

  union all

  -- ---- 6. Tables with no client write path at all -------------------------
  -- medication_administrations and lab_results are RPC-only on the way in: the
  -- right-patient check and the critical-value flagging must not be bypassable.
  select 6,
         'no client ' || priv || ': ' || tbl,
         case when not has_table_privilege('authenticated', 'public.' || tbl, priv)
              then 'PASS' else 'FAIL' end
  from (values
    ('medication_administrations', 'INSERT'),
    ('medication_administrations', 'UPDATE'),
    ('medication_administrations', 'DELETE'),
    ('lab_results', 'INSERT'),
    ('lab_results', 'UPDATE'),
    ('lab_results', 'DELETE'),
    ('vitals', 'DELETE'),
    ('tasks', 'DELETE'),
    ('lab_critical_ranges', 'INSERT'),
    ('lab_critical_ranges', 'UPDATE'),
    ('lab_critical_ranges', 'DELETE')
  ) as t(tbl, priv)

  union all

  -- ---- 7. No NOT NULL on any vitals measurement column --------------------
  -- The product requirement, asserted against the live schema rather than the
  -- migration text. A nurse mid-round must always be able to save what they have.
  select 7,
         'vitals: no NOT NULL measurement column',
         case when (
           select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'vitals'
             and is_nullable = 'NO'
             and column_name = any(array['temperature_c', 'pulse_bpm', 'bp_systolic',
                                         'bp_diastolic', 'respiratory_rate',
                                         'spo2_percent', 'blood_glucose', 'notes'])
         ) = 0 then 'PASS' else 'FAIL' end

  union all

  -- ...and the structural columns ARE not-null, so the check above is not vacuous.
  select 7,
         'vitals: structural columns are NOT NULL',
         case when (
           select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'vitals'
             and is_nullable = 'NO'
             and column_name = any(array['tenant_id', 'visit_id', 'recorded_by', 'recorded_at'])
         ) = 4 then 'PASS' else 'FAIL' end

  union all

  -- ---- 8. The critical-value reference set is populated -------------------
  -- An empty reference table would make every result report 'no_reference'. That
  -- fails safe, but it also means no alert ever fires, so it must not go unnoticed.
  select 8,
         'lab_critical_ranges is seeded',
         case when (select count(*) from public.lab_critical_ranges) >= 10
              then 'PASS' else 'FAIL' end

  union all

  -- ---- 9. PHASE 4: RLS on the audit log and the Tier 3 placeholders -------
  select 9,
         'rls enabled: public.' || t,
         case when coalesce((
           select c.relrowsecurity from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = t
         ), false) then 'PASS' else 'FAIL' end
  from unnest(array['audit_log', 'insurance_claims', 'ot_schedule', 'blood_units']) as t

  union all

  -- ---- 10. PHASE 4: every admin/reporting view is security_invoker --------
  -- Seven views that aggregate revenue, staff activity and billing discrepancies. If
  -- any lost security_invoker it would execute as postgres and report EVERY clinic's
  -- numbers to whoever asked — the single worst failure available in this schema.
  select 10,
         'security_invoker: public.' || t,
         case when exists (
           select 1 from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = t
             and c.reloptions @> array['security_invoker=true']
         ) then 'PASS' else 'FAIL' end
  from unnest(array['admin_patient_volume_daily', 'admin_revenue_daily',
                    'admin_occupancy_current', 'admin_staff_activity_daily',
                    'admin_dashboard_summary', 'billing_reconciliation',
                    'billing_reconciliation_summary']) as t

  union all

  -- ---- 11. PHASE 4: the audit log has no client write path ----------------
  -- A log a user can write to is not a log.
  select 11,
         'no client ' || priv || ': audit_log',
         case when not has_table_privilege('authenticated', 'public.audit_log', priv)
              then 'PASS' else 'FAIL' end
  from unnest(array['INSERT', 'UPDATE', 'DELETE']) as priv

  union all

  select 11,
         'no client EXECUTE: record_audit_event()',
         case when not has_function_privilege(
           'authenticated',
           'public.record_audit_event(uuid,text,text,uuid,jsonb)',
           'EXECUTE'
         ) then 'PASS' else 'FAIL' end

  union all

  -- ---- 12. PHASE 4: deactivation cannot be self-served --------------------
  -- is_active is the whole access-revocation mechanism. If it were client-writable, a
  -- deactivated user could reactivate themselves.
  select 12,
         'no client UPDATE: profiles.' || col,
         case when not has_column_privilege('authenticated', 'public.profiles', col, 'UPDATE')
              then 'PASS' else 'FAIL' end
  from unnest(array['is_active', 'deactivated_at', 'role', 'tenant_id']) as col

  union all

  -- ---- 13. PHASE 4: the tenancy helpers are active-aware ------------------
  -- The deactivation guarantee is entirely carried by these seven functions. If a
  -- future migration rewrote one without `is_active`, deactivation would silently stop
  -- working for every policy that helper backs — with no error anywhere.
  select 13,
         'active-aware helper: ' || fn,
         case when pg_get_functiondef(fn::regprocedure) ilike '%is_active%'
              then 'PASS' else 'FAIL' end
  from unnest(array[
    'public.current_tenant_id()',
    'public.current_user_role()',
    'public.is_tenant_admin()',
    'public.is_tenant_staff()',
    'public.has_tenant_role(text[])',
    'public.current_tenant_tier()',
    'public.tenant_has_tier(integer)'
  ]) as fn

  union all

  -- ---- 14. PHASE 4: Tier 3 tables have no client DELETE -------------------
  select 14,
         'no client DELETE: ' || t,
         case when not has_table_privilege('authenticated', 'public.' || t, 'DELETE')
              then 'PASS' else 'FAIL' end
  from unnest(array['insurance_claims', 'ot_schedule', 'blood_units']) as t
)

select
  case when status = 'PASS' then 'ok  ' else '>>>>' end as flag,
  status,
  check_name
from checks
order by (status = 'PASS'), grp, check_name;
