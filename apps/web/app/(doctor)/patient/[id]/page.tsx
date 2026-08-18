import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AlertTriangle } from "lucide-react";

import { Badge, Card } from "@/components/ui";
import { getPatient } from "@/lib/data/patient-chart";

export default async function PatientChartPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("chart");
  const { data: patient, error } = await getPatient(id);

  if (error || !patient) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-10 text-center">
          <h1 className="text-lg font-medium text-text-primary">
            {t("notFoundTitle")}
          </h1>
          <p className="text-sm text-text-secondary">{t("notFoundBody")}</p>
          <Link
            href="/queue"
            className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t("backToQueue")}
          </Link>
        </div>
      </div>
    );
  }

  const locale = await getLocale();
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <Card>
        <h1 className="text-2xl font-semibold">{patient.fullName}</h1>
        <p className="mt-1 text-sm tabular-nums text-text-secondary">
          {t("years", { age: patient.age })} · {patient.phone}
        </p>

        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
            {t("allergies")}
          </p>
          {patient.allergies.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {patient.allergies.map((allergy) => (
                <Badge key={allergy} tone="critical">
                  <AlertTriangle
                    className="mr-1 h-3 w-3"
                    aria-hidden="true"
                  />
                  {allergy}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-sm text-text-secondary">
              {t("noAllergies")}
            </p>
          )}
        </div>
      </Card>

      <section className="mt-6">
        <h2 className="text-lg font-medium">{t("history")}</h2>
        {patient.visits.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3">
            {patient.visits.map((visit) => (
              <li key={visit.id}>
                <Card>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-medium text-text-primary">
                      {visit.reason}
                    </p>
                    <p className="shrink-0 text-sm tabular-nums text-text-secondary">
                      {dateFormat.format(new Date(visit.date))}
                    </p>
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">
                    {visit.note}
                  </p>
                  <p className="mt-2 text-xs text-text-disabled">
                    {visit.doctorName}
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-text-secondary">{t("noHistory")}</p>
        )}
      </section>
    </div>
  );
}
