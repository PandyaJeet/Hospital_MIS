import type { AssignableRole, Role } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { fromRpc, mapPostgrestError, rpcUntyped } from "./rpc";
import type { Result } from "./types";

/**
 * Admin surfaces — `docs/contracts/user-management.md` and `billing.md` §2.
 *
 * **Users are never deleted.** Every clinician reference in the schema is
 * ON DELETE RESTRICT, because a medical record must keep pointing at whoever
 * created it — a doctor who leaves cannot be erased from the notes they wrote.
 * "Remove access" is deactivation. Do not build a delete button.
 */
export interface StaffProfile {
  id: string;
  full_name: string | null;
  role: Role;
  /** Not client-writable — writing it returns 42501 even for an admin. */
  is_active: boolean;
  deactivated_at: string | null;
  consultation_fee: number | null;
}

export interface SetActivePayload {
  user_id: string;
  is_active: boolean;
  changed: boolean;
  role?: Role;
  /**
   * Non-null only on deactivation. Carries the plain-language warning that the
   * user's JWT stays valid until it expires, so their access is revoked at the
   * data layer but their session is not killed. Show it to the admin.
   */
  session_note?: string | null;
}

export interface SetRolePayload {
  user_id: string;
  role: Role;
  changed: boolean;
}

export interface Invite {
  id: string;
  email: string;
  role: AssignableRole;
  expires_at: string;
  created_at: string;
}

export interface CreateInvitePayload {
  invite_id: string;
  token: string;
  email: string;
  role: AssignableRole;
  expires_at: string;
  /** true ⇒ an expired invite was reissued with a NEW token. Say "resent". */
  refreshed: boolean;
}

export interface TenantSettings {
  name: string;
  tier: number;
  gst_registered: boolean;
  gstin: string | null;
  gst_state_code: string | null;
  default_consultation_fee: number;
}

export type TenantSettingsInput = Partial<
  Pick<
    TenantSettings,
    "gst_registered" | "gstin" | "gst_state_code" | "default_consultation_fee"
  >
> & { name?: string };

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realGetStaff(): Promise<Result<StaffProfile[]>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active, deactivated_at, consultation_fee")
    .order("is_active", { ascending: false })
    .order("full_name");

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: (data ?? []) as unknown as StaffProfile[], error: null };
}

async function realGetInvites(): Promise<Result<Invite[]>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("invites")
    .select("id, email, role, expires_at, created_at")
    .is("accepted_at", null)
    .order("created_at", { ascending: false });

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: (data ?? []) as unknown as Invite[], error: null };
}

