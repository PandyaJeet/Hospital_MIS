"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";

import { Button, Input, Spinner } from "@/components/ui";
import { createLabOrder, type LabPriority } from "@/lib/data/labs";
import type { AppError } from "@/lib/data/types";

const PRIORITIES: LabPriority[] = ["routine", "urgent", "stat"];

/**
 * Order a diagnostic test for one visit.
 *
 * A plain INSERT, not an RPC (lab-orders.md §1) — nothing is decided at insert
 * time. Three effects follow from triggers and none is called here: a pending ₹0
 * billing line, a nurse "collect sample" card, and a Realtime event.
 *
 * `test_name` is free text on purpose. The reference set is not exhaustive, and a
 * doctor must never be blocked from ordering a test it does not contain (§2).
 */
export function OrderLabPanel({
  visitId,
  patientId,
  tenantId,
  orderedBy,
  onOrdered,
  onClose,
}: {
  visitId: string;
  patientId: string;
  tenantId: string;
  orderedBy: string;
  onOrdered?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("labs");
  const [testName, setTestName] = useState("");
  const [priority, setPriority] = useState<LabPriority>("routine");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [ordered, setOrdered] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const { data, error: failure } = await createLabOrder({
      tenant_id: tenantId,
      visit_id: visitId,
      patient_id: patientId,
      ordered_by: orderedBy,
      test_name: testName,
      priority,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (data) {
      setOrdered(data.test_name);
      onOrdered?.();
    }
  }

  if (ordered) {
    return (
      <div className="mt-3 rounded-md border border-success bg-success/5 p-3">
        <p className="text-sm font-medium text-text-primary">
          {t("orderedTitle", { test: ordered })}
        </p>
        {/* The ₹0 charge is deliberate: there is no lab price list, and a visible
            zero that billing prices beats a silently omitted charge (§3a). */}
        <p className="mt-1 text-sm text-text-secondary">
          {t("orderedEffects")}
        </p>
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
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-3 rounded-md border border-border bg-surface-muted p-3"
    >
      <p className="text-sm font-medium text-text-primary">{t("orderTitle")}</p>

      <div className="mt-3 flex flex-col gap-3">
        <Input
          label={t("testName")}
          value={testName}
          onChange={(e) => setTestName(e.target.value)}
          required
          helperText={t("testNameHelp")}
        />

        <fieldset>
          <legend className="text-sm font-medium text-text-primary">
            {t("priorityLabel")}
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PRIORITIES.map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={priority === option ? "primary" : "secondary"}
                aria-pressed={priority === option}
                onClick={() => setPriority(option)}
              >
                {t(`priority.${option}`)}
              </Button>
            ))}
          </div>
          {/*
            Priority goes on the nurse's card label, not into a due time — there is
            no scheduler, so "routine means 4 hours" would assert a turnaround policy
            no clinic has stated (§3b).
          */}
          <p className="mt-1.5 text-xs text-text-disabled">
            {t("priorityNote")}
          </p>
        </fieldset>

        <Input
          label={t("labNotes")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          helperText={t("labNotesHelp")}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-1.5 text-sm text-text-primary"
        >
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <span>
            {error.code === "PERMISSION_DENIED"
              ? t("cannotOrder")
              : error.message}
          </span>
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving || !testName.trim()}>
          {saving ? <Spinner /> : null}
          {t("placeOrder")}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
