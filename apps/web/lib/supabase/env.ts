/**
 * Supabase connection config, read once with a clear failure message.
 *
 * Next.js only loads env files from the app directory, so these live in
 * `apps/web/.env.local` — not the repo-root `.env` that the backend tooling
 * uses. Both are documented in `.env.example`.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Add it to apps/web/.env.local (see .env.example), ` +
        `or set NEXT_PUBLIC_USE_MOCK=true to run against mock data.`,
    );
  }
  return value;
}

export function supabaseUrl() {
  return required(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
}

/**
 * Publishable ("anon") key. Safe to expose to the browser — RLS is the security
 * boundary (rules.md §1, §4).
 */
export function supabaseAnonKey() {
  return required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
