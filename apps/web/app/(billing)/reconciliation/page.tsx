"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, Info } from "lucide-react";

import { Badge, Button, Card, Skeleton, type BadgeProps } from "@/components/ui";
import {
  getReconciliationFindings,
  type ReconciliationFinding,
  type ReconciliationSeverity,
} from "@/lib/data/reporting";
import { formatMoney } from "@/lib/utils/money";

const severityTone: Record<
  ReconciliationSeverity,
  NonNullable<BadgeProps["tone"]>
> = {
  high: "critical",
  warning: "warning",
  info: "neutral",
};

const severityKey: Record<ReconciliationSeverity, string> = {
  high: "severityHigh",
  warning: "severityWarning",
  info: "severityInfo",
};

const severityOrder: Record<ReconciliationSeverity, number> = {
  high: 0,
  warning: 1,
  info: 2,
};

/**
 * Reconciliation — `admin-dashboard.md` §8. One row per finding, worst first.
 *
 * **Read-only: it reports, it does not correct.** Adjusting money without a human
 * deciding what correct means is not a reporting layer's job.
 */
export default function ReconciliationPage() {
  const t = useTranslations("reconciliation");
  const locale = useLocale();

  const [findings, setFindings] = useState<ReconciliationFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    let active = true;
    void getReconciliationFindings().then((result) => {
      if (!active) return;
      if (result.error) setFailed(true);
      else setFindings(result.data ?? []);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  // Default to warning and above. `info` is available so the list is complete,
  // but routine open charges beside a broken invoice hide the broken invoice.
  const visible = (showInfo ? findings : findings.filter((f) => f.severity !== "info"))
    .slice()
    .sort(
      (a, b) =>
        severityOrder[a.severity] - severityOrder[b.severity] ||
        (b.age_hours ?? 0) - (a.age_hours ?? 0),
    );

  const hiddenCount = findings.length - findings.filter((f) => f.severity !== "info").length;

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>
      <p className="mt-2 flex items-start gap-1.5 text-xs text-text-secondary">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("readOnlyNote")}
      </p>

      {loading ? (
        <div className="mt-6 flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-2 h-3 w-full" />
            </Card>
          ))}
        </div>
      ) : failed ? (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
          <p className="text-sm text-text-secondary">{t("loadError")}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.location.reload()}
          >
            {t("retry")}
          </Button>
        </div>
      ) : (
        <>
          {hiddenCount > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setShowInfo((v) => !v)}
                className="text-sm font-medium text-accent underline-offset-4 hover:underline"
              >
                {showInfo ? t("hideInfo") : t("showAll")}
              </button>
              {!showInfo ? (
                <span className="text-xs text-text-secondary">
                  {t("infoHiddenNote")}
                </span>
              ) : null}
            </div>
          ) : null}

          {visible.length === 0 ? (
            <div className="mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-surface p-10 text-center">
              <CheckCircle2 className="h-6 w-6 text-success" aria-hidden="true" />
              <p className="font-medium text-text-primary">{t("empty")}</p>
              <p className="text-sm text-text-secondary">{t("emptyBody")}</p>
            </div>
          ) : (
            <ul className="mt-4 flex flex-col gap-3">
              {visible.map((finding) => (
                <li key={`${finding.table_name}-${finding.row_id}`}>
                  <Card
                    className={
                      finding.severity === "high" ? "border-critical" : ""
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={severityTone[finding.severity]}>
                        {t(severityKey[finding.severity])}
                      </Badge>
                      <span className="text-sm font-medium text-text-primary">
                        {t(`type.${finding.finding_type}`)}
                      </span>
                      {finding.invoice_number !== null ? (
                        <span className="text-sm tabular-nums text-text-secondary">
                          {t("invoiceNo", { number: finding.invoice_number })}
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-2 text-sm text-text-primary">
                      {finding.detail}
                    </p>

                    <p className="mt-1 text-sm tabular-nums text-text-secondary">
                      {finding.amount_at_stake !== null
                        ? t("atStake", {
                            amount: formatMoney(finding.amount_at_stake, locale),
                          })
                        : ""}
                      {finding.expected_amount !== null
                        ? ` · ${t("expected", {
                            amount: formatMoney(finding.expected_amount, locale),
                          })}`
                        : ""}
                      {finding.age_hours !== null
                        ? ` · ${t("age", { hours: Math.round(finding.age_hours) })}`
                        : ""}
                    </p>

                    {finding.invoice_id ? (
                      <div className="mt-3">
                        <Link
                          href={`/invoice/${finding.invoice_id}`}
                          className="text-sm font-medium text-accent underline-offset-4 hover:underline"
                        >
                          {t("openInvoice")}
                        </Link>
                      </div>
                    ) : null}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
