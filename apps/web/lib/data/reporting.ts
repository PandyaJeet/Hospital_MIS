import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError, untypedClient } from "./rpc";
import type { Result } from "./types";

/**
 * Admin reporting — `docs/contracts/admin-dashboard.md`.
 *
 * Three things the UI must respect:
 *  1. **These are views, not RPCs**, admin-gated inside the view body. A non-admin
 *     gets **zero rows, not an error** (§1) — so never render "no data yet" for a
 *     doctor; check the role and don't show the page.
 *  2. **A clinic day is the UTC calendar date**, i.e. 05:30 IST → 05:30 IST (§2).
 *     Label it "clinic day", never "today".
 *  3. **Staff activity is not utilization** (§6). There is no roster, so the
 *     denominator does not exist. Report activity counts and real consulting
 *     minutes, and never call it utilization.
 */
export interface DashboardSummary {
  tenant_name: string;
  tier: number;
  gst_registered: boolean;
  as_of_date: string;
  visits_today: number;
  visits_completed_today: number;
  visits_open_now: number;
  new_patients_today: number;
  revenue_today: number;
  collected_today: number;
  visits_30d: number;
  new_patients_30d: number;
  revenue_30d: number;
  outstanding_30d: number;
  active_staff: number;
  inactive_staff: number;
  total_patients: number;
}

export interface OccupancySnapshot {
  total_beds: number;
  occupied: number;
  available: number;
  cleaning: number;
  maintenance: number;
  /** NULL when total_beds = 0 — "no ward exists" is not "0% occupied". Render "—". */
  occupancy_pct: number | null;
  current_inpatients: number;
  /** Admitted with no bed yet. Why current_inpatients can exceed occupied. */
  admitted_without_bed: number;
  admissions_today: number;
  discharges_today: number;
}

export interface StaffActivityDay {
  staff_id: string;
  staff_name: string | null;
  staff_role: string;
  staff_is_active: boolean;
  consultations_completed: number;
  notes_authored: number;
  prescriptions_issued: number;
  vitals_recorded: number;
  tasks_completed: number;
  recorded_actions_total: number;
  consulting_minutes: number | null;
  avg_consultation_minutes: number | null;
  /** Show next to the average — it says how much is not being seen. */
  consultations_untimed: number;
}

export type ReconciliationSeverity = "high" | "warning" | "info";
export type ReconciliationFindingType =
  | "pending_charge"
  | "invoice_sum_mismatch"
  | "payment_status_mismatch";

export interface ReconciliationFinding {
  finding_type: ReconciliationFindingType;
  severity: ReconciliationSeverity;
  row_id: string;
  table_name: string;
  visit_id: string | null;
  invoice_id: string | null;
  invoice_number: number | null;
  detail: string;
  amount_at_stake: number | null;
  expected_amount: number | null;
  age_hours: number | null;
  occurred_at: string;
}

export interface ReconciliationSummaryRow {
  finding_type: ReconciliationFindingType;
  severity: ReconciliationSeverity;
  finding_count: number;
  total_amount_at_stake: number | null;
  oldest_age_hours: number | null;
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return num(value);
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realSummary(): Promise<Result<DashboardSummary | null>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("admin_dashboard_summary")
    .select("*")
    .maybeSingle();

  if (error) return { data: null, error: mapPostgrestError(error) };
  // Zero rows means "not an admin", not a failure (§1).
  if (!data) return { data: null, error: null };

  const r = data as Record<string, unknown>;
  return {
    data: {
      tenant_name: String(r.tenant_name ?? ""),
      tier: num(r.tier),
      gst_registered: Boolean(r.gst_registered),
      as_of_date: String(r.as_of_date ?? ""),
      visits_today: num(r.visits_today),
      visits_completed_today: num(r.visits_completed_today),
      visits_open_now: num(r.visits_open_now),
      new_patients_today: num(r.new_patients_today),
      revenue_today: num(r.revenue_today),
      collected_today: num(r.collected_today),
      visits_30d: num(r.visits_30d),
      new_patients_30d: num(r.new_patients_30d),
      revenue_30d: num(r.revenue_30d),
      outstanding_30d: num(r.outstanding_30d),
      active_staff: num(r.active_staff),
      inactive_staff: num(r.inactive_staff),
      total_patients: num(r.total_patients),
    },
    error: null,
  };
}

