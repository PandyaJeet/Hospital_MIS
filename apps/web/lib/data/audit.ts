import type { Role } from "@/lib/roles";
import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError, untypedClient } from "./rpc";
import type { Result } from "./types";

/**
 * Audit log — `docs/contracts/audit-log.md`. Admin-only reads, no write path for
 * anyone.
 *
 * The thing that shapes this UI: **`changes` records field NAMES always, and field
 * VALUES only for an allow-list of non-personal columns** (§3). Everything clinical,
 * plus invite emails and tokens, is stored as `{ changed: true, redacted: true }`.
 * So a row must be renderable with no value at all — never print `undefined`.
 */

export type AuditAction =
  | "user.role_changed"
  | "user.deactivated"
  | "user.reactivated"
  | "user.joined_tenant"
  | "user.tenant_changed"
  | "invite.created"
  | "invite.accepted"
  | "invite.reissued"
  | "invite.revoked"
  | "tenant.created"
  | "tenant.settings_changed";

export interface AuditFieldChange {
  from: unknown;
  to: unknown;
}

export interface AuditFieldRedacted {
  changed: true;
  redacted: true;
}

export type AuditEntry = AuditFieldChange | AuditFieldRedacted;

export interface AuditRow {
  id: string;
  actor_id: string | null;
  /** Snapshotted at the time — a later promotion must not rewrite history (§1). */
  actor_role: Role | null;
  /** A positive signal, so a null actor is never guessed at. */
  actor_is_system: boolean;
  action: AuditAction | string;
  table_name: string;
  row_id: string | null;
  changes: Record<string, AuditEntry>;
  /** Present when the trigger could not resolve the actor. Not an error to hide (§3). */
  audit_note: string | null;
  created_at: string;
}

export interface AuditFilter {
  action?: AuditAction;
  /** Everything that happened to one row, e.g. one user's profile. */
  rowId?: string;
  /** Everything one person did — a leaver review. */
  actorId?: string;
}

/** A redacted entry has no value to render. */
export function isRedacted(entry: AuditEntry): entry is AuditFieldRedacted {
  return (entry as AuditFieldRedacted).redacted === true;
}

/**
 * Renderable value for one side of a change.
 *
 * Booleans get spelled out because `is_active: false` rendered as "false" reads
 * worse than "no" in a log a non-engineer is auditing. `null` becomes an em dash so
 * an unset value never appears as the literal string "null".
 */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.length > 0 ? value : "\u2014";
  return JSON.stringify(value);
}

const AUDIT_SELECT =
  "id, actor_id, actor_role, actor_is_system, action, table_name, row_id, changes, created_at";

function toRow(raw: Record<string, unknown>): AuditRow {
  const rawChanges = (raw.changes ?? {}) as Record<string, unknown>;
  const changes: Record<string, AuditEntry> = {};
  let auditNote: string | null = null;

  for (const [field, entry] of Object.entries(rawChanges)) {
    // Reserved key, not a field diff — pulled out so it cannot render as a column
    // called "_audit_note".
    if (field === "_audit_note") {
      auditNote = typeof entry === "string" ? entry : null;
      continue;
    }
    changes[field] = entry as AuditEntry;
  }

  return {
    id: String(raw.id ?? ""),
    actor_id: (raw.actor_id as string | null) ?? null,
    actor_role: (raw.actor_role as Role | null) ?? null,
    actor_is_system: Boolean(raw.actor_is_system),
    action: String(raw.action ?? ""),
    table_name: String(raw.table_name ?? ""),
    row_id: (raw.row_id as string | null) ?? null,
    changes,
    audit_note: auditNote,
    created_at: String(raw.created_at ?? ""),
  };
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realListAudit(
  filter: AuditFilter,
): Promise<Result<AuditRow[]>> {
  const supabase = untypedClient(createClient());
  let query = supabase
    .from("audit_log")
    .select(AUDIT_SELECT)
    .order("created_at", { ascending: false })
    .limit(100);

  if (filter.action) query = query.eq("action", filter.action);
  if (filter.rowId) query = query.eq("row_id", filter.rowId);
  if (filter.actorId) query = query.eq("actor_id", filter.actorId);

  const { data, error } = await query;
  if (error) return { data: null, error: mapPostgrestError(error) };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map(toRow),
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

function delay(ms = 320) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hoursAgo(h: number) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

/**
 * Deliberately includes all three shapes a reader must cope with: an allow-listed
 * value change, a redacted one, and a system actor with no name attached.
 */
const MOCK_AUDIT: AuditRow[] = [
  {
    id: "audit-1",
    actor_id: "mock-user-1",
    actor_role: "admin",
    actor_is_system: false,
    action: "user.role_changed",
    table_name: "profiles",
    row_id: "mock-user-4",
    changes: { role: { from: "nurse", to: "billing" } },
    audit_note: null,
    created_at: hoursAgo(2),
  },
  {
    id: "audit-2",
    actor_id: "mock-user-1",
    actor_role: "admin",
    actor_is_system: false,
    action: "user.deactivated",
    table_name: "profiles",
    row_id: "mock-user-5",
    changes: {
      is_active: { from: true, to: false },
      deactivated_at: { from: null, to: hoursAgo(3) },
    },
    audit_note: null,
    created_at: hoursAgo(3),
  },
  {
    id: "audit-3",
    actor_id: "mock-user-1",
    actor_role: "admin",
    actor_is_system: false,
    action: "invite.created",
    table_name: "invites",
    row_id: "invite-9",
    // The invitee's email and the token are absent by design — a permanent table
    // must not hold a second copy of either.
    changes: {
      role: { from: null, to: "nurse" },
      expires_at: { from: null, to: hoursAgo(-48) },
      email: { changed: true, redacted: true },
    },
    audit_note: null,
    created_at: hoursAgo(5),
  },
  {
    id: "audit-4",
    actor_id: null,
    actor_role: null,
    // Tier is not client-writable, so a tier change is always a platform action.
    actor_is_system: true,
    action: "tenant.settings_changed",
    table_name: "tenants",
    row_id: "mock-tenant-1",
    changes: { tier: { from: 1, to: 2 } },
    audit_note: null,
    created_at: hoursAgo(26),
  },
  {
    id: "audit-5",
    actor_id: "mock-user-3",
    actor_role: "nurse",
    actor_is_system: false,
    action: "invite.accepted",
    table_name: "invites",
    row_id: "invite-8",
    changes: {
      accepted_at: { from: null, to: hoursAgo(50) },
      accepted_by: { from: null, to: "mock-user-3" },
    },
    audit_note: null,
    created_at: hoursAgo(50),
  },
  {
    id: "audit-6",
    actor_id: "mock-user-1",
    actor_role: "admin",
    actor_is_system: false,
    action: "tenant.created",
    table_name: "tenants",
    row_id: "mock-tenant-1",
    changes: { name: { from: null, to: "Sunrise Clinic (mock)" } },
    audit_note: null,
    created_at: hoursAgo(400),
  },
];

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Admin only. Every other role reads zero rows under RLS, not an error. */
export async function listAuditLog(
  filter: AuditFilter = {},
): Promise<Result<AuditRow[]>> {
  if (!USE_MOCK) return realListAudit(filter);
  await delay();
  return {
    data: MOCK_AUDIT.filter((row) => {
      if (filter.action && row.action !== filter.action) return false;
      if (filter.rowId && row.row_id !== filter.rowId) return false;
      if (filter.actorId && row.actor_id !== filter.actorId) return false;
      return true;
    }),
    error: null,
  };
}
