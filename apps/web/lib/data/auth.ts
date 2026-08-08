import { roles, type Role } from "@/lib/roles";

import { USE_MOCK } from "./mock";
import type { Result } from "./types";

export interface AuthUser {
  userId: string;
  role: Role;
  tenantId: string;
}

export interface SignInInput {
  email: string;
  password: string;
}

export interface CreateTenantInput {
  clinicName: string;
  fullName: string;
  email: string;
  password: string;
}

const MOCK_PASSWORD = "password";

function delay(ms = 500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockSignIn({
  email,
  password,
}: SignInInput): Promise<Result<AuthUser>> {
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
  // Demo convenience: derive the role from the email prefix
  // (e.g. admin@clinic.test -> admin), defaulting to doctor. The real role
  // will come from the profiles table once the backend is wired.
  const prefix = email.split("@")[0]?.toLowerCase() ?? "";
  const role = (roles as readonly string[]).includes(prefix)
    ? (prefix as Role)
    : "doctor";
  return {
    data: { userId: "mock-user-1", role, tenantId: "mock-tenant-1" },
    error: null,
  };
}

async function mockCreateTenantAndOwner({
  email,
}: CreateTenantInput): Promise<Result<AuthUser>> {
  await delay();
  if (email.toLowerCase() === "taken@clinic.test") {
    return {
      data: null,
      error: {
        code: "EMAIL_TAKEN",
        message: "That email is already registered.",
        fields: ["email"],
      },
    };
  }
  // The first user of a new tenant becomes its admin.
  return {
    data: { userId: "mock-user-1", role: "admin", tenantId: "mock-tenant-1" },
    error: null,
  };
}

function notImplemented(): Promise<Result<AuthUser>> {
  // TODO(integration): wire to Supabase Auth + profiles once the Auth & Tenancy
  // contract is finalized with the backend. Until then, run with USE_MOCK=true.
  return Promise.resolve({
    data: null,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "The real backend is not wired yet.",
    },
  });
}

export function signIn(input: SignInInput): Promise<Result<AuthUser>> {
  return USE_MOCK ? mockSignIn(input) : notImplemented();
}

export function createTenantAndOwner(
  input: CreateTenantInput,
): Promise<Result<AuthUser>> {
  return USE_MOCK ? mockCreateTenantAndOwner(input) : notImplemented();
}
