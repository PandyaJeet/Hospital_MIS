-- ============================================================================
-- Migration:  medication_administrations
--             + record_medication_administration()  (the barcode/QR validation)
--
-- phases.md asks for "barcode/QR med-administration logic (data model +
-- validation)". The scanner, the camera permission and the decoding are entirely
-- Prince's; a scan is just a string by the time it reaches the database. What is
-- owned here is the part that makes the scan MEAN something: the server-side check
-- that the string identifies the same patient the prescription was written for.
--
-- ---------------------------------------------------------------------------
-- WHY THE VALIDATION CANNOT LIVE IN THE UI
-- ---------------------------------------------------------------------------
-- The clinical "five rights" (right patient, drug, dose, route, time) are a
-- process, and most of them are a human's job. Exactly one of them is mechanisable
-- and is the reason barcode administration exists at all: RIGHT PATIENT. A
-- wrong-patient administration is the error class that scanning was invented to
-- catch, and a check that runs in the client is not a check — a stale page, a
-- mis-wired component or a hurried override defeats it silently.
--
-- So `p_scanned_patient_code` is a REQUIRED parameter with no default, the RPC is
-- the only way to write this table (no client INSERT grant), and a blank code is
-- a loud failure (`SCAN_REQUIRED`) rather than a skipped check. That is
-- rules.md §3.4 applied literally: a safety check that did not run must never
-- look like one that passed.
--
-- ---------------------------------------------------------------------------
-- THE THREE FAILURES ARE THREE CODES, NOT ONE
-- ---------------------------------------------------------------------------
--   PATIENT_MISMATCH           — the code resolved to a real patient, and it is
--                                NOT this prescription's patient. The dangerous
--                                one. Its own code because the UI must interrupt
--                                hard here, in the same way a high-severity
--                                interaction does, and must not render it as a
--                                generic "could not save".
--   PATIENT_CODE_UNRECOGNISED  — the code resolved to nobody. A smudged
--                                wristband, a band from another clinic, a
--                                mis-decode. NOT the same as a mismatch, and
--                                emphatically not the same as a pass: the nurse
--                                must re-scan or verify by hand.
--   SCAN_REQUIRED              — no code was supplied at all.
--
-- Same reasoning as check_prescription_safety()'s complete/partial split: "we
-- could not tell" is a third state, never folded into either answer.
--
-- ---------------------------------------------------------------------------
-- DUPLICATE DOSES: DETECTED AND REPORTED, NOT BLOCKED BY A CONSTRAINT
-- ---------------------------------------------------------------------------
-- A unique index on (prescription_item_id, status='given') would be wrong, not
-- strict. `prescription_items.frequency` is free text from Phase 2 ('TDS', '1-0-1'),
-- so ONE item legitimately means several doses a day — three administrations of
-- the same item is the normal case, not an error.
--
-- What is worth catching is the accidental double-tap or the second nurse who did
-- not know the first had already given it. So the RPC LOOKS for a previous 'given'
-- administration of the same item and returns `ALREADY_ADMINISTERED` with when and
-- by whom, plus `can_override: true`. The caller re-submits with
-- p_allow_repeat => true for a genuine subsequent dose. This is the same
-- soft-detection-with-override shape register_patient() uses for duplicate phone
-- numbers, and for the same reason: a hard constraint would make a legitimate
-- action impossible and push staff into working around the system.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT BUILT
-- ---------------------------------------------------------------------------
-- No dose scheduling. "This drug is due at 08:00, 14:00, 20:00" needs structured
-- timing, and `prescription_items.frequency` is free text. Inferring a schedule
-- from 'TDS' would be the system inventing clinical timing nobody entered.
-- Administrations are therefore logged against an ITEM, not against a scheduled
-- occurrence. Recorded as a gap in docs/contracts/nurse-tasks.md.
--
-- Also not built: scanning the DRUG barcode. That needs per-clinic pharmacy stock
-- with barcodes on packs, which is a Tier 3 inventory concern and does not exist.
-- Right-drug remains the nurse's read of the label.
-- ============================================================================

