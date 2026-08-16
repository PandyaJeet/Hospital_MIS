"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle, Ban } from "lucide-react";

import { Button, Card, Input, Spinner } from "@/components/ui";
import { signIn, signOut } from "@/lib/data/auth";
import { roleHomePath } from "@/lib/roles";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const t = useTranslations("auth.login");
  const tv = useTranslations("auth.validation");
  const te = useTranslations("auth.errors");
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const searchParams = useSearchParams();
  const deactivated = searchParams.get("reason") === "account_deactivated";

  // The proxy redirects a deactivated user here. Clear the stale token so their
  // still-valid JWT stops being presented on every request.
  useEffect(() => {
    if (!deactivated) return;
    void signOut();
  }, [deactivated]);

  function validate() {
    const next: { email?: string; password?: string } = {};
    if (!email.trim()) next.email = tv("required");
    else if (!EMAIL_RE.test(email)) next.email = tv("invalidEmail");
    if (!password) next.password = tv("required");
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  /** Map the contract's stable error codes to translated copy (rules.md §3.3). */
  function messageFor(code: string) {
    switch (code) {
      case "INVALID_CREDENTIALS":
        return t("invalidCredentials");
      case "EMAIL_NOT_CONFIRMED":
        return t("emailNotConfirmed");
      case "NETWORK_ERROR":
        return te("network");
      case "PROFILE_MISSING":
        return te("profileMissing");
      case "PERMISSION_DENIED":
        return te("permission");
      default:
        return te("generic");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    setSubmitting(true);
    const { data, error } = await signIn(email, password);
    setSubmitting(false);

    if (error) {
      setFormError(messageFor(error.code));
      return;
    }
    // `pending` users land on /onboarding — a normal state, not an error
    // (auth-tenancy.md §7).
    if (data) router.push(roleHomePath[data.role]);
  }

  return (
    <Card className="w-full max-w-sm">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      {deactivated ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface-muted p-3">
          <Ban
            className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary"
            aria-hidden="true"
          />
          <p className="text-sm text-text-primary">{t("deactivated")}</p>
        </div>
      ) : null}

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
          href="/signup"
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          {t("createAccount")}
        </Link>
      </p>
    </Card>
  );
}
