"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Plus, Trash2 } from "lucide-react";

import { Button, Card, Input, Spinner, Textarea } from "@/components/ui";
import { savePrescription } from "@/lib/data/prescriptions";

interface MedRow {
  id: string;
  drug: string;
  dosage: string;
  frequency: string;
  duration: string;
}

type MedField = "drug" | "dosage" | "frequency" | "duration";

// Fixed id for the initial row so server and client render match; added rows
// use a runtime uuid (client-only, so no hydration mismatch).
const INITIAL: MedRow[] = [
  { id: "med-1", drug: "", dosage: "", frequency: "", duration: "" },
];

function newRow(): MedRow {
  return {
    id: crypto.randomUUID(),
    drug: "",
    dosage: "",
    frequency: "",
    duration: "",
  };
}

export default function PrescribePage() {
  const t = useTranslations("prescribe");

  const [meds, setMeds] = useState<MedRow[]>(INITIAL);
  const [advice, setAdvice] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  function updateMed(id: string, field: MedField, value: string) {
    setMeds((prev) =>
      prev.map((med) => (med.id === id ? { ...med, [field]: value } : med)),
    );
  }

  function addMed() {
    setMeds((prev) => [...prev, newRow()]);
  }

  function removeMed(id: string) {
    setMeds((prev) => prev.filter((med) => med.id !== id));
  }

  function resetForm() {
    setMeds(INITIAL);
    setAdvice("");
    setSaved(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!meds.some((med) => med.drug.trim().length > 0)) {
      setFormError(t("atLeastOneMed"));
      return;
    }

    setSubmitting(true);
    const { data, error } = await savePrescription({
      medications: meds
        .filter((med) => med.drug.trim().length > 0)
        .map(({ drug, dosage, frequency, duration }) => ({
          drug: drug.trim(),
          dosage: dosage.trim(),
          frequency: frequency.trim(),
          duration: duration.trim(),
        })),
      advice: advice.trim(),
    });
    setSubmitting(false);

    if (error) {
      setFormError(
        error.code === "NO_MEDICATIONS" ? t("atLeastOneMed") : error.message,
      );
      return;
    }
    if (data) setSaved(true);
  }

  if (saved) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-success/10 p-10 text-center">
          <CheckCircle2 className="h-8 w-8 text-success" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-medium text-text-primary">
              {t("successTitle")}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t("successBody")}
            </p>
          </div>
          <Button size="sm" onClick={resetForm}>
            {t("newPrescription")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
        {meds.map((med, index) => (
          <Card key={med.id}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-text-secondary">
                {t("medication", { number: index + 1 })}
              </p>
              {meds.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeMed(med.id)}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t("remove")}
                </button>
              ) : null}
            </div>
            <div className="mt-3 flex flex-col gap-3">
              <Input
                label={t("drug")}
                placeholder={t("drugPlaceholder")}
                value={med.drug}
                onChange={(event) => updateMed(med.id, "drug", event.target.value)}
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Input
                  label={t("dosage")}
                  placeholder={t("dosagePlaceholder")}
                  value={med.dosage}
                  onChange={(event) =>
                    updateMed(med.id, "dosage", event.target.value)
                  }
                />
                <Input
                  label={t("frequency")}
                  placeholder={t("frequencyPlaceholder")}
                  value={med.frequency}
                  onChange={(event) =>
                    updateMed(med.id, "frequency", event.target.value)
                  }
                />
                <Input
                  label={t("duration")}
                  placeholder={t("durationPlaceholder")}
                  value={med.duration}
                  onChange={(event) =>
                    updateMed(med.id, "duration", event.target.value)
                  }
                />
              </div>
            </div>
          </Card>
        ))}

        <div>
          <Button type="button" variant="secondary" size="sm" onClick={addMed}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("addMedication")}
          </Button>
        </div>

        <Textarea
          label={t("advice")}
          placeholder={t("advicePlaceholder")}
          value={advice}
          onChange={(event) => setAdvice(event.target.value)}
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
          <Button type="submit" disabled={submitting}>
            {submitting ? (
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
    </div>
  );
}
