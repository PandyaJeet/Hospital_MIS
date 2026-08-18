"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TicketCheck, TriangleAlert } from "lucide-react";

import { Button, Spinner } from "@/components/ui";
import { checkInPatient, type CheckInPayload, type VisitType } from "@/lib/data/queue";
import type { AppError } from "@/lib/data/types";

/**
 * Put a registered patient into today's OPD queue.
 *
 * This is the step that was missing: `check_in_patient()` has existed since
 * Phase 2 and nothing in the UI called it, so a patient could be registered and
 * then never reach the doctor's queue.
 *
 * Checking the same patient in twice is not an error — the RPC returns the
 * existing visit and its token (`opd-queue.md`), so a second press shows the
 * number they already have rather than issuing a second one.
 */
export function CheckInButton({
  patientId,
  visitType = "new",
  size = "md",
  variant = "primary",
  onCheckedIn,
}: {
  patientId: string;
  visitType?: VisitType;
  size?: "sm" | "md";
  variant?: "primary" | "secondary";
  onCheckedIn?: (payload: CheckInPayload) => void;
}) {
  const t = useTranslations("checkIn");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckInPayload | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const { data, error: failure } = await checkInPatient(patientId, visitType);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (data) {
      setResult(data);
      onCheckedIn?.(data);
    }
  }

  if (result) {
    return (
      <div className="rounded-md border border-success bg-success/5 p-3">
        <p className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <TicketCheck
            className="mt-0.5 h-4 w-4 shrink-0 text-success"
            aria-hidden="true"
          />
          {t("token", { number: result.queue_number })}
        </p>
        <p className="mt-1 pl-6 text-sm text-text-secondary">
          {t("inQueue")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        size={size}
        variant={variant}
        disabled={busy}
        onClick={() => void run()}
      >
        {busy ? <Spinner /> : null}
        {busy ? t("checkingIn") : t("action")}
      </Button>
      {error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-sm text-text-primary"
        >
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <span>
            {error.code === "NOT_STAFF"
              ? t("notStaff")
              : error.code === "PATIENT_NOT_FOUND"
                ? t("notFound")
                : error.message}
          </span>
        </p>
      ) : null}
    </div>
  );
}
