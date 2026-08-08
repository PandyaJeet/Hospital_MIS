import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "./types";

/**
 * Server-side Supabase client, for use in Server Components, Route Handlers,
 * and Server Actions.
 *
 * Uses Next.js `cookies()` (awaited in Next 15+) so the auth session is shared
 * with the browser client. Multi-tenant isolation is enforced by Postgres
 * Row-Level Security, never by app-layer checks (see rules.md §1, §4).
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Deliberate, documented exception to rules.md §3.2 (no silent catch):
            // `setAll` throws when invoked from a Server Component because cookies
            // are read-only in that context. This is expected and benign — the
            // session cookie is refreshed by middleware (added with Phase 1 auth),
            // so there is nothing to surface to the user here.
          }
        },
      },
    },
  );
}
