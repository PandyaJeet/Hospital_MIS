import { isRole, type Role } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { fromRpc, mapPostgrestError } from "./rpc";
import type { AppError, Result } from "./types";

export interface AuthUser {
  userId: string;
  role: Role;
  /** NULL until the user founds a clinic or accepts an invite (auth-tenancy.md §2). */
  tenantId: string | null;
  fullName: string | null;
}

export interface SignUpInput {
  fullName: string;
  email: string;
  password: string;
}

export interface SignUpOutcome {
  /**
   * False when Supabase requires email confirmation before issuing a session.
   * The user must confirm, then sign in, before they can found a clinic or
   * accept an invite (`accept_invite` requires a confirmed email — §5).
   */
  sessionReady: boolean;
}

export interface TenantAssignment {
  tenantId: string;
  tenantName: string;
  role: Role;
}

interface AuthLikeError {
  message: string;
  code?: string;
}

/**
 * Supabase Auth errors are their own channel — separate from the RPC envelope.
 * Map to stable codes the UI can translate; never surface raw provider text
 * (rules.md §3.3).
 */
function mapAuthError(error: AuthLikeError): AppError {
  switch (error.code) {
    case "invalid_credentials":
      return {
        code: "INVALID_CREDENTIALS",
        message: "Incorrect email or password.",
      };
    case "email_not_confirmed":
      return {
        code: "EMAIL_NOT_CONFIRMED",
        message: "Please confirm your email address first.",
      };
    case "user_already_exists":
    case "email_exists":
      return {
        code: "EMAIL_TAKEN",
        message: "That email is already registered.",
      };
    case "weak_password":
      return {
        code: "WEAK_PASSWORD",
        message: "Please choose a stronger password.",
      };
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return {
        code: "RATE_LIMITED",
        message: "Too many attempts. Please wait a moment and try again.",
      };
    default:
      return {
        code: "AUTH_FAILED",
        message: "Something went wrong. Please try again.",
      };
  }
}

const NOT_AUTHENTICATED: AppError = {
  code: "NOT_AUTHENTICATED",
  message: "Your session has expired. Please sign in again.",
};

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realGetSessionUser(): Promise<Result<AuthUser>> {
  const supabase = createClient();

  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) {
    return { data: null, error: NOT_AUTHENTICATED };
  }

  // RLS restricts this to the caller's own row, so no filter is needed.
  // maybeSingle() avoids PGRST116 when RLS legitimately returns nothing (§6).
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, tenant_id, role, full_name")
    .maybeSingle();

  if (profileError) {
    return { data: null, error: mapPostgrestError(profileError) };
  }
  if (!profile) {
    return {
      data: null,
      error: {
        code: "PROFILE_MISSING",
        message: "Your account isn't fully set up. Please contact support.",
      },
    };
  }

  return {
    data: {
      userId: profile.id,
      // An unrecognised role means the DB vocabulary moved ahead of this build;
      // treat it as un-onboarded rather than guessing a privileged role.
      role: isRole(profile.role) ? profile.role : "pending",
      tenantId: profile.tenant_id,
      fullName: profile.full_name,
    },
    error: null,
  };
}

async function realSignIn(
  email: string,
  password: string,
): Promise<Result<AuthUser>> {
  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { data: null, error: mapAuthError(error) };
  }
  return realGetSessionUser();
}

async function realSignUp(input: SignUpInput): Promise<Result<SignUpOutcome>> {
  const supabase = createClient();
  // full_name is lifted into profiles by the on_auth_user_created trigger (§2).
  const { data, error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { full_name: input.fullName } },
  });
  if (error) {
    return { data: null, error: mapAuthError(error) };
  }
  return { data: { sessionReady: data.session !== null }, error: null };
}

interface TenantRpcPayload {
  tenant_id: string;
  tenant_name: string;
  role: string;
}

function toAssignment(payload: TenantRpcPayload): TenantAssignment {
  return {
    tenantId: payload.tenant_id,
    tenantName: payload.tenant_name,
    role: isRole(payload.role) ? payload.role : "pending",
  };
}

async function realCreateTenant(
  tenantName: string,
): Promise<Result<TenantAssignment>> {
  const supabase = createClient();
  const result = fromRpc<TenantRpcPayload>(
    await supabase.rpc("create_tenant_and_assign_admin", {
      p_tenant_name: tenantName,
    }),
  );
  if (!result.data) return { data: null, error: result.error };
  return { data: toAssignment(result.data), error: null };
}

async function realAcceptInvite(
  token: string,
): Promise<Result<TenantAssignment>> {
  const supabase = createClient();
  const result = fromRpc<TenantRpcPayload>(
    await supabase.rpc("accept_invite", { p_token: token }),
  );
  if (!result.data) return { data: null, error: result.error };
  return { data: toAssignment(result.data), error: null };
}

