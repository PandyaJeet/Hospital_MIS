"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search, UserSearch } from "lucide-react";

import { CheckInButton } from "@/components/shared/check-in-button";
import { Button, Card, EmptyState, Input, Skeleton } from "@/components/ui";
import { searchPatients, type PatientMatch } from "@/lib/data/patients";
import type { AppError } from "@/lib/data/types";

/** One search's outcome, tagged with the term it answers. */
interface Answer {
  term: string;
  rows: PatientMatch[];
  error: AppError | null;
}

/**
 * Patient lookup, and the second half of the front-desk job: finding a returning
 * patient and putting them in today's queue.
 *
 * The header search box submits here, so `?q=` is the single source of truth
 * rather than component state. That makes a result linkable, survives a refresh,
 * and means arriving from the header and typing here behave identically.
 */
export default function PatientsPage() {
  const t = useTranslations("patients");
  const router = useRouter();
  const params = useSearchParams();
  const query = (params.get("q") ?? "").trim();

  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (!query) return;
    let active = true;
    void searchPatients(query).then((result) => {
      if (!active) return;
      setAnswer({
        term: query,
        rows: result.data ?? [],
        error: result.error,
      });
    });
    return () => {
      active = false;
    };
  }, [query]);

  // Derived rather than stored, so the effect never sets state synchronously and
  // a stale result can't be shown as though it answered the current term.
  const loading = query !== "" && answer?.term !== query;
  const rows = answer?.term === query ? answer.rows : [];
  const error = answer?.term === query ? answer.error : null;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entered = String(
      new FormData(event.currentTarget).get("q") ?? "",
    ).trim();
    if (!entered) return;
    router.push(`/patients?q=${encodeURIComponent(entered)}`);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      <Card className="mt-6">
        <form onSubmit={submit} className="flex items-end gap-3">
          <div className="flex-1">
            {/* Uncontrolled, keyed on the query so navigating re-seeds it. */}
            <Input
              key={query}
              name="q"
              label={t("searchLabel")}
              defaultValue={query}
              autoFocus
              autoComplete="off"
              helperText={t("searchHelp")}
            />
          </div>
          <Button type="submit">
            <Search className="h-4 w-4" aria-hidden="true" />
            {t("search")}
          </Button>
        </form>
      </Card>

      <div className="mt-6">
        {loading ? (
          <div className="flex flex-col gap-3">
            {[0, 1].map((i) => (
              <Card key={i}>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-2 h-3 w-24" />
              </Card>
            ))}
          </div>
        ) : error ? (
          <div className="rounded-lg border border-dashed border-border bg-surface p-8 text-center">
            <p className="text-sm text-text-secondary">{t("loadError")}</p>
          </div>
        ) : !query ? (
          <EmptyState
            icon={UserSearch}
            title={t("promptTitle")}
            description={t("promptBody")}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={UserSearch}
            title={t("noResults")}
            description={t("noResultsBody")}
            action={
              <Button size="sm" onClick={() => router.push("/register")}>
                {t("registerCta")}
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((patient) => (
              <li key={patient.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/patient/${patient.id}`}
                        className="font-medium text-text-primary underline-offset-4 hover:underline"
                      >
                        {patient.full_name}
                      </Link>
                      <p className="text-sm tabular-nums text-text-secondary">
                        {t("uhid", { number: patient.patient_number })}
                        {patient.age_years !== null
                          ? ` · ${t("years", { age: patient.age_years })}`
                          : ""}
                        {patient.phone ? ` · ${patient.phone}` : ""}
                      </p>
                    </div>
                    {/* A returning patient is a follow-up. A repeat check-in is
                        idempotent server-side, so this cannot double-token. */}
                    <CheckInButton
                      patientId={patient.id}
                      visitType="follow_up"
                      size="sm"
                      variant="secondary"
                    />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
