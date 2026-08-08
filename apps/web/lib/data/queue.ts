import { USE_MOCK } from "./mock";
import type { Result } from "./types";

export type QueueStatus = "waiting" | "in_consultation" | "done";

export interface QueueEntry {
  id: string;
  patientName: string;
  tokenNumber: number;
  status: QueueStatus;
  waitMinutes: number;
  age: number;
  sex: "male" | "female" | "other";
}

const MOCK_QUEUE: QueueEntry[] = [
  {
    id: "v1",
    patientName: "Aarav Sharma",
    tokenNumber: 12,
    status: "in_consultation",
    waitMinutes: 0,
    age: 34,
    sex: "male",
  },
  {
    id: "v2",
    patientName: "Priya Patel",
    tokenNumber: 13,
    status: "waiting",
    waitMinutes: 14,
    age: 28,
    sex: "female",
  },
  {
    id: "v3",
    patientName: "Rohan Mehta",
    tokenNumber: 14,
    status: "waiting",
    waitMinutes: 22,
    age: 45,
    sex: "male",
  },
  {
    id: "v4",
    patientName: "Sunita Rao",
    tokenNumber: 11,
    status: "done",
    waitMinutes: 0,
    age: 52,
    sex: "female",
  },
];

function delay(ms = 600) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockGetQueue(): Promise<Result<QueueEntry[]>> {
  await delay();
  return { data: MOCK_QUEUE, error: null };
}

function notImplemented(): Promise<Result<QueueEntry[]>> {
  // TODO(integration): replace with a tenant-scoped Supabase query + Realtime
  // subscription once the OPD Queue contract is finalized with the backend.
  return Promise.resolve({
    data: null,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "The real backend is not wired yet.",
    },
  });
}

export function getQueue(): Promise<Result<QueueEntry[]>> {
  return USE_MOCK ? mockGetQueue() : notImplemented();
}
