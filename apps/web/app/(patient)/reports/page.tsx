import { getTranslations } from "next-intl/server";
import { FileText } from "lucide-react";

/**
 * Patient portal — see the note in ../queue-status/page.tsx. The `patient` role has
 * no read access to clinical data in this phase, by design.
 */
export default async function ReportsPage() {
  const t = await getTranslations("portal");

  return (
    <main className="mx-auto w-full max-w-md flex-1 px-6 py-12">
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
        <FileText className="h-8 w-8 text-text-disabled" aria-hidden="true" />
        <h1 className="text-lg font-medium text-text-primary">
          {t("reportsTitle")}
        </h1>
        <p className="text-sm text-text-secondary">{t("notReadyBody")}</p>
        <p className="text-sm text-text-secondary">{t("askReception")}</p>
      </div>
    </main>
  );
}
