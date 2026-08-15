"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, Building2, Ticket } from "lucide-react";

import { Button, Card, Input, Spinner } from "@/components/ui";
import { acceptInvite, createTenant, signOut } from "@/lib/data/auth";
import { roleHomePath } from "@/lib/roles";

/**
 * The `pending` landing screen: signed in, but not yet a member of any clinic.
 * Two exits — found a clinic (becoming its admin) or redeem an invite
 * (auth-tenancy.md §7). `pending` is a normal state, so this screen never
 * redirects on its own.
 */
export default function OnboardingPage() {
  const t = useTranslations("auth.onboarding");
  const tv = useTranslations("auth.validation");
  const te = useTranslations("auth.errors");
  const router = useRouter();

  const [clinicName, setClinicName] = useState("");
  const [token, setToken] = useState("");
  const [clinicError, setClinicError] = useState<string | undefined>();
  const [tokenError, setTokenError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"create" | "join" | null>(null);

  function messageFor(code: string) {
    switch (code) {
      case "ALREADY_IN_TENANT":
        return t("alreadyInTenant");
      case "INVITE_NOT_FOUND":
        return t("inviteNotFound");
      case "INVITE_EXPIRED":
        return t("inviteExpired");
      case "INVITE_ALREADY_ACCEPTED":
        return t("inviteAlreadyAccepted");
      case "INVITE_EMAIL_MISMATCH":
        return t("inviteEmailMismatch");
      case "EMAIL_NOT_CONFIRMED":
        return t("emailNotConfirmed");
      case "NETWORK_ERROR":
        return te("network");
      case "NOT_AUTHENTICATED":
        return te("notAuthenticated");
      case "PROFILE_MISSING":
        return te("profileMissing");
      case "NOT_ADMIN":
      case "PERMISSION_DENIED":
        return te("permission");
      default:
        return te("generic");
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setClinicError(undefined);
    if (!clinicName.trim()) {
      setClinicError(tv("required"));
      return;
    }

    setBusy("create");
    const { data, error } = await createTenant(clinicName.trim());
    setBusy(null);

    if (error) {
      if (error.code === "VALIDATION_ERROR") setClinicError(error.message);
      else setFormError(messageFor(error.code));
      return;
    }
    if (data) router.push(roleHomePath[data.role]);
  }

  async function onJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setTokenError(undefined);
    if (!token.trim()) {
      setTokenError(tv("required"));
      return;
    }

    setBusy("join");
    const { data, error } = await acceptInvite(token.trim());
    setBusy(null);

    if (error) {
      // Invite problems belong on the field the user can act on.
      if (error.fields?.includes("token") || error.code.startsWith("INVITE_")) {
        setTokenError(messageFor(error.code));
      } else {
        setFormError(messageFor(error.code));
      }
      return;
    }
    if (data) router.push(roleHomePath[data.role]);
  }

  async function onSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <div className="w-full max-w-md">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      {formError ? (
        <p
          role="alert"
          className="mt-4 flex items-center gap-1.5 text-sm text-text-secondary"
        >
          <AlertCircle
            className="h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          {formError}
        </p>
      ) : null}

      <Card className="mt-6">
        <div className="flex items-start gap-3">
          <Building2
            className="mt-0.5 h-5 w-5 shrink-0 text-accent"
            aria-hidden="true"
          />
          <div>
            <h2 className="font-medium text-text-primary">{t("createTitle")}</h2>
            <p className="text-sm text-text-secondary">{t("createBody")}</p>
          </div>
        </div>
        <form onSubmit={onCreate} noValidate className="mt-4 flex flex-col gap-3">
          <Input
            label={t("clinicName")}
            value={clinicName}
            maxLength={120}
            onChange={(event) => setClinicName(event.target.value)}
            error={clinicError}
          />
          <div>
            <Button type="submit" disabled={busy !== null}>
              {busy === "create" ? (
                <>
                  <Spinner />
                  {t("creating")}
                </>
              ) : (
                t("createSubmit")
              )}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="mt-4">
        <div className="flex items-start gap-3">
          <Ticket
            className="mt-0.5 h-5 w-5 shrink-0 text-accent"
            aria-hidden="true"
          />
          <div>
            <h2 className="font-medium text-text-primary">{t("joinTitle")}</h2>
            <p className="text-sm text-text-secondary">{t("joinBody")}</p>
          </div>
        </div>
        <form onSubmit={onJoin} noValidate className="mt-4 flex flex-col gap-3">
          <Input
            label={t("inviteToken")}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            error={tokenError}
          />
          <div>
            <Button
              type="submit"
              variant="secondary"
              disabled={busy !== null}
            >
              {busy === "join" ? (
                <>
                  <Spinner />
                  {t("joining")}
                </>
              ) : (
                t("joinSubmit")
              )}
            </Button>
          </div>
        </form>
      </Card>

      <div className="mt-4 text-sm">
        <button
          type="button"
          onClick={() => void onSignOut()}
          className="font-medium text-accent underline-offset-4 hover:underline"
        >
          {t("signOut")}
        </button>
      </div>
    </div>
  );
}
