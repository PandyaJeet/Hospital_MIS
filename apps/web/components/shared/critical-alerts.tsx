"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CircleAlert, HelpCircle } from "lucide-react";

import { Badge, Button, Spinner } from "@/components/ui";
import {
  acknowledgeCriticalResult,
  alertLevel,
  type CriticalAlert,
} from "@/lib/data/labs";
import type { AppError } from "@/lib/data/types";

/**
 * Outstanding critical-value alerts.
 *
 * ⚠️ Rendering is driven by `alertLevel()`, never by `is_critical` alone. A result
 * for a test with no thresholds on file arrives as `is_critical: false` because no
 * comparison happened — showing that as reassuring is precisely the failure the
 * two-field shape exists to prevent (lab-orders.md §4).
 *
 * The alert view carries **no patient name** by design (§7): the same shape feeds a
 * notification dispatcher that will one day reach WhatsApp or SMS, and a payload
 * without a name cannot leak one. Patients are identified here by UHID plus
 * ward/bed, which is what staff act on anyway.
 */
export function CriticalAlerts({
  alerts,
  onAcknowledged,
}: {
  alerts: CriticalAlert[];
  onAcknowledged?: () => void;
}) {
  const t = useTranslations("labs");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  async function acknowledge(alert: CriticalAlert) {
    setBusyId(alert.lab_result_id);
    setError(null);
    const { error: failure } = await acknowledgeCriticalResult(
      alert.lab_result_id,
    );
    setBusyId(null);
    if (failure) {
      setError(failure);
      return;
    }
    onAcknowledged?.();
  }

  if (alerts.length === 0) return null;

  return (
    <section aria-label={t("alertsTitle")} className="mt-6">
      <h2 className="text-lg font-medium">{t("alertsTitle")}</h2>
      <p className="mt-1 text-sm text-text-secondary">{t("alertsSubtitle")}</p>

      <ul className="mt-3 flex flex-col gap-3">
        {alerts.map((alert) => {
          const level = alertLevel(alert);
          const isCritical = level === "critical";

          return (
            <li
              key={alert.lab_result_id}
              className={
                isCritical
                  ? "rounded-lg border border-critical bg-critical/5 p-4"
                  : "rounded-lg border border-warning bg-warning/5 p-4"
              }
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p
                    className={
                      isCritical
                        ? "flex items-start gap-1.5 font-medium text-critical"
                        : "flex items-start gap-1.5 font-medium text-text-primary"
                    }
                  >
                    {isCritical ? (
                      <CircleAlert
                        className="mt-0.5 h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <HelpCircle
                        className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      {isCritical
                        ? t("criticalHeadline", {
                            test: alert.test_name,
                            direction: t(
                              `direction.${alert.critical_direction ?? "high"}`,
                            ),
                          })
                        : t("unevaluatedHeadline", { test: alert.test_name })}
                    </span>
                  </p>

                  <p className="mt-1 text-sm tabular-nums text-text-primary">
                    {alert.result_value}
                    {alert.unit ? ` ${alert.unit}` : ""}
                    {isCritical &&
                    (alert.critical_low_used !== null ||
                      alert.critical_high_used !== null) ? (
                      <span className="text-text-secondary">
                        {" · "}
                        {t("thresholdUsed", {
                          low: alert.critical_low_used ?? "—",
                          high: alert.critical_high_used ?? "—",
                        })}
                      </span>
                    ) : null}
                  </p>

                  {/* Say *why* it could not be checked. "Not evaluated" alone gives
                      the reader nothing to act on. */}
                  {!isCritical ? (
                    <p className="mt-1 text-sm text-text-secondary">
                      {t(`checkStatus.${alert.critical_check_status}`)}
                    </p>
                  ) : null}

                  <p className="mt-1.5 text-sm text-text-secondary">
                    {t("uhid", { number: alert.patient_number })}
                    {alert.ward_name && alert.bed_number
                      ? ` · ${alert.ward_name} ${alert.bed_number}`
                      : ` · ${t(`setting.${alert.care_setting}`)}`}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <Badge tone={isCritical ? "critical" : "warning"}>
                    {isCritical ? t("severity.critical") : t("severity.unevaluated")}
                  </Badge>
                  {alert.priority !== "routine" ? (
                    <Badge tone="info">{t(`priority.${alert.priority}`)}</Badge>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
                <Link
                  href={`/patient/${alert.patient_id}`}
                  className="text-sm text-text-secondary underline-offset-4 hover:underline"
                >
                  {t("openChart")}
                </Link>
                <Button
                  size="sm"
                  variant={isCritical ? "primary" : "secondary"}
                  disabled={busyId === alert.lab_result_id}
                  onClick={() => void acknowledge(alert)}
                >
                  {busyId === alert.lab_result_id ? <Spinner /> : null}
                  {t("acknowledge")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-text-secondary">
          {error.code === "NOT_CLINICAL_STAFF"
            ? t("notClinicalStaff")
            : error.code === "NOT_ALERTABLE"
              ? t("notAlertable")
              : error.message}
        </p>
      ) : null}
    </section>
  );
}
