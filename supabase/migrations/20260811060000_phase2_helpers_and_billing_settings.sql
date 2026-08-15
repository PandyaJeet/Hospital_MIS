-- ============================================================================
-- Migration:  phase2_helpers_and_billing_settings
-- Phase:      2 (Core OPD Flow) — foundation for everything that follows
--
-- Two jobs:
--   1. Two more tenancy helpers, following exactly the Phase 1 pattern
--      (SECURITY DEFINER + pinned empty search_path + no arguments derived from
--      the client). Every Phase 2 policy is built from these plus the Phase 1
--      trio, so tenant resolution stays in one auditable place.
--   2. The per-tenant billing/GST settings that §3.6 of the phase brief requires
--      exist BEFORE any billing table references them.
--
-- WHY GST IS A PER-TENANT SETTING AND NOT AN ASSUMPTION
-- Whether a clinic charges GST at all depends on whether it is GST-registered,
-- which depends on turnover (₹20 lakh threshold generally, ₹10 lakh in some
-- special-category states). A solo doctor below the threshold legitimately
-- issues a bill with no GST on it at all — not a GST invoice showing zeros.
-- So `gst_registered` defaults to FALSE, which is the safe default: a clinic
-- that has not told us it is registered does not get tax lines computed.
--
-- Separately, core healthcare services are GST-exempt under Notification
-- 12/2017 while dispensed medicines are taxable — which is why tax lives per
-- line item (see 20260811060500) and never as one rate on an invoice total.
--
-- !! BUSINESS DECISION REQUIRED PER PILOT CLINIC !!
-- `gst_registered`, `gstin` and `gst_state_code` cannot be derived from code.
-- Jeet must confirm each real clinic's registration status before it issues
-- invoices to patients. This is flagged in Memory.md §6 as an open item.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- is_tenant_staff() — the workhorse of every Phase 2 policy.
--
-- True for a fully-onboarded clinical/operational staff member. Deliberately
-- EXCLUDES:
--   * 'pending' — signed up but belongs to no tenant
--   * 'patient' — a patient-portal login must not get blanket read access to
--     the clinic's patient master, queue, notes, or billing. The phase brief is
--     explicit that a patient-facing "my own record" view is out of scope, so
--     rather than write a half-policy now, the patient role simply matches
--     nothing on the Phase 2 tables. That is a deliberate deny, not an
--     oversight — see the contract files.
-- ---------------------------------------------------------------------------
create or replace function public.is_tenant_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.tenant_id is not null
         and p.role in ('admin', 'doctor', 'nurse', 'billing')
      from public.profiles p
      where p.id = (select auth.uid())
    ),
    false
  )
$$;

comment on function public.is_tenant_staff() is
  'True when the caller is fully-onboarded clinic staff (admin/doctor/nurse/billing). Excludes pending and patient roles. Basis of every Phase 2 RLS policy.';


-- ---------------------------------------------------------------------------
-- has_tenant_role(text[]) — for the narrower cases (e.g. only a doctor may
-- author a clinical note or a prescription).
--
-- Takes the ALLOWED roles as its argument, never the caller's identity, so
-- there is nothing a client can pass that makes it answer about someone else
-- (rules.md §1.2). The caller is always auth.uid().
-- ---------------------------------------------------------------------------
create or replace function public.has_tenant_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.tenant_id is not null
         and p.role = any(p_roles)
      from public.profiles p
      where p.id = (select auth.uid())
    ),
    false
  )
$$;

comment on function public.has_tenant_role(text[]) is
  'True when the caller is onboarded in a tenant AND holds one of the supplied roles. The argument is the allow-list, never the caller identity.';


revoke execute on function public.is_tenant_staff()          from public, anon;
revoke execute on function public.has_tenant_role(text[])     from public, anon;
grant  execute on function public.is_tenant_staff()          to authenticated;
grant  execute on function public.has_tenant_role(text[])     to authenticated;


-- ---------------------------------------------------------------------------
-- tenants: billing + GST settings
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column if not exists gst_registered           boolean        not null default false,
  add column if not exists gstin                    text           null,
  add column if not exists gst_state_code           text           null,
  add column if not exists default_consultation_fee numeric(12, 2) not null default 0,
  add column if not exists address                  text           null,
  add column if not exists phone                    text           null;

comment on column public.tenants.gst_registered is
  'Whether this clinic is GST-registered and therefore charges GST. FALSE means invoices render as legitimate non-GST bills with no tax lines at all. Must be confirmed per real clinic by the platform owner — not derivable from code.';
comment on column public.tenants.gstin is
  '15-character GSTIN, required when gst_registered is true. Snapshotted onto each invoice at issue time so historic invoices stay accurate if this later changes.';
comment on column public.tenants.default_consultation_fee is
  'Fallback consultation fee used by the billing auto-insert trigger when the treating doctor has no personal fee set.';

do $$
begin
  -- GSTIN shape: 2-digit state code, 10-char PAN, entity number, 'Z', checksum.
  if not exists (select 1 from pg_constraint where conname = 'tenants_gstin_format') then
    alter table public.tenants
      add constraint tenants_gstin_format check (
        gstin is null
        or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'tenants_gst_state_code_format') then
    alter table public.tenants
      add constraint tenants_gst_state_code_format check (
        gst_state_code is null or gst_state_code ~ '^[0-9]{2}$'
      );
  end if;

  -- You cannot claim to be GST-registered without the identifiers that make a
  -- GST invoice legal. Prevents issuing a "GST invoice" with no GSTIN on it.
  if not exists (select 1 from pg_constraint where conname = 'tenants_gst_registration_complete') then
    alter table public.tenants
      add constraint tenants_gst_registration_complete check (
        not gst_registered or (gstin is not null and gst_state_code is not null)
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'tenants_consultation_fee_non_negative') then
    alter table public.tenants
      add constraint tenants_consultation_fee_non_negative check (default_consultation_fee >= 0);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- profiles: per-doctor consultation fee override
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists consultation_fee numeric(12, 2) null;

comment on column public.profiles.consultation_fee is
  'Optional per-doctor consultation fee. NULL falls back to tenants.default_consultation_fee. Writable by the doctor themselves and by a tenant admin — it is the practitioner''s own commercial term, not a platform entitlement like tenants.tier.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_consultation_fee_non_negative') then
    alter table public.profiles
      add constraint profiles_consultation_fee_non_negative check (
        consultation_fee is null or consultation_fee >= 0
      );
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- Privileges for the new columns.
--
-- SELECT is already granted table-wide on both tables from Phase 1, and a
-- table-level SELECT covers columns added later, so reads need nothing here.
--
-- Writes are additive to the Phase 1 column grants. Note what is and is not
-- included: an admin may edit their clinic's own commercial/compliance facts,
-- but `tier` remains unwritable — that is a platform entitlement and letting a
-- tenant raise it would make tier gating cosmetic (rules.md §4.3). GST
-- registration is different in kind: it is a fact about the clinic's own tax
-- status that only the clinic can know, so it is theirs to set.
-- ---------------------------------------------------------------------------
grant update (gst_registered, gstin, gst_state_code, default_consultation_fee, address, phone)
  on public.tenants to authenticated;

grant update (consultation_fee) on public.profiles to authenticated;
