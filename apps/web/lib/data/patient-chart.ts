import { USE_MOCK } from "./mock";
import type { Result } from "./types";

export interface VisitSummary {
  id: string;
  date: string;
  reason: string;
  note: string;
  doctorName: string;
}

export interface PatientDetail {
  id: string;
  fullName: string;
  age: number;
  sex: "male" | "female" | "other";
  phone: string;
  allergies: string[];
  visits: VisitSummary[];
}

const MOCK_PATIENTS: Record<string, PatientDetail> = {
  v1: {
    id: "v1",
    fullName: "Aarav Sharma",
    age: 34,
    sex: "male",
    phone: "98765 43210",
    allergies: ["Penicillin"],
    visits: [
      {
        id: "vis-1",
        date: "2026-07-28",
        reason: "Fever & cough",
        note: "Viral upper respiratory infection. Advised rest, fluids, paracetamol.",
        doctorName: "Dr. Verma",
      },
      {
        id: "vis-2",
        date: "2026-05-14",
        reason: "Follow-up",
        note: "Blood pressure stable. Continue current medication.",
        doctorName: "Dr. Verma",
      },
    ],
  },
  v2: {
    id: "v2",
    fullName: "Priya Patel",
    age: 28,
    sex: "female",
    phone: "91234 56780",
    allergies: [],
    visits: [
      {
        id: "vis-3",
        date: "2026-06-02",
        reason: "Headache",
        note: "Tension headache. Advised hydration and rest.",
        doctorName: "Dr. Rao",
      },
    ],
  },
  v3: {
    id: "v3",
    fullName: "Rohan Mehta",
    age: 45,
    sex: "male",
    phone: "99887 76655",
    allergies: ["Sulfa drugs", "Aspirin"],
    visits: [],
  },
  v4: {
    id: "v4",
    fullName: "Sunita Rao",
    age: 52,
    sex: "female",
    phone: "90011 22334",
    allergies: [],
    visits: [
      {
        id: "vis-4",
        date: "2026-07-01",
        reason: "Diabetes review",
        note: "HbA1c improved. Continue metformin.",
        doctorName: "Dr. Singh",
      },
    ],
  },
};

function delay(ms = 500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockGetPatient(id: string): Promise<Result<PatientDetail>> {
  await delay();
  const patient = MOCK_PATIENTS[id];
  if (!patient) {
    return {
      data: null,
      error: { code: "PATIENT_NOT_FOUND", message: "Patient not found." },
    };
  }
  return { data: patient, error: null };
}

function notImplemented(): Promise<Result<PatientDetail>> {
  // TODO(integration): replace with a tenant-scoped Supabase query (patients ⋈
  // visits) once the Patient Chart contract is finalized with the backend.
  return Promise.resolve({
    data: null,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "The real backend is not wired yet.",
    },
  });
}

export function getPatient(id: string): Promise<Result<PatientDetail>> {
  return USE_MOCK ? mockGetPatient(id) : notImplemented();
}
