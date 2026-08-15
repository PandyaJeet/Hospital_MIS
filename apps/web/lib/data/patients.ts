import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError } from "./rpc";
import type { AppError } from "./types";

/**
 * Shapes follow `docs/contracts/patient-registration.md` §7 exactly, including
 * its snake_case field names, so integration is a swap of the implementation
 * rather than a rewrite of every caller.
 *
 * ⚠️ This module handles real patient PII. Never log a name, phone, address or
 * allergy string — log `patient_id` or `patient_number` instead (rules.md §1.3).
 */
export type Gender = "male" | "female" | "other" | "unknown";

export const genders: readonly Gender[] = [
  "male",
  "female",
  "other",
  "unknown",
];

export interface NewPatientInput {
  full_name: string;
  phone?: string | null;
  dob?: string | null;
  age_years?: number | null;
  gender?: Gender | null;
  address?: string | null;
  allergies?: string | null;
  allow_duplicate_phone?: boolean;
}

export interface PatientMatch {
  id: string;
  patient_number: number;
  full_name: string;
  phone: string | null;
  dob: string | null;
  age_years: number | null;
  gender: string | null;
  created_at: string;
}

/**
 * Three states, not two. A duplicate phone is a **prompt, not a wall** (§3):
 * different people legitimately share a number, so the user either opens an
 * existing record or confirms this is someone new and resubmits with
 * `allow_duplicate_phone`.
 */
export type RegisterPatientOutcome =
  | {
      kind: "registered";
      patient_id: string;
      patient_number: number;
      full_name: string;
    }
  | { kind: "duplicate"; matches: PatientMatch[]; message: string }
  | { kind: "failed"; error: AppError };

/** Duplicate detection matches on the last 10 digits (§3). */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-10);
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realRegisterPatient(
  input: NewPatientInput,
): Promise<RegisterPatientOutcome> {
  const supabase = createClient();
  // The RPC's optional args are `?: T`, not `T | null`, so absent values must be
  // omitted rather than sent as null — hence `?? undefined`.
  const { data, error } = await supabase.rpc("register_patient", {
    p_full_name: input.full_name,
    p_phone: input.phone ?? undefined,
    p_dob: input.dob ?? undefined,
    p_age_years: input.age_years ?? undefined,
    p_gender: input.gender ?? undefined,
    p_address: input.address ?? undefined,
    p_allergies: input.allergies ?? undefined,
    p_allow_duplicate_phone: input.allow_duplicate_phone ?? false,
  });

  if (error) {
    return { kind: "failed", error: mapPostgrestError(error) };
  }

  const envelope = data as
    | {
        ok: boolean;
        code?: string;
        message?: string;
        fields?: string[];
        matches?: PatientMatch[];
        patient_id?: string;
        patient_number?: number;
        full_name?: string;
      }
    | null;

  if (!envelope || typeof envelope.ok !== "boolean") {
    return {
      kind: "failed",
      error: {
        code: "UNEXPECTED_RESPONSE",
        message: "Something went wrong. Please try again.",
      },
    };
  }

  if (envelope.ok) {
    return {
      kind: "registered",
      patient_id: envelope.patient_id!,
      patient_number: envelope.patient_number!,
      full_name: envelope.full_name!,
    };
  }

  if (envelope.code === "DUPLICATE_PATIENT") {
    return {
      kind: "duplicate",
      matches: envelope.matches ?? [],
      message: envelope.message ?? "",
    };
  }

  return {
    kind: "failed",
    error: {
      code: envelope.code ?? "UNKNOWN",
      message: envelope.message ?? "",
      fields: envelope.fields,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

interface MockRow extends PatientMatch {
  phone_normalized: string | null;
}

const mockPatients: MockRow[] = [
  {
    id: "mock-p-1",
    patient_number: 1,
    full_name: "Aarav Sharma",
    phone: "+91 98765 43210",
    phone_normalized: "9876543210",
    dob: null,
    age_years: 34,
    gender: "male",
    created_at: "2026-07-28T09:15:00.000Z",
  },
];

let mockCounter = mockPatients.length;

function delay(ms = 450) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockRegisterPatient(
  input: NewPatientInput,
): Promise<RegisterPatientOutcome> {
  await delay();

  // Detection is skipped entirely when no phone is given (§3).
  const normalized = input.phone ? normalizePhone(input.phone) : "";
  if (normalized && !input.allow_duplicate_phone) {
    const matches = mockPatients.filter(
      (row) => row.phone_normalized === normalized,
    );
    if (matches.length > 0) {
      return {
        kind: "duplicate",
        matches: matches.map((row) => ({
          id: row.id,
          patient_number: row.patient_number,
          full_name: row.full_name,
          phone: row.phone,
          dob: row.dob,
          age_years: row.age_years,
          gender: row.gender,
          created_at: row.created_at,
        })),
        message: "A patient with this phone number already exists.",
      };
    }
  }

  mockCounter += 1;
  const row: MockRow = {
    id: `mock-p-${mockCounter}`,
    patient_number: mockCounter,
    full_name: input.full_name,
    phone: input.phone ?? null,
    phone_normalized: normalized || null,
    dob: input.dob ?? null,
    age_years: input.age_years ?? null,
    gender: input.gender ?? null,
    created_at: new Date().toISOString(),
  };
  mockPatients.push(row);

  return {
    kind: "registered",
    patient_id: row.id,
    patient_number: row.patient_number,
    full_name: row.full_name,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function registerPatient(
  input: NewPatientInput,
): Promise<RegisterPatientOutcome> {
  return USE_MOCK ? mockRegisterPatient(input) : realRegisterPatient(input);
}
