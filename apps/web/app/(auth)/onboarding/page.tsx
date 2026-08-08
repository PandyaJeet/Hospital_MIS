"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";

import { Button, Card, Input, Spinner } from "@/components/ui";
import { createTenantAndOwner } from "@/lib/data/auth";
import { roleHomePath } from "@/lib/roles";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Field = "clinicName" | "fullName" | "email" | "password";

export default function OnboardingPage() {
  const t = useTranslations("auth.onboarding");
  const tv = useTranslations("auth.validation");
  const router = useRouter();

  const [values, setValues] = useState<Record<Field, string>>({
    clinicName: "",
    fullName: "",
    email: "",
    password: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field: Field, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function validate() {
    const next: Partial<Record<Field, string>> = {};
    if (!values.clinicName.trim()) next.clinicName = tv("required");
    if (!values.fullName.trim()) next.fullName = tv("required");
    if (!values.email.trim()) next.email = tv("required");
    else if (!EMAIL_RE.test(values.email)) next.email = tv("invalidEmail");
    if (!values.password) next.password = tv("required");
    else if (values.password.length < 6)
      next.password = tv("passwordTooShort");
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setSubmitting(true);
    const { data, error } = await createTenantAndOwner(values);
    setSubmitting(false);

    if (error) {
      if (error.code === "EMAIL_TAKEN") {
        setFieldErrors((prev) => ({ ...prev, email: t("emailTaken") }));
      } else {
        setFormError(error.message);
      }
      return;
    }
    if (data) router.push(roleHomePath[data.role]);
  }

  return (
    <Card className="w-full max-w-sm">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
        <Input
          label={t("clinicName")}
          value={values.clinicName}
          onChange={(event) => update("clinicName", event.target.value)}
          error={fieldErrors.clinicName}
        />
        <Input
          label={t("fullName")}
          autoComplete="name"
          value={values.fullName}
          onChange={(event) => update("fullName", event.target.value)}
          error={fieldErrors.fullName}
        />
        <Input
          label={t("email")}
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={(event) => update("email", event.target.value)}
          error={fieldErrors.email}
        />
        <Input
          label={t("password")}
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={(event) => update("password", event.target.value)}
          error={fieldErrors.password}
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
      </form>

      <p className="mt-4 text-sm text-text-secondary">
        {t("haveAccount")}{" "}
        <Link
          href="/login"
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          {t("signIn")}
        </Link>
      </p>
    </Card>
  );
}