async function realOccupancy(): Promise<Result<OccupancySnapshot | null>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("admin_occupancy_current")
    .select("*")
    .maybeSingle();

  if (error) return { data: null, error: mapPostgrestError(error) };
  if (!data) return { data: null, error: null };

  const r = data as Record<string, unknown>;
  return {
    data: {
      total_beds: num(r.total_beds),
      occupied: num(r.occupied),
      available: num(r.available),
      cleaning: num(r.cleaning),
      maintenance: num(r.maintenance),
      occupancy_pct: nullableNum(r.occupancy_pct),
      current_inpatients: num(r.current_inpatients),
      admitted_without_bed: num(r.admitted_without_bed),
      admissions_today: num(r.admissions_today),
      discharges_today: num(r.discharges_today),
    },
    error: null,
  };
}

async function realStaffActivity(
  day: string,
): Promise<Result<StaffActivityDay[]>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("admin_staff_activity_daily")
    .select("*")
    .eq("activity_date", day)
    .order("recorded_actions_total", { ascending: false });

  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      staff_id: String(r.staff_id ?? ""),
      staff_name: (r.staff_name as string | null) ?? null,
      staff_role: String(r.staff_role ?? ""),
      staff_is_active: Boolean(r.staff_is_active),
      consultations_completed: num(r.consultations_completed),
      notes_authored: num(r.notes_authored),
      prescriptions_issued: num(r.prescriptions_issued),
      vitals_recorded: num(r.vitals_recorded),
      tasks_completed: num(r.tasks_completed),
      recorded_actions_total: num(r.recorded_actions_total),
      consulting_minutes: nullableNum(r.consulting_minutes),
      avg_consultation_minutes: nullableNum(r.avg_consultation_minutes),
      consultations_untimed: num(r.consultations_untimed),
    })),
    error: null,
  };
}

async function realReconSummary(): Promise<Result<ReconciliationSummaryRow[]>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("billing_reconciliation_summary")
    .select("*");

  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      finding_type: r.finding_type as ReconciliationFindingType,
      severity: r.severity as ReconciliationSeverity,
      finding_count: num(r.finding_count),
      total_amount_at_stake: nullableNum(r.total_amount_at_stake),
      oldest_age_hours: nullableNum(r.oldest_age_hours),
    })),
    error: null,
  };
}

async function realFindings(): Promise<Result<ReconciliationFinding[]>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("billing_reconciliation")
    .select("*")
    .order("occurred_at", { ascending: true });

  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      finding_type: r.finding_type as ReconciliationFindingType,
      severity: r.severity as ReconciliationSeverity,
      row_id: String(r.row_id ?? ""),
      table_name: String(r.table_name ?? ""),
      visit_id: (r.visit_id as string | null) ?? null,
      invoice_id: (r.invoice_id as string | null) ?? null,
      invoice_number: nullableNum(r.invoice_number),
      detail: String(r.detail ?? ""),
      amount_at_stake: nullableNum(r.amount_at_stake),
      expected_amount: nullableNum(r.expected_amount),
      age_hours: nullableNum(r.age_hours),
      occurred_at: String(r.occurred_at ?? ""),
    })),
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

function delay(ms = 380) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MOCK_SUMMARY: DashboardSummary = {
  tenant_name: "Sunrise Clinic (seed)",
  tier: 1,
  gst_registered: true,
  as_of_date: new Date().toISOString().slice(0, 10),
  visits_today: 13,
  visits_completed_today: 9,
  visits_open_now: 3,
  new_patients_today: 4,
  revenue_today: 8425,
  collected_today: 7180,
  visits_30d: 268,
  new_patients_30d: 74,
  revenue_30d: 184300,
  outstanding_30d: 12450,
  active_staff: 3,
  inactive_staff: 1,
  total_patients: 412,
};

/**
 * A Tier 2 nursing home, kept consistent with the rounds mock.
 *
 * Note `current_inpatients` (3) exceeds `occupied` (2): one patient is admitted
 * without a bed yet, which is legitimate rather than an inconsistency.
 *
 * Set `total_beds` to 0 to see the no-ward path, where `occupancy_pct` is NULL and
 * the dashboard renders "no beds configured" rather than a misleading 0%.
 */
const MOCK_OCCUPANCY: OccupancySnapshot = {
  total_beds: 6,
  occupied: 2,
  available: 3,
  cleaning: 1,
  maintenance: 0,
  occupancy_pct: 33,
  current_inpatients: 3,
  admitted_without_bed: 1,
  admissions_today: 2,
  discharges_today: 1,
};

