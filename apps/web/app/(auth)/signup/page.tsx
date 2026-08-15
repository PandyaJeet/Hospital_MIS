"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle, MailCheck } from "lucide-react";

import { Button, Card, Input, Spinner } from "@/components/ui";
import { signUp } from "@/lib/data/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Field = "fullName" | "email" | "password";

/**
 * Signup only creates the account. The `on_auth_user_created` trigger gives it a
 * `pending` profile with no tenant; founding or joining a clinic happens next on
 * /onboarding (auth-tenancy.md §7).
 */
export default function SignupPage() {
  const t = useTranslations("auth.signup");
  const tv = useTranslations("auth.validation");
  const te = useTranslations("auth.errors");
  const router = useRouter();

  const [values, setValues] = useState<Record<Field, string>>({
    fullName: "",
    email: "",
    password: "",
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  function update(field: Field, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function validate() {
    const next: Partial<Record<Field, string>> = {};
    if (!values.fullName.trim()) next.fullName = tv("required");
    if (!values.email.trim()) next.email = tv("required");
    else if (!EMAIL_RE.test(values.email)) next.email = tv("invalidEmail");
    if (!values.password) next.password = tv("required");
    else if (values.password.length < 6)
      next.password = tv("passwordTooShort");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setSubmitting(true);
    const { data, error } = await signUp({
      fullName: values.fullName.trim(),
      email: values.email.trim(),
      password: values.password,
    });
    setSubmitting(false);

    if (error) {
      switch (error.code) {
        case "EMAIL_TAKEN":
          setErrors((prev) => ({ ...prev, email: t("emailTaken") }));
          break;
        case "WEAK_PASSWORD":
          setErrors((prev) => ({ ...prev, password: t("weakPassword") }));
          break;
        case "NETWORK_ERROR":
          setFormError(te("network"));
          break;
        default:
          setFormError(te("generic"));
      }
      return;
    }

    // No session means the project requires email confirmation, so the user
    // cannot found or join a clinic yet.
    if (data?.sessionReady) router.push("/onboarding");
    else setAwaitingConfirmation(true);
  }

  if (awaitingConfirmation) {
    return (
      <Card className="w-full max-w-sm text-center">
        <MailCheck
          className="mx-auto h-8 w-8 text-accent"
          aria-hidden="true"
        />
        <h1 className="mt-3 text-xl font-semibold">{t("checkEmailTitle")}</h1>
        <p className="mt-2 text-sm text-text-secondary">
          {t("checkEmailBody", { email: values.email.trim() })}
        </p>
        <Link
          href="/login"
          className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {t("goToSignIn")}
        </Link>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4">
        <Input
          label={t("fullName")}
          autoComplete="name"
          value={values.fullName}
          onChange={(event) => update("fullName", event.target.value)}
          error={errors.fullName}
        />
        <Input
          label={t("email")}
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={(event) => update("email", event.target.value)}
          error={errors.email}
        />
        <Input
          label={t("password")}
          type="password"
          autoComplete="new-password"
          value={values.password}
          onChange={(event) => update("password", event.target.value)}
          error={errors.password}
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
