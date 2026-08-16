import { getTranslations } from "next-intl/server";
import { Clock } from "lucide-react";

/**
 * Patient portal — intentionally not implemented against data yet.
 *
 * The `patient` role matches **no rows** on `patients` and is not granted `visits`
 * (patient-registration.md §5, opd-queue.md §6). That is a deliberate deny: a real
 * portal needs its own narrow policy matching a verified link between `auth.uid()`
 * and a patient row, not a widening of the staff policy.
 *
 * So this screen says so plainly rather than rendering an empty queue that would
 * read as "you have no appointment".
 */
export default async function QueueStatusPage() {
  const t = await getTranslations("portal");

  return (
    <main className="mx-auto w-full max-w-md flex-1 px-6 py-12">
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
        <Clock className="h-8 w-8 text-text-disabled" aria-hidden="true" />
        <h1 className="text-lg font-medium text-text-primary">
          {t("queueTitle")}
        </h1>
        <p className="text-sm text-text-secondary">{t("notReadyBody")}</p>
        <p className="text-sm text-text-secondary">{t("askReception")}</p>
      </div>
    </main>
  );
}
