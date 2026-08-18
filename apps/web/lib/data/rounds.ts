import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError, untypedClient } from "./rpc";
import type { Result } from "./types";
import type { MeasurementKey } from "./vitals";

/**
 * Doctor's rounds — `docs/contracts/vitals-and-rounds.md` §4.
 *
 * **The measurement columns are "latest known value per measurement", not the
 * latest row.** Each is the most recent non-null value for that measurement within
 * the encounter, resolved independently. So a temperature from 06:00 can legitimately
 * sit beside a pulse from 11:00 — which is why the view also returns
 * `vitals_component_times`, and why this UI shows each figure's own age rather than
 * one timestamp for the card.
 *
 * A `NULL` measurement means exactly one thing for a clinical role: never recorded
 * during this encounter. For **billing** it means "not visible to you" — the vitals
 * policy excludes them and `security_invoker` honours it. Same for the aggregate
 * counts, which come back `0` rather than null. This screen is clinical-only, so it
 * reads them as clinical, but never reuse these fields in a billing context.
 */
export type VitalsComponentTimes = Partial<Record<MeasurementKey, string>>;

export interface RoundsRow {
  visit_id: string;
  patient_id: string;
  care_setting: "opd" | "ipd";
  visit_status: string;
  admitted_at: string | null;
  discharged_at: string | null;
  bed_id: string | null;
  ward_name: string | null;
  bed_number: string | null;
  patient_number: number;
  patient_name: string;
  age_years: number | null;
  gender: string | null;
  allergies: string | null;
  last_vitals_at: string | null;
  vitals_age_seconds: number | null;
  /** 0 distinguishes "no observations at all" from "this field wasn't among them". */
  vitals_row_count: number;
  temperature_c: number | null;
  pulse_bpm: number | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  respiratory_rate: number | null;
  spo2_percent: number | null;
  blood_glucose: number | null;
  vitals_notes: string | null;
  vitals_component_times: VitalsComponentTimes;
  pending_tasks: number;
  overdue_tasks: number;
  unacknowledged_alerts: number;
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

async function realGetRounds(): Promise<Result<RoundsRow[]>> {
  const supabase = untypedClient(createClient());
  const { data, error } = await supabase
    .from("rounds_overview")
    .select("*")
    .eq("care_setting", "ipd")
    .is("discharged_at", null)
    // nullsFirst matters: a patient with no vitals at all is the MOST overdue on
    // the ward, not the least.
    .order("last_vitals_at", { ascending: true, nullsFirst: true });

  if (error) return { data: null, error: mapPostgrestError(error) };

  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      visit_id: String(r.visit_id ?? ""),
      patient_id: String(r.patient_id ?? ""),
      care_setting: (r.care_setting as "opd" | "ipd") ?? "ipd",
      visit_status: String(r.visit_status ?? ""),
      admitted_at: (r.admitted_at as string | null) ?? null,
      discharged_at: (r.discharged_at as string | null) ?? null,
      bed_id: (r.bed_id as string | null) ?? null,
      ward_name: (r.ward_name as string | null) ?? null,
      bed_number: (r.bed_number as string | null) ?? null,
      patient_number: num(r.patient_number),
      patient_name: String(r.patient_name ?? ""),
      age_years: nullableNum(r.age_years),
      gender: (r.gender as string | null) ?? null,
      allergies: (r.allergies as string | null) ?? null,
      last_vitals_at: (r.last_vitals_at as string | null) ?? null,
      vitals_age_seconds: nullableNum(r.vitals_age_seconds),
      vitals_row_count: num(r.vitals_row_count),
      temperature_c: nullableNum(r.temperature_c),
      pulse_bpm: nullableNum(r.pulse_bpm),
      bp_systolic: nullableNum(r.bp_systolic),
      bp_diastolic: nullableNum(r.bp_diastolic),
      respiratory_rate: nullableNum(r.respiratory_rate),
      spo2_percent: nullableNum(r.spo2_percent),
      blood_glucose: nullableNum(r.blood_glucose),
      vitals_notes: (r.vitals_notes as string | null) ?? null,
      vitals_component_times:
        (r.vitals_component_times as VitalsComponentTimes) ?? {},
      pending_tasks: num(r.pending_tasks),
      overdue_tasks: num(r.overdue_tasks),
      unacknowledged_alerts: num(r.unacknowledged_alerts),
    })),
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

