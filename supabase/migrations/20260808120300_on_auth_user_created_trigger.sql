-- ============================================================================
-- Migration:  on_auth_user_created_trigger
-- Purpose:    Every auth.users row gets a matching public.profiles row, so
--             there is never an authenticated session without a resolvable
--             tenant/role. Architecture.md §7 step 2.
--
-- The new profile is (tenant_id NULL, role 'pending') — a signed-up user who
-- belongs to nothing yet. From here exactly two paths lead onward:
--   * create_tenant_and_assign_admin()  -> they found a new clinic, become admin
--   * accept_invite()                   -> they join an existing clinic
--
-- Failure behaviour is deliberate: this function does NOT swallow exceptions.
-- If the insert fails, the enclosing auth.users insert rolls back and signup
-- fails visibly ("Database error saving new user"). The alternative — catching
-- the error and letting signup succeed — produces an authenticated user with
-- no profile row, which means current_tenant_id() returns NULL forever, every
-- RLS policy denies them, and the account is silently unrecoverable from the
-- app. A loud failure at signup is far cheaper to diagnose. This matches
-- rules.md §3.2/§3.4: never let a failed write look like a successful one.
--
-- `on conflict (id) do nothing` is for idempotency, not error suppression — it
-- covers re-running the seed script against a project where a profile row
-- already exists, without masking a genuine insert failure.
--
-- PII: full_name is *stored* (it is the user's own display name) but never
-- logged or raised in a message anywhere in this function — rules.md §1.3.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, tenant_id, role, full_name)
  values (
    new.id,
    null,
    'pending',
    -- Supabase puts signUp({ options: { data: {...} } }) into raw_user_meta_data.
    -- Accept either key, and normalise '' -> NULL so downstream code only has
    -- to handle one "no name given" representation.
    nullif(
      trim(coalesce(
        new.raw_user_meta_data ->> 'full_name',
        new.raw_user_meta_data ->> 'name',
        ''
      )),
      ''
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'AFTER INSERT trigger on auth.users: creates the matching profiles row as (tenant_id NULL, role pending). SECURITY DEFINER because auth.users triggers run outside any user session.';

-- Recreate rather than `create if not exists` so re-applying against a project
-- that already has an older version of the trigger converges to this one.
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- This function is invoked only by the trigger, never over the wire. Strip the
-- default PUBLIC execute grant so it is not callable via RPC.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
