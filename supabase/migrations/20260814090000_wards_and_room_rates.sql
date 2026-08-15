-- ============================================================================
-- Migration:  wards_and_room_rates
-- Phase:      6 (IPD billing) — 1 of 6
--
-- ###########################################################################
-- #  THIS IS THE `wards` TABLE THAT 20260811070400 EXPLICITLY DEFERRED.      #
-- ###########################################################################
--
-- That migration wrote, on `beds.ward_name`:
--
--     "Free text rather than a `wards` table. A nursing-home-scale tenant has a
--      handful of ward names that never change; a lookup table would add a join
--      and an admin screen to maintain for no gain this phase. If ward-level
--      attributes (per-day rate, gender restriction, nurse station) are ever
--      needed, that is when a `wards` table earns its place."
--
-- It named "per-day rate" first. Room-rent billing needs exactly that, so this is
-- the moment, and the deferral is being honoured rather than overridden.
--
-- ---------------------------------------------------------------------------
-- WHY WARD-LEVEL AND NOT A COLUMN ON `beds` — THIS IS A COMPLIANCE ARGUMENT
-- ---------------------------------------------------------------------------
-- A rate/critical-care flag per BED would have been less work. It is the wrong
-- place, and the reason is tax, not tidiness.
--
-- GST on a hospital room turns on two facts (see 20260814090200 for sources): is
-- it critical care, and is the daily rate above ₹5,000. If those live per bed,
-- then two beds in the same ICU can disagree — ICU-1 flagged critical, ICU-2 not,
-- because someone ticked one box. Worse, a typo of ₹5,200 -> ₹4,900 on one bed
-- silently flips that bed from taxable to exempt. **Tax treatment would depend on
-- per-bed data entry**, which is a compliance defect, not a data-quality niggle.
--
-- A ward is the real unit: every bed in the ICU is critical care, and every bed in
-- "General Ward" costs the same. One row, one rate, one flag, one place to be
-- wrong or right.
--
-- ---------------------------------------------------------------------------
-- HOW THIS AVOIDS A BREAKING CHANGE — no new column on `beds`, no backfill of
-- bed rows, no mirrored data
-- ---------------------------------------------------------------------------
-- The obvious shape is `beds.ward_id uuid`. That would mean backfilling every bed,
-- deciding what happens to `beds.ward_name` (drop it? mirror it? — both bad; this
-- codebase has form on rejecting mirrors, see beds.current_visit_id vs
-- visits.bed_id), and breaking `beds_number_unique_per_ward`.
--
-- Instead `wards` is keyed on `(tenant_id, name)` and `beds` gets a COMPOSITE
-- FOREIGN KEY `(tenant_id, ward_name) -> wards (tenant_id, name)`. That upgrades
-- the existing free-text column into a real reference without changing the shape
-- of `beds` at all: every existing query, index, constraint and the
-- `ipd-beds.md` contract keep working unchanged, and there is exactly one source
-- of truth for a ward's name.
--
-- The FK would normally make bed creation fail for a ward that does not exist yet.
-- A BEFORE INSERT/UPDATE trigger on `beds` auto-creates the ward row instead, so
-- **adding a bed never breaks**, and the new ward simply starts at rate 0. Rate 0
-- is the deliberately safe default: it is exempt (≤ ₹5,000), and it produces a
-- visible ₹0 room-rent line that billing can price — the same "a visible zero is
-- honest, a silent omission is revenue leakage" rule Phase 2 set for a drug with
-- no MRP and Phase 3 set for a lab test with no price list.
--
-- ---------------------------------------------------------------------------
-- ALSO HERE: tenants.billing_timezone. NOT scope creep — a correctness fix.
-- ---------------------------------------------------------------------------
-- This database runs in UTC (verified: `current_setting('TimeZone')` = 'UTC' on
-- the hosted project). A bed-day is a CALENDAR day, so counting nights by UTC date
-- would put the day boundary at 05:30 IST — a patient admitted at 02:00 IST and
-- discharged at 09:00 IST the same morning would be billed two days.
--
-- Rather than hardcode Asia/Kolkata inside a billing function, it is a per-tenant
-- column with that default. One column removes the whole class of bug, and follows
-- the exact grant discipline of `default_consultation_fee`: the clinic's own
-- operational fact, so the clinic may set it; not a platform entitlement like
-- `tier`.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. tenants.billing_timezone
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column if not exists billing_timezone text not null default 'Asia/Kolkata';

comment on column public.tenants.billing_timezone is
  'IANA timezone used to decide calendar-day boundaries for per-day charges (room rent). The server runs in UTC, so without this a bed-day boundary would fall at 05:30 IST. Defaults to Asia/Kolkata because the product is India-first (PRD §5.1); it is a column rather than a constant so a clinic in another zone is a settings change, not a migration.';

