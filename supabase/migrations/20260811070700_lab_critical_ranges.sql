-- ============================================================================
-- Migration:  lab_critical_ranges  +  evaluate_lab_critical()
--
-- ############################################################################
-- #  !! STARTER REFERENCE SET FOR CRITICAL-VALUE FLAGGING.                    #
-- #  !! NOT CLINICALLY REVIEWED. NOT EXHAUSTIVE. ADULTS ONLY.                 #
-- #                                                                           #
-- #  About a dozen widely-published adult critical limits, enough to make      #
-- #  critical-value alerting real and nothing more. It has NOT been reviewed   #
-- #  by a pathologist, it is NOT a substitute for the reference ranges the     #
-- #  clinic's own laboratory publishes, and — the caveat that matters most —   #
-- #  PAEDIATRIC AND NEONATAL LIMITS DIFFER MATERIALLY. A bilirubin of 15      #
-- #  mg/dL means something entirely different in a three-day-old than in an    #
-- #  adult. Age-stratified ranges are a known gap, recorded in Memory.md.      #
-- #                                                                           #
-- #  Because the set is incomplete, a test with no row here must NEVER be      #
-- #  reported as "checked and normal". evaluate_lab_critical() returns         #
-- #  status = 'no_reference' for that case, and lab_results carries it through #
-- #  to requires_manual_review = true (rules.md §3.4, §6.4). This is the same  #
-- #  discipline check_prescription_safety() applies to an unresolved drug.     #
-- ############################################################################
--
-- SAME DELIBERATE EXCEPTION TO rules.md §4.1 AS `drugs`
-- No tenant_id, and not tenant-scoped. §4.1 governs tenant BUSINESS data — rows
-- owned by and private to one clinic. A critical potassium threshold is not that:
-- it does not vary by clinic, and per-tenant copies would multiply storage, make a
-- correction an N-fold job, and let two clinics silently disagree about what
-- counts as a life-threatening result. Isolation is honoured in the other
-- direction instead: RLS on, read-only to every client including admins, writable
-- only by migration or service_role. Exactly the precedent set in 20260811060400.
--
-- WHY UNITS ARE PART OF THE DATA AND CHECKED
-- A number without a unit is not a result. Potassium 6.2 mmol/L is critical;
-- 6.2 mg/dL would be a different quantity entirely. So `unit` is NOT NULL on every
-- reference row, and a result whose unit contradicts the reference is reported as
-- `unit_mismatch` — a non-evaluation, not a pass.
--
-- Interchangeable units are stated PER ANALYTE in `unit_aliases`, not decided by
-- global string rules. mEq/L and mmol/L are numerically identical for a monovalent
-- ion like potassium or sodium, and NOT identical for a divalent one like calcium
-- (they differ by a factor of two). A global "meq == mmol" shortcut would
-- therefore be right for some rows and dangerously wrong for others, so the
-- equivalence is data, the same way drugs.interaction_generics makes combination
-- products a data statement rather than a parsing rule.
-- ============================================================================


