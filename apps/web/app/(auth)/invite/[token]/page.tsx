"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Ticket } from "lucide-react";

import { Card, Spinner } from "@/components/ui";
import { getSessionUser } from "@/lib/data/auth";
import { storeInviteToken } from "@/lib/auth/invite";

/**
 * Landing page for an invite link. Parks the token, then sends the invitee down the
 * right path: straight to onboarding if they already have a session, otherwise to
 * signup — because with email confirmation on they cannot redeem anything until
 * they have confirmed and signed in.
 */
export default function InvitePage() {
  const t = useTranslations("invite");
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const token = params.token;

    void storeInviteToken(token)
      .then(() => getSessionUser())
      .then((session) => {
        if (!active) return;
        if (session.data) {
          router.replace(`/onboarding?token=${encodeURIComponent(token)}`);
        } else {
          setMessage(t("needAccount"));
          router.replace("/signup");
        }
      });

    return () => {
      active = false;
    };
  }, [params.token, router, t]);

  return (
    <Card className="w-full max-w-sm text-center">
      <Ticket className="mx-auto h-8 w-8 text-accent" aria-hidden="true" />
      <h1 className="mt-3 text-xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm text-text-secondary">
        {message ?? t("checking")}
      </p>
      <div className="mt-4 flex justify-center">
        <Spinner className="h-5 w-5 text-accent" />
      </div>
    </Card>
  );
}
