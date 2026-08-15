/**
 * Builds a Supabase client that acts AS THE CALLING USER.
 *
 * This is the single most important design point in the Edge Functions.
 *
 * The tempting shortcut is to construct a client with SUPABASE_SERVICE_ROLE_KEY,
 * because it always works and never hits a policy. That would break the security
 * model: the service role bypasses RLS entirely, so the function would happily
 * render any tenant's prescription for anyone who could guess a uuid, and tenant
 * isolation would depend on this file being correct rather than on the database.
 * rules.md §1.1 forbids service-role usage in Edge Function code without an
 * explicit stated reason, and there is no reason for one here.
 *
 * Instead the caller's `Authorization: Bearer <jwt>` header is forwarded verbatim.
 * PostgREST then runs as that user, `auth.uid()` resolves to them, and the
 * SECURITY INVOKER payload functions (get_prescription_for_pdf /
 * get_invoice_for_pdf) are filtered by exactly the same RLS policies as a browser
 * query. A cross-tenant id returns "not found" rather than a document.
 *
 * Net effect: these functions hold no authority of their own. They are renderers.
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

export interface AuthedClient {
  client: SupabaseClient;
  /** null when the request carried no usable bearer token. */
  token: string | null;
}

export function clientForRequest(req: Request): AuthedClient {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!url || !anonKey) {
    // Misconfiguration, not a user error. Surfaced as a thrown error so the
    // caller's catch turns it into a generic 500 rather than leaking config state.
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY are not set');
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : null;

  const client = createClient(url, anonKey, {
    global: { headers: authHeader ? { Authorization: authHeader } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { client, token: token && token.length > 0 ? token : null };
}
