-- ============================================================================
-- supabase-preamble.sql
--
-- A minimal but FAITHFUL reproduction of the parts of a hosted Supabase project
-- that our migrations depend on but do not create themselves. Applied to a
-- throwaway in-process Postgres (PGlite) before the migrations, so the RLS
-- policies can be exercised offline with no credentials and no Docker.
--
-- This file is test scaffolding ONLY. It is never applied to a real project —
-- on a real project Supabase owns all of this.
--
-- FIDELITY NOTES (why each piece is here, and where the seams are):
--
--  * anon / authenticated / service_role are the three roles PostgREST switches
--    into based on the JWT. service_role gets BYPASSRLS, matching Supabase, which
--    is what lets the seed script provision fixtures.
--
--  * The ALTER DEFAULT PRIVILEGES lines are the most important part of this
--    file. A real Supabase project grants ALL on new public tables to anon and
--    authenticated by default. Our migrations deliberately REVOKE that and
--    re-grant narrowly. If this preamble omitted the default grants, those
--    revokes would be no-ops locally and the column-privilege tests would pass
--    for the wrong reason — they'd be asserting against a permission that was
--    never there. Reproducing the permissive default is what makes the
--    "authenticated cannot write profiles.role" assertion meaningful.
--
--  * auth.users carries only the four columns our code actually reads
--    (id, email, email_confirmed_at, raw_user_meta_data). The real table has
--    many more; none are referenced by our migrations.
--
--  * auth.uid() / auth.jwt() / auth.email() read request.jwt.claims, exactly as
--    the real Supabase implementations do, so `set local request.jwt.claims`
--    reproduces a PostgREST request faithfully.
--
--  * authenticated gets USAGE on schema auth (as in production) but NO table
--    privilege on auth.users — client sessions must never read the user table
--    directly. create_invite() reaches it only from inside SECURITY DEFINER.
--
-- KNOWN SEAM: this does not reproduce Supabase's GoTrue signup logic (password
-- hashing, confirmation emails, rate limits). Tests insert into auth.users
-- directly to fire the on_auth_user_created trigger. That exercises our trigger
-- and everything downstream of it, but the real signup HTTP path still has to be
-- confirmed against the hosted project.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase's permissive defaults — see fidelity note above.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth schema
-- ---------------------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                 uuid        primary key default gen_random_uuid(),
  email              text        unique,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Deliberately NOT granted to anon/authenticated: the user table is not
-- client-readable in production either.
grant select on auth.users to service_role;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'email', '')
$$;

grant execute on function auth.uid()   to anon, authenticated, service_role;
grant execute on function auth.jwt()   to anon, authenticated, service_role;
grant execute on function auth.email() to anon, authenticated, service_role;
