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
