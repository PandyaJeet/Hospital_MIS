/**
 * The dummy dataset both devs test against: 2 tenants x 4 roles.
 *
 * Shared by the seed script and the remote RLS test so there is exactly one
 * definition of "the test data". If the remote test hardcoded its own emails it
 * would drift from the seed the first time either changed.
 *
 * Emails use example.com, which RFC 2606 reserves for documentation/testing, so
 * these addresses can never collide with a real inbox. Every account is created
 * pre-confirmed by the admin API — no mail is sent.
 */

export type SeedRole = 'admin' | 'doctor' | 'nurse' | 'billing';

export interface SeedUser {
  role: SeedRole;
  email: string;
  fullName: string;
}

export interface SeedTenant {
  /** Used as the tenants.name value and as the reset key. */
  name: string;
  users: SeedUser[];
  /**
   * Billing/GST posture. One seed tenant is GST-registered and one is not, on
   * purpose: the two produce genuinely different invoices (GST invoice with
   * rate-wise tax vs. a bill of supply with no tax section at all), and both
   * paths need a fixture to test against.
   */
  billing: {
    gstRegistered: boolean;
    gstin?: string;
    gstStateCode?: string;
    defaultConsultationFee: number;
  };
  /**
   * Feature tier (Phase 3). One seed tenant is Tier 1 and one is Tier 2, on
   * purpose: the Tier 2 IPD/bed gate has two sides, and asserting only the
   * permitted side would leave the gate itself untested against the real project.
   *
   * Applied with the SERVICE ROLE, not through the admin's session, and that is
   * the point rather than a convenience: `tenants.tier` is deliberately not
   * writable by anyone from a client session (rules.md §4.3 — an admin who could
   * raise their own tier would make every tier gate cosmetic). Setting it is a
   * platform-owner action, performed via the dashboard in production and via the
   * seed script here.
   */
  tier: 1 | 2 | 3;
}

const DOMAIN = 'hmis-seed.example.com';

export const SEED_TENANTS: SeedTenant[] = [
  {
    name: 'Sunrise Clinic (seed)',
    users: [
      { role: 'admin', email: `a.admin@${DOMAIN}`, fullName: 'Asha Rao' },
      { role: 'doctor', email: `a.doctor@${DOMAIN}`, fullName: 'Vikram Shah' },
      { role: 'nurse', email: `a.nurse@${DOMAIN}`, fullName: 'Priya Nair' },
      { role: 'billing', email: `a.billing@${DOMAIN}`, fullName: 'Rohit Kumar' },
    ],
    // GST-registered. GSTIN is a syntactically valid dummy (state code 27,
    // Maharashtra) — not a real registration.
    billing: {
      gstRegistered: true,
      gstin: '27AABCU9603R1ZM',
      gstStateCode: '27',
      defaultConsultationFee: 500,
    },
    // A solo clinic: employs a nurse who takes vitals, but runs no ward. The Tier 1
    // half of the IPD gate.
    tier: 1,
  },
  {
    name: 'Lotus Hospital (seed)',
    users: [
      { role: 'admin', email: `b.admin@${DOMAIN}`, fullName: 'Meera Iyer' },
      { role: 'doctor', email: `b.doctor@${DOMAIN}`, fullName: 'Arjun Desai' },
      { role: 'nurse', email: `b.nurse@${DOMAIN}`, fullName: 'Sunita Patil' },
      { role: 'billing', email: `b.billing@${DOMAIN}`, fullName: 'Imran Sheikh' },
    ],
    // Not registered — the solo-practice case below the turnover threshold.
    billing: { gstRegistered: false, defaultConsultationFee: 300 },
    // A nursing home with beds. The Tier 2 half of the IPD gate.
    tier: 2,
  },
];

export const ALL_SEED_EMAILS: string[] = SEED_TENANTS.flatMap((t) => t.users.map((u) => u.email));
export const SEED_TENANT_NAMES: string[] = SEED_TENANTS.map((t) => t.name);

export function tenantAdmin(tenant: SeedTenant): SeedUser {
  const admin = tenant.users.find((u) => u.role === 'admin');
  if (!admin) throw new Error(`Seed tenant "${tenant.name}" has no admin user defined`);
  return admin;
}

export function tenantStaff(tenant: SeedTenant): SeedUser[] {
  return tenant.users.filter((u) => u.role !== 'admin');
}
