/**
 * Global mock/real data switch (Workflow.md §3).
 *
 * Set NEXT_PUBLIC_USE_MOCK=true in .env.local to run the UI against mock data
 * before the real Supabase backend is wired. Each feature's data module
 * (e.g. lib/data/patients.ts) branches on this flag:
 *
 *   export async function registerPatient(input: NewPatientInput) {
 *     return USE_MOCK ? mockRegisterPatient(input) : realRegisterPatient(input);
 *   }
 */
export const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";
