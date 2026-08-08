import { USE_MOCK } from "./mock";
import type { Result } from "./types";

export interface Medication {
  drug: string;
  dosage: string;
  frequency: string;
  duration: string;
}

export interface NewPrescription {
  medications: Medication[];
  advice: string;
}

export interface Prescription {
  id: string;
  createdAt: string;
}

function delay(ms = 500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockSavePrescription(
  input: NewPrescription,
): Promise<Result<Prescription>> {
  await delay();
  const hasMedication = input.medications.some(
    (medication) => medication.drug.trim().length > 0,
  );
  if (!hasMedication) {
    return {
      data: null,
      error: {
        code: "NO_MEDICATIONS",
        message: "Add at least one medication.",
      },
    };
  }
  return {
    data: { id: `rx-${Date.now()}`, createdAt: new Date().toISOString() },
    error: null,
  };
}

function notImplemented(): Promise<Result<Prescription>> {
  // TODO(integration): insert prescription + items (tenant-scoped) via Supabase
  // once the Prescriptions contract is finalized with the backend.
  return Promise.resolve({
    data: null,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "The real backend is not wired yet.",
    },
  });
}

export function savePrescription(
  input: NewPrescription,
): Promise<Result<Prescription>> {
  return USE_MOCK ? mockSavePrescription(input) : notImplemented();
}
