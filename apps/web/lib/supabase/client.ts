import { createBrowserClient } from "@supabase/ssr";

import { supabaseAnonKey, supabaseUrl } from "./env";
import type { Database } from "./types";

/**
 * Browser-side Supabase client, for use in Client Components.
 *
 * Reads only public env vars (safe to expose). Multi-tenant isolation is
 * enforced by Postgres Row-Level Security, never by app-layer checks
 * (see rules.md §1, §4).
 */
export function createClient() {
  return createBrowserClient<Database>(supabaseUrl(), supabaseAnonKey());
}
