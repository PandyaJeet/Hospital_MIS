import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load the three variables the suite needs, without adding a dotenv dependency
 * for three variables.
 *
 * They live in two places and that is not an accident:
 *  - `apps/web/.env.local` holds the Supabase URL and anon key, because Next.js
 *    cannot see the repo-root `.env` at all
 *  - the root `.env` holds `SEED_USER_PASSWORD`, which belongs to the backend's
 *    seed script rather than the app
 *
 * Existing `process.env` values win, so CI can inject them instead.
 */
function loadFile(path: string) {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    // Absent is normal — CI supplies these as real environment variables.
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

export function loadE2eEnv() {
  const here = resolve(__dirname, "..");
  loadFile(resolve(here, ".env.local"));
  loadFile(resolve(here, "../../.env"));
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The e2e suite needs it — see docs/playwright-e2e-spec.md, "Environment requirements".`,
    );
  }
  return value;
}

/**
 * The seeded clinics. Two are required rather than convenient: every isolation
 * scenario needs a second tenant with real data to fail to see.
 *
 * Sunrise is Tier 1 (OPD only) and Lotus is Tier 2 (IPD/beds), which is what
 * makes the tier-gating assertions in §4 meaningful.
 */
export const CLINICS = {
  sunrise: { prefix: "a", tier: 1 },
  lotus: { prefix: "b", tier: 2 },
} as const;

export type ClinicKey = keyof typeof CLINICS;
export type SeedRole = "admin" | "doctor" | "nurse" | "billing";

export function seedEmail(clinic: ClinicKey, role: SeedRole) {
  return `${CLINICS[clinic].prefix}.${role}@hmis-seed.example.com`;
}

export function seedPassword() {
  return requireEnv("SEED_USER_PASSWORD");
}

/** Where a signed-in role's storageState is cached. */
export function authStatePath(clinic: ClinicKey, role: SeedRole) {
  return resolve(__dirname, ".auth", `${clinic}-${role}.json`);
}

/**
 * Test data is prefixed so it is identifiable in a shared project. The spec wants
 * a dedicated project; until there is one, at least make the noise obvious.
 */
export const E2E_PREFIX = "E2E";

export function uniqueName(label: string) {
  return `${E2E_PREFIX} ${label} ${Date.now().toString().slice(-6)}`;
}
