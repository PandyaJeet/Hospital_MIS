"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";

import { Button, Spinner } from "@/components/ui";
import { dischargePatient, type DischargeOutcome } from "@/lib/data/beds";
import type { AppError } from "@/lib/data/types";

/**
 * Discharge confirmation.
 *
 * Deliberately **not** tier-gated (ipd-beds.md §6): a clinic downgraded while a
 * patient is in a bed must still be able to unwind, or that patient stays admitted
 * forever with no in-app way out.
 *
 * No notes field. `p_notes` is echoed by the RPC but **not stored** — there is no
 * discharge-summary column this phase — so offering a box that silently discards a
 * clinician's summary would be worse than not offering one.
 */
export function DischargePanel({
  visitId,
  bedLabel,
  pendingTasks,
  onDischarged,
  onClose,
}: {
  visitId: string;
  bedLabel: string | null;
  pendingTasks: number;
  onDischarged?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("beds");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [outcome, setOutcome] = useState<DischargeOutcome | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    const { data, error: failure } = await dischargePatient(visitId);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (data) {
      setOutcome(data);
      onDischarged?.();
    }
  }

  if (outcome) {
    return (
      <div className="mt-3 rounded-md border border-success bg-success/5 p-3">
        <p className="text-sm font-medium text-text-primary">
          {t("dischargedTitle")}
        </p>
        <ul className="mt-1 flex flex-col gap-0.5 text-sm text-text-secondary">
          <li>
            {outcome.bed_released
              ? t("bedReleased", { bed: outcome.bed_released })
              : // Admitted but never given a bed — a real state, and it correctly
                // bills no room rent.
                t("noBedToRelease")}
          </li>
          {outcome.pending_tasks_cancelled > 0 ? (
            <li>
              {t("tasksCancelled", {
                count: outcome.pending_tasks_cancelled,
              })}
            </li>
          ) : null}
        </ul>
        <p className="mt-2 text-xs text-text-disabled">{t("noSummaryNote")}</p>
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

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-muted p-3">
      <p className="text-sm font-medium text-text-primary">
        {t("confirmDischarge")}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5 text-sm text-text-secondary">
        {bedLabel ? <li>{t("willRelease", { bed: bedLabel })}</li> : null}
        {pendingTasks > 0 ? (
          <li>{t("willCancelTasks", { count: pendingTasks })}</li>
        ) : null}
      </ul>

      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-text-primary">
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <span>
            {error.code === "ALREADY_DISCHARGED"
              ? t("alreadyDischarged")
              : error.code === "NOT_ADMITTED"
                ? t("notAdmitted")
                : error.message}
          </span>
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void confirm()}>
          {busy ? <Spinner /> : null}
          {t("confirmDischargeAction")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t("cancel")}
        </Button>
      </div>
      <p className="mt-2 text-xs text-text-disabled">{t("noSummaryNote")}</p>
    </div>
  );
}