-- Validated against the real zone set rather than a regex: a typo like
-- 'Asia/Kolkatta' must be rejected at write time, because discovering it later
-- means every bed-day charged since is suspect.
--
-- It has to go through a helper, because a CHECK constraint may not contain a
-- subquery — `billing_timezone in (select name from pg_timezone_names)` is
-- rejected outright by Postgres. The helper casts a FIXED timestamp rather than
-- now(), which is what makes IMMUTABLE an honest label here: the answer depends
-- only on the argument and the compiled zone set, not on the clock.
create or replace function public.is_valid_timezone(p_tz text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_tz is null then
    return false;
  end if;
  perform timestamp '2000-01-01 00:00:00' at time zone p_tz;
  return true;
exception
  when others then
    return false;
end;
$$;

comment on function public.is_valid_timezone(text) is
  'True when p_tz is a timezone name this server recognises. Exists because a CHECK constraint cannot contain a subquery against pg_timezone_names. Casts a fixed timestamp, not now(), so IMMUTABLE is accurate.';

revoke execute on function public.is_valid_timezone(text) from public, anon;
grant  execute on function public.is_valid_timezone(text) to authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_billing_timezone_valid') then
    alter table public.tenants
      add constraint tenants_billing_timezone_valid check (
        public.is_valid_timezone(billing_timezone)
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 2. wards
-- ---------------------------------------------------------------------------
create table if not exists public.wards (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants (id) on delete restrict,

  -- The ward's identity, and the FK target for beds.ward_name. Same free-text
  -- values that are already in beds.ward_name — this table does not rename
  -- anything, it gives those names a row to carry attributes on.
  name             text        not null,

  -- ---- the two facts that decide GST on a room (20260814090200) ----
  --
  -- The daily rate. NOT NULL with a 0 default so a ward always has a defined
  -- rate: a NULL rate would force every consumer to decide what NULL means, and
  -- the honest answer ("nobody has priced this ward") is better expressed as 0,
  -- which bills a visible zero line rather than silently skipping the charge.
  daily_rate       numeric(12, 2) not null default 0,

  -- ICU / CCU / ICCU / NICU. Exempt from GST at ANY rate, so this is not a
  -- cosmetic label — it overrides the ₹5,000 threshold entirely.
  is_critical_care boolean     not null default false,

  notes            text        null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint wards_name_not_blank check (length(trim(name)) > 0),
  constraint wards_daily_rate_non_negative check (daily_rate >= 0),

  -- The FK target for beds(tenant_id, ward_name), and the reason a clinic cannot
  -- have two wards with one name.
  constraint wards_name_unique_per_tenant unique (tenant_id, name),
  constraint wards_id_tenant_unique unique (id, tenant_id)
);

comment on table public.wards is
  'Ward-level attributes, chiefly the per-day room rate and the critical-care flag that together decide GST on room rent. Referenced by beds via the composite FK (tenant_id, ward_name) -> (tenant_id, name), so beds.ward_name stays the ward identity and nothing is mirrored. Rows are auto-created by the beds trigger, so adding a bed never fails on a missing ward.';
comment on column public.wards.daily_rate is
  'Per-day room charge. Snapshotted onto bed_stays at admission (20260814090100) so a later rate change never rewrites what an earlier stay was charged — the same rule GSTIN follows on invoices.';
comment on column public.wards.is_critical_care is
  'True for ICU/CCU/ICCU/NICU. Makes room rent GST-exempt regardless of the daily rate, overriding the ₹5,000 threshold. A commercial/compliance fact, so admin-writable and not settable by nursing staff.';

create index if not exists wards_tenant_name_idx on public.wards (tenant_id, name);

drop trigger if exists wards_touch_updated_at on public.wards;
create trigger wards_touch_updated_at
  before update on public.wards
  for each row
  execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 3. Backfill from the ward names that already exist, then add the FK.
--
-- rules.md §1.6 wants a stated reason for a data-altering migration: this inserts
-- one `wards` row per distinct ward name already present in `beds`, because the
-- foreign key added below cannot be created while any bed references a ward with
-- no row. Nothing existing is modified or deleted; every backfilled ward starts at
-- rate 0 / not critical care, which is the safe default described in the header
-- and must be reviewed per clinic before an inpatient is billed.
-- ---------------------------------------------------------------------------
insert into public.wards (tenant_id, name)
select distinct b.tenant_id, b.ward_name
from public.beds b
on conflict (tenant_id, name) do nothing;

do $$
declare
  v_wards integer;
begin
  select count(*) into v_wards from public.wards;
  if v_wards > 0 then
    raise notice 'wards backfilled from existing beds: % ward row(s). All start at daily_rate 0 / is_critical_care false and MUST be priced before billing an inpatient.', v_wards;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'beds_ward_exists') then
    alter table public.beds
      add constraint beds_ward_exists
      foreign key (tenant_id, ward_name)
      references public.wards (tenant_id, name)
      -- RESTRICT, not CASCADE: deleting a ward that still has beds in it is a
      -- mistake, not a bulk decommissioning. Note the column order — the FK is
      -- (tenant_id, ward_name), so tenant isolation is structural here too: a bed
      -- cannot reference another clinic's ward, because no such pair exists.
      on update cascade
      on delete restrict;
  end if;
end
$$;

-- ON UPDATE CASCADE above is deliberate and is the one place this table earns
-- something `beds.ward_name` alone could not do: renaming a ward is now a single
-- UPDATE on `wards.name` that follows through to every bed, instead of an
-- N-row update that could half-fail and split one ward into two.


-- ---------------------------------------------------------------------------
-- 4. Auto-create the ward row, so the FK above can never block adding a bed.
--
-- BEFORE INSERT OR UPDATE OF ward_name, so both "add the first bed in a new ward"
-- and "move a bed into a new ward" work without a separate ward-creation step.
--
-- SECURITY DEFINER for the same reason the billing triggers are: the acting admin
-- has INSERT on `wards` (see the policies below) but a nurse renaming nothing
-- still passes through here on any bed UPDATE, and the trigger must not depend on
-- the caller's grant. Every value written is derived server-side from the bed row
-- (rules.md §1.2) — the ward name comes from NEW, the tenant from NEW, and the
-- rate/flag take their table defaults. It cannot be steered into another tenant.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_ward_exists()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.wards (tenant_id, name)
  values (new.tenant_id, new.ward_name)
  on conflict (tenant_id, name) do nothing;

  return new;
end;
$$;

comment on function public.ensure_ward_exists() is
  'BEFORE INSERT/UPDATE OF ward_name on beds: creates the wards row if absent, so the beds_ward_exists FK never turns "add a bed" into a 23503. The new ward starts at daily_rate 0 / is_critical_care false and must be priced by an admin. SECURITY DEFINER; all values derived from NEW.';

drop trigger if exists beds_ensure_ward on public.beds;
create trigger beds_ensure_ward
  before insert or update of ward_name on public.beds
  for each row
  execute function public.ensure_ward_exists();


-- ---------------------------------------------------------------------------
-- 5. RLS — mirrors `beds` exactly, including its two deliberate asymmetries.
--
-- READ: any onboarded staff member, tenant-scoped, and NOT tier-gated. Same
-- reasoning 20260811070400 gave for beds: a tier downgrade must not make the ward
-- a patient is lying in disappear from every screen. Billing is included on
-- purpose — an inpatient bill has to name the ward and its rate.
--
-- WRITE: admin only, AND Tier 2+. A room rate is a commercial term, so this sits
-- with `tenants.default_consultation_fee` (admin) rather than with anything
-- nursing staff touch. Gated on tier for the same reason bed inventory is: wards
-- are meaningless below Tier 2.
--
-- DELETE: admin + Tier 2, and only a ward with no beds. The FK would refuse
-- anyway; the predicate makes the ordinary case a clean 0-row policy miss instead
-- of a foreign-key error, which is the pattern beds_delete_admin_tier2_unoccupied
-- already established.
-- ---------------------------------------------------------------------------
alter table public.wards enable row level security;

revoke all on public.wards from anon, authenticated;

grant select on public.wards to authenticated;
grant insert (tenant_id, name, daily_rate, is_critical_care, notes) on public.wards to authenticated;
grant update (name, daily_rate, is_critical_care, notes) on public.wards to authenticated;
grant delete on public.wards to authenticated;

create policy wards_select_staff
  on public.wards
  for select
  to authenticated
  using (
    public.is_tenant_staff()
    and tenant_id = public.current_tenant_id()
  );

create policy wards_insert_admin_tier2
  on public.wards
  for insert
  to authenticated
  with check (
    public.is_tenant_admin()
    and public.tenant_has_tier(2)
    and tenant_id = public.current_tenant_id()
  );

create policy wards_update_admin_tier2
  on public.wards
  for update
  to authenticated
  using (
    public.is_tenant_admin()
    and public.tenant_has_tier(2)
    and tenant_id = public.current_tenant_id()
  )
  with check (
    public.is_tenant_admin()
    and public.tenant_has_tier(2)
    and tenant_id = public.current_tenant_id()
  );

create policy wards_delete_admin_tier2_empty
  on public.wards
  for delete
  to authenticated
  using (
    public.is_tenant_admin()
    and public.tenant_has_tier(2)
    and tenant_id = public.current_tenant_id()
    and not exists (
      select 1 from public.beds b
      where b.tenant_id = wards.tenant_id and b.ward_name = wards.name
    )
  );


-- ---------------------------------------------------------------------------
-- 6. The new tenants column's grant, additive to the Phase 2 list.
--
-- `tier` stays ungranted, as always. billing_timezone joins the clinic's own
-- operational facts.
-- ---------------------------------------------------------------------------
grant update (billing_timezone) on public.tenants to authenticated;
