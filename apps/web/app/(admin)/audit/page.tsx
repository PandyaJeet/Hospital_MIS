"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ScrollText, ShieldCheck } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
  type BadgeProps,
} from "@/components/ui";
import {
  formatAuditValue,
  isRedacted,
  listAuditLog,
  type AuditAction,
  type AuditRow,
} from "@/lib/data/audit";
import type { AppError, Result } from "@/lib/data/types";

/** The actions this phase records. Anything else renders by its raw code. */
const ACTIONS: AuditAction[] = [
  "user.role_changed",
  "user.deactivated",
  "user.reactivated",
  "user.joined_tenant",
  "user.tenant_changed",
  "invite.created",
  "invite.accepted",
  "invite.reissued",
  "invite.revoked",
  "tenant.created",
  "tenant.settings_changed",
];

const ACTION_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  "user.role_changed": "info",
  "user.deactivated": "warning",
  "user.reactivated": "success",
  "user.joined_tenant": "success",
  "user.tenant_changed": "info",
  "invite.created": "neutral",
  "invite.accepted": "success",
  "invite.reissued": "warning",
  "invite.revoked": "warning",
  "tenant.created": "accent",
  "tenant.settings_changed": "info",
};

export default function AuditPage() {
  const t = useTranslations("audit");
  const tRoles = useTranslations("roles");

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [action, setAction] = useState<AuditAction | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const apply = useCallback((result: Result<AuditRow[]>) => {
    if (result.error) {
      setError(result.error);
    } else {
      setRows(result.data ?? []);
      setError(null);
    }
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    apply(await listAuditLog(action ? { action } : {}));
  }, [action, apply]);

  useEffect(() => {
    let active = true;
    void listAuditLog(action ? { action } : {}).then((result) => {
      if (active) apply(result);
    });
    return () => {
      active = false;
    };
  }, [action, apply]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      {/*
        Values are recorded only for an allow-list of non-personal fields; clinical
        content, invite emails and tokens are never stored here (audit-log.md §3).
        Saying so up front stops an admin reading a redacted row as data loss.
      */}
      <Card className="mt-6 border-info bg-info/5">
        <p className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <ShieldCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-info"
            aria-hidden="true"
          />
          {t("privacyTitle")}
        </p>
        <p className="mt-1 pl-6 text-sm text-text-secondary">
          {t("privacyBody")}
        </p>
      </Card>

      <div className="mt-6">
        <label
          htmlFor="audit-action"
          className="text-sm font-medium text-text-primary"
        >
          {t("filterLabel")}
        </label>
        <select
          id="audit-action"
          value={action}
          onChange={(e) => setAction(e.target.value as AuditAction | "")}
          className="mt-1.5 h-11 w-full rounded-md border border-border bg-surface px-3 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:w-80"
        >
          <option value="">{t("allActions")}</option>
          {ACTIONS.map((option) => (
            <option key={option} value={option}>
              {t(`action.${option}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {loading ? (
          [0, 1, 2].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-48" />
              <Skeleton className="mt-2 h-3 w-32" />
            </Card>
          ))
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
            <p className="text-sm text-text-secondary">
              {/* A non-admin reads zero rows under RLS rather than erroring, so a
                  real error here is a fault, not a permissions outcome. */}
              {error.code === "PERMISSION_DENIED"
                ? t("adminOnly")
                : t("loadError")}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              {t("retry")}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={t("empty")}
            description={action ? t("emptyFiltered") : t("emptyBody")}
          />
        ) : (
          rows.map((row) => {
            const fields = Object.entries(row.changes);

            return (
              <Card key={row.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">
                      {ACTIONS.includes(row.action as AuditAction)
                        ? t(`action.${row.action}`)
                        : row.action}
                    </p>
                    <p className="mt-0.5 text-sm text-text-secondary">
                      {/*
                        actor_is_system is a positive signal so a null actor is never
                        guessed at. A tier change is always a platform action, since
                        tenants.tier is not client-writable.
                      */}
                      {row.actor_is_system
                        ? t("bySystem")
                        : t("byRole", {
                            role: row.actor_role
                              ? tRoles(row.actor_role)
                              : t("unknownRole"),
                          })}
                      {" · "}
                      {new Date(row.created_at).toLocaleString()}
                    </p>
                  </div>
                  <Badge tone={ACTION_TONE[row.action] ?? "neutral"}>
                    {row.table_name}
                  </Badge>
                </div>

                {fields.length > 0 ? (
                  <ul className="mt-3 flex flex-col gap-1">
                    {fields.map(([field, entry]) => (
                      <li key={field} className="text-sm">
                        <span className="text-text-secondary">{field}</span>{" "}
                        {isRedacted(entry) ? (
                          // No value to render. Never print `undefined`, and never
                          // let an absent value read as an empty one.
                          <span className="text-text-disabled">
                            {t("wasChangedRedacted")}
                          </span>
                        ) : (
                          <span className="text-text-primary">
                            {t("fromTo", {
                              from: formatAuditValue(entry.from),
                              to: formatAuditValue(entry.to),
                            })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* The trigger could not identify the actor. The event is still
                    recorded and the reason is recoverable — not swallowed. */}
                {row.audit_note ? (
                  <p className="mt-2 text-xs text-text-disabled">
                    {t("auditNote", { note: row.audit_note })}
                  </p>
                ) : null}
              </Card>
            );
          })
        )}
      </div>

      <p className="mt-8 text-xs text-text-disabled">{t("scopeNote")}</p>
    </div>
  );
}
