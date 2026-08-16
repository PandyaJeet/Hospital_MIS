"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertTriangle, BedDouble, Clock, Stethoscope } from "lucide-react";

import { AdmitPanel } from "@/components/shared/admit-panel";
import { DischargePanel } from "@/components/shared/discharge-panel";
import { Badge, Button, Card, EmptyState, Skeleton } from "@/components/ui";
import { useRounds } from "@/hooks/use-rounds";
import type { RoundsRow } from "@/lib/data/rounds";
import { measurementKeys, type MeasurementKey } from "@/lib/data/vitals";

/** Compact labels — the full ones from the vitals form are too long for chips. */
const SHORT: Record<MeasurementKey, string> = {
  temperature_c: "Temp",
  pulse_bpm: "Pulse",
  bp_systolic: "BP sys",
  bp_diastolic: "BP dia",
  respiratory_rate: "RR",
  spo2_percent: "SpO₂",
  blood_glucose: "Glucose",
};

export default function RoundsPage() {
  const t = useTranslations("rounds");
  const tBeds = useTranslations("beds");
  const { rows, loading, error, refresh, fetchedAt } = useRounds();
  /** Which row has a panel open, and which one. Only one at a time. */
  const [openPanel, setOpenPanel] = useState<{
    visitId: string;
    kind: "bed" | "discharge";
  } | null>(null);

  function togglePanel(visitId: string, kind: "bed" | "discharge") {
    setOpenPanel((current) =>
      current?.visitId === visitId && current.kind === kind
        ? null
        : { visitId, kind },
    );
  }

  function ageLabel(iso: string | null) {
    if (!iso) return null;
    const minutes = Math.max(
      0,
      Math.round((fetchedAt - new Date(iso).getTime()) / 60000),
    );
    return minutes < 90
      ? t("minutesAgo", { count: minutes })
      : t("hoursAgo", { count: Math.round(minutes / 60) });
  }

  function measurements(row: RoundsRow) {
    return measurementKeys
      .map((key) => ({ key, value: row[key] }))
      .filter((m) => m.value !== null);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      <div className="mt-6 flex flex-col gap-3">
        {loading ? (
          [0, 1].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-44" />
              <Skeleton className="mt-2 h-3 w-32" />
              <Skeleton className="mt-3 h-8 w-full" />
            </Card>
          ))
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
            <p className="text-sm text-text-secondary">{t("loadError")}</p>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              {t("retry")}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Stethoscope}
            title={t("empty")}
            description={t("emptyBody")}
          />
        ) : (
          rows.map((row) => {
            const values = measurements(row);
            // vitals_row_count distinguishes "nothing recorded at all" from
            // "some recorded, this field wasn't among them".
            const neverObserved = row.vitals_row_count === 0;
            // More than one distinct component time means the figures are from
            // different moments — say so rather than implying one reading.
            const distinctTimes = new Set(
              Object.values(row.vitals_component_times ?? {}),
            ).size;

            return (
              <Card
                key={row.visit_id}
                className={neverObserved ? "border-warning" : ""}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      href={`/patient/${row.patient_id}`}
                      className="font-medium text-text-primary underline-offset-4 hover:underline"
                    >
                      {row.patient_name}
                    </Link>
                    <p className="text-sm tabular-nums text-text-secondary">
                      {t("uhid", { number: row.patient_number })}
                      {row.age_years !== null
                        ? ` · ${t("years", { age: row.age_years })}`
                        : ""}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {row.bed_number && row.ward_name ? (
                      <Badge tone="neutral">
                        <BedDouble
                          className="mr-1 h-3 w-3"
                          aria-hidden="true"
                        />
                        {t("bed", {
                          ward: row.ward_name,
                          bed: row.bed_number,
                        })}
                      </Badge>
                    ) : (
                      <Badge tone="warning">{t("noBed")}</Badge>
                    )}
                    {row.overdue_tasks > 0 ? (
                      <Badge tone="warning">
                        {t("overdueTasks", { count: row.overdue_tasks })}
                      </Badge>
                    ) : null}
                    {row.unacknowledged_alerts > 0 ? (
                      <Badge tone="critical">
                        {t("alerts", { count: row.unacknowledged_alerts })}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                {row.allergies ? (
                  <p className="mt-2 flex items-start gap-1.5 text-sm text-critical">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="font-medium">{t("allergy")}:</span>{" "}
                      {row.allergies}
                    </span>
                  </p>
                ) : null}

                {!row.bed_id ? (
                  <p className="mt-2 text-sm text-text-secondary">
                    {t("noBedNote")}
                  </p>
                ) : null}

                {neverObserved ? (
                  <div className="mt-3 rounded-md border border-warning bg-warning/10 p-3">
                    <p className="text-sm font-medium text-text-primary">
                      {t("neverObserved")}
                    </p>
                    <p className="text-sm text-text-secondary">
                      {t("neverObservedNote")}
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="mt-3 flex items-center gap-1.5 text-sm text-text-secondary">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("lastObserved", {
                        age: ageLabel(row.last_vitals_at) ?? "—",
                      })}
                    </p>

                    {/* Each chip carries its own age: a temperature from 06:00 can
                        legitimately sit beside a pulse from 11:00. */}
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {values.map(({ key, value }) => {
                        const at = row.vitals_component_times?.[key] ?? null;
                        const age = ageLabel(at);
                        return (
                          <li
                            key={key}
                            className="rounded-md border border-border bg-surface-muted px-2 py-1"
                          >
                            <span className="text-xs text-text-secondary">
                              {SHORT[key]}
                            </span>{" "}
                            <span className="text-sm font-medium tabular-nums text-text-primary">
                              {value}
                            </span>
                            {age ? (
                              <span className="ml-1 text-xs text-text-disabled">
                                {age}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>

                    {distinctTimes > 1 ? (
                      <p className="mt-1.5 text-xs text-text-disabled">
                        {t("mixedTimesNote")}
                      </p>
                    ) : null}

                    {row.vitals_notes ? (
                      <p className="mt-2 text-sm text-text-secondary">
                        {row.vitals_notes}
                      </p>
                    ) : null}
                  </>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {row.pending_tasks > 0 ? (
                    <span className="text-sm text-text-secondary">
                      {t("pendingTasks", { count: row.pending_tasks })}
                    </span>
                  ) : null}
                  <div className="ml-auto flex flex-wrap items-center gap-3">
                    <Link
                      href={`/patient/${row.patient_id}`}
                      className="text-sm text-text-secondary underline-offset-4 hover:underline"
                    >
                      {t("openChart")}
                    </Link>
                    <Link
                      href={`/vitals/${row.visit_id}`}
                      className="text-sm font-medium text-accent underline-offset-4 hover:underline"
                    >
                      {t("recordVitals")}
                    </Link>
                    {/* Transfer and "assign a bed at last" are the same RPC, so one
                        control covers both. Label follows whether they have a bed. */}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => togglePanel(row.visit_id, "bed")}
                    >
                      {row.bed_id ? tBeds("transfer") : tBeds("assignBed")}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => togglePanel(row.visit_id, "discharge")}
                    >
                      {tBeds("discharge")}
                    </Button>
                  </div>
                </div>

                {openPanel?.visitId === row.visit_id &&
                openPanel.kind === "bed" ? (
                  <AdmitPanel
                    visitId={row.visit_id}
                    onAdmitted={() => void refresh()}
                    onClose={() => setOpenPanel(null)}
                  />
                ) : null}

                {openPanel?.visitId === row.visit_id &&
                openPanel.kind === "discharge" ? (
                  <DischargePanel
                    visitId={row.visit_id}
                    bedLabel={
                      row.ward_name && row.bed_number
                        ? `${row.ward_name} ${row.bed_number}`
                        : null
                    }
                    pendingTasks={row.pending_tasks}
                    onDischarged={() => void refresh()}
                    onClose={() => setOpenPanel(null)}
                  />
                ) : null}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