const MOCK_STAFF: StaffActivityDay[] = [
  {
    staff_id: "u2",
    staff_name: "Vikram Shah",
    staff_role: "doctor",
    staff_is_active: true,
    consultations_completed: 9,
    notes_authored: 8,
    prescriptions_issued: 7,
    vitals_recorded: 0,
    tasks_completed: 0,
    recorded_actions_total: 24,
    consulting_minutes: 96,
    avg_consultation_minutes: 12,
    consultations_untimed: 1,
  },
  {
    staff_id: "u3",
    staff_name: "Priya Nair",
    staff_role: "nurse",
    staff_is_active: true,
    consultations_completed: 0,
    notes_authored: 0,
    prescriptions_issued: 0,
    vitals_recorded: 14,
    tasks_completed: 11,
    recorded_actions_total: 25,
    consulting_minutes: null,
    avg_consultation_minutes: null,
    consultations_untimed: 0,
  },
];

const MOCK_FINDINGS: ReconciliationFinding[] = [
  {
    finding_type: "invoice_sum_mismatch",
    severity: "high",
    row_id: "inv-x",
    table_name: "invoices",
    visit_id: "v9",
    invoice_id: "inv-x",
    invoice_number: 1039,
    detail:
      "Stored subtotal (₹1,240.00) disagrees with the sum of its lines (₹1,190.00).",
    amount_at_stake: 50,
    expected_amount: 1190,
    age_hours: 19,
    occurred_at: new Date(Date.now() - 19 * 3600_000).toISOString(),
  },
  {
    finding_type: "payment_status_mismatch",
    severity: "high",
    row_id: "inv-y",
    table_name: "invoices",
    visit_id: "v8",
    invoice_id: "inv-y",
    invoice_number: 1036,
    detail: "Marked paid but ₹300.00 short of the grand total.",
    amount_at_stake: 300,
    expected_amount: 1500,
    age_hours: 41,
    occurred_at: new Date(Date.now() - 41 * 3600_000).toISOString(),
  },
  {
    finding_type: "pending_charge",
    severity: "warning",
    row_id: "bl-9",
    table_name: "billing_line_items",
    visit_id: "v7",
    invoice_id: null,
    invoice_number: null,
    detail: "Consultation charge uninvoiced for more than 24 hours.",
    amount_at_stake: 500,
    expected_amount: null,
    age_hours: 30,
    occurred_at: new Date(Date.now() - 30 * 3600_000).toISOString(),
  },
  {
    finding_type: "pending_charge",
    severity: "info",
    row_id: "bl-1",
    table_name: "billing_line_items",
    visit_id: "v1",
    invoice_id: null,
    invoice_number: null,
    detail: "Charge raised today, not yet invoiced — an open encounter.",
    amount_at_stake: 500,
    expected_amount: null,
    age_hours: 2,
    occurred_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
  },
];

function mockSummaryRows(): ReconciliationSummaryRow[] {
  const map = new Map<string, ReconciliationSummaryRow>();
  for (const f of MOCK_FINDINGS) {
    const key = `${f.finding_type}:${f.severity}`;
    const row = map.get(key) ?? {
      finding_type: f.finding_type,
      severity: f.severity,
      finding_count: 0,
      total_amount_at_stake: 0,
      oldest_age_hours: 0,
    };
    row.finding_count += 1;
    row.total_amount_at_stake =
      (row.total_amount_at_stake ?? 0) + (f.amount_at_stake ?? 0);
    row.oldest_age_hours = Math.max(
      row.oldest_age_hours ?? 0,
      f.age_hours ?? 0,
    );
    map.set(key, row);
  }
  return [...map.values()];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getDashboardSummary(): Promise<
  Result<DashboardSummary | null>
> {
  if (!USE_MOCK) return realSummary();
  await delay();
  return { data: MOCK_SUMMARY, error: null };
}

export async function getOccupancy(): Promise<Result<OccupancySnapshot | null>> {
  if (!USE_MOCK) return realOccupancy();
  await delay();
  return { data: MOCK_OCCUPANCY, error: null };
}

export async function getStaffActivity(
  day: string,
): Promise<Result<StaffActivityDay[]>> {
  if (!USE_MOCK) return realStaffActivity(day);
  await delay();
  return { data: MOCK_STAFF, error: null };
}

export async function getReconciliationSummary(): Promise<
  Result<ReconciliationSummaryRow[]>
> {
  if (!USE_MOCK) return realReconSummary();
  await delay();
  return { data: mockSummaryRows(), error: null };
}

export async function getReconciliationFindings(): Promise<
  Result<ReconciliationFinding[]>
> {
  if (!USE_MOCK) return realFindings();
  await delay();
  return { data: MOCK_FINDINGS, error: null };
}
