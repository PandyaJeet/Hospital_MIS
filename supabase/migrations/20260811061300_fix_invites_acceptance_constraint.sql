-- ============================================================================
-- Migration:  fix_invites_acceptance_constraint
--
-- BUG BEING FIXED (introduced in 20260808120500, found while running
-- `npm run db:seed:reset` against the hosted project)
--
-- Deleting any user who had accepted an invite failed with GoTrue's generic
-- "Database error deleting user". The real cause was a conflict between two
-- things added in the same migration:
--
--   invites.accepted_by  uuid null references auth.users (id) on delete set null
--
--   constraint invites_acceptance_consistent check (
--     (accepted_at is null     and accepted_by is null)
--     or (accepted_at is not null and accepted_by is not null)
--   )
--
-- Deleting the auth user sets `accepted_by` to NULL while `accepted_at` stays
-- populated — which the check forbids. So the FK's own ON DELETE action was
-- guaranteed to violate a constraint on the same row, making the delete
-- impossible. The two clauses were individually reasonable and jointly
-- unsatisfiable.
--
-- Why it stayed hidden until now: on a first run the reset has no prior users to
-- remove, so the cascade never fires. It only appears from the second
-- `db:seed:reset` onward, which is the first time an accepted invite exists at
-- delete time. Worth noting as a reminder that idempotent tooling needs to be run
-- twice to actually be tested.
--
-- THE FIX — relax the invariant to the direction that is genuinely meaningful.
-- `accepted_at` is the authoritative "this token is spent" flag; every code path
-- that cares (accept_invite, the one-open-invite index) reads only that.
-- `accepted_by` is supplementary audit data that may legitimately be lost when an
-- account is removed. So:
--
--   forbidden:  accepted_by set without accepted_at   (who, but not when)
--   allowed:    accepted_at set without accepted_by   (when, but the account is gone)
--
-- The spent-token guarantee is unchanged: accept_invite() rejects any invite with
-- a non-null accepted_at, and that is unaffected by accepted_by going NULL.
--
-- rules.md §1.6 requires a stated reason for altering an applied object: stated
-- above. This is a new migration rather than an edit to 20260808120500, which is
-- already applied to the hosted project (rules.md §5.6).
-- ============================================================================

alter table public.invites
  drop constraint if exists invites_acceptance_consistent;

alter table public.invites
  add constraint invites_acceptance_consistent check (
    accepted_by is null or accepted_at is not null
  );

comment on column public.invites.accepted_by is
  'Who spent the token. Goes NULL if that account is later deleted — accepted_at remains, and it is accepted_at alone that marks the invite spent.';
