import type { SupabaseClient } from "@supabase/supabase-js";

import type { AppError, Result } from "./types";

/**
 * Every backend RPC returns this envelope rather than raising, because
 * PostgREST maps an unrecognised SQLSTATE to HTTP 500 — which would make
 * "you already belong to a clinic" indistinguishable from "the database is
 * down" (auth-tenancy.md §4).
 */
export type RpcEnvelope<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string; fields?: string[] };

interface TransportError {
  message: string;
  code?: string;
}

/**
 * Transport/auth/RLS failures. These are genuinely exceptional — a bug or an
 * outage — so they get generic copy and never expose raw Postgres text
 * (rules.md §3.3).
 */
export function mapPostgrestError(error: TransportError): AppError {
  switch (error.code) {
    case "42501":
      return {
        code: "PERMISSION_DENIED",
        message: "You don't have permission to do that.",
      };
    case "23505":
      return {
        code: "ALREADY_EXISTS",
        message: "That record already exists.",
      };
    default:
      // A failed fetch has no Postgres code; it must stay distinguishable from
      // an application error (rules.md §3.5).
      if (!error.code) {
        return {
          code: "NETWORK_ERROR",
          message: "No internet connection — please check your network.",
        };
      }
      return {
        code: error.code,
        message: "Something went wrong. Please try again.",
      };
  }
}

interface RpcCapable {
  rpc: (
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: TransportError | null }>;
}

/**
 * A permissive schema shape: any table or view name is callable and rows come back
 * as plain records. Same reason as `rpcUntyped` — the generated types predate the
 * Phase 4–6 migrations, so the Phase 4 reporting views are absent from them.
 *
 * Values must be narrowed by the caller, which is honest: nothing here is verified
 * against the real schema until `npm run db:types` can be re-run.
 */
type PermissiveSchema = {
  public: {
    Tables: Record<
      string,
      {
        Row: Record<string, unknown>;
        Insert: Record<string, unknown>;
        Update: Record<string, unknown>;
        Relationships: [];
      }
    >;
    Views: Record<string, { Row: Record<string, unknown>; Relationships: [] }>;
    Functions: Record<
      string,
      { Args: Record<string, unknown>; Returns: unknown }
    >;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

export function untypedClient(client: unknown) {
  return client as unknown as SupabaseClient<PermissiveSchema>;
}

/**
 * Call an RPC that exists in the database but not yet in the generated types.
 *
 * `supabase/types/database.types.ts` predates the Phase 4–6 migrations (Memory.md
 * §1 — `supabase gen types` needs Docker, currently unavailable on the backend
 * machine), so functions added in those phases are missing from the union of
 * callable names and a normal `.rpc()` call fails to type-check.
 *
 * Keeping the escape hatch in one place means there is a single thing to delete
 * once `npm run db:types` can be re-run, rather than casts scattered across
 * feature modules.
 */
export async function rpcUntyped<T>(
  client: unknown,
  fn: string,
  args: Record<string, unknown>,
): Promise<Result<T>> {
  const callable = client as RpcCapable;
  return fromRpc<T>(await callable.rpc(fn, args));
}

/**
 * Collapse the two failure channels of a `supabase.rpc()` call into one
 * `Result`. Both must be handled — never assume success (rules.md §3.1):
 *
 *   `error`          → transport / auth / RLS / a bug
 *   `data.ok===false`→ a business rule the user can act on, with a stable code
 */
export function fromRpc<T>(response: {
  data: unknown;
  error: TransportError | null;
}): Result<T> {
  if (response.error) {
    return { data: null, error: mapPostgrestError(response.error) };
  }

  const envelope = response.data as RpcEnvelope<T> | null;

  if (!envelope || typeof envelope !== "object" || !("ok" in envelope)) {
    return {
      data: null,
      error: {
        code: "UNEXPECTED_RESPONSE",
        message: "Something went wrong. Please try again.",
      },
    };
  }

  if (!envelope.ok) {
    return {
      data: null,
      error: {
        code: envelope.code,
        message: envelope.message,
        fields: envelope.fields,
      },
    };
  }

  // Strip the discriminant; everything else is the payload.
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== "ok") payload[key] = value;
  }
  return { data: payload as T, error: null };
}
