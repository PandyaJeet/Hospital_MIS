import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError, rpcUntyped, untypedClient } from "./rpc";
import type { Result } from "./types";

/**
 * Lab orders, results and critical-value alerts —
 * `docs/contracts/lab-orders.md`.
 *
 * ⚠️ **The single most important thing in this module: `is_critical === false` does
 * not mean "fine".** You must read `requires_manual_review` alongside it. A result
 * for a test with no thresholds on file comes back `is_critical: false` because no
 * comparison happened — rendering that as reassuring is exactly the failure the
 * two-field shape exists to prevent (§4, rules.md §3.4).
 *
 * Use `alertLevel()` below rather than branching on `is_critical` yourself.
 */

export type LabPriority = "routine" | "urgent" | "stat";

export type LabOrderStatus =
  | "pending"
  | "sample_collected"
  | "in_progress"
  | "completed"
  | "cancelled";

/** Only `evaluated` means a threshold comparison actually happened. */
export type CriticalCheckStatus =
  | "evaluated"
  | "no_reference"
  | "unparseable_value"
  | "unit_mismatch"
  | "evaluation_failed";

export interface LabOrder {
  id: string;
  visit_id: string;
  patient_id: string;
  ordered_by: string;
  /** Free text on purpose — the reference set is not exhaustive (§2). */
  test_name: string;
  priority: LabPriority;
  /** Not client-writable; move it with `setLabOrderStatus`. */
  status: LabOrderStatus;
  ordered_at: string;
  notes: string | null;
  cancellation_reason: string | null;
}

export interface NewLabOrderInput {
  tenant_id: string;
  visit_id: string;
  patient_id: string;
  /** Must equal the caller — the schema enforces it. */
  ordered_by: string;
  test_name: string;
  priority?: LabPriority;
  notes?: string | null;
}

export interface CriticalEvaluation {
  status: CriticalCheckStatus;
  is_critical: boolean;
  direction: "low" | "high" | null;
  value_numeric: number | null;
  comparator: string | null;
  reference_unit: string | null;
  critical_low: number | null;
  critical_high: number | null;
  normal_low: number | null;
  normal_high: number | null;
  message: string;
}

export interface RecordResultOutcome {
  lab_result_id: string;
  lab_order_id: string;
  test_name: string;
  visit_id: string;
  lab_order_status: LabOrderStatus;
  tasks_closed: number;
  is_critical: boolean;
  critical_check_status: CriticalCheckStatus;
  requires_manual_review: boolean;
  critical_direction: "low" | "high" | null;
  value_numeric: number | null;
  critical_low: number | null;
  critical_high: number | null;
  /** `is_critical || requires_manual_review` — both demand a human look. */
  requires_acknowledgement: boolean;
  reference_disclaimer: string;
}

export interface SetLabStatusOutcome {
  lab_order_id: string;
  status: LabOrderStatus;
  changed: boolean;
  tasks_closed: number;
  pending_charges_removed: number;
  /** True => the charge is already on an issued invoice; raise a credit deliberately. */
  billing_line_invoiced: boolean;
}

/**
 * A row of `critical_lab_alerts`. **Carries no patient name by design** (§7) — the
 * same shape feeds the notification dispatcher, which will one day terminate at
 * WhatsApp or SMS, and a payload without a name cannot leak one. Identify the
 * patient by UHID plus ward/bed.
 */
export interface CriticalAlert {
  lab_result_id: string;
  lab_order_id: string;
  test_name: string;
  priority: LabPriority;
  visit_id: string;
  patient_id: string;
  patient_number: number;
  care_setting: "opd" | "ipd";
  ward_name: string | null;
  bed_number: string | null;
  result_value: string;
  result_numeric: number | null;
  unit: string | null;
  is_critical: boolean;
  critical_check_status: CriticalCheckStatus;
  requires_manual_review: boolean;
  critical_direction: "low" | "high" | null;
  critical_low_used: number | null;
  critical_high_used: number | null;
  reported_at: string;
  acknowledged_at: string | null;
}