function hoursAgo(h: number) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

function delay(ms = 380) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A Tier 2 nursing home, so the ward surfaces have something to show. */
const MOCK_ROUNDS: RoundsRow[] = [
  {
    // No observations at all — the most overdue patient on the ward.
    visit_id: "ipd-1",
    patient_id: "mock-p-7",
    care_setting: "ipd",
    visit_status: "done",
    admitted_at: hoursAgo(5),
    discharged_at: null,
    bed_id: "bed-3",
    ward_name: "General Ward",
    bed_number: "G-03",
    patient_number: 7,
    patient_name: "Kavita Joshi",
    age_years: 61,
    gender: "female",
    allergies: null,
    last_vitals_at: null,
    vitals_age_seconds: null,
    vitals_row_count: 0,
    temperature_c: null,
    pulse_bpm: null,
    bp_systolic: null,
    bp_diastolic: null,
    respiratory_rate: null,
    spo2_percent: null,
    blood_glucose: null,
    vitals_notes: null,
    vitals_component_times: {},
    pending_tasks: 2,
    overdue_tasks: 1,
    unacknowledged_alerts: 0,
  },
  {
    // Values from different moments — the case component_times exists for.
    visit_id: "ipd-2",
    patient_id: "mock-p-8",
    care_setting: "ipd",
    visit_status: "done",
    admitted_at: hoursAgo(30),
    discharged_at: null,
    bed_id: "bed-1",
    ward_name: "General Ward",
    bed_number: "G-01",
    patient_number: 8,
    patient_name: "Imran Sheikh",
    age_years: 47,
    gender: "male",
    allergies: "Penicillin",
    last_vitals_at: hoursAgo(1),
    vitals_age_seconds: 3600,
    vitals_row_count: 4,
    temperature_c: 37.2,
    pulse_bpm: 88,
    bp_systolic: 138,
    bp_diastolic: 86,
    respiratory_rate: null,
    spo2_percent: 96,
    blood_glucose: null,
    vitals_notes: "Comfortable, mobilising with support.",
    vitals_component_times: {
      temperature_c: hoursAgo(6),
      pulse_bpm: hoursAgo(1),
      bp_systolic: hoursAgo(1),
      bp_diastolic: hoursAgo(1),
      spo2_percent: hoursAgo(6),
    },
    pending_tasks: 1,
    overdue_tasks: 0,
    unacknowledged_alerts: 1,
  },
  {
    // Admitted but no bed yet — legitimate, and why inpatients can exceed occupied.
    visit_id: "ipd-3",
    patient_id: "mock-p-9",
    care_setting: "ipd",
    visit_status: "done",
    admitted_at: hoursAgo(2),
    discharged_at: null,
    bed_id: null,
    ward_name: null,
    bed_number: null,
    patient_number: 9,
    patient_name: "Sunita Patil",
    age_years: 34,
    gender: "female",
    allergies: null,
    last_vitals_at: hoursAgo(2),
    vitals_age_seconds: 7200,
    vitals_row_count: 1,
    temperature_c: 38.4,
    pulse_bpm: 104,
    bp_systolic: null,
    bp_diastolic: null,
    respiratory_rate: 22,
    spo2_percent: 94,
    blood_glucose: null,
    vitals_notes: null,
    vitals_component_times: {
      temperature_c: hoursAgo(2),
      pulse_bpm: hoursAgo(2),
      respiratory_rate: hoursAgo(2),
      spo2_percent: hoursAgo(2),
    },
    pending_tasks: 3,
    overdue_tasks: 2,
    unacknowledged_alerts: 0,
  },
];

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getRounds(): Promise<Result<RoundsRow[]>> {
  if (!USE_MOCK) return realGetRounds();
  await delay();
  // Same ordering as the real query: never-recorded first.
  return {
    data: [...MOCK_ROUNDS].sort((a, b) => {
      if (a.last_vitals_at === null) return -1;
      if (b.last_vitals_at === null) return 1;
      return a.last_vitals_at.localeCompare(b.last_vitals_at);
    }),
    error: null,
  };
}
