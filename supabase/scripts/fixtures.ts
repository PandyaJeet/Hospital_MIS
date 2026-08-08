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
  },
  {
    name: 'Lotus Hospital (seed)',
    users: [
      { role: 'admin', email: `b.admin@${DOMAIN}`, fullName: 'Meera Iyer' },
      { role: 'doctor', email: `b.doctor@${DOMAIN}`, fullName: 'Arjun Desai' },
      { role: 'nurse', email: `b.nurse@${DOMAIN}`, fullName: 'Sunita Patil' },
      { role: 'billing', email: `b.billing@${DOMAIN}`, fullName: 'Imran Sheikh' },
    ],
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
