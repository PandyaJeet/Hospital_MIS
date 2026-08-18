"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CircleAlert, FlaskConical, HelpCircle, TriangleAlert } from "lucide-react";

import { CriticalAlerts } from "@/components/shared/critical-alerts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  Spinner,
  type BadgeProps,
} from "@/components/ui";
import { useLabs } from "@/hooks/use-labs";
import { getSessionUser, type AuthUser } from "@/lib/data/auth";
import {
  allowedTransitions,
  alertLevel,
  evaluateLabCritical,
  recordLabResult,
  setLabOrderStatus,
  type CriticalEvaluation,
  type LabOrder,
  type LabOrderStatus,
  type RecordResultOutcome,
} from "@/lib/data/labs";
import type { AppError } from "@/lib/data/types";

const STATUS_TONE: Record<LabOrderStatus, NonNullable<BadgeProps["tone"]>> = {
  pending: "warning",
  sample_collected: "info",
  in_progress: "info",
  completed: "success",
  cancelled: "neutral",
};

export default function LabsPage() {
  const t = useTranslations("labs");
  const { orders, alerts, loading, error, refresh } = useLabs();

  const [session, setSession] = useState<AuthUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [enteringFor, setEnteringFor] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSessionUser().then((result) => {
      if (active && result.data) setSession(result.data);
    });
    return () => {
      active = false;
    };
  }, []);

  // Recording a result is admin/doctor/nurse. There is no `lab_tech` role in
  // `profiles` — in a clinic this size the nurse does sample handling and entry
  // (lab-orders.md §6).
  const canRecord =
    session?.role === "admin" ||
    session?.role === "doctor" ||
    session?.role === "nurse";

  async function moveStatus(order: LabOrder, status: LabOrderStatus) {
    setBusyId(order.id);
    setActionError(null);
    const { data, error: failure } = await setLabOrderStatus(order.id, status);
    setBusyId(null);
    if (failure) {
      setActionError(failure);
      return;
    }
    // A cancelled order withdraws its pending charge — unless it is already on an
    // issued invoice, which cannot be silently rewritten (§6).
    if (data?.billing_line_invoiced) {
      setActionError({
        code: "BILLING_LINE_INVOICED",
        message: t("alreadyInvoiced"),
      });
    }
    await refresh();
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      <CriticalAlerts alerts={alerts} onAcknowledged={() => void refresh()} />

      {actionError ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-1.5 text-sm text-text-primary"
        >
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <span>
            {actionError.code === "NOT_CLINICAL_STAFF"
              ? t("notClinicalStaff")
              : actionError.code === "INVALID_STATUS_TRANSITION"
                ? t("invalidTransition")
                : actionError.message}
          </span>
        </p>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">{t("ordersTitle")}</h2>

      <div className="mt-3 flex flex-col gap-3">
        {loading ? (
          [0, 1].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-2 h-3 w-24" />
            </Card>
          ))
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
            <p className="text-sm text-text-secondary">{t("loadError")}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
            >
              {t("retry")}
            </Button>
          </div>
        ) : orders.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title={t("empty")}
            description={t("emptyBody")}
          />
        ) : (
          orders.map((order) => {
            const transitions = allowedTransitions(order.status);
            const busy = busyId === order.id;

            return (
              <Card key={order.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">
                      {order.test_name}
                    </p>
                    <p className="text-sm text-text-secondary">
                      {new Date(order.ordered_at).toLocaleString()}
                    </p>
                    {order.notes ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        {order.notes}
                      </p>
                    ) : null}
                    {order.cancellation_reason ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        {t("cancelledReason", {
                          reason: order.cancellation_reason,
                        })}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {order.priority !== "routine" ? (
                      <Badge tone="info">
                        {t(`priority.${order.priority}`)}
                      </Badge>
                    ) : null}
                    <Badge tone={STATUS_TONE[order.status]}>
                      {t(`status.${order.status}`)}
                    </Badge>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {transitions
                    // `completed` is reached by recording a result, not by a status
                    // button — otherwise an order could be closed with no finding.
                    .filter((s) => s !== "completed")
                    .map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void moveStatus(order, status)}
                      >
                        {busy ? <Spinner /> : null}
                        {t(`moveTo.${status}`)}
                      </Button>
                    ))}

                  {canRecord &&
                  order.status !== "completed" &&
                  order.status !== "cancelled" ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        setEnteringFor((current) =>
                          current === order.id ? null : order.id,
                        )
                      }
                    >
                      {t("recordResult")}
                    </Button>
                  ) : null}
                </div>

                {enteringFor === order.id ? (
                  <ResultEntry
                    order={order}
                    onClose={() => setEnteringFor(null)}
                    onRecorded={() => void refresh()}
                  />
                ) : null}
              </Card>
            );
          })
        )}
      </div>

      <p className="mt-8 text-xs text-text-disabled">{t("noPriceListNote")}</p>
    </div>
  );
}

/**
 * Result entry with a live criticality check.
 *
 * The pre-save check exists so a critical value is visible **before** the row is
 * written (§6). It is advisory only — `record_lab_result` re-decides server-side and
 * its envelope is what counts, which is why the outcome panel re-renders from the
 * saved result rather than from this preview.
 */
