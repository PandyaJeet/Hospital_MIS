import { expect, test, type Page } from "@playwright/test";

import { authStatePath } from "./env";

/**
 * §4 of `docs/playwright-e2e-spec.md` — the RLS boundary, seen from the browser.
 *
 * The backend already proves the *data* is denied: 477 attack attempts across 33
 * relations × 9 role states. What that cannot show is whether the UI **offers the
 * action**, and whether a deep link is refused.
 *
 * The spec's rule for this section is the important one: hiding a button is not
 * access control (`rules.md` §4.3). So every hidden-navigation assertion is paired
 * with a typed-URL assertion.
 */

/** A route is refused if the proxy bounces us somewhere else entirely. */
async function expectRefused(page: Page, path: string) {
  await page.goto(path);
  await expect(page, `${path} should be refused`).not.toHaveURL(
    new RegExp(`${path.replace(/\//g, "\\/")}$`),
  );
}

async function expectAllowed(page: Page, path: string) {
  await page.goto(path);
  await expect(page, `${path} should be reachable`).toHaveURL(
    new RegExp(`${path.replace(/\//g, "\\/")}$`),
  );
}

test.describe("nurse", () => {
  test.use({ storageState: authStatePath("sunrise", "nurse") });

  test("has no billing navigation, and cannot deep-link billing", async ({
    page,
  }) => {
    await page.goto("/tasks");
    const sidebar = page.getByRole("navigation");
    await expect(sidebar.getByRole("link", { name: "Charges" })).toHaveCount(0);
    await expect(
      sidebar.getByRole("link", { name: "Reconciliation" }),
    ).toHaveCount(0);

    // create_invoice_for_visit returns NOT_BILLING_STAFF for a nurse, so the
    // screen is withheld as well as the button.
    await expectRefused(page, "/charges");
    await expectRefused(page, "/reconciliation");
  });

  test("cannot reach admin screens", async ({ page }) => {
    await expectRefused(page, "/dashboard");
    await expectRefused(page, "/users");
    await expectRefused(page, "/audit");
    await expectRefused(page, "/settings");
  });

  test("can reach the screens nursing actually needs", async ({ page }) => {
    await expectAllowed(page, "/tasks");
    await expectAllowed(page, "/labs");
    await expectAllowed(page, "/patients");
    // A nurse registers patients in a small clinic — register_patient() accepts
    // every staff role.
    await expectAllowed(page, "/register");
  });
});

test.describe("billing", () => {
  test.use({ storageState: authStatePath("sunrise", "billing") });

  test("cannot reach clinical authoring screens", async ({ page }) => {
    // Billing is excluded from /consult entirely, and sees no vitals or tasks.
    await expectRefused(page, "/consult/00000000-0000-0000-0000-000000000000");
    await expectRefused(page, "/vitals/00000000-0000-0000-0000-000000000000");
    await expectRefused(page, "/tasks");
  });

  test("cannot reach admin screens", async ({ page }) => {
    await expectRefused(page, "/dashboard");
    await expectRefused(page, "/users");
    await expectRefused(page, "/audit");
  });

  test("can reach billing screens", async ({ page }) => {
    await expectAllowed(page, "/charges");
    await expectAllowed(page, "/reconciliation");
    await expectAllowed(page, "/register");
  });
});

test.describe("doctor", () => {
  test.use({ storageState: authStatePath("sunrise", "doctor") });

  test("has no admin navigation, and cannot deep-link the audit log", async ({
    page,
  }) => {
    await page.goto("/queue");
    const sidebar = page.getByRole("navigation");
    await expect(sidebar.getByRole("link", { name: "Audit log" })).toHaveCount(
      0,
    );
    await expect(sidebar.getByRole("link", { name: "Users" })).toHaveCount(0);

    await expectRefused(page, "/audit");
    await expectRefused(page, "/users");
    await expectRefused(page, "/dashboard");
  });

  test("cannot reach billing", async ({ page }) => {
    await expectRefused(page, "/charges");
  });
});

test.describe("admin", () => {
  test.use({ storageState: authStatePath("sunrise", "admin") });

  test("reaches the admin screens, and the audit log renders", async ({
    page,
  }) => {
    await expectAllowed(page, "/dashboard");
    await expectAllowed(page, "/users");

    await page.goto("/audit");
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    // The redaction notice must be stated up front, or an admin reads a redacted
    // row as data loss (audit-log.md §3).
    await expect(
      page.getByText("Values are recorded only for non-personal fields"),
    ).toBeVisible();

    /*
     * Audit action codes contain dots (`user.role_changed`), and next-intl treats a
     * dot as a namespace separator. The filter options are rendered from those keys
     * statically, so they are a data-independent probe: if lookup fell through, the
     * option would show the raw key or nothing at all.
     */
    const filter = page.getByLabel("Filter by action");
    await expect(filter).toBeVisible();
    const options = await filter.locator("option").allInnerTexts();
    expect(options, "action labels should be translated, not raw keys").toContain(
      "Role changed",
    );
    expect(options.join(" ")).not.toContain("user.role_changed");
  });
});

test.describe("tier gating", () => {
  test.use({ storageState: authStatePath("sunrise", "admin") });

  test("Tier 1 (Sunrise) is told inpatient management is not on the plan", async ({
    page,
  }) => {
    // Verified live: Sunrise is Tier 1 and admit_patient_to_bed returns
    // TIER_NOT_ENABLED before any lookup. The UI must say "not on your plan"
    // rather than "you are not allowed" — a different sentence entirely.
    await page.goto("/beds");
    await expect(page.getByRole("heading", { name: "Ward beds" })).toBeVisible();
    await expect(
      page.getByText("Inpatient management isn't on your plan"),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("Tier 2 (Lotus) gets a usable ward board", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: authStatePath("lotus", "admin"),
    });
    const page = await context.newPage();
    try {
      await page.goto("/beds");
      await expect(
        page.getByRole("heading", { name: "Ward beds" }),
      ).toBeVisible();
      // The tier lock must NOT appear for a Tier 2 clinic.
      await expect(
        page.getByText("Inpatient management isn't on your plan"),
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