create table if not exists public.lab_critical_ranges (
  id                   uuid    primary key default gen_random_uuid(),

  -- Stable machine key. What code and seeds refer to; independent of display text
  -- so a wording change never breaks a lookup.
  test_code            text    not null,

  test_name            text    not null,
  test_name_normalized text    generated always as (lower(trim(test_name))) stored,

  -- Normalised alternate spellings a lab or a doctor might actually type:
  -- {'k+','serum potassium','s. potassium'}. Indian requisition slips are
  -- abbreviation-heavy, and a miss here means a critical result silently reports
  -- 'no_reference'. Maintained normalised by the trigger below.
  aliases              text[]  not null default '{}',

  -- Canonical unit for the thresholds below, plus the units numerically
  -- interchangeable with it FOR THIS ANALYTE. See the header.
  unit                 text    not null,
  unit_aliases         text[]  not null default '{}',

  -- A result at or beyond either bound is critical. Either may be NULL: a high
  -- creatinine is critical, a low one is not a crisis.
  critical_low         numeric null,
  critical_high        numeric null,

  -- Reference (normal) interval, for display alongside the result. Not used by the
  -- critical decision — "outside normal" and "critical" are different questions and
  -- conflating them would turn every mildly abnormal result into an alarm, which is
  -- how alert fatigue starts.
  normal_low           numeric null,
  normal_high          numeric null,

  source_note          text    null,
  created_at           timestamptz not null default now(),

  constraint lab_critical_ranges_code_unique unique (test_code),
  constraint lab_critical_ranges_code_normalized check (test_code = lower(trim(test_code))),
  constraint lab_critical_ranges_name_not_blank check (length(trim(test_name)) > 0),
  constraint lab_critical_ranges_unit_not_blank check (length(trim(unit)) > 0),

  -- A row with no critical bound at all cannot make a critical decision, so it
  -- would masquerade as coverage while providing none — worse than having no row,
  -- because 'no_reference' at least tells the truth.
  constraint lab_critical_ranges_has_a_bound check (
    critical_low is not null or critical_high is not null
  ),
  constraint lab_critical_ranges_bounds_ordered check (
    critical_low is null or critical_high is null or critical_low < critical_high
  ),
  constraint lab_critical_ranges_normal_ordered check (
    normal_low is null or normal_high is null or normal_low <= normal_high
  )
);

comment on table public.lab_critical_ranges is
  'STARTER critical-value thresholds — NOT clinically reviewed, NOT exhaustive, ADULT ranges only (paediatric/neonatal differ materially). Non-tenant shared reference data: read-only to clients, maintained by the platform owner. A test absent from this table yields status=no_reference, never "normal". See migration header.';
comment on column public.lab_critical_ranges.unit_aliases is
  'Units numerically interchangeable with `unit` FOR THIS ANALYTE. Stated per row because mEq/L == mmol/L holds for monovalent ions and not for divalent ones; a global rule would be silently wrong for some tests.';
comment on column public.lab_critical_ranges.normal_low is
  'Reference interval for display only. The critical decision uses critical_low/critical_high — "abnormal" and "critical" are deliberately different questions.';

create index if not exists lab_ranges_name_idx    on public.lab_critical_ranges (test_name_normalized);
create index if not exists lab_ranges_aliases_idx on public.lab_critical_ranges using gin (aliases);


-- ---------------------------------------------------------------------------
-- Alias/unit normalisation, enforced rather than trusted.
--
-- A CHECK constraint cannot express "every element of this array is lowercase and
-- trimmed" without a subquery, so the invariant is maintained by a trigger. It
-- matters more than it looks: the lookup normalises the incoming test name, so a
-- stray capital in an alias would not raise an error — it would just fail to
-- match, and a critical potassium would come back as 'no_reference'. A silent
-- coverage hole is the exact failure this table exists to prevent.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_lab_range_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.aliases := coalesce(
    (select array_agg(distinct lower(trim(a)))
       from unnest(new.aliases) as a
      where nullif(trim(a), '') is not null),
    '{}'
  );
  new.unit := lower(trim(new.unit));
  new.unit_aliases := coalesce(
    (select array_agg(distinct lower(trim(u)))
       from unnest(new.unit_aliases) as u
      where nullif(trim(u), '') is not null),
    '{}'
  );
  return new;
end;
$$;

comment on function public.normalize_lab_range_row() is
  'BEFORE INSERT/UPDATE on lab_critical_ranges: lowercases and trims aliases and units. A non-normalised alias would not error, it would silently fail to match and report a critical result as no_reference.';

drop trigger if exists lab_critical_ranges_normalize on public.lab_critical_ranges;
create trigger lab_critical_ranges_normalize
  before insert or update on public.lab_critical_ranges
  for each row
  execute function public.normalize_lab_range_row();