function ResultEntry({
  order,
  onClose,
  onRecorded,
}: {
  order: LabOrder;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const t = useTranslations("labs");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [referenceRange, setReferenceRange] = useState("");
  const [preview, setPreview] = useState<CriticalEvaluation | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [outcome, setOutcome] = useState<RecordResultOutcome | null>(null);

  async function check() {
    if (!value.trim()) return;
    setChecking(true);
    const { data } = await evaluateLabCritical(
      order.test_name,
      value,
      unit.trim() || null,
    );
    setPreview(data);
    setChecking(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const { data, error: failure } = await recordLabResult({
      labOrderId: order.id,
      resultValue: value,
      unit: unit.trim() || null,
      referenceRange: referenceRange.trim() || null,
    });
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (data) {
      setOutcome(data);
      onRecorded();
    }
  }

  if (outcome) {
    const level = alertLevel(outcome);
    return (
      <div
        className={
          level === "critical"
            ? "mt-3 rounded-md border border-critical bg-critical/5 p-3"
            : level === "unevaluated"
              ? "mt-3 rounded-md border border-warning bg-warning/5 p-3"
              : "mt-3 rounded-md border border-success bg-success/5 p-3"
        }
      >
        {level === "critical" ? (
          <p className="flex items-start gap-1.5 font-medium text-critical">
            <CircleAlert
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            {t("savedCritical", {
              direction: t(
                `direction.${outcome.critical_direction ?? "high"}`,
              ),
            })}
          </p>
        ) : level === "unevaluated" ? (
          <p className="flex items-start gap-1.5 font-medium text-text-primary">
            <HelpCircle
              className="mt-0.5 h-4 w-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            {t("savedUnevaluated")}
          </p>
        ) : (
          <p className="font-medium text-text-primary">{t("savedNormal")}</p>
        )}

        <p className="mt-1 text-sm text-text-secondary">
          {t(`checkStatus.${outcome.critical_check_status}`)}
        </p>

        {outcome.requires_acknowledgement ? (
          <p className="mt-2 text-sm text-text-primary">
            {t("needsAcknowledgement")}
          </p>
        ) : null}

        {outcome.tasks_closed > 0 ? (
          <p className="mt-1 text-sm text-text-secondary">
            {t("collectionCardClosed")}
          </p>
        ) : null}

        {/* The reference set is a starter list, adult-only and not clinically
            reviewed. The RPC returns the disclaimer; surfacing it is required. */}
        {outcome.reference_disclaimer ? (
          <p className="mt-2 text-xs text-text-disabled">
            {outcome.reference_disclaimer}
          </p>
        ) : null}

        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={onClose}
        >
          {t("close")}
        </Button>
      </div>
    );
  }

  const previewLevel = preview
    ? alertLevel({
        is_critical: preview.is_critical,
        requires_manual_review: preview.status !== "evaluated",
      })
    : null;

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-muted p-3">
      <p className="text-sm font-medium text-text-primary">
        {t("resultFor", { test: order.test_name })}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Input
          label={t("resultValue")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void check()}
          // Text, not number: 'Reactive', 'No growth' and '<0.01' are real results.
          inputMode="text"
          helperText={t("resultValueHelp")}
        />
        <Input
          label={t("unit")}
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          onBlur={() => void check()}
          helperText={t("unitHelp")}
        />
        <Input
          label={t("referenceRange")}
          value={referenceRange}
          onChange={(e) => setReferenceRange(e.target.value)}
          helperText={t("referenceRangeHelp")}
        />
      </div>

      {checking ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
          <Spinner />
          {t("checking")}
        </p>
      ) : preview ? (
        <div
          className={
            previewLevel === "critical"
              ? "mt-3 rounded-md border border-critical bg-critical/5 p-2.5"
              : previewLevel === "unevaluated"
                ? "mt-3 rounded-md border border-warning bg-warning/5 p-2.5"
                : "mt-3 rounded-md border border-border bg-surface p-2.5"
          }
        >
          <p
            className={
              previewLevel === "critical"
                ? "text-sm font-medium text-critical"
                : "text-sm font-medium text-text-primary"
            }
          >
            {previewLevel === "critical"
              ? t("previewCritical")
              : previewLevel === "unevaluated"
                ? t("previewUnevaluated")
                : t("previewNormal")}
          </p>
          <p className="mt-0.5 text-sm text-text-secondary">
            {preview.message}
          </p>
          {preview.normal_low !== null && preview.normal_high !== null ? (
            // "Outside normal" and "critical" are different questions; showing the
            // normal band beside the result must not imply an alarm.
            <p className="mt-0.5 text-xs text-text-disabled">
              {t("normalRange", {
                low: preview.normal_low,
                high: preview.normal_high,
                unit: preview.reference_unit ?? "",
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-text-primary">
          {error.code === "NOT_CLINICAL_STAFF"
            ? t("notClinicalStaff")
            : error.code === "LAB_ORDER_CANCELLED"
              ? t("orderCancelled")
              : error.message}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={saving || !value.trim()}
          onClick={() => void save()}
        >
          {saving ? <Spinner /> : null}
          {t("saveResult")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}
