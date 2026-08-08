"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Inbox } from "lucide-react";

import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  type BadgeProps,
} from "@/components/ui";
import { useQueue } from "@/hooks/use-queue";
import type { QueueStatus } from "@/lib/data/queue";

const statusTone: Record<QueueStatus, NonNullable<BadgeProps["tone"]>> = {
  waiting: "warning",
  in_consultation: "info",
  done: "success",
};

export default function QueuePage() {
  const t = useTranslations("queue");
  const router = useRouter();
  const { entries, loading, error, refresh } = useQueue();

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
            {entries.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/patient/${entry.id}`}
                  className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-sm font-semibold tabular-nums text-accent">
                    {entry.tokenNumber}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-text-primary">
                      {entry.patientName}
                    </p>
                    <p className="text-sm tabular-nums text-text-secondary">
                      {t("years", { age: entry.age })}
                      {entry.status === "waiting"
                        ? ` · ${t("waitMinutes", { minutes: entry.waitMinutes })}`
                        : ""}
                    </p>
                  </div>
                  <Badge tone={statusTone[entry.status]}>
                    {t(`status.${entry.status}`)}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