/**
 * The three states a criticality check can land in, collapsed into one value so no
 * screen can accidentally branch on `is_critical` alone.
 *
 *  `critical`    — checked, and dangerously abnormal. Interrupt the user.
 *  `unevaluated` — could not be checked. Ask for manual verification.
 *  `normal`      — checked, and not critical. The only reassuring answer.
 */
export type AlertLevel = "critical" | "unevaluated" | "normal";

export function alertLevel(input: {
  is_critical: boolean;
  requires_manual_review: boolean;
}): AlertLevel {
  if (input.is_critical) return "critical";
  if (input.requires_manual_review) return "unevaluated";
  return "normal";
}

/** Which statuses a given status may move to (§6). Terminal states return none. */
export function allowedTransitions(from: LabOrderStatus): LabOrderStatus[] {
  switch (from) {
    case "pending":
      return ["sample_collected", "cancelled"];
    case "sample_collected":
      return ["in_progress", "completed", "cancelled"];
    case "in_progress":
      return ["completed", "cancelled"];
    default:
      return [];
  }
}

const ORDER_SELECT =
  "id, visit_id, patient_id, ordered_by, test_name, priority, status, ordered_at, notes, cancellation_reason";

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return num(value);
}

function toOrder(row: Record<string, unknown>): LabOrder {
  return {
    id: String(row.id ?? ""),
    visit_id: String(row.visit_id ?? ""),
    patient_id: String(row.patient_id ?? ""),
    ordered_by: String(row.ordered_by ?? ""),
    test_name: String(row.test_name ?? ""),
    priority: (row.priority as LabPriority) ?? "routine",
    status: (row.status as LabOrderStatus) ?? "pending",
    ordered_at: String(row.ordered_at ?? ""),
    notes: (row.notes as string | null) ?? null,
    cancellation_reason: (row.cancellation_reason as string | null) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realListOrders(
  visitId?: string,
): Promise<Result<LabOrder[]>> {
  const supabase = untypedClient(createClient());
  let query = supabase
    .from("lab_orders")
    .select(ORDER_SELECT)
    .order("ordered_at", { ascending: false })
    .limit(100);
  if (visitId) query = query.eq("visit_id", visitId);

  const { data, error } = await query;
  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map(toOrder),
    error: null,
  };
}

/**
 * Ordering is a plain INSERT, not an RPC (§1) — there is nothing to decide at
 * insert time. Three effects fire from triggers: a ₹0 billing line, a nurse
 * "collect sample" card, and a Realtime event. None needs calling.
 */
async function realCreateOrder(
  input: NewLabOrderInput,
): Promise<Result<LabOrder>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("lab_orders")
    .insert({
      tenant_id: input.tenant_id,
      visit_id: input.visit_id,
      patient_id: input.patient_id,
      ordered_by: input.ordered_by,
      test_name: input.test_name.trim(),
      priority: input.priority ?? "routine",
      notes: input.notes?.trim() || null,
    })
    .select(ORDER_SELECT)
    .maybeSingle();

  if (error) return { data: null, error: mapPostgrestError(error) };
  if (!data) {
    // A nurse hits the insert policy and gets 42501; anything else that returns no
    // row must not be reported as a saved order.
    return {
      data: null,
      error: {
        code: "PERMISSION_DENIED",
        message: "Only a doctor or admin can order a test.",
      },
    };
  }
  return { data: toOrder(data as Record<string, unknown>), error: null };
}

/**
 * Side-effect free check, for showing the alert **as the tech types** rather than
 * after saving (§6). Not the source of truth — `recordLabResult` re-decides
 * server-side and its envelope is what counts.
 */
