import { expect, test } from "@playwright/test";

import { authStatePath, uniqueName } from "./env";

/**
 * §2 of `docs/playwright-e2e-spec.md` — the journey a clinic cannot operate
 * without, and the spec's highest-priority file.
 *
 * The API layer already proves this flow works twice over (local PGlite with real
 * RLS, and remote against real GoTrue + PostgREST). What is unproven, and all this
 * file is for, is whether the **screens agree** with what the API returned.
 *
 * Runs as Sunrise billing: reception is the role that registers and checks in.
 */
test.use({ storageState: authStatePath("sunrise", "billing") });

test.describe("OPD journey", () => {
  test("register a patient, check them in, and see the token", async ({
    page,
  }) => {
    const name = uniqueName("Journey");

    await page.goto("/register");
    await expect(
      page.getByRole("heading", { name: "Register patient" }),
    ).toBeVisible();

    // Only the name is required. Filling nothing else is the walk-in case and
    // must not be blocked (rules.md §1.7).
    await page.getByLabel("Full name").fill(name);
    await page.getByRole("button", { name: "Register", exact: true }).click();

    await expect(page.getByText("Patient registered")).toBeVisible();
    const success = page.getByText(/is registered with UHID \d+/);
    await expect(success).toBeVisible();

    const uhid = (await success.innerText()).match(/UHID (\d+)/)?.[1];
    expect(uhid, "the success message should quote a UHID").toBeTruthy();

    // Check-in is offered right here, which is the fix for the gap that made this
    // journey impossible to complete in the UI at all.
    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page.getByText(/Token \d+/)).toBeVisible();
  });

  test("a registered patient is findable by name and by UHID", async ({
    page,
  }) => {
    const name = uniqueName("Findable");

    await page.goto("/register");
    await page.getByLabel("Full name").fill(name);
    await page.getByRole("button", { name: "Register", exact: true }).click();

    const success = page.getByText(/is registered with UHID \d+/);
    await expect(success).toBeVisible();
    const uhid = (await success.innerText()).match(/UHID (\d+)/)?.[1];
    expect(uhid).toBeTruthy();

    // By name — a case-insensitive prefix, which is what the index supports.
    await page.goto(`/patients?q=${encodeURIComponent(name)}`);
    await expect(page.getByRole("link", { name })).toBeVisible();

    // By UHID — the fastest path and the one staff use most.
    await page.goto(`/patients?q=${uhid}`);
    await expect(page.getByText(`UHID ${uhid}`)).toBeVisible();
  });

  test("a checked-in patient reaches the doctor's queue", async ({
    browser,
    page,
  }) => {
    const name = uniqueName("ToQueue");

    await page.goto("/register");
    await page.getByLabel("Full name").fill(name);
    await page.getByRole("button", { name: "Register", exact: true }).click();
    await expect(page.getByText("Patient registered")).toBeVisible();
    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page.getByText(/Token \d+/)).toBeVisible();

    // A second context as the doctor. This is the actual claim under test: the
    // patient reception queued is the patient the doctor sees.
    const doctorContext = await browser.newContext({
      storageState: authStatePath("sunrise", "doctor"),
    });
    const doctorPage = await doctorContext.newPage();
    try {
      await doctorPage.goto("/queue");
      await expect(
        doctorPage.getByRole("heading", { name: "Patient queue" }),
      ).toBeVisible();
      await expect(doctorPage.getByRole("link", { name })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await doctorContext.close();
    }
  });

  test("a second check-in is refused and hands back the existing token", async ({
    page,
  }) => {
    const name = uniqueName("Idempotent");

    await page.goto("/register");
    await page.getByLabel("Full name").fill(name);
    await page.getByRole("button", { name: "Register", exact: true }).click();
    await expect(page.getByText("Patient registered")).toBeVisible();

    await page.getByRole("button", { name: "Check in" }).click();
    const first = page.getByText(/Token \d+/);
    await expect(first).toBeVisible();
    const firstToken = (await first.innerText()).match(/Token (\d+)/)?.[1];
    expect(firstToken).toBeTruthy();

    // Find them and try again. check_in_patient() refuses a second open visit on
    // the same day on purpose — two tokens would become two consultation charges
    // (opd-queue.md §3). The refusal must still show the token they already have,
    // or the front desk is left at a dead end.
    await page.goto(`/patients?q=${encodeURIComponent(name)}`);
    await page.getByRole("button", { name: "Check in" }).click();

    await expect(page.getByText(`Token ${firstToken}`)).toBeVisible();
    await expect(
      page.getByText("They were already in today's queue with this token"),
    ).toBeVisible();
    // And a way onward, rather than a dead end.
    await expect(page.getByRole("link", { name: "Open the queue" })).toBeVisible();
  });

  test("a duplicate phone number warns and offers to continue, never blocks", async ({
    page,
  }) => {
    const phone = `98${Date.now().toString().slice(-8)}`;
    const first = uniqueName("DupA");
    const second = uniqueName("DupB");

    await page.goto("/register");
    await page.getByLabel("Full name").fill(first);
    await page.getByLabel(/Phone number/).fill(phone);
    await page.getByRole("button", { name: "Register", exact: true }).click();
    await expect(page.getByText("Patient registered")).toBeVisible();

    // Same number, different person. Families share a number, so this is a prompt
    // with an escape hatch rather than a field error.
    await page.goto("/register");
    await page.getByLabel("Full name").fill(second);
    await page.getByLabel(/Phone number/).fill(phone);
    await page.getByRole("button", { name: "Register", exact: true }).click();

    await expect(
      page.getByText("Someone already uses this number"),
    ).toBeVisible();
    const override = page.getByRole("button", {
      name: "No, this is a different person",
    });
    await expect(override).toBeVisible();

    await override.click();
    await expect(page.getByText("Patient registered")).toBeVisible();
  });
});