-- ---------------------------------------------------------------------------
-- RLS — enabled, read-only to clients, exactly like `drugs`.
--
-- Any onboarded staff member can read: the lab entry screen should prefill the
-- unit and show the reference interval, and a doctor reading a result wants the
-- normal range beside it. Nobody gets INSERT/UPDATE/DELETE — not granted and no
-- policy exists, so writes are impossible from a client session even for an admin.
-- That read-only-ness is what replaces tenant scoping as the isolation guarantee.
-- ---------------------------------------------------------------------------
alter table public.lab_critical_ranges enable row level security;

revoke all on public.lab_critical_ranges from anon, authenticated;
grant select on public.lab_critical_ranges to authenticated;

create policy lab_critical_ranges_select_staff
  on public.lab_critical_ranges
  for select
  to authenticated
  using (public.is_tenant_staff());


-- ---------------------------------------------------------------------------
-- evaluate_lab_critical(test_name, value, unit)
--
-- The whole critical-value judgement, in one callable function.
--
-- WHY THIS IS A FUNCTION AND NOT JUST TRIGGER BODY
-- Three reasons, and the third is the one that matters for this phase:
--   1. It is directly testable — the local suite calls it with values either side
--      of every boundary without inserting anything.
--   2. The lab-entry UI can pre-check a value before saving, so a tech sees the
--      alert as they type rather than after.
--   3. NO PERSONAL ACCESS TOKEN IS AVAILABLE ON THIS MACHINE, so the alert Edge
--      Function cannot be deployed (same constraint as the Phase 2 PDF functions).
--      Keeping the entire decision — is this critical, why, against what threshold
--      — inside Postgres means the compliance-bearing logic is covered by SQL
--      tests today, and the undeployable part is reduced to a dispatcher that
--      forwards an already-made decision.
--
-- SECURITY INVOKER: it needs no elevated privilege. Every staff member can already
-- read `lab_critical_ranges`, and the function touches nothing tenant-scoped. Least
-- privilege is available, so it is taken — same call as check_prescription_safety().
--
-- STATUS VOCABULARY (never a bare boolean):
--   evaluated          — a reference row matched, the unit was compatible, and the
--                        value parsed. is_critical is then meaningful.
--   no_reference       — no thresholds on file for this test name. NOT "normal".
--   unparseable_value  — the result is not numeric ('Positive', 'Trace', 'Grew
--                        E. coli'). Perfectly valid as a result; simply cannot be
--                        compared against a numeric threshold.
--   unit_mismatch      — a reference row matched but the reported unit is not
--                        compatible with it. Comparing anyway would be worse than
--                        not comparing.
-- Only 'evaluated' means the check actually happened.
-- ---------------------------------------------------------------------------
create or replace function public.evaluate_lab_critical(
  p_test_name text,
  p_value     text,
  p_unit      text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_name    text := lower(trim(coalesce(p_test_name, '')));
  v_unit    text := lower(trim(coalesce(p_unit, '')));
  v_raw     text := trim(coalesce(p_value, ''));
  v_ref     record;
  v_match   text[];
  v_num     numeric;
  v_cmp     text := null;
  v_crit    boolean := false;
  v_dir     text := null;
begin
  if v_name = '' then
    return jsonb_build_object(
      'status', 'no_reference', 'is_critical', false, 'direction', null,
      'message', 'No test name supplied, so no thresholds could be looked up.');
  end if;

  -- Match on the canonical name, the code, or any alias.
  select r.test_code, r.test_name, r.unit, r.unit_aliases,
         r.critical_low, r.critical_high, r.normal_low, r.normal_high
    into v_ref
  from public.lab_critical_ranges r
  where r.test_name_normalized = v_name
     or r.test_code = v_name
     or v_name = any(r.aliases)
  limit 1;

  if not found then
    return jsonb_build_object(
      'status', 'no_reference',
      'is_critical', false,
      'direction', null,
      'message', 'No critical-value thresholds are on file for this test, so it could not be evaluated. Verify against the laboratory''s own reference range.');
  end if;

  -- ---- unit compatibility -------------------------------------------------
  -- An absent unit is treated as the reference unit. That is an assumption, and it
  -- is the pragmatic one: refusing to evaluate every result whose unit box was
  -- left blank would mean almost nothing ever got checked, which is a worse
  -- outcome than assuming the unit the reference publishes. The lab-entry UI
  -- should prefill `unit` from this table (it can — the table is readable) so the
  -- assumption is rarely load-bearing. A unit that is present and INCOMPATIBLE is
  -- a different matter and is refused outright.
  if v_unit <> '' and v_unit <> v_ref.unit and not (v_unit = any(v_ref.unit_aliases)) then
    return jsonb_build_object(
      'status', 'unit_mismatch',
      'is_critical', false,
      'direction', null,
      'test_code', v_ref.test_code,
      'reference_unit', v_ref.unit,
      'reported_unit', v_unit,
      'message', 'The reported unit does not match the reference unit for this test, so the value was not compared.');
  end if;

  -- ---- parse the value ----------------------------------------------------
  -- Accepts a plain number and the censored forms a lab actually reports
  -- ('<0.01', '>1000'). The comparator is kept for the payload: a '<' result that
  -- trips a LOW threshold is genuinely critical, and one that does not trip
  -- anything is still not a precise number.
  v_match := regexp_match(v_raw, '^([<>]=?)?\s*(-?[0-9]+(?:\.[0-9]+)?)\s*$');

  if v_match is null then
    return jsonb_build_object(
      'status', 'unparseable_value',
      'is_critical', false,
      'direction', null,
      'test_code', v_ref.test_code,
      'reference_unit', v_ref.unit,
      'message', 'This result is not a number, so it could not be compared against numeric thresholds. Interpret manually.');
  end if;

  v_cmp := v_match[1];
  v_num := v_match[2]::numeric;

  -- At or beyond a bound is critical. Inclusive on purpose: published critical
  -- limits are stated as "notify if K+ >= 6.2", and an exclusive test would let a
  -- result sitting exactly on the limit pass unremarked.
  if v_ref.critical_low is not null and v_num <= v_ref.critical_low then
    v_crit := true;
    v_dir  := 'low';
  elsif v_ref.critical_high is not null and v_num >= v_ref.critical_high then
    v_crit := true;
    v_dir  := 'high';
  end if;

  return jsonb_build_object(
    'status', 'evaluated',
    'is_critical', v_crit,
    'direction', v_dir,
    'test_code', v_ref.test_code,
    'test_name', v_ref.test_name,
    'value_numeric', v_num,
    'comparator', v_cmp,
    'reference_unit', v_ref.unit,
    'critical_low', v_ref.critical_low,
    'critical_high', v_ref.critical_high,
    'normal_low', v_ref.normal_low,
    'normal_high', v_ref.normal_high,
    'message', case
      when v_crit and v_dir = 'low'  then 'Critically low result.'
      when v_crit and v_dir = 'high' then 'Critically high result.'
      else 'Evaluated against the reference thresholds; not in the critical range.'
    end
  );
end;
$$;

comment on function public.evaluate_lab_critical(text, text, text) is
  'Decides whether a lab value is critical, and says which of four states the check reached: evaluated / no_reference / unparseable_value / unit_mismatch. Only ''evaluated'' means the check ran, so "could not evaluate" can never be rendered as "normal" (rules.md §3.4). SECURITY INVOKER — needs no elevated privilege.';

revoke execute on function public.evaluate_lab_critical(text, text, text) from public, anon;
grant  execute on function public.evaluate_lab_critical(text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Starter thresholds. Adult values, widely published in laboratory practice.
--
-- Deliberately omitted, and worth saying why rather than leaving a silent gap:
--   * troponin — critical cut-offs are ASSAY-specific, so a single number here
--     would be the reference table asserting something it cannot know. Better
--     reported as no_reference than confidently wrong.
--   * neonatal bilirubin — the adult row below is adult-only; a neonatal
--     threshold is age-in-hours dependent and needs a real age-stratified model.
-- ---------------------------------------------------------------------------
insert into public.lab_critical_ranges
  (test_code, test_name, aliases, unit, unit_aliases,
   critical_low, critical_high, normal_low, normal_high, source_note)
values
  ('potassium', 'Serum Potassium',
   array['k+','k','potassium','serum k+','s. potassium'], 'mmol/l', array['meq/l'],
   2.8, 6.2, 3.5, 5.1,
   'Monovalent ion: mmol/L and mEq/L are numerically identical.'),

  ('sodium', 'Serum Sodium',
   array['na+','na','sodium','serum na+','s. sodium'], 'mmol/l', array['meq/l'],
   120, 160, 135, 145,
   'Monovalent ion: mmol/L and mEq/L are numerically identical.'),

  ('glucose_random', 'Blood Glucose (Random)',
   array['rbs','random blood sugar','blood glucose','glucose','sugar random'], 'mg/dl', array['mgdl'],
   50, 450, 70, 140,
   'mg/dL, the Indian convention. Matches the unit used by vitals.blood_glucose.'),

  ('hemoglobin', 'Haemoglobin',
   array['hb','hgb','haemoglobin','hemoglobin'], 'g/dl', array['gm/dl','gdl'],
   7.0, 20.0, 12.0, 16.0,
   'Adult range spanning both sexes; sex-specific normals are narrower.'),

  ('platelet_count', 'Platelet Count',
   array['platelets','plt','platelet'], '/ul', array['cells/ul','per ul','/cumm','/mm3'],
   20000, 1000000, 150000, 450000, null),

  ('wbc_count', 'Total Leucocyte Count',
   array['tlc','wbc','wbc count','leucocyte count','total wbc'], '/ul', array['cells/ul','per ul','/cumm','/mm3'],
   2000, 30000, 4000, 11000, null),

  ('calcium_total', 'Serum Calcium (Total)',
   array['calcium','ca','serum calcium','s. calcium'], 'mg/dl', array[]::text[],
   6.5, 13.0, 8.5, 10.5,
   'Divalent ion: mEq/L is NOT interchangeable with mg/dL here, hence no unit aliases.'),

  ('creatinine', 'Serum Creatinine',
   array['creatinine','cr','serum creatinine','s. creatinine'], 'mg/dl', array[]::text[],
   null, 7.4, 0.6, 1.3,
   'No critical low: a low creatinine is not an emergency.'),

  ('inr', 'INR',
   array['inr','prothrombin inr','pt inr'], 'ratio', array[]::text[],
   null, 5.0, 0.8, 1.2,
   'Unitless ratio. Critical high only.'),

  ('bilirubin_total', 'Serum Bilirubin (Total)',
   array['bilirubin','total bilirubin','t. bilirubin','s. bilirubin'], 'mg/dl', array[]::text[],
   null, 15.0, 0.2, 1.2,
   'ADULT threshold. Neonatal jaundice thresholds are age-in-hours dependent and are NOT represented here.'),

  ('magnesium', 'Serum Magnesium',
   array['magnesium','mg','serum magnesium','s. magnesium'], 'mg/dl', array[]::text[],
   1.0, 4.7, 1.7, 2.4, null),

  ('ph_arterial', 'Arterial pH',
   array['ph','arterial ph','abg ph'], 'ph', array[]::text[],
   7.20, 7.60, 7.35, 7.45,
   'Unitless; `ph` is recorded as the unit so the mismatch check has something to compare.'),

  ('pco2_arterial', 'Arterial pCO2',
   array['pco2','paco2','arterial pco2'], 'mmhg', array[]::text[],
   20, 70, 35, 45, null),

  ('po2_arterial', 'Arterial pO2',
   array['po2','pao2','arterial po2'], 'mmhg', array[]::text[],
   40, null, 80, 100,
   'No critical high: a high pO2 on supplemental oxygen is expected, not critical.')
on conflict (test_code) do nothing;
