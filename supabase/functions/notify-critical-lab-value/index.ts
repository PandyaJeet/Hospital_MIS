/**
 * notify-critical-lab-value — critical lab value alert dispatcher.
 *
 * ###########################################################################
 * #  NOT DEPLOYED, AND NOT DEPLOYABLE FROM THIS MACHINE.                     #
 * #                                                                          #
 * #  `supabase functions deploy` requires a personal access token (sbp_...),  #
 * #  which is not available here — the same constraint that left the Phase 2  #
 * #  PDF functions written but not live (Memory.md §6). This file is          #
 * #  committed, reviewed and typed, and it has never executed.                #
 * #                                                                          #
 * #  THE ALERT DOES NOT DEPEND ON IT. That is the important part, and it is    #
 * #  deliberate. Everything that decides or describes a critical value lives   #
 * #  in Postgres and is covered by the SQL suites:                            #
 * #                                                                          #
 * #    evaluate_lab_critical()            decides criticality, and reports     #
 * #                                       four distinct "could not evaluate"   #
 * #                                       states rather than defaulting to     #
 * #                                       "normal"                            #
 * #    flag_lab_result_critical()          stamps it onto the row on insert,    #
 * #                                       whatever wrote the row               #
 * #    record_lab_result()                returns the decision to the person    #
 * #                                       entering the result, so a critical    #
 * #                                       value cannot be saved unseen          #
 * #    critical_lab_alerts (view)          the outstanding-alert feed, RLS-      #
 * #                                       scoped, pushed live by Realtime       #
 * #    acknowledge_critical_result()       clears an alert, with a name attached #
 * #    get_critical_lab_alert_payload()    assembles the alert text             #
 * #                                                                          #
 * #  So an in-app alert works today with nothing deployed. What is missing     #
 * #  without this function is out-of-app notification (push/SMS/WhatsApp) to   #
 * #  a clinician who does not have the app open — which is also blocked on the #
 * #  WhatsApp/SMS integration that phases.md places elsewhere. See the report. #
 * ###########################################################################
 *
 * WHY A DATABASE WEBHOOK AND NOT A CLIENT-SIDE CHECK
 * A critical result must not depend on anybody having the right screen open. The
 * trigger path is: INSERT into lab_results -> Supabase Database Webhook (a
 * Postgres trigger under the hood) -> this function. Nothing in that chain
 * involves a browser, so an alert fires at 3am with no user logged in.
 *
 * ---------------------------------------------------------------------------
 * DASHBOARD CONFIGURATION REQUIRED (cannot be done from SQL or the CLI here)
 * ---------------------------------------------------------------------------
 *   Database > Webhooks > Create a new hook
 *     Table:      public.lab_results
 *     Events:     INSERT
 *     Type:       Supabase Edge Function -> notify-critical-lab-value
 *     HTTP header: x-alert-webhook-secret: <the same value as the
 *                  CRITICAL_LAB_ALERT_SECRET function secret>
 *
 * The webhook cannot express "only when is_critical = true" — Supabase webhooks
 * fire per row, not per predicate — so this function filters. It is a cheap check
 * and it is done first, before any database access. Note that it must let
 * `requires_manual_review` rows through as well: an unevaluable result is an
 * outstanding obligation, not a non-event (rules.md §3.4).
 *
 * ---------------------------------------------------------------------------
 * AUTHENTICATION, AND THE ONE STATED SERVICE-ROLE USE
 * ---------------------------------------------------------------------------
 * rules.md §1.1 forbids service-role keys in Edge Function code "unless explicitly
 * instructed for a specific admin-only operation". This is that stated exception,
 * and the reasoning is:
 *
 *   A database webhook carries NO user JWT, because no user is involved — the
 *   trigger is the caller. The Phase 2 PDF functions could forward the caller's
 *   bearer token precisely because a human clicked "print"; here there is nobody
 *   to forward. Something has to hold authority to read the row, and the only two
 *   candidates are a service-role read or a SECURITY DEFINER function open to
 *   anonymous callers. The second is far worse: it would mean any unauthenticated
 *   request with a guessed uuid could pull a lab result.
 *
 * The exception is kept as narrow as it can be:
 *   * exactly one call, get_critical_lab_alert_payload(), which is SECURITY
 *     INVOKER — so its shape is identical whether a clinician or this dispatcher
 *     calls it, and it can be (and is) tested through a normal user session;
 *   * for exactly the one row id the webhook already delivered;
 *   * gated behind a shared secret compared in constant time, so the endpoint is
 *     not an open oracle;
 *   * and no writes of any kind.
 *
 * ---------------------------------------------------------------------------
 * PHI (rules.md §1.3)
 * ---------------------------------------------------------------------------
 * The payload deliberately contains no patient name and no phone number — that is
 * enforced upstream in the view, not here, so a future change to this file cannot
 * reintroduce one. On top of that, nothing in this file logs the payload, the
 * result value, or the patient identifiers. Only a request id, the tenant id and a
 * severity label are ever written to the log, which is enough to correlate with the
 * database without putting a clinical finding into a log aggregator.
 */

