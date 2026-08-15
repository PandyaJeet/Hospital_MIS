"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, Inbox } from "lucide-react";

import { Button, Card, EmptyState, Skeleton, Spinner } from "@/components/ui";
import {
  createInvoiceForVisit,
  getPendingCharges,
  type PendingVisitGroup,
} from "@/lib/data/billing";
import { formatMoney } from "@/lib/utils/money";

/**
 * Review-and-invoice, not data entry: every line here was captured by a trigger
 * when a consultation started or a prescription was issued (billing.md §1).
 */
export default function ChargesPage() {
  const t = useTranslations("charges");
  const locale = useLocale();
  const router = useRouter();

  const [groups, setGroups] = useState<PendingVisitGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyVisit, setBusyVisit] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getPendingCharges().then((result) => {
      if (!active) return;
      if (result.error) setLoadFailed(true);
      else setGroups(result.data ?? []);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function reload() {
    setLoading(true);
    setLoadFailed(false);
    const result = await getPendingCharges();
    if (result.error) setLoadFailed(true);
    else setGroups(result.data ?? []);
    setLoading(false);
  }

  function messageFor(code: string) {
    switch (code) {
      case "NO_PENDING_CHARGES":
        return t("noPending");
      case "INVOICE_ALREADY_EXISTS":
        return t("alreadyExists");
      case "NOT_BILLING_STAFF":
        return t("notBillingStaff");
      case "VISIT_NOT_FOUND":
        return t("visitNotFound");
      case "NETWORK_ERROR":
        return t("networkError");
      case "PERMISSION_DENIED":
        return t("permissionError");
      default:
        return t("genericError");
    }
  }

  async function onRaise(visitId: string) {
    setActionError(null);
    setBusyVisit(visitId);
    const { data, error } = await createInvoiceForVisit(visitId);
    setBusyVisit(null);

    if (error) {
      // INVOICE_ALREADY_EXISTS carries the existing invoice id — go there rather
      // than showing a dead end (§9).
      const existing = error.fields?.[0];
      if (error.code === "INVOICE_ALREADY_EXISTS" && existing) {
        router.push(`/invoice/${existing}`);
        return;
      }
      setActionError(messageFor(error.code));
      return;
    }
    if (data) router.push(`/invoice/${data.invoice_id}`);
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

      <div className="mt-6 flex flex-col gap-4">
        {loading ? (
          [0, 1].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-2 h-3 w-2/3" />
            </Card>
          ))
        ) : loadFailed ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
            <p className="text-sm text-text-secondary">{t("loadError")}</p>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              {t("retry")}
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={t("empty")}
            description={t("emptyBody")}
          />
        ) : (
          groups.map((group) => (
            <Card key={group.visit_id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-medium text-text-primary">
                    {group.patient_name}
                  </p>
                  <p className="text-sm tabular-nums text-text-secondary">
                    {group.patient_number !== null
                      ? t("uhid", { number: group.patient_number })
                      : null}
                    {group.queue_number !== null
                      ? ` · ${t("token", { number: group.queue_number })}`
                      : ""}
                  </p>
                </div>
              </div>

              <ul className="mt-3 flex flex-col gap-2">
                {group.lines.map((line) => (
                  <li
                    key={line.id}
                    className="flex items-start justify-between gap-3 border-t border-border pt-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="text-text-primary">{line.description}</p>
                      <p className="text-xs text-text-secondary">
                        {line.quantity} × {formatMoney(line.unit_amount, locale)}
                        {line.is_auto ? ` · ${t("auto")}` : ` · ${t("manual")}`}
                      </p>
                    </div>
                    <span className="shrink-0 tabular-nums text-text-primary">
                      {formatMoney(line.amount, locale)}
                    </span>
                  </li>
                ))}
              </ul>

              {group.has_unpriced ? (
                <p className="mt-3 flex items-start gap-1.5 text-sm text-text-primary">
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  {t("unpriced")}
                </p>
              ) : null}

              <dl className="mt-3 flex flex-col gap-1 border-t border-border pt-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-text-secondary">{t("subtotal")}</dt>
                  <dd className="tabular-nums">
                    {formatMoney(group.subtotal, locale)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-secondary">{t("tax")}</dt>
                  <dd className="tabular-nums">
                    {formatMoney(group.tax_total, locale)}
                  </dd>
                </div>
                <div className="flex justify-between font-medium">
                  <dt>{t("total")}</dt>
                  <dd className="tabular-nums">
                    {formatMoney(group.grand_total, locale)}
                  </dd>
                </div>
              </dl>

              <div className="mt-4 flex justify-end">
                <Button
                  size="sm"
                  disabled={busyVisit !== null}
                  onClick={() => void onRaise(group.visit_id)}
                >
                  {busyVisit === group.visit_id ? (
                    <>
                      <Spinner />
                      {t("raising")}
                    </>
                  ) : (
                    t("raiseInvoice")
                  )}
                </Button>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
