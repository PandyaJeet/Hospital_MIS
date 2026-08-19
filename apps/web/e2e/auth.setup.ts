import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test as setup } from "@playwright/test";

import {
  authStatePath,
  seedEmail,
  seedPassword,
  type ClinicKey,
  type SeedRole,
} from "./env";

/**
 * Sign in once per role and cache the session.
 *
 * The spec asks for this explicitly: sign-in is slow, §1 already covers it as
 * behaviour, and repeating it per test would spend most of the 10-minute budget
 * on authentication.
 */

const ROLES: { clinic: ClinicKey; role: SeedRole }[] = [
  { clinic: "sunrise", role: "admin" },
  { clinic: "sunrise", role: "doctor" },
  { clinic: "sunrise", role: "nurse" },
  { clinic: "sunrise", role: "billing" },
  // Lotus is only needed for the isolation and tier scenarios, so just the two
  // roles those use.
  { clinic: "lotus", role: "admin" },
  { clinic: "lotus", role: "billing" },
];

for (const { clinic, role } of ROLES) {
  setup(`sign in as ${clinic} ${role}`, async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Email").fill(seedEmail(clinic, role));
    await page.getByLabel("Password").fill(seedPassword());
    await page.getByRole("button", { name: "Sign in" }).click();

    // The proxy sends each role to its own home, so the only safe assertion is
    // that we left /login. A failure here means the credentials are wrong, and
    // the visible error says which.
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });

    // The shell only renders for an onboarded staff member, so this doubles as a
    // check that the profile resolved to a real role rather than `pending`.
    await expect(page.getByRole("button", { name: "Account" })).toBeVisible();

    const file = authStatePath(clinic, role);
    mkdirSync(dirname(file), { recursive: true });
    await page.context().storageState({ path: file });
  });
}