import { CORS_HEADERS, errorResponse, newRequestId, readJson } from '../_shared/http.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

/** The subset of the Supabase webhook envelope this function relies on. */
interface WebhookPayload {
  type?: 'INSERT' | 'UPDATE' | 'DELETE';
  table?: string;
  schema?: string;
  record?: {
    id?: string;
    tenant_id?: string;
    is_critical?: boolean;
    requires_manual_review?: boolean;
  } | null;
}

interface AlertEnvelope {
  ok: boolean;
  code?: string;
  alert?: {
    lab_result_id: string;
    tenant_id: string;
    patient_number: number | null;
    ward_name: string | null;
    bed_number: string | null;
    test_name: string;
    severity: 'critical' | 'unevaluated';
    headline: string;
    [k: string]: unknown;
  };
}

/**
 * Length-independent, timing-safe-ish comparison.
 *
 * A plain `a === b` on a secret leaks length and prefix through timing. This is
 * not a high-value target, but the cost of doing it properly is six lines.
 */
function secretsMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  // Compare over a fixed length so a short guess does not return early.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * The actual notification send.
 *
 * NOT IMPLEMENTED, and reported as such rather than faked. There is no
 * WhatsApp/SMS/push integration in this project yet — phases.md puts that with the
 * third-party integration work, and Architecture.md §1 lists it as Phase 2+ but it
 * was not built. Writing a plausible-looking stub that silently succeeds would be
 * the worst option available: the alert path would look healthy in production while
 * delivering nothing, which is exactly the "a failed safety check must not look
 * like a passed one" failure rules.md §3.4 is about.
 *
 * So this returns an explicit 'no_channel_configured' outcome, the HTTP response
 * says so, and the in-app alert (Realtime on lab_results + the
 * critical_lab_alerts view + acknowledge_critical_result) remains the delivery
 * mechanism that actually works.
 */
async function dispatch(alert: NonNullable<AlertEnvelope['alert']>): Promise<
  { delivered: false; reason: 'no_channel_configured' }
> {
  // Intentionally does not touch `alert` beyond keeping the signature honest about
  // what a real implementation would receive. No logging of its contents.
  void alert;
  return await Promise.resolve({ delivered: false, reason: 'no_channel_configured' });
}

/**
 * Service-role client. See the header for why this is the one place in the
 * codebase's function directory that holds more authority than its caller.
 */
function dispatcherClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const requestId = newRequestId();

  try {
    if (req.method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Use POST.', 405);
    }

    // ---- 1. authenticate the webhook ------------------------------------
    const expected = Deno.env.get('CRITICAL_LAB_ALERT_SECRET');
    if (!expected) {
      // Fail closed. An unsecured endpoint that reads lab results with the service
      // role is worse than an alert channel that is down, and a missing secret is a
      // deployment mistake that must be loud.
      console.error(`[${requestId}] CRITICAL_LAB_ALERT_SECRET is not configured`);
      return errorResponse(
        'ALERT_DISPATCHER_MISCONFIGURED',
        'The alert dispatcher is not configured.',
        500,
      );
    }

    if (!secretsMatch(req.headers.get('x-alert-webhook-secret'), expected)) {
      console.error(`[${requestId}] rejected: bad or missing webhook secret`);
      return errorResponse('UNAUTHORIZED', 'Invalid webhook credentials.', 401);
    }

    // ---- 2. read and filter the webhook body ----------------------------
    const body = await readJson<WebhookPayload>(req);
    if (!body || body.table !== 'lab_results' || body.type !== 'INSERT') {
      return errorResponse(
        'UNEXPECTED_PAYLOAD',
        'This endpoint handles INSERT events on lab_results only.',
        400,
      );
    }

    const record = body.record;
    const labResultId = record?.id;
    if (!labResultId) {
      return errorResponse('UNEXPECTED_PAYLOAD', 'The event carried no row id.', 400);
    }

    // Both branches matter. `requires_manual_review` is included on purpose: a
    // result nobody could evaluate needs a human just as much as one that is
    // dangerously abnormal, and dropping it here would recreate the silent-default
    // failure the schema went to some trouble to make impossible.
    const alertable = record?.is_critical === true || record?.requires_manual_review === true;
    if (!alertable) {
      // A normal result is a successful no-op, not an error — the webhook fires for
      // every insert because Supabase webhooks cannot filter on a predicate.
      return new Response(JSON.stringify({ ok: true, dispatched: false, reason: 'not_alertable' }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // ---- 3. fetch the assembled payload from Postgres -------------------
    // The dispatcher does not decide anything and does not build the message. Both
    // are Postgres's job, so both are already tested.
    const supabase = dispatcherClient();
    const { data, error } = await supabase.rpc('get_critical_lab_alert_payload', {
      p_lab_result_id: labResultId,
    });

    if (error) {
      // No message forwarded: a PostgREST error body can contain row content
      // (rules.md §1.3, §3.3). The code alone is enough to correlate.
      console.error(`[${requestId}] payload lookup failed: ${error.code ?? 'unknown'}`);
      return errorResponse(
        'ALERT_LOOKUP_FAILED',
        'Could not assemble the alert for this result.',
        502,
      );
    }

    const envelope = data as AlertEnvelope | null;
    if (!envelope?.ok || !envelope.alert) {
      console.error(`[${requestId}] no alert payload: ${envelope?.code ?? 'EMPTY'}`);
      return errorResponse(
        'ALERT_NOT_FOUND',
        'No outstanding alert was found for that result.',
        404,
      );
    }

    // ---- 4. dispatch -----------------------------------------------------
    const outcome = await dispatch(envelope.alert);

    // Log line carries NO clinical content and NO patient identifier: request id,
    // tenant, severity. Enough to answer "did the alert fire", nothing more.
    console.log(
      `[${requestId}] alert ${envelope.alert.severity} tenant=${envelope.alert.tenant_id} ` +
        `delivered=${outcome.delivered} reason=${outcome.reason}`,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        dispatched: outcome.delivered,
        reason: outcome.reason,
        severity: envelope.alert.severity,
        // Deliberately echoes no clinical content back to the webhook caller.
        lab_result_id: envelope.alert.lab_result_id,
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    // rules.md §3.7: structured error, never a stack trace. rules.md §1.3: the
    // caught error's message is not logged, because it can contain row content.
    const kind = err instanceof Error ? err.name : typeof err;
    console.error(`[${requestId}] unhandled ${kind}`);
    return errorResponse(
      'ALERT_DISPATCH_FAILED',
      'Could not dispatch the critical value alert.',
      500,
    );
  }
});
