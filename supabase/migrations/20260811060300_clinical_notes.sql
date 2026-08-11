-- ============================================================================
-- Migration:  clinical_notes
-- Purpose:    The doctor's record of an encounter.
--
-- ############################################################################
-- #  rules.md §1.7 — EVERY CLINICAL FREE-TEXT COLUMN IN THIS TABLE IS         #
-- #  NULLABLE. A doctor must be able to hit save on a blank or half-filled    #
-- #  note and have it persist. This is a product requirement, not a style     #
-- #  preference: mandatory fields are precisely what drives clinicians back   #
-- #  to paper (PRD §3, §6.1).                                                 #
-- #                                                                           #
-- #  Nullable clinical columns:                                               #
-- #    template_type, chief_complaint, history, examination, diagnosis,        #
-- #    advice, follow_up_instructions, note_text                              #
-- #                                                                           #
-- #  The only NOT NULL columns are structural, not content:                   #
-- #    id, tenant_id, visit_id, author_id, created_at, updated_at             #
-- #  These are "which encounter, whose clinic, who wrote it" — they are what   #
-- #  makes the row addressable and tenant-safe. None of them is something a   #
-- #  doctor types into a form, so none of them can block a save.              #
-- #                                                                           #
-- #  Do NOT add a NOT NULL or a "at least one field must be present" CHECK to  #
-- #  this table later. An empty note is a legitimate state — it means the      #
-- #  doctor opened the encounter and saved before writing anything.            #
-- ############################################################################
--
-- MULTIPLE NOTES PER VISIT are allowed on purpose. There is no unique
-- constraint on visit_id. A clinician may save a note early and add an addendum
-- after test results, and an append-only clinical record is safer than one row
-- that gets silently overwritten. The UI shows the most recent note for a visit
-- and can append.
--
-- WHO CAN READ THIS — data minimisation
-- Read access is admin/doctor/nurse, NOT all staff. Billing staff do not need a
-- patient's diagnosis to raise an invoice, and giving a front-desk role
-- clinical-note access by default is the kind of over-broad grant that DPDP
-- alignment (PRD §7) will be judged on. Billing gets the billing tables, which
-- carry a service description, not clinical content. If insurance/TPA work in
-- Phase 4 genuinely needs diagnosis on a claim, that should be an explicit,
-- narrow addition then — not a blanket grant now.
-- ============================================================================

create table if not exists public.clinical_notes (
  id                      uuid        primary key default gen_random_uuid(),
  tenant_id               uuid        not null references public.tenants (id) on delete restrict,
  visit_id                uuid        not null,

  -- Author. RESTRICT for the same reason as visits.doctor_id: a clinical record
  -- must not lose its author because an account was deleted.
  author_id               uuid        not null,

  -- ---- clinical content: ALL NULLABLE (see banner above) ----
  template_type           text        null,
  chief_complaint         text        null,
  history                 text        null,
  examination             text        null,
  diagnosis               text        null,
  advice                  text        null,
  follow_up_instructions  text        null,
  note_text               text        null,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint clinical_notes_visit_same_tenant
    foreign key (visit_id, tenant_id)
    references public.visits (id, tenant_id)
    on delete restrict,

  constraint clinical_notes_author_same_tenant
    foreign key (author_id, tenant_id)
    references public.profiles (id, tenant_id)
    on delete restrict,

  constraint clinical_notes_id_tenant_unique unique (id, tenant_id)
);

comment on table public.clinical_notes is
  'Doctor''s note per visit. EVERY clinical free-text column is nullable by design (rules.md §1.7) — an empty note must be savable. Multiple notes per visit are allowed (addenda). Readable by admin/doctor/nurse only, not billing.';
comment on column public.clinical_notes.note_text is
  'Free-text body. Nullable — never make this NOT NULL.';
comment on column public.clinical_notes.template_type is
  'Optional template the doctor started from (e.g. ''fever'', ''antenatal''). Nullable; templates are a UI convenience, not a schema requirement.';

create index if not exists clinical_notes_visit_idx  on public.clinical_notes (visit_id, created_at desc);
create index if not exists clinical_notes_tenant_idx on public.clinical_notes (tenant_id, created_at desc);

drop trigger if exists clinical_notes_touch_updated_at on public.clinical_notes;
create trigger clinical_notes_touch_updated_at
  before update on public.clinical_notes
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.clinical_notes enable row level security;

revoke all on public.clinical_notes from anon, authenticated;

-- Note-taking is plain CRUD with no business-rule branching, so it is a direct
-- table insert rather than an RPC — the envelope pattern is reserved for the
-- safety check and billing calculation, which genuinely branch.
--
-- tenant_id is grantable on INSERT because the WITH CHECK policy pins it to
-- current_tenant_id(); a forged value is rejected rather than trusted
-- (rules.md §1.2).
grant select on public.clinical_notes to authenticated;
grant insert (tenant_id, visit_id, author_id, template_type, chief_complaint,
              history, examination, diagnosis, advice, follow_up_instructions, note_text)
  on public.clinical_notes to authenticated;
grant update (template_type, chief_complaint, history, examination, diagnosis,
              advice, follow_up_instructions, note_text)
  on public.clinical_notes to authenticated;

create policy clinical_notes_select_clinical_staff
  on public.clinical_notes
  for select
  to authenticated
  using (
    public.has_tenant_role(array['admin', 'doctor', 'nurse'])
    and tenant_id = public.current_tenant_id()
  );

-- Only a doctor may author a note, and only as themselves. Pinning
-- author_id = auth.uid() in WITH CHECK is what stops a note being attributed to
-- a colleague.
create policy clinical_notes_insert_doctor
  on public.clinical_notes
  for insert
  to authenticated
  with check (
    public.has_tenant_role(array['doctor', 'admin'])
    and tenant_id = public.current_tenant_id()
    and author_id = (select auth.uid())
  );

-- Only the author may revise their own note. No DELETE policy: clinical records
-- are not deletable from the app.
--
-- Known limitation, deliberately deferred: an edit overwrites in place, so there
-- is no version history of what a note said before. Proper amendment history
-- belongs with the audit-log work in Phase 4 (phases.md) and is recorded as a
-- risk in Memory.md §6 rather than half-built here.
create policy clinical_notes_update_author
  on public.clinical_notes
  for update
  to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and author_id = (select auth.uid())
  )
  with check (
    tenant_id = public.current_tenant_id()
    and author_id = (select auth.uid())
  );
