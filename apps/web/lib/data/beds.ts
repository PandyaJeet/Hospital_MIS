import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError, rpcUntyped, untypedClient } from "./rpc";
import type { Result } from "./types";

/**
 * IPD admission and bed management — `docs/contracts/ipd-beds.md`.
 *
 * Two things drive the shape of everything here:
 *
 * **Admission is not a `visits.status` value** (§1). `status` tracks the
 * consultation lifecycle; `care_setting` + `discharged_at` track where the patient
 * is. A discharged patient's `status` is frequently still `queued`. Never infer
 * inpatient state from `status`.
 *
 * **`beds.status` and `beds.current_visit_id` are not client-writable** (§2), so
 * occupancy is only ever a consequence of admitting or discharging somebody. There
 * is deliberately no function here that writes them directly.
 */

export type BedStatus = "available" | "occupied" | "cleaning" | "maintenance";

/**
 * What `set_bed_status()` accepts. `occupied` is excluded at the type level for the
 * same reason the RPC rejects it (§5): occupancy is an outcome of an admission,
 * never a state somebody types in.
 */
export type HousekeepingStatus = Exclude<BedStatus, "occupied">;

export type CareSetting = "opd" | "ipd";

export interface Bed {
  id: string;
  ward_name: string;
  /** Text, not a number — `'12A'` and `'ICU-3'` are real bed numbers (§2). */
  bed_number: string;
  status: BedStatus;
  /** Live occupancy. Cleared on discharge, unlike `visits.bed_id`. */
  current_visit_id: string | null;
  notes: string | null;
}

export interface Ward {
  id: string;
  name: string;
  /** Per ward, never per bed — GST treatment must not vary by bed-level typo (§12.1). */
  daily_rate: number;
  is_critical_care: boolean;
  notes: string | null;
}

/** An open stay's running total. A projection, not a ledger — reading it charges nothing. */
export interface AccrualRow {
  bed_stay_id: string;
  visit_id: string;
  patient_id: string;
  patient_number: number;
  patient_name: string;
  bed_id: string;
  bed_number: string;
  ward_name: string;
  is_critical_care: boolean;
  daily_rate: number;
  started_at: string;
  admitted_at: string;
  days_so_far: number;
  accrued_amount: number;
  tax_category: string | null;
  tax_rate: number | null;
  accrued_tax: number | null;
  /** True when the ward has no rate set. Show a warning, never a plausible ₹0 (§12.6). */
  ward_unpriced: boolean;
}

export interface AdmitOutcome {
  visit_id: string;
  bed_id: string;
  ward_name: string;
  bed_number: string;
  admitted_at: string;
  /** False when the patient was already in this exact bed — idempotent success (§4). */
  changed: boolean;
  daily_rate: number | null;
  is_critical_care: boolean;
  /** Present when this call moved the patient out of another bed. */
  transferred_from: {
    bed_id: string;
    ward_name: string;
    bed_number: string;
  } | null;
}

export interface DischargeOutcome {
  visit_id: string;
  discharged_at: string;
  /** Null when the patient was admitted but never given a bed — a real state (§1). */
  bed_released: string | null;
  pending_tasks_cancelled: number;
  bed_stays_closed: number;
  /** Echoed back, NOT stored — there is no discharge-summary field this phase (§6). */
  notes: string | null;
}

export interface SetBedStatusOutcome {
  bed_id: string;
  status: HousekeepingStatus;
  changed: boolean;
}

export interface NewBedInput {
  /** Required by the schema; `status` and `current_visit_id` are not grantable (§2). */
  tenant_id: string;
  ward_name: string;
  bed_number: string;
  notes?: string | null;
}

export interface WardPricingInput {
  daily_rate: number;
  is_critical_care: boolean;
}

/** Beds a patient can actually be moved into. */
export function isAssignable(bed: Bed) {
  return bed.status === "available";
}

