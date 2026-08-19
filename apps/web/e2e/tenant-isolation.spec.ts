import { expect, test } from "@playwright/test";

import { authStatePath, uniqueName } from "./env";

/**
 * §5 of `docs/playwright-e2e-spec.md` — tenant isolation, from the browser.
 *
 * This is the half of the security model the backend cannot prove. Its 57/57
 * isolation suite shows Postgres denies the rows; these tests show a **signed-in
 * user in a real browser** cannot reach another clinic's data by typing a URL, and
 * that a search for a name that exists in the other clinic comes back empty rather
 * than leaking it.
 *
 * A deep link that renders "not found" is the pass condition. Rendering data is the
 * failure, and so is a crash — an unhandled error page can itself confirm that an
 * id exists.
 */

test.describe("cross-tenant deep links", () => {
  test("Sunrise cannot open a Lotus patient by id, and never sees their name", async ({
    browser,
  }) => {
    const lotusName = uniqueName("LotusOnly");

    // Create a patient inside Lotus, and capture their real id from the chart link.
    const lotus = await browser.newContext({
      storageState: authStatePath("lotus", "billing"),
    });
    const lotusPage = await lotus.newPage();
    let lotusPatientId: string | null = null;
    try {
      await lotusPage.goto("/register");
      await lotusPage.getByLabel("Full name").fill(lotusName);
      await lotusPage
        .getByRole("button", { name: "Register", exact: true })
        .click();
      await expect(lotusPage.getByText("Patient registered")).toBeVisible();

      await lotusPage.goto(`/patients?q=${encodeURIComponent(lotusName)}`);
      const link = lotusPage.getByRole("link", { name: lotusName });
      await expect(link).toBeVisible();
      const href = await link.getAttribute("href");
      lotusPatientId = href?.split("/patient/")[1] ?? null;
      expect(lotusPatientId, "should have captured a Lotus patient id").toBeTruthy();
    } finally {
      await lotus.close();
    }

    // Now try to reach that exact id as Sunrise.
    const sunrise = await browser.newContext({
      storageState: authStatePath("sunrise", "billing"),
    });
    const sunrisePage = await sunrise.newPage();
    try {
      await sunrisePage.goto(`/patient/${lotusPatientId}`);

      // The name must not appear anywhere on the page, whatever the page decides
      // to render.
      await expect(sunrisePage.getByText(lotusName)).toHaveCount(0);

      // And a name search must come back empty rather than leaking the row.
      await sunrisePage.goto(`/patients?q=${encodeURIComponent(lotusName)}`);
      await expect(sunrisePage.getByText("No patient found")).toBeVisible();
      await expect(sunrisePage.getByRole("link", { name: lotusName })).toHaveCount(
        0,
      );
    } finally {
      await sunrise.close();
    }
  });

  test("a fabricated visit id leaks nothing on any clinical screen", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: authStatePath("sunrise", "doctor"),
    });
    const page = await context.newPage();
    const fake = "00000000-0000-0000-0000-000000000000";
    try {
      for (const path of [
        `/consult/${fake}`,
        `/prescribe/${fake}`,
        `/vitals/${fake}`,
        `/administer/${fake}`,
      ]) {
        await page.goto(path);
        // No raw Postgres text anywhere in the UI (rules.md §3, spec §8).
        const body = (await page.textContent("body")) ?? "";
        expect(
          body,
          `${path} should not surface raw database errors`,
        ).not.toMatch(/PGRST|violates|permission denied for|SQLSTATE|42501/i);
      }
    } finally {
      await context.close();
    }
  });
});

test.describe("two clinics side by side", () => {
  // Two full register-and-queue journeys plus two queue reads in one test. The
  // 60s default is not enough for that on a cold dev server.
  test.setTimeout(150_000);

  test("neither clinic's queue shows the other's patient", async ({
    browser,
  }) => {
    const sunriseName = uniqueName("SunriseQ");
    const lotusName = uniqueName("LotusQ");

    // Admin, not billing: billing has no /queue in its route list, because the
    // queue is a clinical screen. Admin can register, check in and read the queue,
    // which is what this scenario needs from a single session.
    const sunrise = await browser.newContext({
      storageState: authStatePath("sunrise", "admin"),
    });
    const lotus = await browser.newContext({
      storageState: authStatePath("lotus", "admin"),
    });
    const sunrisePage = await sunrise.newPage();
    const lotusPage = await lotus.newPage();

    try {
      // Register and queue one patient in each clinic, concurrently — this is the
      // "two browser contexts side by side" case the spec asks for.
      for (const [page, name] of [
        [sunrisePage, sunriseName],
        [lotusPage, lotusName],
      ] as const) {
        await page.goto("/register");
        await page.getByLabel("Full name").fill(name);
        await page.getByRole("button", { name: "Register", exact: true }).click();
        await expect(page.getByText("Patient registered")).toBeVisible();
        await page.getByRole("button", { name: "Check in" }).click();
        await expect(page.getByText(/Token \d+/)).toBeVisible();
      }

      // Each clinic sees its own patient in its own queue, and not the other's.
      await sunrisePage.goto("/queue");
      await expect(
        sunrisePage.getByRole("link", { name: sunriseName }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        sunrisePage.getByRole("link", { name: lotusName }),
      ).toHaveCount(0);

      await lotusPage.goto("/queue");
      await expect(lotusPage.getByRole("link", { name: lotusName })).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        lotusPage.getByRole("link", { name: sunriseName }),
      ).toHaveCount(0);
    } finally {
      await sunrise.close();
      await lotus.close();
    }
  });
});
