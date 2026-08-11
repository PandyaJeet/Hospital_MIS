-- ============================================================================
-- Migration:  prescription_safety_check
--
-- PRD §6.1 / rules.md §6.4: "Silent-by-default interaction/allergy checking;
-- hard interrupt only for high-severity combinations."
-- rules.md §3.4: "a failed safety check must fail loud — never let a failed
-- safety check look like a passed one."
--
-- Those two requirements together dictate the entire return shape.
--
-- 1. SEVERITY PER FINDING, NOT A BOOLEAN.
--    Returning true/false would decide the interaction design on the frontend's
--    behalf: Prince could only ever render one treatment for all findings, and
--    "silent by default, interrupt on high" becomes impossible to implement.
--    So every finding carries its own severity ('low' | 'medium' | 'high') and
--    the UI chooses: inline badge for low/medium, blocking modal for high.
--    `highest_severity` and `requires_acknowledgement` are conveniences derived
--    from the findings — they are not a substitute for reading them.
--
-- 2. "CHECKED, FOUND NOTHING" MUST NOT LOOK LIKE "COULD NOT CHECK".
--    An empty findings array is ambiguous in the worst possible direction, so
--    the result carries an explicit `status`:
--        'complete' — every drug was resolved and the patient's allergies were
--                     on record. An empty findings list here really does mean
--                     nothing was found.
--        'partial'  — the check ran but could not see everything. `warnings`
--                     says why. The UI MUST surface "verify manually" for this.
--    and genuine failure returns { ok: false, code: 'SAFETY_CHECK_UNAVAILABLE' },
--    which is a third, separate state.
--
--    Two things trigger 'partial', and the second is the one that is easy to
--    miss:
--      UNKNOWN_DRUGS         — a prescribed drug is not in the starter reference
--                              list, so no interaction could be evaluated for it.
--      NO_ALLERGIES_RECORDED — the patient's allergy field is empty. That means
--                              nobody asked, NOT that the patient has no
--                              allergies. Reporting 'complete' for an
--                              unrecorded allergy history would be the system
--                              asserting something it does not know.
--
-- 3. SECURITY INVOKER, deliberately.
--    Unlike the other RPCs in this phase, this one needs no elevated privilege:
--    a doctor can already read their own tenant's patients and the shared drug
--    reference. Running as the caller means RLS still applies, so passing another
--    tenant's patient id simply resolves to nothing and returns
--    PATIENT_NOT_FOUND. Least privilege is available here, so it is used.
--
-- KNOWN LIMITATION — allergy matching is textual.
-- `patients.allergies` is free text this phase, matched against
-- `drugs.allergy_tags`. That can false-positive (a note reading "no penicillin
-- allergy" matches the penicillin tag). That is the deliberately safe direction:
-- a spurious warning is an annoyance, a missed allergy is a patient-safety event.
-- Each finding carries `match_basis` so the UI can show what was matched and let
-- the clinician judge. Structured allergy capture is the real fix and belongs
-- with a future phase.
-- ============================================================================

create or replace function public.check_prescription_safety(
  p_patient_id uuid,
  p_drug_names text[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tenant        uuid;
  v_allergies     text;
  v_has_patient   boolean := false;
  v_names         text[];
  v_findings      jsonb := '[]'::jsonb;
  v_warnings      jsonb := '[]'::jsonb;
  v_unknown       text[] := '{}';
  v_generics      text[] := '{}';
  v_status        text;
  v_highest       text := null;
  v_name          text;
  v_generic       text;
  v_molecules     text[];
  v_mol           text;
  v_row           record;
begin
  v_tenant := public.current_tenant_id();

  if (select auth.uid()) is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED',
      'message', 'You must be signed in.');
  end if;

  if not public.is_tenant_staff() then
    return jsonb_build_object('ok', false, 'code', 'NOT_STAFF',
      'message', 'Only clinic staff can run a safety check.');
  end if;

  -- ---- resolve the patient (RLS-filtered, so cross-tenant ids just miss) ----
  select true, pt.allergies
    into v_has_patient, v_allergies
  from public.patients pt
  where pt.id = p_patient_id;

  if not coalesce(v_has_patient, false) then
    return jsonb_build_object('ok', false, 'code', 'PATIENT_NOT_FOUND',
      'message', 'That patient is not registered at this clinic.');
  end if;

  -- ---- normalise the requested drug list ----
  select coalesce(array_agg(distinct lower(trim(n))), '{}')
    into v_names
  from unnest(coalesce(p_drug_names, '{}')) as n
  where nullif(trim(n), '') is not null;

  if array_length(v_names, 1) is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'Provide at least one drug to check.',
      'fields', jsonb_build_array('p_drug_names'));
  end if;

  -- Everything below is wrapped so that an unexpected fault becomes an explicit
  -- "unavailable" answer rather than a 500 the UI might mistake for "no
  -- findings". This is the opposite of swallowing an error (rules.md §3.2): the
  -- caller is told louder, not more quietly. Only the SQLSTATE is returned —
  -- never the message, which could contain patient data (rules.md §1.3).
  begin
    -- ---- resolve each name to a generic, or record it as unknown ----
    foreach v_name in array v_names loop
      -- Resolve by brand or generic, and pull the molecule list. For a
      -- fixed-dose combination `interaction_generics` holds each constituent, so
      -- a combo is checked against single-molecule interaction pairs; for a plain
      -- drug it is empty and we fall back to the generic name.
      select d.generic_name_normalized,
             case
               when array_length(d.interaction_generics, 1) is null
                 then array[d.generic_name_normalized]
               else d.interaction_generics
             end
        into v_generic, v_molecules
      from public.drugs d
      where d.brand_name_normalized = v_name
         or d.generic_name_normalized = v_name
      limit 1;

      if v_generic is null then
        v_unknown := v_unknown || v_name;
      else
        foreach v_mol in array coalesce(v_molecules, '{}') loop
          if not (v_mol = any(v_generics)) then
            v_generics := v_generics || v_mol;
          end if;
        end loop;

        -- ---- allergy check for this drug ----
        if nullif(trim(coalesce(v_allergies, '')), '') is not null then
          for v_row in
            select tag
            from public.drugs d, unnest(d.allergy_tags) as tag
            where d.generic_name_normalized = v_generic
          loop
            if position(lower(replace(v_row.tag, '_', ' ')) in lower(v_allergies)) > 0
               or position(lower(v_row.tag) in lower(v_allergies)) > 0 then
              v_findings := v_findings || jsonb_build_object(
                'finding_type', 'allergy',
                -- Prescribing into a documented allergy is the archetypal
                -- hard-interrupt case.
                'severity', 'high',
                'drug_a', v_name,
                'drug_b', null,
                'description', 'Patient''s recorded allergies mention "'
                               || replace(v_row.tag, '_', ' ')
                               || '", which this drug belongs to.',
                'match_basis', 'allergy_tag:' || v_row.tag
              );
              v_highest := 'high';
            end if;
          end loop;

          -- Direct mention of any constituent molecule. Looped over the molecule
          -- list rather than the display generic so a combination product is
          -- caught when the patient is allergic to just one of its ingredients.
          foreach v_mol in array coalesce(v_molecules, '{}') loop
            if position(v_mol in lower(v_allergies)) > 0 then
              v_findings := v_findings || jsonb_build_object(
                'finding_type', 'allergy',
                'severity', 'high',
                'drug_a', v_name,
                'drug_b', null,
                'description', 'Patient''s recorded allergies mention '
                               || v_mol || ', which this drug contains.',
                'match_basis', 'generic_name:' || v_mol
              );
              v_highest := 'high';
            end if;
          end loop;
        end if;
      end if;
    end loop;

    -- ---- pairwise interactions across resolved generics ----
    -- Pairs are compared in canonical order, matching how drug_interactions
    -- stores them, so a reversed pair cannot be missed.
    for v_row in
      select di.severity, di.description, di.generic_a, di.generic_b
      from public.drug_interactions di
      where di.generic_a = any(v_generics)
        and di.generic_b = any(v_generics)
    loop
      v_findings := v_findings || jsonb_build_object(
        'finding_type', 'interaction',
        'severity', v_row.severity,
        'drug_a', v_row.generic_a,
        'drug_b', v_row.generic_b,
        'description', v_row.description,
        'match_basis', 'interaction_pair'
      );
      if v_row.severity = 'high' then
        v_highest := 'high';
      elsif v_row.severity = 'medium' and v_highest is distinct from 'high' then
        v_highest := 'medium';
      elsif v_row.severity = 'low' and v_highest is null then
        v_highest := 'low';
      end if;
    end loop;

  exception
    when others then
      return jsonb_build_object(
        'ok', false,
        'code', 'SAFETY_CHECK_UNAVAILABLE',
        'message', 'Interaction check unavailable — verify manually.',
        'sqlstate', sqlstate
      );
  end;

  -- ---- assemble status + warnings ----
  if array_length(v_unknown, 1) is not null then
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'UNKNOWN_DRUGS',
      'message', 'Some drugs are not in the reference list and could not be checked.'
    );
  end if;

  if nullif(trim(coalesce(v_allergies, '')), '') is null then
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'NO_ALLERGIES_RECORDED',
      'message', 'No allergy history is recorded for this patient, so no allergy check was possible.'
    );
  end if;

  v_status := case when jsonb_array_length(v_warnings) > 0 then 'partial' else 'complete' end;

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'findings', v_findings,
    'warnings', v_warnings,
    'unknown_drugs', to_jsonb(v_unknown),
    'checked_drug_count', array_length(v_names, 1),
    'highest_severity', v_highest,
    -- Convenience for the UI's interrupt decision. A 'partial' result also
    -- demands acknowledgement even with no findings, because "we could not
    -- check" is information the clinician must actively see.
    --
    -- coalesce is load-bearing: v_highest is NULL on a clean check, and
    -- `NULL = 'high' or false` evaluates to NULL, not false. Shipping a NULL in a
    -- safety-critical boolean would put the burden of three-valued logic on the
    -- frontend for the one field that must never be ambiguous.
    'requires_acknowledgement', (coalesce(v_highest, '') = 'high' or v_status = 'partial'),
    'allergies_recorded', (nullif(trim(coalesce(v_allergies, '')), '') is not null),
    'reference_disclaimer',
      'Starter reference dataset, not a certified drug database. Absence of a finding is not confirmation of safety.'
  );
end;
$$;

comment on function public.check_prescription_safety(uuid, text[]) is
  'Interaction + allergy check. Returns a severity per finding (never a boolean) so the UI can be silent-by-default and interrupt only on high. status=partial with warnings when drugs are unresolved or no allergy history exists, so "could not check" is never rendered as "all clear". SECURITY INVOKER — needs no elevated privilege.';

revoke execute on function public.check_prescription_safety(uuid, text[]) from public, anon;
grant  execute on function public.check_prescription_safety(uuid, text[]) to authenticated;