export function groupByWard(beds: Bed[]): { ward: string; beds: Bed[] }[] {
  const wards = new Map<string, Bed[]>();
  for (const bed of beds) {
    const list = wards.get(bed.ward_name);
    if (list) list.push(bed);
    else wards.set(bed.ward_name, [bed]);
  }
  return [...wards.entries()]
    .map(([ward, list]) => ({ ward, beds: list }))
    .sort((a, b) => a.ward.localeCompare(b.ward));
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

function toBed(row: Record<string, unknown>): Bed {
  return {
    id: String(row.id ?? ""),
    ward_name: String(row.ward_name ?? ""),
    bed_number: String(row.bed_number ?? ""),
    status: (row.status as BedStatus) ?? "available",
    current_visit_id: (row.current_visit_id as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The clinic's tier, for hiding what a Tier 1 clinic cannot use.
 *
 * `current_tenant_tier()` returns a bare number rather than the `{ ok }` envelope,
 * so this cannot go through `fromRpc`. Null means "not in a clinic" — a different
 * fact from Tier 1, and the reason this is not defaulted to 1 (§3).
 *
 * This hides UI only. The gate itself is in RLS and in the RPCs, so a stale or
 * wrong answer here cannot grant anything.
 */
async function realGetCurrentTier(): Promise<Result<number | null>> {
  const supabase = createClient();
  const { data, error } = await untypedClient(supabase).rpc(
    "current_tenant_tier",
    {},
  );
  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: nullableNum(data), error: null };
}

async function realListBeds(): Promise<Result<Bed[]>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("beds")
    .select("id, ward_name, bed_number, status, current_visit_id, notes")
    .order("ward_name")
    .order("bed_number");

  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map(toBed),
    error: null,
  };
}

async function realListWards(): Promise<Result<Ward[]>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("wards")
    .select("id, name, daily_rate, is_critical_care, notes")
    .order("name");

  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      daily_rate: num(row.daily_rate),
      is_critical_care: Boolean(row.is_critical_care),
      notes: (row.notes as string | null) ?? null,
    })),
    error: null,
  };
}

/**
 * Adding a bed in a ward that does not exist creates the ward automatically, at
 * rate 0 (§12.2). That is convenient but silently unpriced, so callers must warn —
 * see `wardsNeedingPrice`.
 */
async function realCreateBed(input: NewBedInput): Promise<Result<Bed>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("beds")
    .insert({
      tenant_id: input.tenant_id,
      ward_name: input.ward_name.trim(),
      bed_number: input.bed_number.trim(),
      notes: input.notes?.trim() || null,
    })
    .select("id, ward_name, bed_number, status, current_visit_id, notes")
    .maybeSingle();

  if (error) return { data: null, error: mapPostgrestError(error) };
  if (!data) {
    // Insert reported success but returned nothing: RLS let the write through and
    // then hid the row, or the policy matched nothing. Either way we cannot claim
    // it worked.
    return {
      data: null,
      error: {
        code: "PERMISSION_DENIED",
        message: "You don't have permission to do that.",
      },
    };
  }
  return { data: toBed(data as Record<string, unknown>), error: null };
}

/**
 * Set a ward's daily rate and critical-care flag.
 *
 * ⚠️ An UPDATE whose policy matches nothing affects 0 rows and **returns success**
 * (§2) — standard RLS semantics. A nurse editing a rate would otherwise be told it
 * saved. So this asks for the row back and treats an empty result as a denial.
 */
async function realSetWardPricing(
  wardId: string,
  input: WardPricingInput,
): Promise<Result<Ward>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("wards")
    .update({
      daily_rate: input.daily_rate,
      is_critical_care: input.is_critical_care,
    })
    .eq("id", wardId)
    .select("id, name, daily_rate, is_critical_care, notes")
    .maybeSingle();

  if (error) return { data: null, error: mapPostgrestError(error) };
  if (!data) {
    return {
      data: null,
      error: {
        code: "PERMISSION_DENIED",
        message: "You don't have permission to change ward pricing.",
      },
    };
  }
  const row = data as Record<string, unknown>;
  return {
    data: {
      id: String(row.id ?? ""),
      name: String(row.name ?? ""),
      daily_rate: num(row.daily_rate),
      is_critical_care: Boolean(row.is_critical_care),
      notes: (row.notes as string | null) ?? null,
    },
    error: null,
  };
}

async function realListAccrual(): Promise<Result<AccrualRow[]>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("ipd_accrual_current")
    .select("*")
    .order("started_at", { ascending: true });

  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      bed_stay_id: String(r.bed_stay_id ?? ""),
      visit_id: String(r.visit_id ?? ""),
      patient_id: String(r.patient_id ?? ""),
      patient_number: num(r.patient_number),
      patient_name: String(r.patient_name ?? ""),
      bed_id: String(r.bed_id ?? ""),
      bed_number: String(r.bed_number ?? ""),
      ward_name: String(r.ward_name ?? ""),
      is_critical_care: Boolean(r.is_critical_care),
      daily_rate: num(r.daily_rate),
      started_at: String(r.started_at ?? ""),
      admitted_at: String(r.admitted_at ?? ""),
      days_so_far: num(r.days_so_far),
      accrued_amount: num(r.accrued_amount),
      tax_category: (r.tax_category as string | null) ?? null,
      tax_rate: nullableNum(r.tax_rate),
      accrued_tax: nullableNum(r.accrued_tax),
      ward_unpriced: Boolean(r.ward_unpriced),
    })),
    error: null,
  };
}

