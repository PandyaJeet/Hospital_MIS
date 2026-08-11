/**
 * Shared HTTP helpers for the Edge Functions.
 *
 * `_shared` is not deployed as a function itself — Supabase treats
 * underscore-prefixed directories as support code.
 *
 * rules.md §3.7: every function wraps its work in try/catch and returns a
 * structured `{ error: { code, message } }`, never a raw stack trace. §3.3 adds
 * that a user-facing message must never carry raw database text, so the mapping
 * below deliberately translates rather than forwards.
 */

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export interface ErrorBody {
  error: { code: string; message: string };
}

export function errorResponse(code: string, message: string, status: number): Response {
  const body: ErrorBody = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export function pdfResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/pdf',
      // `inline` so the browser can preview it; the client can still force a
      // download. Filenames carry no patient name — see the PII note below.
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Maps an internal failure to a safe, user-facing response.
 *
 * PII (rules.md §1.3): the caught error is NOT logged. These functions handle
 * prescriptions and invoices, so an exception message or a PostgREST error body
 * can easily contain a patient name, phone number or drug list. Logging it would
 * put PHI into the Edge Function log, which is exactly what §1.3 forbids — and
 * "it's only in development" is explicitly not an excuse there.
 *
 * What IS safe to log is the error's constructor name and the request id, which
 * is enough to correlate with the database logs without leaking content.
 */
export function unexpectedError(err: unknown, requestId: string): Response {
  const kind = err instanceof Error ? err.name : typeof err;
  // Deliberately no message, no stack, no payload.
  console.error(`[${requestId}] unhandled ${kind}`);
  return errorResponse(
    'PDF_GENERATION_FAILED',
    'Could not generate the document. Please try again.',
    500,
  );
}

/** Short correlation id so a failure can be traced without logging content. */
export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Reads and validates the JSON body, returning null on anything malformed. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