async function realSignOut(): Promise<Result<null>> {
  const supabase = createClient();
  const { error } = await supabase.auth.signOut();
  if (error) return { data: null, error: mapAuthError(error) };
  return { data: null, error: null };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

const MOCK_PASSWORD = "password";

/** Survives a refresh badly on purpose — mock mode has no real session. */
let mockUser: AuthUser | null = null;

function delay(ms = 400) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockSignIn(
  email: string,
  password: string,
): Promise<Result<AuthUser>> {
  await delay();
  if (password !== MOCK_PASSWORD) {
    return {
      data: null,
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Incorrect email or password.",
      },
    };
  }
  // Demo convenience: the email prefix picks the role, so every landing screen
  // is reachable (e.g. pending@… → /onboarding, nurse@… → /tasks).
  const prefix = email.split("@")[0]?.toLowerCase() ?? "";
  const role: Role = isRole(prefix) ? prefix : "doctor";
  mockUser = {
    userId: "mock-user-1",
    role,
    tenantId: role === "pending" ? null : "mock-tenant-1",
    fullName: "Mock User",
  };
  return { data: mockUser, error: null };
}

async function mockSignUp(input: SignUpInput): Promise<Result<SignUpOutcome>> {
  await delay();
  if (input.email.toLowerCase() === "taken@clinic.test") {
    return {
      data: null,
      error: {
        code: "EMAIL_TAKEN",
        message: "That email is already registered.",
        fields: ["email"],
      },
    };
  }
  mockUser = {
    userId: "mock-user-1",
    role: "pending",
    tenantId: null,
    fullName: input.fullName,
  };
  return { data: { sessionReady: true }, error: null };
}

async function mockGetSessionUser(): Promise<Result<AuthUser>> {
  await delay(150);
  if (!mockUser) return { data: null, error: NOT_AUTHENTICATED };
  return { data: mockUser, error: null };
}

async function mockCreateTenant(
  tenantName: string,
): Promise<Result<TenantAssignment>> {
  await delay();
  if (!mockUser) return { data: null, error: NOT_AUTHENTICATED };
  if (mockUser.tenantId) {
    return {
      data: null,
      error: {
        code: "ALREADY_IN_TENANT",
        message: "You already belong to a clinic.",
      },
    };
  }
  mockUser = { ...mockUser, role: "admin", tenantId: "mock-tenant-1" };
  return {
    data: {
      tenantId: "mock-tenant-1",
      tenantName,
      role: "admin",
    },
    error: null,
  };
}

async function mockAcceptInvite(
  token: string,
): Promise<Result<TenantAssignment>> {
  await delay();
  if (!mockUser) return { data: null, error: NOT_AUTHENTICATED };
  if (token.trim().toLowerCase() === "expired") {
    return {
      data: null,
      error: {
        code: "INVITE_EXPIRED",
        message: "This invite link has expired.",
        fields: ["token"],
      },
    };
  }
  if (token.trim().length < 8) {
    return {
      data: null,
      error: {
        code: "INVITE_NOT_FOUND",
        message: "This invite link isn't valid.",
        fields: ["token"],
      },
    };
  }
  mockUser = { ...mockUser, role: "nurse", tenantId: "mock-tenant-1" };
  return {
    data: {
      tenantId: "mock-tenant-1",
      tenantName: "Sunrise Clinic (mock)",
      role: "nurse",
    },
    error: null,
  };
}

async function mockSignOut(): Promise<Result<null>> {
  await delay(150);
  mockUser = null;
  return { data: null, error: null };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function signIn(
  email: string,
  password: string,
): Promise<Result<AuthUser>> {
  return USE_MOCK ? mockSignIn(email, password) : realSignIn(email, password);
}

export function signUp(input: SignUpInput): Promise<Result<SignUpOutcome>> {
  return USE_MOCK ? mockSignUp(input) : realSignUp(input);
}

/** The first call after login — resolves the caller's role and tenant. */
export function getSessionUser(): Promise<Result<AuthUser>> {
  return USE_MOCK ? mockGetSessionUser() : realGetSessionUser();
}

/** "Found a clinic" — the caller becomes its admin (auth-tenancy.md §5). */
export function createTenant(
  tenantName: string,
): Promise<Result<TenantAssignment>> {
  return USE_MOCK ? mockCreateTenant(tenantName) : realCreateTenant(tenantName);
}

/** "Join a clinic I was invited to." */
export function acceptInvite(
  token: string,
): Promise<Result<TenantAssignment>> {
  return USE_MOCK ? mockAcceptInvite(token) : realAcceptInvite(token);
}

export function signOut(): Promise<Result<null>> {
  return USE_MOCK ? mockSignOut() : realSignOut();
}