async function realGetSettings(): Promise<Result<TenantSettings>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("name, tier, gst_registered, gstin, gst_state_code, default_consultation_fee")
    .maybeSingle();

  if (error) return { data: null, error: mapPostgrestError(error) };
  if (!data) {
    return {
      data: null,
      error: { code: "TENANT_NOT_FOUND", message: "Clinic not found." },
    };
  }
  const row = data as unknown as Record<string, unknown>;
  return {
    data: {
      name: row.name as string,
      tier: num(row.tier),
      gst_registered: Boolean(row.gst_registered),
      gstin: (row.gstin as string | null) ?? null,
      gst_state_code: (row.gst_state_code as string | null) ?? null,
      default_consultation_fee: num(row.default_consultation_fee),
    },
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

const SESSION_NOTE =
  "Database access is revoked immediately, but their existing sign-in stays valid until it expires (up to 1 hour). They will see empty screens until then.";

const mockStaff: StaffProfile[] = [
  {
    id: "mock-user-1",
    full_name: "Asha Rao",
    role: "admin",
    is_active: true,
    deactivated_at: null,
    consultation_fee: null,
  },
  {
    id: "u2",
    full_name: "Vikram Shah",
    role: "doctor",
    is_active: true,
    deactivated_at: null,
    consultation_fee: 600,
  },
  {
    id: "u3",
    full_name: "Priya Nair",
    role: "nurse",
    is_active: true,
    deactivated_at: null,
    consultation_fee: null,
  },
  {
    id: "u4",
    full_name: "Rohit Kumar",
    role: "billing",
    is_active: false,
    deactivated_at: "2026-08-02T10:00:00.000Z",
    consultation_fee: null,
  },
];

let mockInvites: Invite[] = [
  {
    id: "inv-1",
    email: "newnurse@clinic.example",
    role: "nurse",
    expires_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
    created_at: new Date(Date.now() - 2 * 86400_000).toISOString(),
  },
];

let mockSettings: TenantSettings = {
  name: "Sunrise Clinic (seed)",
  tier: 1,
  gst_registered: true,
  gstin: "27AABCU9603R1ZM",
  gst_state_code: "27",
  default_consultation_fee: 500,
};

/** Stands in for auth.uid() so the self-deactivation guard is exercisable. */
const MOCK_SELF_ID = "mock-user-1";

function delay(ms = 350) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getStaff(): Promise<Result<StaffProfile[]>> {
  if (!USE_MOCK) return realGetStaff();
  await delay();
  return { data: [...mockStaff], error: null };
}

export async function setUserActive(
  userId: string,
  isActive: boolean,
): Promise<Result<SetActivePayload>> {
  if (!USE_MOCK) {
    // Phase 4 function, absent from the stale generated types — see rpcUntyped.
    return rpcUntyped<SetActivePayload>(createClient(), "admin_set_user_active", {
      p_user_id: userId,
      p_is_active: isActive,
    });
  }

  await delay();
  const target = mockStaff.find((s) => s.id === userId);
  if (!target) {
    return {
      data: null,
      error: {
        code: "USER_NOT_IN_TENANT",
        message: "That user isn't part of your clinic.",
      },
    };
  }
  // Unconditional, even when other admins exist: an admin who deactivates
  // themselves is locked out instantly and cannot undo it.
  if (userId === MOCK_SELF_ID && !isActive) {
    return {
      data: null,
      error: {
        code: "CANNOT_DEACTIVATE_SELF",
        message: "You cannot revoke your own access.",
      },
    };
  }
  // Counts ACTIVE admins — a different check from demoting the last admin.
  if (!isActive && target.role === "admin") {
    const activeAdmins = mockStaff.filter(
      (s) => s.role === "admin" && s.is_active,
    ).length;
    if (activeAdmins <= 1) {
      return {
        data: null,
        error: {
          code: "CANNOT_DEACTIVATE_LAST_ADMIN",
          message: "Your clinic needs at least one active admin.",
        },
      };
    }
  }

  const changed = target.is_active !== isActive;
  target.is_active = isActive;
  target.deactivated_at = isActive ? null : new Date().toISOString();

  return {
    data: {
      user_id: userId,
      is_active: isActive,
      changed,
      role: target.role,
      session_note: isActive ? null : SESSION_NOTE,
    },
    error: null,
  };
}

export async function setUserRole(
  userId: string,
  role: AssignableRole,
): Promise<Result<SetRolePayload>> {
  if (!USE_MOCK) {
    const supabase = createClient();
    return fromRpc<SetRolePayload>(
      await supabase.rpc("admin_set_user_role", {
        p_user_id: userId,
        p_role: role,
      }),
    );
  }

  await delay();
  const target = mockStaff.find((s) => s.id === userId);
  if (!target) {
    return {
      data: null,
      error: {
        code: "USER_NOT_IN_TENANT",
        message: "That user isn't part of your clinic.",
      },
    };
  }
  if (target.role === "admin" && role !== "admin") {
    const admins = mockStaff.filter((s) => s.role === "admin").length;
    if (admins <= 1) {
      return {
        data: null,
        error: {
          code: "CANNOT_DEMOTE_LAST_ADMIN",
          message: "Your clinic needs at least one admin.",
        },
      };
    }
  }
  const changed = target.role !== role;
  target.role = role;
  return { data: { user_id: userId, role, changed }, error: null };
}

export async function listInvites(): Promise<Result<Invite[]>> {
  if (!USE_MOCK) return realGetInvites();
  await delay();
  return { data: [...mockInvites], error: null };
}

export async function createInvite(
  email: string,
  role: AssignableRole,
): Promise<Result<CreateInvitePayload>> {
  if (!USE_MOCK) {
    const supabase = createClient();
    return fromRpc<CreateInvitePayload>(
      await supabase.rpc("create_invite", { p_email: email, p_role: role }),
    );
  }

  await delay();
  const normalized = email.trim().toLowerCase();
  if (mockStaff.some((s) => s.full_name?.toLowerCase() === normalized)) {
    return {
      data: null,
      error: {
        code: "ALREADY_MEMBER",
        message: "That person is already part of your clinic.",
      },
    };
  }
  const existing = mockInvites.find((i) => i.email === normalized);
  if (existing) {
    return {
      data: null,
      error: {
        code: "INVITE_ALREADY_EXISTS",
        message: "An invite is already pending for this email.",
      },
    };
  }
  const invite: Invite = {
    id: `inv-${Date.now()}`,
    email: normalized,
    role,
    expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    created_at: new Date().toISOString(),
  };
  mockInvites = [invite, ...mockInvites];
  return {
    data: {
      invite_id: invite.id,
      token: `mock-token-${invite.id}`,
      email: invite.email,
      role,
      expires_at: invite.expires_at,
      refreshed: false,
    },
    error: null,
  };
}

export async function revokeInvite(inviteId: string): Promise<Result<null>> {
  if (!USE_MOCK) {
    const supabase = createClient();
    const { error } = await supabase.from("invites").delete().eq("id", inviteId);
    if (error) return { data: null, error: mapPostgrestError(error) };
    return { data: null, error: null };
  }
  await delay(200);
  mockInvites = mockInvites.filter((i) => i.id !== inviteId);
  return { data: null, error: null };
}

export async function getTenantSettings(): Promise<Result<TenantSettings>> {
  if (!USE_MOCK) return realGetSettings();
  await delay();
  return { data: { ...mockSettings }, error: null };
}

export async function updateTenantSettings(
  input: TenantSettingsInput,
): Promise<Result<TenantSettings>> {
  if (!USE_MOCK) {
    const supabase = createClient();
    // `tier` is deliberately absent — it is a platform entitlement, not a
    // clinic-editable fact. An admin who could raise it would unlock Tier 2/3
    // modules for free, making every tier gate cosmetic.
    const { error } = await supabase.from("tenants").update(input);
    if (error) return { data: null, error: mapPostgrestError(error) };
    return realGetSettings();
  }

  await delay();
  // The database refuses gst_registered = true without a GSTIN.
  const merged = { ...mockSettings, ...input };
  if (merged.gst_registered && !merged.gstin?.trim()) {
    return {
      data: null,
      error: {
        code: "23514",
        message: "A GSTIN is required to register for GST.",
        fields: ["gstin"],
      },
    };
  }
  mockSettings = merged;
  return { data: { ...mockSettings }, error: null };
}