async function realEvaluate(
  testName: string,
  value: string,
  unit: string | null,
): Promise<Result<CriticalEvaluation>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase.rpc("evaluate_lab_critical", {
    p_test_name: testName,
    p_value: value,
    p_unit: unit,
  });

  if (error) return { data: null, error: mapPostgrestError(error) };
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    data: {
      status: (r.status as CriticalCheckStatus) ?? "evaluation_failed",
      is_critical: Boolean(r.is_critical),
      direction: (r.direction as "low" | "high" | null) ?? null,
      value_numeric: nullableNum(r.value_numeric),
      comparator: (r.comparator as string | null) ?? null,
      reference_unit: (r.reference_unit as string | null) ?? null,
      critical_low: nullableNum(r.critical_low),
      critical_high: nullableNum(r.critical_high),
      normal_low: nullableNum(r.normal_low),
      normal_high: nullableNum(r.normal_high),
      message: String(r.message ?? ""),
    },
    error: null,
  };
}

interface RecordPayload {
  lab_result_id?: string;
  lab_order_id?: string;
  test_name?: string;
  visit_id?: string;
  lab_order_status?: LabOrderStatus;
  tasks_closed?: number | string;
  is_critical?: boolean;
  critical_check_status?: CriticalCheckStatus;
  requires_manual_review?: boolean;
  critical_direction?: "low" | "high" | null;
  value_numeric?: number | string | null;
  critical_low?: number | string | null;
  critical_high?: number | string | null;
  requires_acknowledgement?: boolean;
  reference_disclaimer?: string;
}

async function realRecordResult(input: {
  labOrderId: string;
  resultValue: string;
  unit: string | null;
  referenceRange: string | null;
  notes: string | null;
}): Promise<Result<RecordResultOutcome>> {
  const result = await rpcUntyped<RecordPayload>(
    createClient(),
    "record_lab_result",
    {
      p_lab_order_id: input.labOrderId,
      p_result_value: input.resultValue,
      p_unit: input.unit,
      p_reference_range: input.referenceRange,
      p_notes: input.notes,
    },
  );
  if (!result.data) return { data: null, error: result.error };
  const p = result.data;
  return {
    data: {
      lab_result_id: String(p.lab_result_id ?? ""),
      lab_order_id: String(p.lab_order_id ?? input.labOrderId),
      test_name: String(p.test_name ?? ""),
      visit_id: String(p.visit_id ?? ""),
      lab_order_status: p.lab_order_status ?? "completed",
      tasks_closed: num(p.tasks_closed),
      is_critical: Boolean(p.is_critical),
      critical_check_status:
        p.critical_check_status ?? "evaluation_failed",
      requires_manual_review: Boolean(p.requires_manual_review),
      critical_direction: p.critical_direction ?? null,
      value_numeric: nullableNum(p.value_numeric),
      critical_low: nullableNum(p.critical_low),
      critical_high: nullableNum(p.critical_high),
      requires_acknowledgement: Boolean(p.requires_acknowledgement),
      reference_disclaimer: String(p.reference_disclaimer ?? ""),
    },
    error: null,
  };
}

async function realSetStatus(
  labOrderId: string,
  status: LabOrderStatus,
  reason: string | null,
): Promise<Result<SetLabStatusOutcome>> {
  const result = await rpcUntyped<{
    lab_order_id?: string;
    status?: LabOrderStatus;
    changed?: boolean;
    tasks_closed?: number | string;
    pending_charges_removed?: number | string;
    billing_line_invoiced?: boolean;
  }>(createClient(), "set_lab_order_status", {
    p_lab_order_id: labOrderId,
    p_status: status,
    p_reason: reason?.trim() || null,
  });
  if (!result.data) return { data: null, error: result.error };
  const p = result.data;
  return {
    data: {
      lab_order_id: String(p.lab_order_id ?? labOrderId),
      status: p.status ?? status,
      changed: p.changed !== false,
      tasks_closed: num(p.tasks_closed),
      pending_charges_removed: num(p.pending_charges_removed),
      billing_line_invoiced: Boolean(p.billing_line_invoiced),
    },
    error: null,
  };
}

