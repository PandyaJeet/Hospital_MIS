"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";

import { Button, Card, Input, Spinner } from "@/components/ui";
import {
  getTenantSettings,
  updateTenantSettings,
  type TenantSettings,
} from "@/lib/data/admin";

/**
 * Clinic billing settings. `gst_registered` is the consequential one: it decides
 * whether every future invoice is a TAX INVOICE or a BILL OF SUPPLY, and it cannot
 * be derived from code — it depends on the clinic's turnover and registration
 * (billing.md §2). `tier` is shown read-only because it is a platform entitlement,
 * not a clinic-editable fact.
 */
export default function SettingsPage() {
  const t = useTranslations("settings");

  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [gstRegistered, setGstRegistered] = useState(false);
  const [gstin, setGstin] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [fee, setFee] = useState("");
  const [gstinError, setGstinError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function hydrate(next: TenantSettings) {
    setSettings(next);
    setGstRegistered(next.gst_registered);
    setGstin(next.gstin ?? "");
    setStateCode(next.gst_state_code ?? "");
    setFee(String(next.default_consultation_fee));
  }

  useEffect(() => {
    let active = true;
    void getTenantSettings().then((result) => {
      if (!active) return;
      if (result.error || !result.data) setLoadFailed(true);
      else hydrate(result.data);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  function messageFor(code: string) {
    switch (code) {
      case "NETWORK_ERROR":
        return t("networkError");
      case "PERMISSION_DENIED":
      case "42501":
        return t("permissionError");
      default:
        return t("genericError");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setGstinError(undefined);
    setSaved(false);

    // Mirror the DB constraint so the user finds out before the round trip.
    if (gstRegistered && !gstin.trim()) {
      setGstinError(t("gstinRequired"));
      return;
    }

    setSaving(true);
    const { data, error } = await updateTenantSettings({
      gst_registered: gstRegistered,
      gstin: gstin.trim() || null,
      gst_state_code: stateCode.trim() || null,
      default_consultation_fee: Number(fee) || 0,
    });
    setSaving(false);

    if (error) {
      if (error.fields?.includes("gstin")) setGstinError(t("gstinRequired"));
      else setFormError(messageFor(error.code));
      return;
    }
    if (data) hydrate(data);
    setSaved(true);
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-lg px-6 py-8">
        <Spinner className="h-5 w-5 text-accent" />
      </div>
    );
  }

  if (loadFailed || !settings) {
    return (
      <div className="mx-auto w-full max-w-lg px-6 py-8">
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
          <p className="text-sm text-text-secondary">{t("loadError")}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.location.reload()}
          >
            {t("retry")}
          </Button>
        </div>
      </div>
    );
  }

  const willChangeGst = gstRegistered !== settings.gst_registered;

  return (
    <div className="mx-auto w-full max-w-lg px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      {saved ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-success/10 p-3">
          <CheckCircle2
            className="h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-text-primary">
            {t("savedTitle")}
          </p>
        </div>
      ) : null}

      <Card className="mt-6">
        <dl className="flex flex-col gap-3 border-b border-border pb-4 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-text-secondary">{t("clinicName")}</dt>
            <dd className="font-medium text-text-primary">{settings.name}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-text-secondary">{t("tier")}</dt>
            <dd className="text-right">
              <span className="font-medium tabular-nums text-text-primary">
                {settings.tier}
              </span>
              <span className="block text-xs text-text-disabled">
                {t("tierNote")}
              </span>
            </dd>
          </div>
        </dl>

        <form onSubmit={onSubmit} noValidate className="mt-4 flex flex-col gap-4">
          <h2 className="font-medium text-text-primary">{t("gstTitle")}</h2>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={gstRegistered}
              onChange={(event) => setGstRegistered(event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 rounded border-border text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <span>
              <span className="text-sm font-medium text-text-primary">
                {t("gstRegistered")}
              </span>
              <span className="block text-sm text-text-secondary">
                {t("gstRegisteredHelp")}
              </span>
            </span>
          </label>

          {/* Only warn when the posture is actually changing. */}
          {willChangeGst ? (
            <div className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-3">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <p className="text-sm text-text-primary">{t("gstWarning")}</p>
            </div>
          ) : null}

          <Input
            label={t("gstin")}
            value={gstin}
            onChange={(event) => setGstin(event.target.value.toUpperCase())}
            error={gstinError}
          />
          <Input
            label={t("gstStateCode")}
            value={stateCode}
            inputMode="numeric"
            onChange={(event) => setStateCode(event.target.value)}
          />
          <Input
            label={t("defaultFee")}
            type="number"
            inputMode="decimal"
            value={fee}
            onChange={(event) => setFee(event.target.value)}
            helperText={t("defaultFeeHelp")}
          />

          {formError ? (
            <p
              role="alert"
              className="flex items-center gap-1.5 text-sm text-text-secondary"
            >
              <AlertCircle
                className="h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              {formError}
            </p>
          ) : null}

          <div>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Spinner />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
