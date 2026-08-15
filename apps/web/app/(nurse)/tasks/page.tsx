"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle, ClipboardCheck, Clock } from "lucide-react";

import { Badge, Button, Card, EmptyState, Skeleton, Spinner } from "@/components/ui";
import { useTasks } from "@/hooks/use-tasks";
import {
  cancelTask,
  claimTask,
  completeTask,
  isOverdue,
  type Task,
} from "@/lib/data/tasks";

/**
 * Card board, not a data table (Design.md §8) — quick visual triage of what's due.
 * Overdue is computed at read time; nothing stores it.
 */
export default function TasksPage() {
  const t = useTranslations("tasks");
  const { tasks, loading, error, refresh, fetchedAt } = useTasks();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<"complete" | "cancel" | "claim" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  function messageFor(code: string) {
    switch (code) {
      case "TASK_ALREADY_DONE":
        return t("alreadyDone");
      case "TASK_CANCELLED":
        return t("taskCancelled");
      case "TASK_NOT_FOUND":
        return t("notFound");
      case "NOT_CLINICAL_STAFF":
        return t("notClinicalStaff");
      case "NETWORK_ERROR":
        return t("networkError");
      case "PERMISSION_DENIED":
        return t("permissionError");
      default:
        return t("genericError");
    }
  }

  async function run(
    task: Task,
    kind: "complete" | "cancel" | "claim",
  ): Promise<void> {
    setActionError(null);
    setBusyId(task.id);
    setBusyKind(kind);

    const result =
      kind === "complete"
        ? await completeTask(task.id)
        : kind === "cancel"
          ? await cancelTask(task.id)
          : await claimTask(task.id, "mock-user-1");

    setBusyId(null);
    setBusyKind(null);

    if (result.error) {
      setActionError(messageFor(result.error.code));
      return;
    }
    await refresh();
  }

  /** `custom` carries its own label; every other type is self-describing. */
  function labelFor(task: Task) {
    if (task.task_type === "custom") {
      return task.title ?? t("type.custom");
    }
    return task.title ?? t(`type.${task.task_type}`);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

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

      <div className="mt-6 flex flex-col gap-3">
        {loading ? (
          [0, 1, 2].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-48" />
              <Skeleton className="mt-2 h-3 w-32" />
            </Card>
          ))
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
            <p className="text-sm text-text-secondary">{t("loadError")}</p>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              {t("retry")}
            </Button>
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title={t("empty")}
            description={t("emptyBody")}
          />
        ) : (
          tasks.map((task) => {
            const overdue = isOverdue(task, fetchedAt);
            const deltaMin = Math.abs(
              Math.round((new Date(task.due_at).getTime() - fetchedAt) / 60000),
            );
            const busy = busyId === task.id;

            return (
              <Card key={task.id} className={overdue ? "border-warning" : ""}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">
                      {labelFor(task)}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-sm text-text-secondary">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      {deltaMin === 0
                        ? t("dueNow")
                        : overdue
                          ? t("overdue", { minutes: deltaMin })
                          : t("dueIn", { minutes: deltaMin })}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Badge tone={task.task_type === "custom" ? "neutral" : "accent"}>
                      {t(`type.${task.task_type}`)}
                    </Badge>
                    {task.assigned_to === null ? (
                      <Badge tone="warning">{t("unclaimed")}</Badge>
                    ) : (
                      <Badge tone="success">{t("claimed")}</Badge>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {/* Recording the observation IS doing the task — the server closes
                      the card, so we don't ask the nurse to tick a second thing. */}
                  {task.task_type === "vitals_due" ? (
                    <Link
                      href={`/vitals/${task.visit_id}`}
                      className="text-sm font-medium text-accent underline-offset-4 hover:underline"
                    >
                      {t("recordVitals")}
                    </Link>
                  ) : null}

                  {task.assigned_to === null ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void run(task, "claim")}
                    >
                      {busy && busyKind === "claim" ? (
                        <>
                          <Spinner />
                          {t("claiming")}
                        </>
                      ) : (
                        t("claim")
                      )}
                    </Button>
                  ) : null}

                  <div className="ml-auto flex items-center gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(task, "cancel")}
                      className="text-sm text-text-secondary underline-offset-4 hover:underline disabled:opacity-50"
                    >
                      {busy && busyKind === "cancel"
                        ? t("cancelling")
                        : t("cancel")}
                    </button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(task, "complete")}
                    >
                      {busy && busyKind === "complete" ? (
                        <>
                          <Spinner />
                          {t("completing")}
                        </>
                      ) : (
                        t("complete")
                      )}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
