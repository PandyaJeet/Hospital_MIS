-- ============================================================================
-- Migration:  drug_reference  (drugs + drug_interactions)
--
-- ############################################################################
-- #  !! THIS IS A STARTER DATASET FOR INTERACTION-CHECKING.                   #
-- #  !! IT IS NOT A CERTIFIED OR EXHAUSTIVE DRUG DATABASE.                    #
-- #                                                                           #
-- #  It holds on the order of dozens of common Indian OPD drugs and a small    #
-- #  set of well-known interaction pairs. It is adequate to make the           #
-- #  silent-by-default / hard-interrupt-on-high-severity behaviour real, and    #
-- #  nothing more. It has NOT been clinically reviewed, it is NOT a substitute #
-- #  for a licensed drug-interaction service, and absence of a finding is NOT  #
-- #  evidence of safety.                                                      #
-- #                                                                           #
-- #  This is why check_prescription_safety() reports `status: 'partial'` and    #
-- #  lists `unknown_drugs` whenever any prescribed drug is not in this table — #
-- #  so "we don't know" can never be rendered as "all clear" (rules.md §3.4).  #
-- #  Before a real clinic relies on this, it needs either clinical review or   #
-- #  replacement with a licensed data source. Logged in Memory.md §6.          #
-- ############################################################################
--
-- DELIBERATE EXCEPTION TO rules.md §4.1 (every table must have tenant_id)
-- These two tables have NO tenant_id and are NOT tenant-scoped. rules.md §4.1
-- governs *business* tables — rows owned by and private to one clinic. This is
-- shared, non-tenant REFERENCE data: paracetamol is paracetamol in every clinic.
-- Adding tenant_id would mean duplicating the whole drug list per tenant, which
-- multiplies storage, makes a correction have to be applied N times, and creates
-- the possibility of clinics silently disagreeing about a drug interaction.
--
-- The isolation requirement is still honoured, just in the other direction: RLS
-- is enabled, and clients get READ-ONLY access. No tenant can modify what
-- another tenant sees, because no tenant can modify this at all. Maintenance is
-- a platform-owner action via migrations or service_role (PRD §6.6).
--
-- If per-tenant formularies or per-tenant pricing are ever needed, the right
-- shape is a separate tenant-scoped `tenant_drug_prices` table joining to this
-- one — not tenant_id bolted onto the reference data.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- drugs
-- ---------------------------------------------------------------------------
create table if not exists public.drugs (
  id                       uuid    primary key default gen_random_uuid(),

  -- Indian prescribing is brand-heavy, but interaction logic must work on the
  -- molecule, so both are first-class. generic_name is the join key for
  -- interactions; brand_name is what a doctor searches for.
  brand_name               text    not null,
  generic_name             text    not null,

  -- Normalised for matching, so lookups do not depend on capitalisation or
  -- stray whitespace in either the reference data or the prescription.
  generic_name_normalized  text    generated always as (lower(trim(generic_name))) stored,
  brand_name_normalized    text    generated always as (lower(trim(brand_name))) stored,

  form                     text    null,   -- tablet, syrup, injection, ...
  strength                 text    null,   -- '500 mg', '5 mg/5 ml'
  drug_class               text    null,   -- 'NSAID', 'macrolide antibiotic'

  -- Allergy cross-reference tags, e.g. {penicillin,beta_lactam}. A patient's
  -- free-text `allergies` is matched against these. Array rather than a child
  -- table because a drug belongs to a handful of allergy families and this keeps
  -- the check a single indexed containment test.
  allergy_tags             text[]  not null default '{}',

  -- The molecules to evaluate interactions against. Necessary because Indian
  -- prescribing is dominated by fixed-dose COMBINATIONS: Combiflam is ibuprofen
  -- + paracetamol, Augmentin is amoxicillin + clavulanic acid. If interactions
  -- were matched on `generic_name`, a combination product's concatenated name
  -- ('ibuprofen + paracetamol') would match no interaction pair and the
  -- ibuprofen–warfarin interaction would be silently missed — a false negative
  -- in exactly the place rules.md §3.4 warns about.
  --
  -- Empty means "use generic_name_normalized", so single-molecule drugs need no
  -- duplication.
  interaction_generics     text[]  not null default '{}',

  -- Indicative MRP in INR, used by the billing trigger to auto-price a
  -- dispensed item. Nullable: unknown price yields a zero-amount line that
  -- billing can edit, which is honest, rather than a silently invented figure.
  mrp                      numeric(12, 2) null,

  -- Per-drug GST rate. NULL means "use the default medicine rate" (5%, per the
  -- Sept 2025 GST Council rationalisation). Set explicitly to 0 for the specific
  -- life-saving drugs that are fully exempt — without this column the billing
  -- trigger would tax them at the blanket rate, which would be wrong on the
  -- invoice. Only consulted when the tenant is GST-registered.
  gst_rate                 numeric(5, 2) null,

  is_otc                   boolean not null default false,
  notes                    text    null,
  created_at               timestamptz not null default now(),

  constraint drugs_brand_not_blank   check (length(trim(brand_name)) > 0),
  constraint drugs_generic_not_blank check (length(trim(generic_name)) > 0),
  constraint drugs_mrp_non_negative  check (mrp is null or mrp >= 0),
  constraint drugs_gst_rate_sane     check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  constraint drugs_brand_generic_unique unique (brand_name, generic_name, strength)
);

