-- ============================================================================
-- Migration:  invites
-- Purpose:    The "admin adds staff to an existing clinic" path. An admin
--             creates a row here; the invitee receives the token out-of-band
--             (email link) and spends it via accept_invite() after signing up.
--
-- THE CORE TENSION THIS TABLE RESOLVES
-- The invitee needs to consume an invite *before* they belong to the tenant —
-- at that moment they are a 'pending' user with tenant_id NULL, so every
-- tenant-scoped policy correctly denies them. If we opened up SELECT so they
-- could look up their own invite, we would be exposing a table that lists
-- staff email addresses and roles per clinic to anyone who can guess a filter.
--
-- Resolution: nobody but a tenant admin can ever SELECT this table. The
-- invitee never reads it. They hold an unguessable token (uuid v4, 122 bits of
-- entropy) delivered out-of-band, and hand it to accept_invite(), which is
-- SECURITY DEFINER and does the lookup on their behalf. The token is a
-- capability; possession is the proof, and the table stays sealed.
--
-- accept_invite() additionally requires the invite's email to match the
-- caller's own confirmed address, so a leaked token alone is not enough to
-- join a clinic — see migration 20260808120600.
-- ============================================================================

create table if not exists public.invites (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants (id) on delete cascade,
  email       text        not null,
  role        text        not null,
  token       uuid        not null default gen_random_uuid(),
  invited_by  uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz null,
  accepted_by uuid        null references auth.users (id) on delete set null,

  constraint invites_email_normalised check (email = lower(trim(email))),
  constraint invites_email_shape     check (position('@' in email) > 1),

  -- An invite grants a *working* role. 'pending' is the absence of a role and
  -- would violate profiles_tenant_role_consistent if accept_invite wrote it.
  constraint invites_role_valid check (
    role in ('admin', 'doctor', 'nurse', 'billing', 'patient')
  ),

  -- NOTE: there is deliberately no `expires_at > created_at` constraint. It
  -- looks sensible but it freezes expires_at against any later adjustment
  -- (including an admin expiring an invite early, and test setup that needs to
  -- age a row), while guarding almost nothing: create_invite() already
  -- validates the requested TTL to 1 hour..30 days, and accept_invite() checks
  -- expiry at redemption time. An invite hand-inserted with a past expiry via
  -- the raw admin path is simply dead on arrival and reports INVITE_EXPIRED,
  -- which is self-diagnosing rather than dangerous.

  -- accepted_at and accepted_by are stamped together by accept_invite().
  constraint invites_acceptance_consistent check (
    (accepted_at is null     and accepted_by is null)
    or
    (accepted_at is not null and accepted_by is not null)
  )
);

comment on table  public.invites             is 'Pending staff invitations. Readable only by admins of the owning tenant; consumed by the invitee via accept_invite(token).';
comment on column public.invites.token       is 'Unguessable capability delivered to the invitee out-of-band. Possession + matching confirmed email = authority to join.';
comment on column public.invites.accepted_at is 'Stamped by accept_invite(). Non-null means spent; the token cannot be reused.';

-- The token is looked up on every acceptance attempt and must be unique.
create unique index if not exists invites_token_key on public.invites (token);

-- At most one OUTSTANDING invite per (tenant, email). Accepted invites stay as
-- history and are excluded from the constraint, so a staff member who leaves
-- and rejoins can be re-invited.
--
-- Note the predicate cannot also test `expires_at > now()` — index predicates
-- must be IMMUTABLE and now() is not. So an *expired* unaccepted invite still
-- occupies the slot. create_invite() handles that by refreshing the existing
-- row rather than erroring, which is the behaviour an admin expects when they
-- re-invite someone whose link went stale.
create unique index if not exists invites_one_open_per_email_idx
  on public.invites (tenant_id, email)
  where accepted_at is null;

create index if not exists invites_tenant_id_idx on public.invites (tenant_id);
create index if not exists invites_email_idx     on public.invites (email);

-- ---------------------------------------------------------------------------
-- Email normalisation. Applied by trigger so that BOTH write paths (the
-- create_invite RPC and a raw admin INSERT) store identical values. Without
-- this, 'Doctor@Clinic.com' and 'doctor@clinic.com' would be two different
-- outstanding invites and the acceptance lookup would miss.
-- ---------------------------------------------------------------------------
create or replace function public.normalise_invite_email()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

comment on function public.normalise_invite_email() is
  'BEFORE INSERT/UPDATE trigger on invites: lowercases and trims email so token lookup and the one-open-invite index behave case-insensitively.';

drop trigger if exists invites_normalise_email on public.invites;

create trigger invites_normalise_email
  before insert or update of email on public.invites
  for each row
  execute function public.normalise_invite_email();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.invites enable row level security;

revoke all on public.invites from anon, authenticated;

-- No UPDATE grant: acceptance is stamped only by accept_invite() (SECURITY
-- DEFINER). An admin can revoke by deleting, but cannot rewrite history.
grant select, delete on public.invites to authenticated;
grant insert (tenant_id, email, role, invited_by, expires_at) on public.invites to authenticated;

-- Admins see their own tenant's invites (drives the Admin > Users pending list).
create policy invites_select_tenant_admin
  on public.invites
  for select
  to authenticated
  using (
    public.is_tenant_admin()
    and tenant_id = public.current_tenant_id()
  );

-- Direct INSERT is permitted for admins, but create_invite() is the documented
-- path because it returns a mapped duplicate error and refreshes stale invites.
-- WITH CHECK pins tenant_id and invited_by to the caller so neither can be
-- forged from the client (rules.md §1.2).
create policy invites_insert_tenant_admin
  on public.invites
  for insert
  to authenticated
  with check (
    public.is_tenant_admin()
    and tenant_id = public.current_tenant_id()
    and invited_by = (select auth.uid())
    and role <> 'pending'
  );

-- Revoke an outstanding invite. Accepted invites are immutable history.
create policy invites_delete_tenant_admin
  on public.invites
  for delete
  to authenticated
  using (
    public.is_tenant_admin()
    and tenant_id = public.current_tenant_id()
    and accepted_at is null
  );