async function realListAlerts(): Promise<Result<CriticalAlert[]>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("critical_lab_alerts")
    .select("*")
    .is("acknowledged_at", null)
    .order("reported_at", { ascending: false });

  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      lab_result_id: String(r.lab_result_id ?? ""),
      lab_order_id: String(r.lab_order_id ?? ""),
      test_name: String(r.test_name ?? ""),
      priority: (r.priority as LabPriority) ?? "routine",
      visit_id: String(r.visit_id ?? ""),
      patient_id: String(r.patient_id ?? ""),
      patient_number: num(r.patient_number),
      care_setting: (r.care_setting as "opd" | "ipd") ?? "opd",
      ward_name: (r.ward_name as string | null) ?? null,
      bed_number: (r.bed_number as string | null) ?? null,
      result_value: String(r.result_value ?? ""),
      result_numeric: nullableNum(r.result_numeric),
      unit: (r.unit as string | null) ?? null,
      is_critical: Boolean(r.is_critical),
      critical_check_status:
        (r.critical_check_status as CriticalCheckStatus) ?? "evaluation_failed",
      requires_manual_review: Boolean(r.requires_manual_review),
      critical_direction: (r.critical_direction as "low" | "high" | null) ?? null,
      critical_low_used: nullableNum(r.critical_low_used),
      critical_high_used: nullableNum(r.critical_high_used),
      reported_at: String(r.reported_at ?? ""),
      acknowledged_at: (r.acknowledged_at as string | null) ?? null,
    })),
    error: null,
  };
}

