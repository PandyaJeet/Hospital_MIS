"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2 } from "lucide-react";

import { Button, Card, Input, Spinner } from "@/components/ui";
import { registerPatient, type Sex } from "@/lib/data/patients";
import { cn } from "@/lib/utils/cn";

const PHONE_RE = /^\d{10}$/;

interface FormState {
  fullName: string;
  phone: string;
  age: string;
  sex: string;
}

const EMPTY: FormState = { fullName: "", phone: "", age: "", sex: "" };

export default function RegisterPage() {
  const t = useTranslations("register");

  const [values, setValues] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registeredName, setRegisteredName] = useState<string | null>(null);

  function update(field: keyof FormState, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function validate() {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!values.fullName.trim()) next.fullName = t("required");
    if (!values.phone.trim()) next.phone = t("required");
    else if (!PHONE_RE.test(values.phone)) next.phone = t("invalidPhone");
    const age = Number(values.age);
    if (!values.age.trim()) next.age = t("required");
    else if (!Number.isInteger(age) || age < 1 || age > 120)
      next.age = t("invalidAge");
    if (!values.sex) next.sex = t("required");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setSubmitting(true);
    const { data, error } = await registerPatient({
      fullName: values.fullName.trim(),
      phone: values.phone.trim(),
      age: Number(values.age),
      sex: values.sex as Sex,
    });
    setSubmitting(false);

    if (error) {
      if (error.code === "DUPLICATE_PATIENT") {
        setErrors((prev) => ({ ...prev, phone: t("duplicate") }));
      } else {
        setFormError(error.message);
      }
      return;
    }
    if (data) {
      setRegisteredName(data.fullName);
      setValues(EMPTY);
      setErrors({});
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      {registeredName ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-success/10 p-4">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium text-text-primary">{t("successTitle")}</p>
            <p className="text-sm text-text-secondary">
              {t("successBody", { name: registeredName })}
            </p>
          </div>
        </div>
      ) : null}

      <Card className="mt-6">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Input
            label={t("fullName")}
            value={values.fullName}
            onChange={(event) => update("fullName", event.target.value)}
            error={errors.fullName}
          />
          <Input
            label={t("phone")}
            type="tel"
            inputMode="numeric"
            value={values.phone}
            onChange={(event) => update("phone", event.target.value)}
            error={errors.phone}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={t("age")}
              type="number"
              inputMode="numeric"
              value={values.age}
              onChange={(event) => update("age", event.target.value)}
              error={errors.age}
            />
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="sex"
                className="text-sm font-medium text-text-primary"
              >
                {t("sex")}
              </label>
              <select
                id="sex"
                value={values.sex}
                onChange={(event) => update("sex", event.target.value)}
                aria-invalid={errors.sex ? true : undefined}
                className={cn(
                  "h-11 rounded-md border bg-surface px-3 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  errors.sex ? "border-warning" : "border-border",
                )}
              >
                <option value="" disabled>
                  {t("sexSelect")}
                </option>
                <option value="male">{t("sexMale")}</option>
                <option value="female">{t("sexFemale")}</option>
                <option value="other">{t("sexOther")}</option>
              </select>
              {errors.sex ? (
                <p className="flex items-center gap-1.5 text-sm text-text-secondary">
                  <AlertCircle
                    className="h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  {errors.sex}
                </p>
              ) : null}
            </div>
          </div>

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
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner />
                  {t("submitting")}
                </>
              ) : (
                t("submit")
              )}
            </Button>
            {registeredName ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setRegisteredName(null)}
              >
                {t("registerAnother")}
              </Button>
            ) : null}
          </div>
        </form>
      </Card>
    </div>
  );
}
