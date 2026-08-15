-- ============================================================================
-- Migration:  room_rent_tax_and_billing
-- Phase:      6 (IPD billing) — 3 of 6
--
-- The tax rule, the night count, and the trigger that turns a closed bed stay into
-- a billing line.
--
-- ---------------------------------------------------------------------------
-- THE GST RULE ON A HOSPITAL ROOM — A THIRD CATEGORY, NOT A VARIANT OF THE OTHER TWO
-- ---------------------------------------------------------------------------
-- Phase 2 established a two-axis model in resolve_tax_treatment(): the TENANT's
-- registration decides whether GST applies at all, and the SUPPLY's nature decides
-- the rate. Room rent needs a third supply nature, because since 18 July 2022 it
-- follows neither the consultation rule nor the medicine rule:
--
--   * ICU / CCU / ICCU / NICU  -> EXEMPT, at any rate whatsoever.
--   * every other room, rate <= ₹5,000/day -> EXEMPT.
--   * every other room, rate  > ₹5,000/day -> TAXABLE at 5%, and the hospital
--                                             cannot claim input tax credit.
--
-- Note the shape of that: it is a per-day-RATE threshold, not a per-bill total. A
-- 10-day stay at ₹4,000/day is ₹40,000 and still exempt. Getting this backwards
-- would misstate tax on every long stay in a cheap ward.
--
-- The critical-care carve-out is an override, not a tie-break: an ICU at
-- ₹25,000/day is exempt. That is why is_critical_care is checked FIRST below.
--
-- "No input tax credit" is a constraint on the hospital's own return, not on the
-- invoice line, so there is nothing to store for it — but it is why the rate is a
-- flat 5% with no variation, and it is recorded here so nobody later "fixes" the
-- 5% into a lookup.
--
-- ---------------------------------------------------------------------------
-- WHY THE EXISTING FUNCTION IS EXTENDED RATHER THAN COPIED, AND HOW
-- ---------------------------------------------------------------------------
-- resolve_tax_treatment()'s own comment says it exists as a "single source of truth
-- ... so tax assignment cannot drift between them". A second, parallel
-- resolve_room_rent_tax() would defeat exactly that, because the
-- "tenant not registered -> non_gst" rule would then live in two places.
--
-- But the existing signature is (uuid, boolean, numeric) and its discriminator is
-- a BOOLEAN, `p_is_medicine`. A boolean cannot express three cases. And
-- CREATE OR REPLACE cannot add a parameter — a different argument list is a
-- different function, so replacing it in place is not available.
--
-- So: the real logic moves to a new 5-argument form whose discriminator is a TEXT
-- supply kind, and the old 3-argument form is kept as a THIN DELEGATING WRAPPER
-- with no logic of its own. Consequences:
--
--   * still exactly one place where tax is decided;
--   * the three existing call sites (autoinsert_consultation_charge,
--     autoinsert_medicine_charges, autoinsert_lab_charge — all in applied
--     migrations) keep working untouched. Redefining three working billing
--     functions just to change how they spell a function call would be risk for
--     no behavioural gain.
--
-- New call sites should use the 5-arg form with NAMED arguments, which is also
-- what removes any doubt about overload resolution.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The real function, now with three supply kinds.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_tax_treatment(
  p_tenant_id       uuid,
  p_supply_kind     text,
  p_drug_gst_rate   numeric default null,
  p_room_daily_rate numeric default null,
  p_room_critical   boolean default false
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

  -- Axis 1, unchanged from Phase 2. A non-registered clinic issues a bill of
  -- supply: every line is 'non_gst', whatever it is a charge for.
  if not coalesce(v_gst_registered, false) then
    return query select 'non_gst'::text, 0::numeric;
    return;
  end if;

  -- Axis 2: the nature of the supply.
  if p_supply_kind = 'medicine' then
    v_rate := coalesce(p_drug_gst_rate, 5.00);
    if v_rate <= 0 then
      return query select 'nil_rated'::text, 0::numeric;
    else
      return query select 'taxable'::text, v_rate;
    end if;
    return;
  end if;

  if p_supply_kind = 'room_rent' then
    -- Critical care first, because it is an OVERRIDE and not a tie-break: an ICU
    -- bed at ₹25,000/day is exempt. Checking the threshold first would tax it.
    if coalesce(p_room_critical, false) then
      return query select 'exempt'::text, 0::numeric;
      return;
    end if;

    -- The ₹5,000 threshold is on the DAILY RATE, never on the bill total.
    -- coalesce to 0 fails in the exempt direction, which is the correct way to be
    -- wrong: charging GST that was not due is a refund problem with a patient,
    -- while under-charging is a matter between the clinic and its own return.
    if coalesce(p_room_daily_rate, 0) > 5000 then
      return query select 'taxable'::text, 5.00::numeric;
    else
      return query select 'exempt'::text, 0::numeric;
    end if;
    return;
  end if;

  -- 'service' and anything unrecognised: core healthcare service, exempt.
  -- Defaulting an unknown kind to exempt rather than raising is deliberate — a
  -- future supply kind that reaches here un-taught produces a visibly wrong-but-
  -- zero tax line that reconciliation can surface, rather than a failed insert
  -- that blocks a clinical action. Same fail-open-on-billing / fail-closed-on-
  -- clinical-safety split the rest of this schema uses.
  return query select 'exempt'::text, 0::numeric;
end;
$$;

comment on function public.resolve_tax_treatment(uuid, text, numeric, numeric, boolean) is
  'Single source of truth for line-level tax treatment. Axis 1 is the tenant''s GST registration, axis 2 is the supply kind: service (exempt), medicine (drug rate, default 5%, 0 -> nil_rated), room_rent (critical care exempt at any rate; otherwise exempt at or below 5000/day, taxable at 5% above it, per the 18 July 2022 GST position). Supersedes the 3-arg boolean form, which now delegates here.';

revoke execute on function public.resolve_tax_treatment(uuid, text, numeric, numeric, boolean) from public, anon;
grant  execute on function public.resolve_tax_treatment(uuid, text, numeric, numeric, boolean) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. The Phase 2 signature, retained as a delegating wrapper.
--
-- No logic of its own — it maps the old boolean onto the new supply kind and
-- forwards. Kept so the three applied trigger functions that call
-- resolve_tax_treatment(tenant, false/true, rate) continue to work without being
-- redefined. Overload resolution is unambiguous: `false`/`true` cannot be
-- implicitly cast to text, so a 3-arg boolean call can only match this one.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_tax_treatment(
  p_tenant_id     uuid,
  p_is_medicine   boolean,
  p_drug_gst_rate numeric default null
)
returns table (tax_category text, tax_rate numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select r.tax_category, r.tax_rate
  from public.resolve_tax_treatment(
    p_tenant_id       => p_tenant_id,
    p_supply_kind     => case when p_is_medicine then 'medicine' else 'service' end,
    p_drug_gst_rate   => p_drug_gst_rate,
    p_room_daily_rate => null,
    p_room_critical   => false
  ) r;
$$;

comment on function public.resolve_tax_treatment(uuid, boolean, numeric) is
  'DEPRECATED SHAPE, retained for the Phase 2/3 call sites. Delegates to resolve_tax_treatment(uuid, text, numeric, numeric, boolean) and holds no logic of its own, so tax assignment still has exactly one definition. New callers should use the 5-arg form with named arguments.';


-- ---------------------------------------------------------------------------
-- 3. How many days a stay is charged for.
--
-- CALENDAR days crossed, in the CLINIC's timezone, minimum 1.
--
-- Three decisions in one line, each worth stating:
--
-- * CALENDAR, not elapsed 24-hour blocks. A room is let by the night; admit at
--   22:00 and discharge at 06:00 the next morning is one night, not zero.
--
-- * THE CLINIC'S timezone, from tenants.billing_timezone. The server runs in UTC
--   (verified on the hosted project), so counting by UTC date would put the day
--   boundary at 05:30 IST and double-charge an early-morning discharge.
--
-- * MINIMUM 1. A same-day admission and discharge is a real event (day care,
--   a patient who leaves against advice) and is charged one day, which is ordinary
--   hospital practice. It is also structurally required: billing_line_items carries
--   `billing_quantity_positive check (quantity > 0)`, so 0 could not be stored
--   even if it were wanted.
--
-- STABLE rather than IMMUTABLE: the answer depends on the zone database, and
-- claiming immutability would be a lie that a future index could act on.
-- ---------------------------------------------------------------------------
create or replace function public.bed_stay_days(
  p_started_at timestamptz,
  p_ended_at   timestamptz,
  p_timezone   text
)
returns integer
language sql
stable
set search_path = ''
as $$
  select greatest(
    1,
    ((p_ended_at   at time zone coalesce(p_timezone, 'Asia/Kolkata'))::date
   - (p_started_at at time zone coalesce(p_timezone, 'Asia/Kolkata'))::date)
  );
$$;

comment on function public.bed_stay_days(timestamptz, timestamptz, text) is
  'Chargeable days for a bed stay: calendar days crossed in the clinic''s own timezone, minimum 1. Calendar rather than elapsed hours because a room is let by the night; clinic-local because the server is UTC and a UTC boundary would fall at 05:30 IST; minimum 1 because a day-care stay is charged a day and because billing_quantity_positive forbids 0.';

revoke execute on function public.bed_stay_days(timestamptz, timestamptz, text) from public, anon;
grant  execute on function public.bed_stay_days(timestamptz, timestamptz, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Admit 'room_rent' to the source_type CHECK.
--
-- Phase 2 reserved 'lab' and 'procedure' so later phases could "add rows rather
-- than altering this constraint". It did not reserve a room-rent value, so this
-- constraint genuinely has to be replaced — which is a DROP and ADD in a NEW
-- migration, not an edit to the applied one (rules.md §5.6).
--
-- 'other' would have worked with zero DDL. Rejected: every reporting surface that
-- groups by source_type would fold room rent in with miscellaneous manual charges,
-- and room rent is the one line on an inpatient bill that a patient, an auditor and
-- an insurer will all look for by name. A category that cannot be selected for is
-- not a category.
--
-- Widening a CHECK cannot invalidate an existing row, so this needs no backfill and
-- no data validation pass.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'billing_source_type_valid') then
    alter table public.billing_line_items
      drop constraint billing_source_type_valid;
  end if;

  alter table public.billing_line_items
    add constraint billing_source_type_valid check (
      source_type in ('consultation', 'medicine', 'lab', 'procedure', 'room_rent', 'other')
    );
end
$$;

comment on column public.billing_line_items.source_type is
  'consultation | medicine | lab | procedure | room_rent | other. room_rent was added in 20260814090200 for IPD bed-day charges; its source_id is a bed_stays.id, so one closed stay bills exactly once through billing_one_line_per_source_idx.';


-- ---------------------------------------------------------------------------
-- 5. The charge itself.
--
-- ###########################################################################
-- #  THE BILLABLE EVENT IS "A BED STAY CLOSES", and picking that is the whole  #
-- #  design decision. Reasoning in full, because none of the three existing    #
-- #  auto-billing patterns fits a stay:                                        #
-- #                                                                          #
-- #   * consultation bills on a visits.status transition — a stay has no such  #
-- #     transition; it accrues.                                                #
-- #   * medicine bills on prescription issue — a one-shot lifecycle change,     #
-- #     again not something a stay has.                                        #
-- #   * lab bills on order insert — a single event with a single charge, but a   #
-- #     stay's cost is not known when it starts.                                #
-- #                                                                          #
-- #  A stay's cost IS known exactly when it closes: start, end, rate and        #
-- #  critical-care flag are all fixed and snapshotted by then. Closing is       #
-- #  therefore the first and only moment the charge can be computed correctly,   #
-- #  which makes it the natural billable event rather than a chosen one.        #
-- ###########################################################################
--
-- WHAT THIS BUYS: a transfer closes the outgoing stay, so the outgoing ward's
-- nights bill at the outgoing ward's snapshotted rate, automatically. Discharge
-- closes the final stay, so the last partial period is captured rather than
-- dropped. Both Phase 6 requirements fall out of the event choice instead of
-- needing special-case code.
--
-- IDEMPOTENCY: source_type = 'room_rent', source_id = the bed_stays.id. The
-- existing billing_one_line_per_source_idx (tenant_id, source_type, source_id)
-- then permits exactly one line per stay, forever, with no new index needed — the
-- same trick autoinsert_medicine_charges() uses by pointing source_id at a
-- prescription_item rather than the prescription. The guard below also refuses to
-- fire unless ended_at genuinely went from NULL to NOT NULL, so the index is the
-- backstop rather than the only defence, matching the belt-and-braces the Phase 2
-- header describes.
--
-- WHAT IS DELIBERATELY NOT DONE HERE: no charge for an OPEN stay. An ongoing
-- admission accrues nothing in billing_line_items until the stay closes. That is a
-- visibility trade-off, not a lost charge, and 20260814090500 adds a view so
-- billing can watch the accrual. See that migration and the report for why this
-- beats posting a line per night.
--
-- SECURITY DEFINER: same stated exception as every other billing trigger. The
-- person discharging a patient deliberately has no INSERT on billing_line_items —
-- and here they have no write path to bed_stays either — so a trigger running as
-- them would fail the policy and the stay would go unbilled, which is precisely
-- the revenue leakage this mechanism exists to prevent. Every value written is
-- derived server-side from the stay row.
-- ---------------------------------------------------------------------------
create or replace function public.autoinsert_room_rent_charge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patient_id uuid;
  v_timezone   text;
  v_days       integer;
  v_category   text;
  v_rate       numeric;
begin
  -- Only on the NULL -> NOT NULL transition. An update to any other column on a
  -- closed stay must not re-charge, and an update on an open stay has nothing to
  -- charge yet.
  if new.ended_at is null or old.ended_at is not null then
    return null;
  end if;

  -- A ₹0 ward still produces a line. Consistent with the consultation fee and the
  -- lab charge: a visible zero that billing can price is honest, while silently
  -- omitting the charge is the failure mode auto-capture exists to prevent. It
  -- also means an unpriced ward shows up on a bill, which is how a clinic finds
  -- out it never set the rate.

  select v.patient_id into v_patient_id
  from public.visits v
  where v.id = new.visit_id and v.tenant_id = new.tenant_id;

  if v_patient_id is null then
    -- Should be unreachable: bed_stays_visit_same_tenant guarantees the visit
    -- exists in this tenant. Returning quietly rather than raising, because an
    -- exception here would abort the discharge, and refusing to discharge a
    -- patient over a billing problem is the wrong failure direction.
    return null;
  end if;

  select t.billing_timezone into v_timezone
  from public.tenants t
  where t.id = new.tenant_id;

  v_days := public.bed_stay_days(new.started_at, new.ended_at, v_timezone);

  select r.tax_category, r.tax_rate
    into v_category, v_rate
  from public.resolve_tax_treatment(
    p_tenant_id       => new.tenant_id,
    p_supply_kind     => 'room_rent',
    p_drug_gst_rate   => null,
    -- The SNAPSHOTTED rate and flag from the stay, never the ward's current
    -- values. This is what makes a mid-stay re-pricing or re-designation unable
    -- to restate a closed stay's tax.
    p_room_daily_rate => new.daily_rate,
    p_room_critical   => new.is_critical_care
  ) r;

  insert into public.billing_line_items (
    tenant_id, patient_id, visit_id,
    source_type, source_id, description,
    quantity, unit_amount, tax_category, tax_rate, is_auto
  )
  values (
    new.tenant_id, v_patient_id, new.visit_id,
    'room_rent', new.id,
    -- Ward name and day count only. No diagnosis, no reason for admission: this
    -- description is read at the billing counter and printed on an invoice the
    -- patient may hand to an employer or insurer. A ward name is operational —
    -- `beds` is already readable by billing for exactly this reason — but note
    -- that naming an ICU does disclose acuity, which is why nothing more is added.
    'Room rent — ' || new.ward_name || ' (' || v_days::text ||
      case when v_days = 1 then ' day)' else ' days)' end,
    v_days, new.daily_rate, v_category, v_rate, true
  )
  on conflict do nothing;   -- billing_one_line_per_source_idx: one line per stay

  return null;
end;
$$;

comment on function public.autoinsert_room_rent_charge() is
  'AFTER UPDATE on bed_stays: when a stay closes (ended_at NULL -> NOT NULL), captures one room-rent line for it. quantity = chargeable days in the clinic''s timezone, unit_amount = the stay''s SNAPSHOTTED daily rate, tax from resolve_tax_treatment(''room_rent'', ...). source_id = the bed_stays.id, so billing_one_line_per_source_idx permits exactly one line per stay. SECURITY DEFINER because the discharging user has no INSERT on billing_line_items.';

drop trigger if exists bed_stays_autoinsert_room_rent on public.bed_stays;
create trigger bed_stays_autoinsert_room_rent
  after update of ended_at on public.bed_stays
  for each row
  execute function public.autoinsert_room_rent_charge();
