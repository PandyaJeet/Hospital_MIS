import { USE_MOCK } from "./mock";
import type { Result } from "./types";

export type Sex = "male" | "female" | "other";

export interface Patient {
  id: string;
  fullName: string;
  phone: string;
  age: number;
  sex: Sex;
  createdAt: string;
}

export interface NewPatientInput {
  fullName: string;
  phone: string;
  age: number;
  sex: Sex;
}

function delay(ms = 500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockRegisterPatient(
  input: NewPatientInput,
): Promise<Result<Patient>> {
  await delay();
  // Demo: a specific number simulates an existing patient.
  if (input.phone === "9999999999") {
    return {
      data: null,
      error: {
        code: "DUPLICATE_PATIENT",
        message: "A patient with this phone number already exists.",
        fields: ["phone"],
      },
    };
  }
  return {
    data: {
      id: `mock-${Date.now()}`,
      fullName: input.fullName,
      phone: input.phone,
      age: input.age,
      sex: input.sex,
      createdAt: new Date().toISOString(),
    },
    error: null,
  };
}

function notImplemented(): Promise<Result<Patient>> {
  // TODO(integration): wire to Supabase (insert into patients, RLS-scoped) once
  // the Patient Registration contract is finalized with the backend.
  return Promise.resolve({
    data: null,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "The real backend is not wired yet.",
    },
  });
}

export function registerPatient(
  input: NewPatientInput,
): Promise<Result<Patient>> {
  return USE_MOCK ? mockRegisterPatient(input) : notImplemented();
}