interface AdmitPayload {
  visit_id?: string;
  bed_id?: string;
  ward_name?: string;
  bed_number?: string;
  admitted_at?: string;
  changed?: boolean;
  daily_rate?: number | string | null;
  is_critical_care?: boolean;
  transferred_from?: {
    bed_id: string;
    ward_name: string;
    bed_number: string;
  } | null;
}

async function realAdmit(
  visitId: string,
  bedId: string,
): Promise<Result<AdmitOutcome>> {
  const result = await rpcUntyped<AdmitPayload>(
    createClient(),
    "admit_patient_to_bed",
    { p_visit_id: visitId, p_bed_id: bedId },
  );
  if (!result.data) return { data: null, error: result.error };
  const p = result.data;
  return {
    data: {
      visit_id: String(p.visit_id ?? visitId),
      bed_id: String(p.bed_id ?? bedId),
      ward_name: String(p.ward_name ?? ""),
      bed_number: String(p.bed_number ?? ""),
      admitted_at: String(p.admitted_at ?? ""),
      changed: p.changed !== false,
      daily_rate: nullableNum(p.daily_rate),
      is_critical_care: Boolean(p.is_critical_care),
      transferred_from: p.transferred_from ?? null,
    },
    error: null,
  };
}

interface DischargePayload {
  visit_id?: string;
  discharged_at?: string;
  bed_released?: string | null;
  pending_tasks_cancelled?: number | string;
  bed_stays_closed?: number | string;
  notes?: string | null;
}

async function realDischarge(
  visitId: string,
  notes: string | null,
): Promise<Result<DischargeOutcome>> {
  const result = await rpcUntyped<DischargePayload>(
    createClient(),
    "discharge_patient",
    { p_visit_id: visitId, p_notes: notes?.trim() || null },
  );
  if (!result.data) return { data: null, error: result.error };
  const p = result.data;
  return {
    data: {
      visit_id: String(p.visit_id ?? visitId),
      discharged_at: String(p.discharged_at ?? ""),
      bed_released: p.bed_released ?? null,
      pending_tasks_cancelled: num(p.pending_tasks_cancelled),
      bed_stays_closed: num(p.bed_stays_closed),
      notes: p.notes ?? null,
    },
    error: null,
  };
}