create table if not exists public.medication_administrations (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null references public.tenants (id) on delete restrict,

  -- What was given. The composite FK needs the constraint added in
  -- 20260811070000.
  prescription_item_id uuid        not null,

  -- Denormalised from the item's prescription so the ward view can list "what was
  -- given during this admission" without a two-hop join, and so the composite FK
  -- below anchors the row to a tenant-consistent encounter. Kept honest by the
  -- RPC, which derives it rather than accepting it.
  visit_id             uuid        not null,

  administered_by      uuid        not null,
  administered_at      timestamptz not null default now(),

  -- 'refused' and 'held' are not failures to record — they are clinically
  -- important events. A patient refusing a dose, or a nurse withholding it
  -- pending review, must both be documented, and "no row at all" cannot express
  -- the difference between those and a dose nobody got round to.
  status               text        not null,

  notes                text        null,

  -- What the scanner actually produced, so a later review can see the check was
  -- performed and against what. Stores the FORM of the code and the patient it
  -- resolved to, never a raw wristband payload that might carry more than an id.
  scan_basis           text        not null,

  created_at           timestamptz not null default now(),

  constraint medication_administrations_status_valid check (
    status in ('given', 'refused', 'held')
  ),
  constraint medication_administrations_scan_basis_valid check (
    scan_basis in ('patient_id', 'patient_number')
  ),

  constraint medication_administrations_item_same_tenant
    foreign key (prescription_item_id, tenant_id)
    references public.prescription_items (id, tenant_id)
    on delete restrict,

  constraint medication_administrations_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  -- RESTRICT, consistent with every other clinician reference in this schema:
  -- deleting a staff account must not detach them from a dose they gave.
  constraint medication_administrations_by_same_tenant
    foreign key (administered_by, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict
);

comment on table public.medication_administrations is
  'Immutable log of medication given / refused / held. Written only by record_medication_administration(), which enforces the right-patient check server-side. No client INSERT, UPDATE or DELETE — see migration header.';
comment on column public.medication_administrations.scan_basis is
  'How the scanned code resolved: ''patient_id'' (uuid on the band) or ''patient_number'' (UHID). Records that the check happened and in what form, without storing the raw scanned payload.';
comment on column public.medication_administrations.status is
  'given | refused | held. A refusal or a withheld dose is a clinical event that must be recorded, not an absence of a row.';

-- The medication administration record (MAR) for an admission, newest first.
create index if not exists med_admin_visit_idx on public.medication_administrations (visit_id, administered_at desc);
-- "has this item been given?" — the duplicate check's lookup.
create index if not exists med_admin_item_idx  on public.medication_administrations (prescription_item_id, administered_at desc);
create index if not exists med_admin_tenant_idx on public.medication_administrations (tenant_id, administered_at desc);


-- ---------------------------------------------------------------------------
-- RLS
--
-- READ: admin, doctor, nurse. Not billing — the MAR is clinical, and Phase 2
-- already settled that billing gets the drug list it needs from `prescriptions`
-- (which it can read, for dispensing) rather than from clinical records.
--
-- WRITE: nothing is granted. No INSERT, so the right-patient check cannot be
-- bypassed by a direct PostgREST call. No UPDATE and no DELETE, so the log is
-- append-only — an administration record is evidence about a controlled act, and
-- editing it after the fact is exactly what an audit trail exists to prevent.
--
-- Consequence to be honest about: a genuinely mistaken entry cannot currently be
-- corrected or voided. A 'voided' status plus an amendment reason belongs with the
-- Phase 4 audit log; noted as a gap in the contract rather than half-built here.
-- ---------------------------------------------------------------------------
alter table public.medication_administrations enable row level security;

revoke all on public.medication_administrations from anon, authenticated;

grant select on public.medication_administrations to authenticated;

create policy medication_administrations_select_clinical
  on public.medication_administrations
  for select
  to authenticated
  using (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
  );


-- ---------------------------------------------------------------------------
-- record_medication_administration()
--
-- SECURITY DEFINER: the table has no client INSERT grant precisely so this is the
-- only door. Every stored value is derived server-side — tenant, visit and
-- patient all come from the prescription item, never from the caller (rules.md
-- §1.2).
--
-- PII (rules.md §1.3): the scanned code is never echoed back, never logged, and
-- never put in a message. A PATIENT_MISMATCH response says that the code belongs
-- to a different patient; it does not say which one, because the whole point is
-- that the nurse is at the wrong bedside and must not be handed a second
-- patient's identity as a consolation prize.
-- ---------------------------------------------------------------------------
create or replace function public.record_medication_administration(
  p_prescription_item_id uuid,
  p_scanned_patient_code text,
  p_status               text default 'given',
  p_notes                text default null,
  p_allow_repeat         boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_tenant     uuid;
  v_status     text := lower(trim(coalesce(p_status, '')));
  v_code       text := trim(coalesce(p_scanned_patient_code, ''));
  v_item       record;
  v_scanned_id uuid;
  v_basis      text;
  v_digits     text;
  v_prev       record;
  v_id         uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.has_tenant_role(array['admin', 'doctor', 'nurse']) then
    return jsonb_build_object('ok', false, 'code', 'NOT_CLINICAL_STAFF',
      'message', 'Only nursing, medical or admin staff can record a medication administration.');
  end if;

  if v_status not in ('given', 'refused', 'held') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Status must be given, refused or held.',
      'fields', jsonb_build_array('p_status'));
  end if;

  -- The check is mandatory. Refusing to proceed without a scan is the entire
  -- safety value of the feature; defaulting to "trust the caller" would make the
  -- rest of this function decoration.
  if v_code = '' then
    return jsonb_build_object('ok', false, 'code', 'SCAN_REQUIRED',
      'message', 'Scan the patient''s identification band before recording an administration.',
      'fields', jsonb_build_array('p_scanned_patient_code'));
  end if;

  v_tenant := public.current_tenant_id();

  -- ---- resolve the item, its prescription, its visit and its patient -------
  select pi.id                as item_id,
         pi.drug_name         as drug_name,
         pi.dose              as dose,
         p.id                 as prescription_id,
         p.status             as prescription_status,
         v.id                 as visit_id,
         v.patient_id         as patient_id
    into v_item
  from public.prescription_items pi
  join public.prescriptions p on p.id = pi.prescription_id and p.tenant_id = pi.tenant_id
  join public.visits v        on v.id = p.visit_id        and v.tenant_id = p.tenant_id
  where pi.id = p_prescription_item_id
    and pi.tenant_id = v_tenant;

  if not found then
    -- Identical answer for "no such item" and "another clinic's item", so this
    -- cannot be used to probe other tenants.
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_ITEM_NOT_FOUND',
      'message', 'That prescribed medicine does not exist at this clinic.');
  end if;

  -- ---- the prescription must actually be in force -------------------------
  -- A draft is a doctor still composing; giving a drug off it means giving
  -- something that was never authorised. A cancelled prescription is an explicit
  -- instruction not to.
  if v_item.prescription_status = 'draft' then
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_NOT_ISSUED',
      'message', 'That prescription is still a draft and has not been issued.');
  end if;

  if v_item.prescription_status = 'cancelled' then
    return jsonb_build_object('ok', false, 'code', 'PRESCRIPTION_CANCELLED',
      'message', 'That prescription was cancelled. Do not administer.');
  end if;

  -- ---- RIGHT PATIENT ------------------------------------------------------
  -- Two accepted code forms, so Prince can encode whichever fits the band
  -- printer: the patient uuid, or the human UHID (patient_number) with or without
  -- any prefix/punctuation. Both are resolved within the caller's tenant only —
  -- a band from another clinic cannot resolve at all.
  if v_code ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select pt.id into v_scanned_id
    from public.patients pt
    where pt.id = v_code::uuid and pt.tenant_id = v_tenant;
    v_basis := 'patient_id';
  else
    v_digits := regexp_replace(v_code, '\D', '', 'g');
    -- Bounded before the cast: an unbounded digit run would overflow bigint and
    -- raise 22003, which would surface as an opaque 500 instead of a clean
    -- "unrecognised code".
    if v_digits <> '' and length(v_digits) <= 18 then
      select pt.id into v_scanned_id
      from public.patients pt
      where pt.patient_number = v_digits::bigint and pt.tenant_id = v_tenant;
    end if;
    v_basis := 'patient_number';
  end if;

  if v_scanned_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'PATIENT_CODE_UNRECOGNISED',
      'message', 'That identification code does not match any patient at this clinic. Re-scan or verify manually.',
      -- Explicitly says the check did not complete, so this can never be
      -- mistaken for a passed check (rules.md §3.4).
      'patient_verified', false
    );
  end if;

  if v_scanned_id <> v_item.patient_id then
    return jsonb_build_object(
      'ok', false,
      'code', 'PATIENT_MISMATCH',
      'message', 'STOP — the scanned patient is not the patient this medicine was prescribed for.',
      'patient_verified', false,
      -- Deliberately no names, no ids, no UHIDs of either patient. The nurse is at
      -- the wrong bedside; the remedy is to stop, not to be shown a second
      -- patient's identity (rules.md §1.3).
      'requires_acknowledgement', true
    );
  end if;

  -- ---- duplicate-dose detection (soft, overridable) -----------------------
  if v_status = 'given' and not coalesce(p_allow_repeat, false) then
    select ma.id, ma.administered_at, ma.administered_by into v_prev
    from public.medication_administrations ma
    where ma.prescription_item_id = p_prescription_item_id
      and ma.tenant_id = v_tenant
      and ma.status = 'given'
    order by ma.administered_at desc
    limit 1;

    if found then
      return jsonb_build_object(
        'ok', false,
        'code', 'ALREADY_ADMINISTERED',
        'message', 'This medicine has already been recorded as given.',
        'patient_verified', true,
        'previous_administration', jsonb_build_object(
          'id', v_prev.id,
          'administered_at', v_prev.administered_at,
          'administered_by', v_prev.administered_by
        ),
        -- A later dose of the same item is legitimate (frequency is free text —
        -- 'TDS' is one item, three doses), so this is a prompt, not a wall.
        'can_override', true
      );
    end if;
  end if;

  insert into public.medication_administrations (
    tenant_id, prescription_item_id, visit_id,
    administered_by, status, notes, scan_basis
  )
  values (
    v_tenant, p_prescription_item_id, v_item.visit_id,
    v_uid, v_status, nullif(trim(coalesce(p_notes, '')), ''), v_basis
  )
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'administration_id', v_id,
    'prescription_item_id', p_prescription_item_id,
    'visit_id', v_item.visit_id,
    'status', v_status,
    -- Positive confirmation that the right-patient check ran AND passed. The UI
    -- should show this, not assume it: a silent success looks identical to a
    -- check that was never performed.
    'patient_verified', true,
    'scan_basis', v_basis,
    'drug_name', v_item.drug_name,
    'dose', v_item.dose
  );
end;
$$;

comment on function public.record_medication_administration(uuid, text, text, text, boolean) is
  'Records a medication administration after verifying server-side that the scanned code identifies the prescription''s own patient. PATIENT_MISMATCH and PATIENT_CODE_UNRECOGNISED are distinct codes, and a missing code is SCAN_REQUIRED — a check that did not run never looks like one that passed. Duplicate ''given'' doses return ALREADY_ADMINISTERED with can_override.';

revoke execute on function public.record_medication_administration(uuid, text, text, text, boolean) from public, anon;
grant  execute on function public.record_medication_administration(uuid, text, text, text, boolean) to authenticated;