comment on table public.drugs is
  'STARTER drug reference for interaction/allergy checking — NOT a certified or exhaustive drug database, and not clinically reviewed. Non-tenant shared reference data: read-only to clients, maintained by the platform owner. See migration header.';
comment on column public.drugs.allergy_tags is
  'Allergy families this drug belongs to (e.g. {penicillin,beta_lactam}). Matched against patients.allergies free-text by check_prescription_safety().';
comment on column public.drugs.mrp is
  'Indicative price used to auto-price dispensed medicines. NULL deliberately produces a zero-amount billing line for staff to complete rather than a guessed figure.';

comment on column public.drugs.interaction_generics is
  'Molecules to check interactions against. Set explicitly for fixed-dose combinations so a combo product still matches single-molecule interaction pairs. Empty falls back to generic_name_normalized.';

create index if not exists drugs_generic_idx      on public.drugs (generic_name_normalized);
create index if not exists drugs_brand_idx        on public.drugs (brand_name_normalized);
create index if not exists drugs_allergy_tags_idx on public.drugs using gin (allergy_tags);
create index if not exists drugs_interaction_idx  on public.drugs using gin (interaction_generics);


-- ---------------------------------------------------------------------------
-- drug_interactions
--
-- Pairs are stored in CANONICAL ORDER (generic_a < generic_b) and enforced by a
-- CHECK. Without that, {warfarin, aspirin} and {aspirin, warfarin} are two rows
-- and a lookup that only tries one ordering silently misses the interaction —
-- exactly the class of false-negative that rules.md §3.4 is about. With it,
-- storage and lookup both normalise the same way and the unique constraint
-- actually prevents duplicates.
-- ---------------------------------------------------------------------------
create table if not exists public.drug_interactions (
  id           uuid    primary key default gen_random_uuid(),
  generic_a    text    not null,
  generic_b    text    not null,

  -- The contract with the UI. 'high' is the only value that justifies a hard
  -- interrupt (PRD §6.1, rules.md §6.4); low/medium are shown passively.
  severity     text    not null,

  description  text    not null,
  -- Where the pairing came from, so a reviewer can audit the starter dataset.
  source_note  text    null,
  created_at   timestamptz not null default now(),

  constraint drug_interactions_severity_valid check (severity in ('low', 'medium', 'high')),
  constraint drug_interactions_canonical_order check (generic_a < generic_b),
  constraint drug_interactions_normalized check (
    generic_a = lower(trim(generic_a)) and generic_b = lower(trim(generic_b))
  ),
  constraint drug_interactions_pair_unique unique (generic_a, generic_b)
);

comment on table public.drug_interactions is
  'STARTER interaction pairs, stored in canonical order (generic_a < generic_b) so lookup cannot miss a reversed pair. severity drives the UI: only ''high'' warrants a hard interrupt. Not clinically reviewed.';

create index if not exists drug_interactions_a_idx on public.drug_interactions (generic_a);
create index if not exists drug_interactions_b_idx on public.drug_interactions (generic_b);


-- ---------------------------------------------------------------------------
-- RLS — enabled on both, read-only to clients.
--
-- Any onboarded staff member can read (a doctor needs autosuggest; billing needs
-- MRP to price a dispensed item). Nobody gets INSERT/UPDATE/DELETE: not granted
-- and no policy exists, so writes are impossible from a client session even for
-- an admin. That is what replaces tenant scoping as the isolation guarantee here.
-- ---------------------------------------------------------------------------
alter table public.drugs             enable row level security;
alter table public.drug_interactions enable row level security;

revoke all on public.drugs             from anon, authenticated;
revoke all on public.drug_interactions from anon, authenticated;

grant select on public.drugs             to authenticated;
grant select on public.drug_interactions to authenticated;

create policy drugs_select_staff
  on public.drugs
  for select
  to authenticated
  using (public.is_tenant_staff());

create policy drug_interactions_select_staff
  on public.drug_interactions
  for select
  to authenticated
  using (public.is_tenant_staff());