async function realAcknowledge(
  labResultId: string,
  note: string | null,
): Promise<Result<{ changed: boolean }>> {
  const result = await rpcUntyped<{ changed?: boolean }>(
    createClient(),
    "acknowledge_critical_result",
    { p_lab_result_id: labResultId, p_note: note?.trim() || null },
  );
  if (!result.data) return { data: null, error: result.error };
  return { data: { changed: result.data.changed !== false }, error: null };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

function delay(ms = 320) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minutesAgo(m: number) {
  return new Date(Date.now() - m * 60_000).toISOString();
}

let mockOrders: LabOrder[] = [
  {
    id: "lab-1",
    visit_id: "ipd-2",
    patient_id: "mock-p-8",
    ordered_by: "mock-user-1",
    test_name: "Serum Potassium",
    priority: "stat",
    status: "completed",
    ordered_at: minutesAgo(90),
    notes: null,
    cancellation_reason: null,
  },
  {
    id: "lab-2",
    visit_id: "ipd-2",
    patient_id: "mock-p-8",
    ordered_by: "mock-user-1",
    test_name: "Dengue NS1 Antigen",
    priority: "urgent",
    status: "completed",
    ordered_at: minutesAgo(80),
    notes: null,
    cancellation_reason: null,
  },
  {
    id: "lab-3",
    visit_id: "visit-1",
    patient_id: "mock-p-1",
    ordered_by: "mock-user-1",
    test_name: "Complete Blood Count",
    priority: "routine",
    status: "sample_collected",
    ordered_at: minutesAgo(40),
    notes: "Fasting sample",
    cancellation_reason: null,
  },
  {
    id: "lab-4",
    visit_id: "visit-2",
    patient_id: "mock-p-2",
    ordered_by: "mock-user-1",
    test_name: "Random Blood Glucose",
    priority: "routine",
    status: "pending",
    ordered_at: minutesAgo(10),
    notes: null,
    cancellation_reason: null,
  },
];

/**
 * One critical and one unevaluable alert — the two cases the UI must render
 * differently, and the reason the mock includes a serology test whose result is a
 * word rather than a number.
 */
let mockAlerts: CriticalAlert[] = [
  {
    lab_result_id: "res-1",
    lab_order_id: "lab-1",
    test_name: "Serum Potassium",
    priority: "stat",
    visit_id: "ipd-2",
    patient_id: "mock-p-8",
    patient_number: 8,
    care_setting: "ipd",
    ward_name: "General Ward",
    bed_number: "G-01",
    result_value: "6.9",
    result_numeric: 6.9,
    unit: "mmol/L",
    is_critical: true,
    critical_check_status: "evaluated",
    requires_manual_review: false,
    critical_direction: "high",
    critical_low_used: 2.8,
    critical_high_used: 6.2,
    reported_at: minutesAgo(20),
    acknowledged_at: null,
  },
  {
    lab_result_id: "res-2",
    lab_order_id: "lab-2",
    test_name: "Dengue NS1 Antigen",
    priority: "urgent",
    visit_id: "ipd-2",
    patient_id: "mock-p-8",
    patient_number: 8,
    care_setting: "ipd",
    ward_name: "General Ward",
    bed_number: "G-01",
    result_value: "Reactive",
    result_numeric: null,
    unit: null,
    // The case that must never render as reassuring: not critical because it could
    // not be compared at all.
    is_critical: false,
    critical_check_status: "unparseable_value",
    requires_manual_review: true,
    critical_direction: null,
    critical_low_used: null,
    critical_high_used: null,
    reported_at: minutesAgo(15),
    acknowledged_at: null,
  },
];

const MOCK_DISCLAIMER =
  "Starter reference set, adult ranges only, not clinically reviewed. Paediatric and neonatal limits differ materially.";

/** A tiny stand-in for `lab_critical_ranges` so mock evaluation behaves plausibly. */
const MOCK_RANGES: Record<
  string,
  { low: number; high: number; unit: string; normalLow: number; normalHigh: number }
> = {
  "serum potassium": {
    low: 2.8,
    high: 6.2,
    unit: "mmol/L",
    normalLow: 3.5,
    normalHigh: 5.1,
  },
  "random blood glucose": {
    low: 50,
    high: 450,
    unit: "mg/dL",
    normalLow: 70,
    normalHigh: 140,
  },
  haemoglobin: {
    low: 7,
    high: 20,
    unit: "g/dL",
    normalLow: 12,
    normalHigh: 16,
  },
};

function mockEvaluate(
  testName: string,
  value: string,
  unit: string | null,
): CriticalEvaluation {
  const range = MOCK_RANGES[testName.trim().toLowerCase()];
  const parsed = Number(value.replace(/^[<>]=?/, "").trim());

  if (!range) {
    return {
      status: "no_reference",
      is_critical: false,
      direction: null,
      value_numeric: Number.isFinite(parsed) ? parsed : null,
      comparator: null,
      reference_unit: null,
      critical_low: null,
      critical_high: null,
      normal_low: null,
      normal_high: null,
      message:
        "No critical thresholds on file for this test. Verify against the lab's own range.",
    };
  }
  if (!Number.isFinite(parsed)) {
    return {
      status: "unparseable_value",
      is_critical: false,
      direction: null,
      value_numeric: null,
      comparator: null,
      reference_unit: range.unit,
      critical_low: range.low,
      critical_high: range.high,
      normal_low: range.normalLow,
      normal_high: range.normalHigh,
      message:
        "This result isn't numeric, so it can't be compared to a threshold. Verify manually.",
    };
  }
  if (unit && unit.trim().toLowerCase() !== range.unit.toLowerCase()) {
    return {
      status: "unit_mismatch",
      is_critical: false,
      direction: null,
      value_numeric: parsed,
      comparator: null,
      reference_unit: range.unit,
      critical_low: range.low,
      critical_high: range.high,
      normal_low: range.normalLow,
      normal_high: range.normalHigh,
      message: `Reported in ${unit}, reference is ${range.unit}. Not compared.`,
    };
  }

  // Inclusive on purpose: published limits read "notify if K+ >= 6.2".
  const high = parsed >= range.high;
  const low = parsed <= range.low;
  return {
    status: "evaluated",
    is_critical: high || low,
    direction: high ? "high" : low ? "low" : null,
    value_numeric: parsed,
    comparator: null,
    reference_unit: range.unit,
    critical_low: range.low,
    critical_high: range.high,
    normal_low: range.normalLow,
    normal_high: range.normalHigh,
    message:
      high || low
        ? "Critical value. Inform the treating doctor now."
        : "Within the checked range.",
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function listLabOrders(
  visitId?: string,
): Promise<Result<LabOrder[]>> {
  if (!USE_MOCK) return realListOrders(visitId);
  await delay();
  const rows = visitId
    ? mockOrders.filter((o) => o.visit_id === visitId)
    : mockOrders;
  return {
    data: [...rows].sort((a, b) => b.ordered_at.localeCompare(a.ordered_at)),
    error: null,
  };
}

/** Doctor or admin only. A nurse gets `42501` — ordering is a clinical decision. */
export async function createLabOrder(
  input: NewLabOrderInput,
): Promise<Result<LabOrder>> {
  if (!USE_MOCK) return realCreateOrder(input);
  await delay();
  if (!input.test_name.trim()) {
    return {
      data: null,
      error: {
        code: "VALIDATION_ERROR",
        message: "Enter a test name.",
        fields: ["test_name"],
      },
    };
  }
  const order: LabOrder = {
    id: `lab-${mockOrders.length + 1}`,
    visit_id: input.visit_id,
    patient_id: input.patient_id,
    ordered_by: input.ordered_by,
    test_name: input.test_name.trim(),
    priority: input.priority ?? "routine",
    status: "pending",
    ordered_at: new Date().toISOString(),
    notes: input.notes?.trim() || null,
    cancellation_reason: null,
  };
  mockOrders = [order, ...mockOrders];
  return { data: order, error: null };
}

/** Live check while typing. Any staff member; no side effects. */
export async function evaluateLabCritical(
  testName: string,
  value: string,
  unit: string | null,
): Promise<Result<CriticalEvaluation>> {
  if (!USE_MOCK) return realEvaluate(testName, value, unit);
  await delay(180);
  return { data: mockEvaluate(testName, value, unit), error: null };
}

/**
 * Record a result. Advances the order to `completed`, closes the nurse's collection
 * card, and returns the criticality decision to the person entering it — which is
 * what makes a critical value impossible to save without seeing that it is critical.
 */
export async function recordLabResult(input: {
  labOrderId: string;
  resultValue: string;
  unit?: string | null;
  referenceRange?: string | null;
  notes?: string | null;
}): Promise<Result<RecordResultOutcome>> {
  if (!USE_MOCK) {
    return realRecordResult({
      labOrderId: input.labOrderId,
      resultValue: input.resultValue,
      unit: input.unit ?? null,
      referenceRange: input.referenceRange ?? null,
      notes: input.notes ?? null,
    });
  }

  await delay();
  const order = mockOrders.find((o) => o.id === input.labOrderId);
  if (!order) {
    return {
      data: null,
      error: {
        code: "LAB_ORDER_NOT_FOUND",
        message: "That order no longer exists.",
      },
    };
  }
  if (order.status === "cancelled") {
    return {
      data: null,
      error: {
        code: "LAB_ORDER_CANCELLED",
        message: "This order was cancelled.",
      },
    };
  }
  if (!input.resultValue.trim()) {
    return {
      data: null,
      error: {
        code: "VALIDATION_ERROR",
        message: "Enter a result.",
        fields: ["result_value"],
      },
    };
  }

  const evaluation = mockEvaluate(
    order.test_name,
    input.resultValue,
    input.unit ?? null,
  );
  const requiresManualReview = evaluation.status !== "evaluated";
  mockOrders = mockOrders.map((o) =>
    o.id === order.id ? { ...o, status: "completed" } : o,
  );

  const outcome: RecordResultOutcome = {
    lab_result_id: `res-${mockAlerts.length + 10}`,
    lab_order_id: order.id,
    test_name: order.test_name,
    visit_id: order.visit_id,
    lab_order_status: "completed",
    tasks_closed: 1,
    is_critical: evaluation.is_critical,
    critical_check_status: evaluation.status,
    requires_manual_review: requiresManualReview,
    critical_direction: evaluation.direction,
    value_numeric: evaluation.value_numeric,
    critical_low: evaluation.critical_low,
    critical_high: evaluation.critical_high,
    requires_acknowledgement: evaluation.is_critical || requiresManualReview,
    reference_disclaimer: MOCK_DISCLAIMER,
  };

  if (outcome.requires_acknowledgement) {
    mockAlerts = [
      {
        lab_result_id: outcome.lab_result_id,
        lab_order_id: order.id,
        test_name: order.test_name,
        priority: order.priority,
        visit_id: order.visit_id,
        patient_id: order.patient_id,
        patient_number: 0,
        care_setting: "opd",
        ward_name: null,
        bed_number: null,
        result_value: input.resultValue.trim(),
        result_numeric: evaluation.value_numeric,
        unit: input.unit ?? null,
        is_critical: evaluation.is_critical,
        critical_check_status: evaluation.status,
        requires_manual_review: requiresManualReview,
        critical_direction: evaluation.direction,
        critical_low_used: evaluation.critical_low,
        critical_high_used: evaluation.critical_high,
        reported_at: new Date().toISOString(),
        acknowledged_at: null,
      },
      ...mockAlerts,
    ];
  }

  return { data: outcome, error: null };
}

export async function setLabOrderStatus(
  labOrderId: string,
  status: LabOrderStatus,
  reason: string | null = null,
): Promise<Result<SetLabStatusOutcome>> {
  if (!USE_MOCK) return realSetStatus(labOrderId, status, reason);
  await delay();
  const order = mockOrders.find((o) => o.id === labOrderId);
  if (!order) {
    return {
      data: null,
      error: {
        code: "LAB_ORDER_NOT_FOUND",
        message: "That order no longer exists.",
      },
    };
  }
  if (!allowedTransitions(order.status).includes(status)) {
    return {
      data: null,
      error: {
        code: "INVALID_STATUS_TRANSITION",
        message: `Can't move from ${order.status} to ${status}.`,
      },
    };
  }
  mockOrders = mockOrders.map((o) =>
    o.id === labOrderId
      ? {
          ...o,
          status,
          cancellation_reason:
            status === "cancelled" ? reason?.trim() || null : o.cancellation_reason,
        }
      : o,
  );
  return {
    data: {
      lab_order_id: labOrderId,
      status,
      changed: true,
      tasks_closed: status === "sample_collected" ? 1 : 0,
      pending_charges_removed: status === "cancelled" ? 1 : 0,
      billing_line_invoiced: false,
    },
    error: null,
  };
}

/** Unacknowledged alerts only — critical **and** unevaluable, both outstanding. */
export async function listCriticalAlerts(): Promise<Result<CriticalAlert[]>> {
  if (!USE_MOCK) return realListAlerts();
  await delay();
  return {
    data: mockAlerts.filter((a) => a.acknowledged_at === null),
    error: null,
  };
}

/** Clinical roles only — billing cannot clear a clinical alert. */
export async function acknowledgeCriticalResult(
  labResultId: string,
  note: string | null = null,
): Promise<Result<{ changed: boolean }>> {
  if (!USE_MOCK) return realAcknowledge(labResultId, note);
  await delay();
  const alert = mockAlerts.find((a) => a.lab_result_id === labResultId);
  if (!alert) {
    return {
      data: null,
      error: {
        code: "LAB_RESULT_NOT_FOUND",
        message: "That result no longer exists.",
      },
    };
  }
  const changed = alert.acknowledged_at === null;
  mockAlerts = mockAlerts.map((a) =>
    a.lab_result_id === labResultId
      ? { ...a, acknowledged_at: new Date().toISOString() }
      : a,
  );
  return { data: { changed }, error: null };
}
