"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, Inbox } from "lucide-react";

import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Spinner,
  type BadgeProps,
} from "@/components/ui";
import { useQueue } from "@/hooks/use-queue";
import {
  setVisitStatus,
  waitSeconds,
  type QueueEntry,
  type VisitStatus,
} from "@/lib/data/queue";

const statusTone: Record<VisitStatus, NonNullable<BadgeProps["tone"]>> = {
  queued: "warning",
  in_consultation: "info",
  done: "success",
  cancelled: "neutral",
};

export default function QueuePage() {
  const t = useTranslations("queue");
  const tNav = useTranslations("nav");
  const router = useRouter();
  const { entries, loading, error, refresh, fetchedAt } = useQueue();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function messageFor(code: string, from?: VisitStatus, to?: VisitStatus) {
    switch (code) {
      case "INVALID_STATUS_TRANSITION":
        return t("invalidTransition", {
          from: from ? t(`status.${from}`) : "",
          to: to ? t(`status.${to}`) : "",
        });
      case "VISIT_NOT_FOUND":
        return t("visitNotFound");
      case "NOT_STAFF":
        return t("notStaff");
      case "NETWORK_ERROR":
        return t("networkError");
      case "PERMISSION_DENIED":
        return t("permissionError");
      default:
        return t("genericError");
    }
  }

  async function advance(entry: QueueEntry, to: VisitStatus) {
    setActionError(null);
    setBusyId(entry.id);
    const { error: err } = await setVisitStatus(entry.id, to);
    setBusyId(null);

    if (err) {
      // The mock carries [from, to] in `fields`; the real RPC returns them as
      // named properties, which fromRpc keeps on the error message.
      const [from, attempted] = err.fields ?? [];
      setActionError(
        messageFor(
          err.code,
          (from as VisitStatus) ?? entry.status,
          (attempted as VisitStatus) ?? to,
        ),
      );
      return;
    }
    await refresh();
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>
        </div>
        {!loading && !error && entries.length > 0 ? (
          <span className="shrink-0 text-sm tabular-nums text-text-secondary">
            {t("count", { count: entries.length })}
          </span>
        ) : null}
      </div>

      {actionError ? (
        <p
          role="alert"
          className="mt-4 flex items-center gap-1.5 text-sm text-text-secondary"
        >
          <AlertCircle
            className="h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          {actionError}
        </p>
      ) : null}

      <div className="mt-6">
        {loading ? (
          <ul className="flex flex-col gap-3">
            {[0, 1, 2].map((index) => (
              <li
                key={index}
                className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4"
              >
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-5 w-20" />
              </li>
            ))}
          </ul>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
            <p className="text-sm text-text-secondary">{t("loadError")}</p>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              {t("retry")}
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={t("empty")}
            description={t("emptyBody")}
            action={
              <Button size="sm" onClick={() => router.push("/register")}>
                {t("registerCta")}
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {entries.map((entry) => {
              const minutes = Math.floor(waitSeconds(entry, fetchedAt) / 60);
              const waiting = entry.status === "queued";
              const to: VisitStatus = waiting ? "in_consultation" : "done";
              const busy = busyId === entry.id;

              return (
                <li
                  key={entry.id}
                  className="rounded-lg border border-border bg-surface p-4"
                >
                  <div className="flex items-start gap-4">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-sm font-semibold tabular-nums text-accent">
                      {entry.queue_number}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/patient/${entry.patient.id}`}
                          className="truncate font-medium text-text-primary underline-offset-4 hover:underline"
                        >
                          {entry.patient.full_name}
                        </Link>
                        {entry.visit_type === "follow_up" ? (
                          <Badge tone="accent">{t("followUp")}</Badge>
                        ) : null}
                      </div>
                      <p className="text-sm tabular-nums text-text-secondary">
                        {t("uhid", { number: entry.patient.patient_number })}
                        {entry.patient.age_years !== null
                          ? ` · ${t("years", { age: entry.patient.age_years })}`
                          : ""}
                        {" · "}
                        {waiting
                          ? t("waitMinutes", { minutes })
                          : t("waitedMinutes", { minutes })}
                      </p>

                      {/* An allergy is genuine clinical urgency — the one place
                          Design.md §2 permits red. */}
                      {entry.patient.allergies ? (
                        <p className="mt-1.5 flex items-start gap-1.5 text-sm text-critical">
                          <AlertTriangle
                            className="mt-0.5 h-4 w-4 shrink-0"
                            aria-hidden="true"
                          />
                          <span>
                            <span className="font-medium">
                              {t("allergyLabel")}:
                            </span>{" "}
                            {entry.patient.allergies}
                          </span>
                        </p>
                      ) : null}
                    </div>

                    <Badge tone={statusTone[entry.status]}>
                      {t(`status.${entry.status}`)}
                    </Badge>
                  </div>

                  <div className="mt-3 flex items-center justify-end gap-3">
                    {!waiting ? (
                      <>
                        <Link
                          href={`/consult/${entry.id}`}
                          className="text-sm font-medium text-accent underline-offset-4 hover:underline"
                        >
                          {t("consultAction")}
                        </Link>
                        <Link
                          href={`/prescribe/${entry.id}`}
                          className="text-sm font-medium text-accent underline-offset-4 hover:underline"
                        >
                          {tNav("prescribe")}
                        </Link>
                      </>
                    ) : null}
                    <Button
                      size="sm"
                      variant={waiting ? "primary" : "secondary"}
                      disabled={busy}
                      onClick={() => void advance(entry, to)}
                    >
                      {busy ? (
                        <>
                          <Spinner />
                          {t("updating")}
                        </>
                      ) : waiting ? (
                        t("startConsultation")
                      ) : (
                        t("markDone")
                      )}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
