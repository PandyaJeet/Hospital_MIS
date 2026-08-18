import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError } from "./rpc";
import { autoCompleteMockVitalsTask } from "./tasks";
import type { Result } from "./types";

/**
 * Shapes follow `docs/contracts/vitals-and-rounds.md` §7.
 *
 * **Every measurement is optional and that is the contract, not an oversight.**
 * Do not add required-field validation: a nurse mid-round routinely has pulse and
 * temperature but no BP because the only cuff is two beds down. Blocking the save
 * means the reading stays on paper, or a placeholder gets typed — and an invented
 * vital is worse than a missing one, because a doctor reads it as fact off a trend.
 *
 * Units are fixed and unstored: °C, bpm, mmHg, breaths/min, %, and **mg/dL** for
 * glucose (the Indian convention). Label the inputs accordingly.
 */
export type MeasurementKey =
  | "temperature_c"
  | "pulse_bpm"
  | "bp_systolic"
  | "bp_diastolic"
  | "respiratory_rate"
  | "spo2_percent"
  | "blood_glucose";

export interface Vitals {
  id: string;
  visit_id: string;
  recorded_by: string;
  recorded_at: string;
  temperature_c: number | null;
  pulse_bpm: number | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  respiratory_rate: number | null;
  spo2_percent: number | null;
  blood_glucose: number | null;
  notes: string | null;
}

export type VitalsInput = Partial<Record<MeasurementKey, number | null>> & {
  /** Writable on purpose: a nurse catching up on paper notes records the real time. */
  recorded_at?: string;
  notes?: string | null;
};

/**
 * Sane ranges, mirroring the DB check constraints so a slipped decimal is caught
 * before it becomes a 23514. Wide enough that no real measurement is refused.
 */
export const RANGES: Record<MeasurementKey, { min: number; max: number }> = {
  temperature_c: { min: 20, max: 45 },
  // 0 is a real reading — asystole during a resuscitation.
  pulse_bpm: { min: 0, max: 400 },
  bp_systolic: { min: 20, max: 400 },
  bp_diastolic: { min: 10, max: 300 },
  respiratory_rate: { min: 0, max: 120 },
  spo2_percent: { min: 0, max: 100 },
  blood_glucose: { min: 0, max: 2000 },
};

export const measurementKeys: readonly MeasurementKey[] = [
  "temperature_c",
  "pulse_bpm",
  "bp_systolic",
  "bp_diastolic",
  "respiratory_rate",
  "spo2_percent",
  "blood_glucose",
];

const VITALS_SELECT =
  "id, visit_id, recorded_by, recorded_at, temperature_c, pulse_bpm, bp_systolic, bp_diastolic, respiratory_rate, spo2_percent, blood_glucose, notes";

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realRecordVitals(
  visitId: string,
  tenantId: string,
  recordedBy: string,
  input: VitalsInput,
): Promise<Result<Vitals>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("vitals")
    .insert({
      tenant_id: tenantId,
      visit_id: visitId,
      recorded_by: recordedBy,
      ...input,
    })
    .select(VITALS_SELECT)
    .single();

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: data as unknown as Vitals, error: null };
}

async function realGetSeries(visitId: string): Promise<Result<Vitals[]>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("vitals")
    .select(VITALS_SELECT)
    .eq("visit_id", visitId)
    .order("recorded_at", { ascending: false })
    .limit(50);

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: (data ?? []) as unknown as Vitals[], error: null };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

const mockSeries = new Map<string, Vitals[]>();
let mockSeq = 0;

function delay(ms = 350) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function recordVitals(
  visitId: string,
  tenantId: string,
  recordedBy: string,
  input: VitalsInput,
): Promise<Result<Vitals>> {
  if (!USE_MOCK) {
    return realRecordVitals(visitId, tenantId, recordedBy, input);
  }
  await delay();
  mockSeq += 1;
  const row: Vitals = {
    id: `vit-${mockSeq}`,
    visit_id: visitId,
    recorded_by: recordedBy,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
    temperature_c: input.temperature_c ?? null,
    pulse_bpm: input.pulse_bpm ?? null,
    bp_systolic: input.bp_systolic ?? null,
    bp_diastolic: input.bp_diastolic ?? null,
    respiratory_rate: input.respiratory_rate ?? null,
    spo2_percent: input.spo2_percent ?? null,
    blood_glucose: input.blood_glucose ?? null,
    notes: input.notes ?? null,
  };
  mockSeries.set(visitId, [row, ...(mockSeries.get(visitId) ?? [])]);
  // Recording the observation IS doing the task, so the oldest pending
  // `vitals_due` card for this visit closes server-side (nurse-tasks.md §5).
  autoCompleteMockVitalsTask(visitId);
  return { data: row, error: null };
}

export async function getVitalsSeries(
  visitId: string,
): Promise<Result<Vitals[]>> {
  if (!USE_MOCK) return realGetSeries(visitId);
  await delay(250);
  return { data: mockSeries.get(visitId) ?? [], error: null };
}
