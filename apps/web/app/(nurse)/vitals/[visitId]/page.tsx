"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";

import { Button, Card, Input, Spinner, Textarea } from "@/components/ui";
import { getSessionUser, type AuthUser } from "@/lib/data/auth";
import {
  getVitalsSeries,
  measurementKeys,
  RANGES,
  recordVitals,
  type MeasurementKey,
  type Vitals,
  type VitalsInput,
} from "@/lib/data/vitals";

type Draft = Record<MeasurementKey, string>;

const EMPTY: Draft = {
  temperature_c: "",
  pulse_bpm: "",
  bp_systolic: "",
  bp_diastolic: "",
  respiratory_rate: "",
  spo2_percent: "",
  blood_glucose: "",
};

/**
 * Vitals entry. **No field is required** — the contract deliberately makes every
 * measurement nullable, because a nurse mid-round often has only some readings, and
 * blocking the save means the rest stays on paper or gets invented.
 *
 * Ranges are still enforced: those catch a slipped decimal (385 for 38.5), which is
 * a typo rather than incomplete data.
 */
export default function VitalsPage() {
  const t = useTranslations("vitals");
  const locale = useLocale();
  const params = useParams<{ visitId: string }>();
  const visitId = params.visitId;

  const [session, setSession] = useState<AuthUser | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [notes, setNotes] = useState("");
  const [recordedAt, setRecordedAt] = useState("");
  const [errors, setErrors] = useState<Partial<Record<MeasurementKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [series, setSeries] = useState<Vitals[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.all([getSessionUser(), getVitalsSeries(visitId)]).then(
      ([user, list]) => {
        if (!active) return;
        setSession(user.data);
        setSeries(list.data ?? []);
      },
    );
    return () => {
      active = false;
    };
  }, [visitId]);

  function update(key: MeasurementKey, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function messageFor(code: string) {
    switch (code) {
      case "23514":
        return t("rangeError");
      case "NETWORK_ERROR":
        return t("networkError");
      case "PERMISSION_DENIED":
        return t("permissionError");
      default:
        return t("genericError");
    }
  }

  /** Range checks only. Emptiness is never an error here. */
  function validate() {
    const next: Partial<Record<MeasurementKey, string>> = {};
    for (const key of measurementKeys) {
      const raw = draft[key].trim();
      if (!raw) continue;
      const value = Number(raw);
      const { min, max } = RANGES[key];
      if (!Number.isFinite(value) || value < min || value > max) {
        next[key] = t("outOfRange", { min, max });
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function buildInput(): VitalsInput {
    const input: VitalsInput = {};
    for (const key of measurementKeys) {
      const raw = draft[key].trim();
      input[key] = raw ? Number(raw) : null;
    }
    if (notes.trim()) input.notes = notes.trim();
    if (recordedAt) input.recorded_at = new Date(recordedAt).toISOString();
    return input;
  }

  const systolic = Number(draft.bp_systolic);
  const diastolic = Number(draft.bp_diastolic);
  // The database deliberately does NOT refuse an inverted pair, so warn here.
  const invertedBp =
    draft.bp_systolic.trim() !== "" &&
    draft.bp_diastolic.trim() !== "" &&
    Number.isFinite(systolic) &&
    Number.isFinite(diastolic) &&
    diastolic > systolic;

  const hasAnything =
    measurementKeys.some((k) => draft[k].trim() !== "") || notes.trim() !== "";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setSaving(true);
    const { error } = await recordVitals(
      visitId,
      session?.tenantId ?? "mock-tenant-1",
      session?.userId ?? "mock-user-1",
      buildInput(),
    );
    setSaving(false);

    if (error) {
      setFormError(messageFor(error.code));
      return;
    }
    setSaved(true);
    setDraft(EMPTY);
    setNotes("");
    setRecordedAt("");
    const refreshed = await getVitalsSeries(visitId);
    setSeries(refreshed.data ?? []);
  }

  const timeFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="mx-auto w-full max-w-lg px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      {saved ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-success/10 p-4">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium text-text-primary">{t("savedTitle")}</p>
            <p className="text-sm text-text-secondary">{t("savedBody")}</p>
          </div>
        </div>
      ) : null}

      <Card className="mt-6">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            {measurementKeys.map((key) => (
              <Input
                key={key}
                label={t(key)}
                type="number"
                inputMode="decimal"
                step="any"
                value={draft[key]}
                onChange={(event) => update(key, event.target.value)}
                error={errors[key]}
              />
            ))}
          </div>

          {invertedBp ? (
            <p className="flex items-start gap-1.5 text-sm text-text-primary">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              {t("invertedBp")}
            </p>
          ) : null}

          <Textarea
            label={t("notes")}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />

          <Input
            label={t("recordedAt")}
            type="datetime-local"
            value={recordedAt}
            onChange={(event) => setRecordedAt(event.target.value)}
            helperText={t("recordedAtHelp")}
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

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={saving || !hasAnything}>
              {saving ? (
                <>
                  <Spinner />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
            {!hasAnything ? (
              <span className="text-sm text-text-disabled">
                {t("nothingEntered")}
              </span>
            ) : null}
          </div>
        </form>
      </Card>

      <section className="mt-6">
        <h2 className="text-lg font-medium">{t("recent")}</h2>
        {series.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">{t("noneYet")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {series.map((row) => {
              // Gaps are expected — plot/print per measurement and skip nulls
              // rather than treating a null as zero.
              const parts = measurementKeys
                .filter((k) => row[k] !== null)
                .map((k) => `${t(k)}: ${row[k]}`);
              return (
                <li
                  key={row.id}
                  className="rounded-md border border-border bg-surface p-3 text-sm"
                >
                  <p className="tabular-nums text-text-secondary">
                    {timeFormat.format(new Date(row.recorded_at))}
                  </p>
                  <p className="mt-1 text-text-primary">
                    {parts.length > 0 ? parts.join(" · ") : "—"}
                  </p>
                  {row.notes ? (
                    <p className="mt-1 text-text-secondary">{row.notes}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
