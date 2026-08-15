"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  Input,
  Spinner,
  type BadgeProps,
} from "@/components/ui";
import {
  getInvoice,
  paymentModes,
  recordPayment,
  type InvoiceDetail,
  type InvoiceStatus,
  type PaymentMode,
  type TaxCategory,
} from "@/lib/data/billing";
import { formatMoney } from "@/lib/utils/money";
import { cn } from "@/lib/utils/cn";

const statusTone: Record<InvoiceStatus, NonNullable<BadgeProps["tone"]>> = {
  draft: "warning",
  issued: "info",
  paid: "success",
  cancelled: "neutral",
};

const categoryKey: Record<TaxCategory, string> = {
  exempt: "categoryExempt",
  taxable: "categoryTaxable",
  nil_rated: "categoryNilRated",
  non_gst: "categoryNonGst",
};

const modeKey: Record<PaymentMode, string> = {
  cash: "modeCash",
  upi: "modeUpi",
  card: "modeCard",
  insurance: "modeInsurance",
  other: "modeOther",
};

export default function InvoicePage() {
  const t = useTranslations("invoice");
  const locale = useLocale();
  const params = useParams<{ id: string }>();
  const invoiceId = params.id;

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [amountError, setAmountError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getInvoice(invoiceId).then((result) => {
      if (!active) return;
      if (result.error || !result.data) setNotFound(true);
      else setInvoice(result.data);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [invoiceId]);

  function messageFor(code: string) {
    switch (code) {
      case "INVOICE_NOT_FOUND":
        return t("notFound");
      case "NETWORK_ERROR":
        return t("networkError");
      case "PERMISSION_DENIED":
        return t("permissionError");
      default:
        return t("genericError");
    }
  }

  async function onPay() {
    if (!invoice) return;
    setActionError(null);
    setAmountError(undefined);
    const value = Number(amount || invoice.grand_total);
    if (!Number.isFinite(value) || value <= 0) {
      setAmountError(t("invalidAmount"));
      return;
    }
    setSaving(true);
    const { error } = await recordPayment(invoice.id, value, mode);
    setSaving(false);
    if (error) {
      setActionError(messageFor(error.code));
      return;
    }
    const refreshed = await getInvoice(invoice.id);
    if (refreshed.data) setInvoice(refreshed.data);
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <Spinner className="h-5 w-5 text-accent" />
      </div>
    );
  }

  if (notFound || !invoice) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-10 text-center">
          <p className="text-text-primary">{t("notFound")}</p>
          <Link
            href="/charges"
            className="text-sm font-medium text-accent underline-offset-4 hover:underline"
          >
            {t("back")}
          </Link>
        </div>
      </div>
    );
  }

  const hasUnpriced = invoice.lines.some((l) => l.amount === 0);

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <Link
        href="/charges"
        className="text-sm text-text-secondary underline-offset-4 hover:underline"
      >
        {t("back")}
      </Link>

      <Card className="mt-4">
        {/* The document's legal nature comes from is_gst_invoice, which was
            snapshotted at creation — never from the tenant's current state (§4). */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <h1 className="text-xl font-semibold">
              {invoice.is_gst_invoice ? t("taxInvoice") : t("billOfSupply")}
            </h1>
            <p className="mt-1 text-sm tabular-nums text-text-secondary">
              {t("number", { number: invoice.invoice_number })}
            </p>
            {invoice.is_gst_invoice && invoice.gstin_snapshot ? (
              <p className="text-sm tabular-nums text-text-secondary">
                {t("gstin", { gstin: invoice.gstin_snapshot })}
              </p>
            ) : null}
            {!invoice.is_gst_invoice ? (
              <p className="mt-1 text-sm text-text-secondary">
                {t("notRegistered")}
              </p>
            ) : null}
          </div>
          <Badge tone={statusTone[invoice.status]}>
            {t(
              `status${invoice.status.charAt(0).toUpperCase()}${invoice.status.slice(1)}`,
            )}
          </Badge>
        </div>

        <div className="border-b border-border py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
            {t("patient")}
          </p>
          <p className="mt-1 font-medium text-text-primary">
            {invoice.patient_name}
          </p>
          {invoice.patient_number !== null ? (
            <p className="text-sm tabular-nums text-text-secondary">
              {t("uhid", { number: invoice.patient_number })}
            </p>
          ) : null}
        </div>

        <div className="overflow-x-auto py-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-secondary">
                <th className="pb-2 font-medium">{t("description")}</th>
                <th className="pb-2 text-right font-medium">{t("qty")}</th>
                <th className="pb-2 text-right font-medium">{t("rate")}</th>
                {invoice.is_gst_invoice ? (
                  <th className="pb-2 text-right font-medium">
                    {t("taxColumn")}
                  </th>
                ) : null}
                <th className="pb-2 text-right font-medium">{t("amount")}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line, index) => (
                <tr
                  key={`${line.description}-${index}`}
                  className="border-t border-border"
                >
                  <td className="py-2 text-text-primary">
                    {line.description}
                    {line.hsn_sac_code ? (
                      <span className="block text-xs text-text-disabled">
                        {t("hsn")} {line.hsn_sac_code}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {line.quantity}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(line.unit_amount, locale)}
                  </td>
                  {/* Per-line tax. There is no invoice-level rate to show. */}
                  {invoice.is_gst_invoice ? (
                    <td className="py-2 text-right tabular-nums text-text-secondary">
                      {line.tax_rate > 0
                        ? `${line.tax_rate}% · ${formatMoney(line.tax_amount, locale)}`
                        : t(categoryKey[line.tax_category])}
                    </td>
                  ) : null}
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(line.amount, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {hasUnpriced ? (
          <p className="flex items-start gap-1.5 pb-4 text-sm text-text-primary">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            {t("unpricedNote")}
          </p>
        ) : null}

        {/* Rate-wise summary, rendered only for a GST invoice. It is empty for a
            non-registered clinic, and that emptiness is the point (§2, §4). */}
        {invoice.is_gst_invoice && invoice.tax_summary.length > 0 ? (
          <div className="border-t border-border py-4">
            <p className="font-medium text-text-primary">{t("taxSummary")}</p>
            <p className="text-xs text-text-secondary">{t("taxSummaryNote")}</p>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-text-secondary">
                  <th className="pb-1 font-medium">{t("category")}</th>
                  <th className="pb-1 text-right font-medium">{t("rate")}</th>
                  <th className="pb-1 text-right font-medium">
                    {t("taxableAmount")}
                  </th>
                  <th className="pb-1 text-right font-medium">
                    {t("taxColumn")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoice.tax_summary.map((row) => (
                  <tr
                    key={`${row.tax_category}-${row.tax_rate}`}
                    className="border-t border-border"
                  >
                    <td className="py-1.5">{t(categoryKey[row.tax_category])}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {row.tax_rate}%
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatMoney(row.taxable_amount, locale)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatMoney(row.tax_amount, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <dl className="flex flex-col gap-1 border-t border-border pt-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-text-secondary">{t("subtotal")}</dt>
            <dd className="tabular-nums">
              {formatMoney(invoice.subtotal, locale)}
            </dd>
          </div>
          {invoice.is_gst_invoice ? (
            <div className="flex justify-between">
              <dt className="text-text-secondary">{t("taxTotal")}</dt>
              <dd className="tabular-nums">
                {formatMoney(invoice.tax_total, locale)}
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between text-base font-semibold">
            <dt>{t("grandTotal")}</dt>
            <dd className="tabular-nums">
              {formatMoney(invoice.grand_total, locale)}
            </dd>
          </div>
        </dl>
      </Card>

      {invoice.status === "paid" ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-success/10 p-4">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <p className="text-sm text-text-primary">
            {t("paidNotice", {
              amount: formatMoney(invoice.amount_paid, locale),
              mode: invoice.payment_mode
                ? t(modeKey[invoice.payment_mode])
                : "",
            })}
          </p>
        </div>
      ) : invoice.status !== "cancelled" ? (
        <Card className="mt-4">
          <h2 className="font-medium text-text-primary">
            {t("recordPayment")}
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t("amountPaid")}
              type="number"
              inputMode="decimal"
              placeholder={String(invoice.grand_total)}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              error={amountError}
            />
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="payment-mode"
                className="text-sm font-medium text-text-primary"
              >
                {t("paymentMode")}
              </label>
              <select
                id="payment-mode"
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value as PaymentMode)
                }
                className={cn(
                  "h-11 rounded-md border border-border bg-surface px-3 text-base text-text-primary",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                )}
              >
                {paymentModes.map((m) => (
                  <option key={m} value={m}>
                    {t(modeKey[m])}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {actionError ? (
            <p
              role="alert"
              className="mt-3 flex items-center gap-1.5 text-sm text-text-secondary"
            >
              <AlertCircle
                className="h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              {actionError}
            </p>
          ) : null}

          <div className="mt-4">
            <Button disabled={saving} onClick={() => void onPay()}>
              {saving ? (
                <>
                  <Spinner />
                  {t("saving")}
                </>
              ) : (
                t("markPaid")
              )}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
