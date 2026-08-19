import { defineConfig, devices } from "@playwright/test";

import { loadE2eEnv } from "./e2e/env";

/**
 * Playwright config — implements `docs/playwright-e2e-spec.md`.
 *
 * Why Playwright at all, given `rules.md` §2 names Vitest as the runner: Vitest
 * cannot drive a browser, and the whole point of this suite is the gap no backend
 * test can reach — whether the rendered screen agrees with what the API returned.
 * That is a genuine tooling gap rather than duplicate tooling (spec, "Environment
 * requirements").
 *
 * ⚠️ These tests write real rows: they register patients and check them in. The
 * spec asks for a dedicated project; there is only the shared dev project
 * (`udjvbvtxrgrvpnmfvnbk`), so every record created here is prefixed `E2E ` to be
 * identifiable, and nothing destructive is attempted — no deactivation, no
 * invoice cancellation. §6 of the spec stays unimplemented for that reason.
 */
loadE2eEnv();

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // Serial. The suite shares one clinic's queue, and parallel workers checking
  // patients in would race each other for queue positions.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The spec's definition of done caps the run at 10 minutes.
  globalTimeout: 10 * 60 * 1000,
  timeout: 60 * 1000,
  expect: { timeout: 15 * 1000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL,
    // "Failures produce a trace and a screenshot" — spec, definition of done.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    // Signs in once per role and saves storageState. The spec asks for this
    // explicitly: signing in per test is slow and §1 already covers sign-in.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
    },
  ],

  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180 * 1000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
