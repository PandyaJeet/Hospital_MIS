"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Stethoscope } from "lucide-react";

import { Button, EmptyState } from "@/components/ui";

/**
 * A prescription hangs off a visit (prescriptions.md §2), so there is nothing to
 * compose without one. Send the doctor to the queue to pick a consultation.
 */
export default function PrescribeEntryPage() {
  const t = useTranslations("prescribe");
  const router = useRouter();

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="mt-6">
        <EmptyState
          icon={Stethoscope}
          title={t("needVisitTitle")}
          description={t("needVisitBody")}
          action={
            <Button size="sm" onClick={() => router.push("/queue")}>
              {t("goToQueue")}
            </Button>
          }
        />
      </div>
    </div>
  );
}
