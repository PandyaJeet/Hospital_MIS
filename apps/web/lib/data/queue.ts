import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { fromRpc, mapPostgrestError } from "./rpc";
import type { AppError, Result } from "./types";

/**
 * Shapes follow `docs/contracts/opd-queue.md` §8 exactly.
 *
 * ⚠️ Queue rows carry patient PII, including the allergy string. Never log an
 * entry — log `visit_id` or `queue_number` instead (rules.md §1.3).
 */
export type VisitStatus = "queued" | "in_consultation" | "done" | "cancelled";
export type VisitType = "new" | "follow_up";

export interface QueueEntry {
  id: string;
  queue_number: number;
  status: VisitStatus;
  visit_type: VisitType;
  checked_in_at: string;
  consultation_started_at: string | null;
  patient: {
    id: string;
    patient_number: number;
    full_name: string;
    age_years: number | null;
    gender: string | null;
    allergies: string | null;
  };
}

/**
 * Wait time is computed, never stored, so it cannot go stale (§2):
 *   coalesce(consultation_started_at, now) - checked_in_at
 */
export function waitSeconds(entry: QueueEntry, now: number = Date.now()) {
  const end = entry.consultation_started_at
    ? new Date(entry.consultation_started_at).getTime()
    : now;
  const start = new Date(entry.checked_in_at).getTime();
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Legal transitions (§4). `done` and `cancelled` are terminal. */
export const nextStatuses: Record<VisitStatus, VisitStatus[]> = {
  queued: ["in_consultation", "cancelled"],
  in_consultation: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

const QUEUE_SELECT = `
  id, queue_number, status, visit_type, checked_in_at, consultation_started_at,
  patient:patients ( id, patient_number, full_name, age_years, gender, allergies )
`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realGetQueue(): Promise<Result<QueueEntry[]>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("visits")
    .select(QUEUE_SELECT)
    .eq("visit_date", today())
    .in("status", ["queued", "in_consultation"])
    .order("queue_number");

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: (data ?? []) as unknown as QueueEntry[], error: null };
}

export interface SetStatusPayload {
  visit_id: string;
  status: VisitStatus;
  changed: boolean;
}

async function realSetVisitStatus(
  visitId: string,
  status: VisitStatus,
  cancellationReason?: string,
): Promise<Result<SetStatusPayload>> {
  const supabase = createClient();
  return fromRpc<SetStatusPayload>(
    await supabase.rpc("set_visit_status", {
      p_visit_id: visitId,
      p_status: status,
      p_cancellation_reason: cancellationReason ?? undefined,
    }),
  );
}

export interface CheckInPayload {
  visit_id: string;
  queue_number: number;
  visit_type: VisitType;
  status: VisitStatus;
}

/**
 * Three states, not two — the same shape `registerPatient` uses, for the same
 * reason.
 *
 * `check_in_patient()` **refuses a second open visit for the same patient on the
 * same day** (opd-queue.md §3). That is not a safety net against clumsiness, it is
 * billing correctness: two tokens become two consultations become two consultation
 * charges.
 *
 * So `VISIT_ALREADY_OPEN` is not a failure to report — it is an answer. The RPC
 * returns the existing `visit_id`, `queue_number` and `status` precisely so the UI
 * can say "already token 6" and point at it, instead of the dead end the contract
 * warns about. `fromRpc` keeps only code/message/fields, so this reads the envelope
 * directly to preserve them.
 */
export type CheckInOutcome =
  | ({ kind: "checked_in" } & CheckInPayload)
  | {
      kind: "already_open";
      visit_id: string;
      queue_number: number;
      status: VisitStatus;
    }
  | { kind: "failed"; error: AppError };

