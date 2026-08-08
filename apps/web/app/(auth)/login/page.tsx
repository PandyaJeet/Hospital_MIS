"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";

import { Button, Card, Input, Spinner } from "@/components/ui";
import { signIn } from "@/lib/data/auth";
import { roleHomePath } from "@/lib/roles";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const t = useTranslations("auth.login");
  const tv = useTranslations("auth.validation");
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate() {
    const next: { email?: string; password?: string } = {};
    if (!email.trim()) next.email = tv("required");
    else if (!EMAIL_RE.test(email)) next.email = tv("invalidEmail");
    if (!password) next.password = tv("required");
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setSubmitting(true);
    const { data, error } = await signIn({ email, password });
    setSubmitting(false);

    if (error) {
      setFormError(
        error.code === "INVALID_CREDENTIALS"
          ? t("invalidCredentials")
          : error.message,
      );
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
          label={t("email")}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={fieldErrors.email}
        />
        <Input
          label={t("password")}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
        {t("noAccount")}{" "}
        <Link
          href="/onboarding"
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          {t("createClinic")}
        </Link>
      </p>
    </Card>
  );
}
