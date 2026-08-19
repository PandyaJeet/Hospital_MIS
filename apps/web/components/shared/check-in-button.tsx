"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { TicketCheck, TriangleAlert } from "lucide-react";

import { Button, Spinner } from "@/components/ui";
import { checkInPatient, type CheckInOutcome, type VisitType } from "@/lib/data/queue";

/**
 * Put a registered patient into today's OPD queue.
 *
 * This is the step that was missing: `check_in_patient()` has existed since
 * Phase 2 and nothing in the UI called it, so a patient could be registered and
 * then never reach the doctor's queue.
 *
 * ⚠️ Check-in is **not** idempotent, deliberately. A second open visit for the
 * same patient on the same day is refused, because two tokens become two
 * consultations become two consultation charges (opd-queue.md §3). So
 * `VISIT_ALREADY_OPEN` is treated as an answer rather than an error: it carries the
 * existing token, and this shows that number instead of the dead end the contract
 * warns about.
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
  onCheckedIn?: (outcome: CheckInOutcome) => void;
}) {
  const t = useTranslations("checkIn");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CheckInOutcome | null>(null);

  async function run() {
    setBusy(true);
    const result = await checkInPatient(patientId, visitType);
    setBusy(false);
    setOutcome(result);
    if (result.kind !== "failed") onCheckedIn?.(result);
  }

  if (outcome && outcome.kind !== "failed") {
    const fresh = outcome.kind === "checked_in";
    return (
      <div
        className={
          fresh
            ? "rounded-md border border-success bg-success/5 p-3"
            : "rounded-md border border-border bg-surface-muted p-3"
        }
      >
        <p className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <TicketCheck
            className={
              fresh
                ? "mt-0.5 h-4 w-4 shrink-0 text-success"
                : "mt-0.5 h-4 w-4 shrink-0 text-text-secondary"
            }
            aria-hidden="true"
          />
          {t("token", { number: outcome.queue_number })}
        </p>
        <p className="mt-1 pl-6 text-sm text-text-secondary">
          {fresh ? t("inQueue") : t("alreadyInQueue")}
        </p>
        {/* Point at the existing visit rather than leaving them stranded. */}
        {!fresh ? (
          <Link
            href="/queue"
            className="mt-1 inline-block pl-6 text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            {t("openQueue")}
          </Link>
        ) : null}
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
      {outcome?.kind === "failed" ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-sm text-text-primary"
        >
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <span>
            {outcome.error.code === "NOT_STAFF"
              ? t("notStaff")
              : outcome.error.code === "PATIENT_NOT_FOUND"
                ? t("notFound")
                : outcome.error.message}
          </span>
        </p>
      ) : null}
    </div>
  );
}
