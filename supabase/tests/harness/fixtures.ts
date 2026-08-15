/**
 * Shared fixture builders for the local (PGlite) suites.
 *
 * Builds a complete clinic — tenant plus admin/doctor/nurse/billing — by driving
 * the REAL Phase 1 onboarding RPCs (create_tenant_and_assign_admin, create_invite,
 * accept_invite) rather than inserting rows as the owner. Two reasons:
 *   * the fixture exercises the same path production uses, so a regression in
 *     onboarding breaks the Phase 2 suites too rather than hiding;
 *   * profiles.role / tenant_id are not directly writable anyway, by design.
 *
 * Extracted here because both Phase 2 suites need the same two-clinic setup, and
 * duplicating it would let them drift apart.
 */

import type { Harness, Row, Sql, SessionUser } from './pglite.ts';

export interface StaffUser extends SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'doctor' | 'nurse' | 'billing';
}

export interface TenantFixture {
  tenantId: string;
  name: string;
  admin: StaffUser;
  doctor: StaffUser;
  nurse: StaffUser;
  billing: StaffUser;
  /** Every staff member, for loops that assert "no staff role can ...". */
  allStaff: StaffUser[];
}

export interface SeedTenantOptions {
  name: string;
  /** Email prefix, e.g. 'a' -> a.admin@clinic-a.test */
  slug: string;
  /** When provided, the tenant is made GST-registered with these details. */
  gst?: { gstin: string; stateCode: string };
  /** Tenant-level default consultation fee. */
  consultationFee?: number;
  /** Per-doctor fee override. */
  doctorFee?: number;
  /**
   * Feature tier. Defaults to 1, matching a freshly created tenant.
   *
   * Applied as the table OWNER, not through the admin's session, and that is the
   * point rather than a shortcut: `tenants.tier` is deliberately not writable by
   * anyone from a client session (Phase 1 column grants), because an admin who
   * could raise their own tier would make every tier gate cosmetic. Raising it is
   * a platform-owner action performed out of band — via the Supabase dashboard in
   * production, and via this line in the harness. The Phase 3 suites assert the
   * client-side impossibility separately.
   */
  tier?: 1 | 2 | 3;
}

/** Calls an RPC and returns the parsed jsonb envelope. */
export async function rpc(sql: Sql, fn: string, args: string, params: unknown[]): Promise<Row> {
  const rows = await sql(`select public.${fn}(${args}) as r`, params);
  return rows[0].r as Row;
}

function expectOk(label: string, env: Row): Row {
  if (env.ok !== true) {
    throw new Error(`Fixture setup failed at ${label}: ${JSON.stringify(env)}`);
  }
  return env;
}

export async function seedTenant(h: Harness, opts: SeedTenantOptions): Promise<TenantFixture> {
  const domain = `clinic-${opts.slug}.test`;
  const mk = (role: StaffUser['role']) => ({
    email: `${opts.slug}.${role}@${domain}`,
    role,
  });

  const defs = [mk('admin'), mk('doctor'), mk('nurse'), mk('billing')] as const;

  const ids: Record<string, string> = {};
  for (const d of defs) {
    ids[d.role] = await h.signUp({
      email: d.email,
      fullName: `${opts.slug.toUpperCase()} ${d.role}`,
    });
  }

  const admin: StaffUser = { id: ids.admin, email: defs[0].email, role: 'admin' };

  // 1. Admin founds the clinic.
  const created = await h.asUser(admin, (sql) =>
    rpc(sql, 'create_tenant_and_assign_admin', '$1', [opts.name]),
  );
  expectOk('create_tenant_and_assign_admin', created);
  const tenantId = created.tenant_id as string;

  // 2. Staff join via the real invite flow.
  const staff: StaffUser[] = [admin];
  for (const d of defs.slice(1)) {
    const user: StaffUser = { id: ids[d.role], email: d.email, role: d.role };

    const invite = await h.asUser(admin, (sql) =>
      rpc(sql, 'create_invite', '$1, $2', [d.email, d.role]),
    );
    expectOk(`create_invite(${d.role})`, invite);

    const accepted = await h.asUser(user, (sql) =>
      rpc(sql, 'accept_invite', '$1', [invite.token]),
    );
    expectOk(`accept_invite(${d.role})`, accepted);

    staff.push(user);
  }

  // 3. Billing / GST settings, applied through the ADMIN's own session so the
  //    column grants added in 20260811060000 are exercised rather than bypassed.
  if (opts.gst || opts.consultationFee !== undefined) {
    await h.asUser(admin, async (sql) => {
      if (opts.gst) {
        await sql(
          `update public.tenants
              set gst_registered = true, gstin = $1, gst_state_code = $2
            where id = $3`,
          [opts.gst.gstin, opts.gst.stateCode, tenantId],
        );
      }
      if (opts.consultationFee !== undefined) {
        await sql(`update public.tenants set default_consultation_fee = $1 where id = $2`, [
          opts.consultationFee,
          tenantId,
        ]);
      }
    });
  }

  if (opts.doctorFee !== undefined) {
    const doctor = staff.find((s) => s.role === 'doctor')!;
    await h.asUser(doctor, async (sql) => {
      await sql(`update public.profiles set consultation_fee = $1 where id = $2`, [
        opts.doctorFee,
        doctor.id,
      ]);
    });
  }

  // 4. Feature tier — owner-level, because no client session can write it. See the
  //    note on SeedTenantOptions.tier.
  if (opts.tier !== undefined && opts.tier !== 1) {
    await h.asOwner(`update public.tenants set tier = $1 where id = $2`, [opts.tier, tenantId]);
  }

  return {
    tenantId,
    name: opts.name,
    admin,
    doctor: staff.find((s) => s.role === 'doctor')!,
    nurse: staff.find((s) => s.role === 'nurse')!,
    billing: staff.find((s) => s.role === 'billing')!,
    allStaff: staff,
  };
}

/**
 * Registers a patient and walks them through a complete OPD encounter, stopping
 * at whichever stage the caller asks for. Returns the ids created along the way.
 */
export interface EncounterResult {
  patientId: string;
  patientNumber: number;
  visitId: string;
  queueNumber: number;
  prescriptionId?: string;
  invoiceId?: string;
}

export async function registerPatient(
  h: Harness,
  t: TenantFixture,
  patient: { name: string; phone?: string; allergies?: string; age?: number },
): Promise<{ patientId: string; patientNumber: number }> {
  const res = await h.asUser(t.billing, (sql) =>
    rpc(sql, 'register_patient', '$1, $2, $3, $4, $5, $6, $7', [
      patient.name,
      patient.phone ?? null,
      null,
      patient.age ?? null,
      null,
      null,
      patient.allergies ?? null,
    ]),
  );
  expectOk('register_patient', res);
  return {
    patientId: res.patient_id as string,
    patientNumber: Number(res.patient_number),
  };
}