async function realCheckInPatient(
  patientId: string,
  visitType: VisitType = "new",
  doctorId?: string,
): Promise<CheckInOutcome> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("check_in_patient", {
    p_patient_id: patientId,
    p_visit_type: visitType,
    p_doctor_id: doctorId ?? undefined,
  });

  if (error) return { kind: "failed", error: mapPostgrestError(error) };

  const envelope = data as
    | {
        ok?: boolean;
        code?: string;
        message?: string;
        fields?: string[];
        visit_id?: string;
        queue_number?: number;
        visit_type?: VisitType;
        status?: VisitStatus;
      }
    | null;

  if (!envelope || typeof envelope.ok !== "boolean") {
    return {
      kind: "failed",
      error: {
        code: "UNEXPECTED_RESPONSE",
        message: "The server returned an unexpected response.",
      },
    };
  }

  if (envelope.ok) {
    return {
      kind: "checked_in",
      visit_id: String(envelope.visit_id ?? ""),
      queue_number: Number(envelope.queue_number ?? 0),
      visit_type: envelope.visit_type ?? visitType,
      status: envelope.status ?? "queued",
    };
  }

  if (envelope.code === "VISIT_ALREADY_OPEN") {
    return {
      kind: "already_open",
      visit_id: String(envelope.visit_id ?? ""),
      queue_number: Number(envelope.queue_number ?? 0),
      status: envelope.status ?? "queued",
    };
  }

  return {
    kind: "failed",
    error: {
      code: envelope.code ?? "UNKNOWN",
      message: envelope.message ?? "Something went wrong.",
      fields: envelope.fields,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

let mockQueue: QueueEntry[] | null = null;

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedQueue(): QueueEntry[] {
  return [
    {
      id: "v1",
      queue_number: 11,
      status: "in_consultation",
      visit_type: "follow_up",
      checked_in_at: minutesAgo(38),
      consultation_started_at: minutesAgo(6),
      patient: {
        id: "mock-p-1",
        patient_number: 1,
        full_name: "Aarav Sharma",
        age_years: 34,
        gender: "male",
        allergies: "Penicillin",
      },
    },
    {
      id: "v2",
      queue_number: 12,
      status: "queued",
      visit_type: "new",
      checked_in_at: minutesAgo(14),
      consultation_started_at: null,
      patient: {
        id: "mock-p-2",
        patient_number: 2,
        full_name: "Priya Patel",
        age_years: 28,
        gender: "female",
        allergies: null,
      },
    },
    {
      id: "v3",
      queue_number: 13,
      status: "queued",
      visit_type: "new",
      checked_in_at: minutesAgo(4),
      consultation_started_at: null,
      patient: {
        id: "mock-p-3",
        patient_number: 3,
        full_name: "Rohan Mehta",
        age_years: 45,
        gender: "male",
        allergies: "Sulfa drugs, Aspirin",
      },
    },
  ];
}

function delay(ms = 450) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockGetQueue(): Promise<Result<QueueEntry[]>> {
  await delay();
  mockQueue ??= seedQueue();
  // Only queued / in_consultation appear in today's queue, same as the real query.
  return {
    data: mockQueue.filter(
      (e) => e.status === "queued" || e.status === "in_consultation",
    ),
    error: null,
  };
}

async function mockSetVisitStatus(
  visitId: string,
  status: VisitStatus,
): Promise<Result<SetStatusPayload>> {
  await delay(300);
  mockQueue ??= seedQueue();
  const entry = mockQueue.find((e) => e.id === visitId);
  if (!entry) {
    return {
      data: null,
      error: {
        code: "VISIT_NOT_FOUND",
        message: "That visit does not exist at this clinic.",
      },
    };
  }
  if (entry.status === status) {
    return {
      data: { visit_id: visitId, status, changed: false },
      error: null,
    };
  }
  if (!nextStatuses[entry.status].includes(status)) {
    return {
      data: null,
      error: {
        code: "INVALID_STATUS_TRANSITION",
        message: `Cannot move from ${entry.status} to ${status}.`,
        fields: [entry.status, status],
      },
    };
  }
  entry.status = status;
  if (status === "in_consultation") {
    entry.consultation_started_at = new Date().toISOString();
  }
  return { data: { visit_id: visitId, status, changed: true }, error: null };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function getQueue(): Promise<Result<QueueEntry[]>> {
  return USE_MOCK ? mockGetQueue() : realGetQueue();
}

export function setVisitStatus(
  visitId: string,
  status: VisitStatus,
  cancellationReason?: string,
): Promise<Result<SetStatusPayload>> {
  return USE_MOCK
    ? mockSetVisitStatus(visitId, status)
    : realSetVisitStatus(visitId, status, cancellationReason);
}

/** Per-tenant, per-day token counter for mock mode. Resets are not simulated. */
let mockToken = 3;
const mockCheckedIn = new Map<string, { visit_id: string; queue_number: number }>();

export async function checkInPatient(
  patientId: string,
  visitType: VisitType = "new",
  doctorId?: string,
): Promise<CheckInOutcome> {
  if (!USE_MOCK) return realCheckInPatient(patientId, visitType, doctorId);

  await new Promise((resolve) => setTimeout(resolve, 300));
  const existing = mockCheckedIn.get(patientId);
  if (existing) {
    // Mirrors the real refusal, including handing back the existing token.
    return { kind: "already_open", ...existing, status: "queued" };
  }
  mockToken += 1;
  const visit = { visit_id: `mock-visit-${mockToken}`, queue_number: mockToken };
  mockCheckedIn.set(patientId, visit);
  return { kind: "checked_in", ...visit, visit_type: visitType, status: "queued" };
}
