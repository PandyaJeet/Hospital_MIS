"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Users } from "lucide-react";

import { CheckInButton } from "@/components/shared/check-in-button";
import { Button, Card, Input, Spinner, Textarea } from "@/components/ui";
import {
  genders,
  registerPatient,
  type Gender,
  type NewPatientInput,
  type PatientMatch,
} from "@/lib/data/patients";
import { cn } from "@/lib/utils/cn";

interface FormState {
  full_name: string;
  phone: string;
  age_years: string;
  gender: string;
  address: string;
  allergies: string;
}

const EMPTY: FormState = {
  full_name: "",
  phone: "",
  age_years: "",
  gender: "",
  address: "",
  allergies: "",
};

type FieldErrors = Partial<Record<keyof FormState, string>>;

export default function RegisterPage() {
  const t = useTranslations("register");

  const [values, setValues] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [duplicate, setDuplicate] = useState<PatientMatch[] | null>(null);
  const [success, setSuccess] = useState<{
    id: string;
    name: string;
    number: number;
  } | null>(null);

  function update(field: keyof FormState, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function messageFor(code: string) {
    switch (code) {
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

  /** Only the name is required — everything else is optional per the contract. */
  function validate(): boolean {
    const next: FieldErrors = {};
    const name = values.full_name.trim();
    if (!name) next.full_name = t("required");
    else if (name.length > 200) next.full_name = t("nameTooLong");

    if (values.phone.trim() && !/\d/.test(values.phone)) {
      next.phone = t("invalidPhone");
    }
    if (values.age_years.trim()) {
      const age = Number(values.age_years);
      if (!Number.isInteger(age) || age < 0 || age > 130) {
        next.age_years = t("invalidAge");
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function buildInput(allowDuplicate: boolean): NewPatientInput {
    return {
      full_name: values.full_name.trim(),
      phone: values.phone.trim() || null,
      age_years: values.age_years.trim() ? Number(values.age_years) : null,
      gender: (values.gender || null) as Gender | null,
      address: values.address.trim() || null,
      allergies: values.allergies.trim() || null,
      allow_duplicate_phone: allowDuplicate,
    };
  }

  async function submit(allowDuplicate: boolean) {
    setFormError(null);
    setSubmitting(true);
    const outcome = await registerPatient(buildInput(allowDuplicate));
    setSubmitting(false);

    switch (outcome.kind) {
      case "registered":
        setSuccess({
          id: outcome.patient_id,
          name: outcome.full_name,
          number: outcome.patient_number,
        });
        setDuplicate(null);
        setValues(EMPTY);
        setErrors({});
        break;
      case "duplicate":
        setDuplicate(outcome.matches);
        break;
      case "failed":
        setDuplicate(null);
        if (outcome.error.code === "VALIDATION_ERROR" && outcome.error.fields) {
          const mapped: FieldErrors = {};
          for (const field of outcome.error.fields) {
            if (field in EMPTY) {
              mapped[field as keyof FormState] = outcome.error.message;
            }
          }
          setErrors(mapped);
          if (Object.keys(mapped).length === 0) {
            setFormError(outcome.error.message);
          }
        } else {
          setFormError(messageFor(outcome.error.code));
        }
        break;
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDuplicate(null);
    if (!validate()) return;
    await submit(false);
  }

  return (
    <div className="mx-auto w-full max-w-lg px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      {success ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-success/10 p-4">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium text-text-primary">{t("successTitle")}</p>
            <p className="text-sm text-text-secondary">
              {t("successBody", {
                name: success.name,
                number: success.number,
              })}
            </p>
            {/*
              Registering does not queue anyone. Without this the patient exists
              and then goes nowhere — the doctor's queue stays empty and the walk-in
              has to be found again by search to be checked in.
            */}
            <div className="mt-3">
              <CheckInButton patientId={success.id} size="sm" />
            </div>
          </div>
        </div>
      ) : null}

      {/* A shared phone is a prompt, not a wall — different people legitimately
          share one number, so offer both exits. */}
      {duplicate ? (
        <Card className="mt-4 border-warning">
          <div className="flex items-start gap-2">
            <Users
              className="mt-0.5 h-5 w-5 shrink-0 text-warning"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium text-text-primary">
                {t("duplicateTitle")}
              </p>
              <p className="text-sm text-text-secondary">
                {t("duplicateBody")}
              </p>
            </div>
          </div>

          <ul className="mt-3 flex flex-col gap-2">
            {duplicate.map((match) => (
              <li
                key={match.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface p-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-text-primary">
                    {match.full_name}
                  </p>
                  <p className="text-sm tabular-nums text-text-secondary">
                    {t("uhid", { number: match.patient_number })}
                    {match.age_years !== null ? ` · ${match.age_years}` : ""}
                  </p>
                </div>
                <Link
                  href={`/patient/${match.id}`}
                  className="shrink-0 text-sm font-medium text-accent underline-offset-4 hover:underline"
                >
                  {t("duplicateOpen")}
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-4">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={submitting}
              onClick={() => void submit(true)}
            >
              {submitting ? <Spinner /> : null}
              {t("duplicateAnyway")}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="mt-6">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Input
            label={t("fullName")}
            value={values.full_name}
            maxLength={200}
            onChange={(event) => update("full_name", event.target.value)}
            error={errors.full_name}
          />
          <Input
            label={`${t("phone")} (${t("optional")})`}
            type="tel"
            inputMode="tel"
            value={values.phone}
            onChange={(event) => update("phone", event.target.value)}
            error={errors.phone}
            helperText={t("phoneHelp")}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={`${t("age")} (${t("optional")})`}
              type="number"
              inputMode="numeric"
              value={values.age_years}
              onChange={(event) => update("age_years", event.target.value)}
              error={errors.age_years}
            />
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="gender"
                className="text-sm font-medium text-text-primary"
              >
                {`${t("gender")} (${t("optional")})`}
              </label>
              <select
                id="gender"
                value={values.gender}
                onChange={(event) => update("gender", event.target.value)}
                className={cn(
                  "h-11 rounded-md border border-border bg-surface px-3 text-base text-text-primary",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                )}
              >
                <option value="">{t("genderSelect")}</option>
                {genders.map((gender) => (
                  <option key={gender} value={gender}>
                    {t(
                      `gender${gender.charAt(0).toUpperCase()}${gender.slice(1)}`,
                    )}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <Input
            label={`${t("address")} (${t("optional")})`}
            value={values.address}
            onChange={(event) => update("address", event.target.value)}
          />
          <Textarea
            label={`${t("allergies")} (${t("optional")})`}
            value={values.allergies}
            onChange={(event) => update("allergies", event.target.value)}
            helperText={t("allergiesHelp")}
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
            <Button type="submit" disabled={submitting}>
              {submitting && !duplicate ? (
                <>
                  <Spinner />
                  {t("submitting")}
                </>
              ) : (
                t("submit")
              )}
            </Button>
            {success ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setSuccess(null)}
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