async function realSetBedStatus(
  bedId: string,
  status: HousekeepingStatus,
): Promise<Result<SetBedStatusOutcome>> {
  const result = await rpcUntyped<{
    bed_id?: string;
    status?: HousekeepingStatus;
    changed?: boolean;
  }>(createClient(), "set_bed_status", {
    p_bed_id: bedId,
    p_status: status,
  });
  if (!result.data) return { data: null, error: result.error };
  return {
    data: {
      bed_id: String(result.data.bed_id ?? bedId),
      status: result.data.status ?? status,
      changed: result.data.changed !== false,
    },
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

function delay(ms = 320) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hoursAgo(h: number) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

/** Kept consistent with the rounds mock: G-01 and G-03 hold ipd-2 and ipd-1. */
let mockBeds: Bed[] = [
  {
    id: "bed-1",
    ward_name: "General Ward",
    bed_number: "G-01",
    status: "occupied",
    current_visit_id: "ipd-2",
    notes: null,
  },
  {
    id: "bed-2",
    ward_name: "General Ward",
    bed_number: "G-02",
    status: "available",
    current_visit_id: null,
    notes: null,
  },
  {
    id: "bed-3",
    ward_name: "General Ward",
    bed_number: "G-03",
    status: "occupied",
    current_visit_id: "ipd-1",
    notes: null,
  },
  {
    id: "bed-4",
    ward_name: "General Ward",
    bed_number: "G-04",
    status: "cleaning",
    current_visit_id: null,
    notes: null,
  },
  {
    id: "bed-5",
    ward_name: "ICU",
    bed_number: "ICU-1",
    status: "available",
    current_visit_id: null,
    notes: "Ventilator available",
  },
  {
    id: "bed-6",
    ward_name: "ICU",
    bed_number: "ICU-2",
    status: "maintenance",
    current_visit_id: null,
    notes: "Monitor faulty",
  },
];

/** "Day Care" is deliberately unpriced, so the ₹0 warning has something to show. */
let mockWards: Ward[] = [
  {
    id: "ward-1",
    name: "General Ward",
    daily_rate: 2500,
    is_critical_care: false,
    notes: null,
  },
  {
    id: "ward-2",
    name: "ICU",
    daily_rate: 25000,
    is_critical_care: true,
    notes: null,
  },
  {
    id: "ward-3",
    name: "Day Care",
    daily_rate: 0,
    is_critical_care: false,
    notes: null,
  },
];

async function mockAdmit(
  visitId: string,
  bedId: string,
): Promise<Result<AdmitOutcome>> {
  await delay();
  const bed = mockBeds.find((b) => b.id === bedId);
  if (!bed) {
    return {
      data: null,
      error: { code: "BED_NOT_FOUND", message: "That bed no longer exists." },
    };
  }
  if (bed.current_visit_id === visitId) {
    // Idempotent success — a double-tap must not close and reopen a stay.
    const ward = mockWards.find((w) => w.name === bed.ward_name);
    return {
      data: {
        visit_id: visitId,
        bed_id: bed.id,
        ward_name: bed.ward_name,
        bed_number: bed.bed_number,
        admitted_at: hoursAgo(1),
        changed: false,
        daily_rate: ward?.daily_rate ?? null,
        is_critical_care: ward?.is_critical_care ?? false,
        transferred_from: null,
      },
      error: null,
    };
  }
  if (bed.status !== "available") {
    return {
      data: null,
      error: {
        code: "BED_NOT_AVAILABLE",
        message: "That bed isn't available.",
      },
    };
  }

  const previous = mockBeds.find((b) => b.current_visit_id === visitId);
  mockBeds = mockBeds.map((b) => {
    if (b.id === bedId) {
      return { ...b, status: "occupied", current_visit_id: visitId };
    }
    // A transfer frees the old bed to `cleaning`, not `available`.
    if (b.id === previous?.id) {
      return { ...b, status: "cleaning", current_visit_id: null };
    }
    return b;
  });

  const ward = mockWards.find((w) => w.name === bed.ward_name);
  return {
    data: {
      visit_id: visitId,
      bed_id: bed.id,
      ward_name: bed.ward_name,
      bed_number: bed.bed_number,
      admitted_at: new Date().toISOString(),
      changed: true,
      daily_rate: ward?.daily_rate ?? null,
      is_critical_care: ward?.is_critical_care ?? false,
      transferred_from: previous
        ? {
            bed_id: previous.id,
            ward_name: previous.ward_name,
            bed_number: previous.bed_number,
          }
        : null,
    },
    error: null,
  };
}

async function mockDischarge(
  visitId: string,
  notes: string | null,
): Promise<Result<DischargeOutcome>> {
  await delay();
  const bed = mockBeds.find((b) => b.current_visit_id === visitId);
  mockBeds = mockBeds.map((b) =>
    b.id === bed?.id ? { ...b, status: "cleaning", current_visit_id: null } : b,
  );
  return {
    data: {
      visit_id: visitId,
      discharged_at: new Date().toISOString(),
      bed_released: bed ? `${bed.ward_name} ${bed.bed_number}` : null,
      pending_tasks_cancelled: bed ? 2 : 0,
      bed_stays_closed: bed ? 1 : 0,
      notes: notes?.trim() || null,
    },
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getCurrentTier(): Promise<Result<number | null>> {
  if (!USE_MOCK) return realGetCurrentTier();
  await delay(120);
  // Tier 2, so the ward surfaces are explorable in mock mode.
  return { data: 2, error: null };
}

export async function listBeds(): Promise<Result<Bed[]>> {
  if (!USE_MOCK) return realListBeds();
  await delay();
  return { data: [...mockBeds], error: null };
}

export async function listWards(): Promise<Result<Ward[]>> {
  if (!USE_MOCK) return realListWards();
  await delay();
  return { data: [...mockWards], error: null };
}

/** Admin + Tier 2. A ward that does not exist yet is created automatically, at ₹0. */
export async function createBed(input: NewBedInput): Promise<Result<Bed>> {
  if (!USE_MOCK) return realCreateBed(input);
  await delay();
  const ward = input.ward_name.trim();
  const number = input.bed_number.trim();
  if (mockBeds.some((b) => b.ward_name === ward && b.bed_number === number)) {
    return {
      data: null,
      error: {
        code: "ALREADY_EXISTS",
        message: "That bed number already exists in this ward.",
        fields: ["bed_number"],
      },
    };
  }
  const bed: Bed = {
    id: `bed-${mockBeds.length + 1}-${number}`,
    ward_name: ward,
    bed_number: number,
    status: "available",
    current_visit_id: null,
    notes: input.notes?.trim() || null,
  };
  mockBeds = [...mockBeds, bed];
  if (!mockWards.some((w) => w.name === ward)) {
    // Mirrors the BEFORE INSERT trigger: the ward appears, unpriced.
    mockWards = [
      ...mockWards,
      {
        id: `ward-${mockWards.length + 1}`,
        name: ward,
        daily_rate: 0,
        is_critical_care: false,
        notes: null,
      },
    ];
  }
  return { data: bed, error: null };
}

/** Admin + Tier 2. Rate and critical-care flag live on the ward, never the bed. */
export async function setWardPricing(
  wardId: string,
  input: WardPricingInput,
): Promise<Result<Ward>> {
  if (!USE_MOCK) return realSetWardPricing(wardId, input);
  await delay();
  const ward = mockWards.find((w) => w.id === wardId);
  if (!ward) {
    return {
      data: null,
      error: { code: "NOT_FOUND", message: "That ward no longer exists." },
    };
  }
  const updated: Ward = { ...ward, ...input };
  mockWards = mockWards.map((w) => (w.id === wardId ? updated : w));
  return { data: updated, error: null };
}

/**
 * Admit, or transfer. Any onboarded staff member — the decision is a doctor's but
 * the recording happens at the front desk (§4). Tier 2 gated.
 *
 * Calling it on an already-admitted visit with a different bed is a transfer, which
 * is the only way to correct a mis-assigned bed without falsifying a discharge time.
 */
export async function admitPatientToBed(
  visitId: string,
  bedId: string,
): Promise<Result<AdmitOutcome>> {
  return USE_MOCK ? mockAdmit(visitId, bedId) : realAdmit(visitId, bedId);
}

/**
 * Discharge. Deliberately **not** tier-gated (§6): a clinic downgraded mid-stay
 * must still be able to unwind, or the patient stays admitted forever.
 */
export async function dischargePatient(
  visitId: string,
  notes: string | null = null,
): Promise<Result<DischargeOutcome>> {
  return USE_MOCK
    ? mockDischarge(visitId, notes)
    : realDischarge(visitId, notes);
}

/** Housekeeping turnover. Nursing or admin only, Tier 2 gated. */
export async function setBedStatus(
  bedId: string,
  status: HousekeepingStatus,
): Promise<Result<SetBedStatusOutcome>> {
  if (!USE_MOCK) return realSetBedStatus(bedId, status);
  await delay();
  const bed = mockBeds.find((b) => b.id === bedId);
  if (!bed) {
    return {
      data: null,
      error: { code: "BED_NOT_FOUND", message: "That bed no longer exists." },
    };
  }
  if (bed.status === "occupied") {
    return {
      data: null,
      error: {
        code: "BED_OCCUPIED",
        message: "Discharge or transfer the patient first.",
      },
    };
  }
  const changed = bed.status !== status;
  mockBeds = mockBeds.map((b) => (b.id === bedId ? { ...b, status } : b));
  return { data: { bed_id: bedId, status, changed }, error: null };
}

export async function listIpdAccrual(): Promise<Result<AccrualRow[]>> {
  if (!USE_MOCK) return realListAccrual();
  await delay();
  return {
    data: [
      {
        bed_stay_id: "stay-1",
        visit_id: "ipd-2",
        patient_id: "mock-p-8",
        patient_number: 8,
        patient_name: "Imran Sheikh",
        bed_id: "bed-1",
        bed_number: "G-01",
        ward_name: "General Ward",
        is_critical_care: false,
        daily_rate: 2500,
        started_at: hoursAgo(30),
        admitted_at: hoursAgo(30),
        days_so_far: 2,
        accrued_amount: 5000,
        tax_category: "exempt",
        tax_rate: 0,
        accrued_tax: 0,
        ward_unpriced: false,
      },
    ],
    error: null,
  };
}
