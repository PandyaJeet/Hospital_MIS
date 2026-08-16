"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Lock, TriangleAlert } from "lucide-react";

import { Badge, Button, Spinner } from "@/components/ui";
import {
  admitPatientToBed,
  getCurrentTier,
  groupByWard,
  isAssignable,
  listBeds,
  type AdmitOutcome,
  type Bed,
} from "@/lib/data/beds";
import type { AppError, Result } from "@/lib/data/types";

interface BedSnapshot {
  beds: Result<Bed[]>;
  tier: Result<number | null>;
}

function fetchBeds(): Promise<BedSnapshot> {
  return Promise.all([listBeds(), getCurrentTier()]).then(([beds, tier]) => ({
    beds,
    tier,
  }));
}

/**
 * Bed picker for admitting or transferring a patient.
 *
 * Inline rather than a modal on purpose: `Design.md` reserves modals for genuine
 * clinical alerts, and choosing a bed is routine work.
 *
 * Called on an already-admitted visit with a different bed, `admit_patient_to_bed`
 * performs a **transfer** (ipd-beds.md §4) — which is the only way to correct a
 * mis-assigned bed without falsifying a discharge time on a medical record.
 */
export function AdmitPanel({
  visitId,
  onAdmitted,
  onClose,
}: {
  visitId: string;
  onAdmitted?: (outcome: AdmitOutcome) => void;
  onClose: () => void;
}) {
  const t = useTranslations("beds");
  const [beds, setBeds] = useState<Bed[]>([]);
  const [tier, setTier] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyBedId, setBusyBedId] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [outcome, setOutcome] = useState<AdmitOutcome | null>(null);

  const apply = useCallback((snapshot: BedSnapshot) => {
    if (snapshot.beds.error) setError(snapshot.beds.error);
    else setBeds(snapshot.beds.data ?? []);
    setTier(snapshot.tier.data ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    void fetchBeds().then((snapshot) => {
      if (active) apply(snapshot);
    });
    return () => {
      active = false;
    };
  }, [apply]);

  const ipdEnabled = tier !== null && tier >= 2;

  async function admit(bed: Bed) {
    setBusyBedId(bed.id);
    setError(null);
    const { data, error: failure } = await admitPatientToBed(visitId, bed.id);
    setBusyBedId(null);

    if (failure) {
      setError(failure);
      // The bed's status moved under us. Re-read so what the user is looking at
      // matches reality rather than offering a bed we now know is taken.
      if (failure.code === "BED_NOT_AVAILABLE") {
        setLoading(true);
        apply(await fetchBeds());
      }
      return;
    }
    if (data) {
      setOutcome(data);
      onAdmitted?.(data);
    }
  }

  if (outcome) {
    return (
      <div className="mt-3 rounded-md border border-success bg-success/5 p-3">
        <p className="text-sm font-medium text-text-primary">
          {outcome.transferred_from
            ? t("transferred", {
                from: `${outcome.transferred_from.ward_name} ${outcome.transferred_from.bed_number}`,
                to: `${outcome.ward_name} ${outcome.bed_number}`,
              })
            : outcome.changed
              ? t("admitted", {
                  ward: outcome.ward_name,
                  bed: outcome.bed_number,
                })
              : // Idempotent success: a double-tap must read as "already there",
                // not as a second admission.
                t("alreadyInBed", {
                  ward: outcome.ward_name,
                  bed: outcome.bed_number,
                })}
        </p>
        {outcome.daily_rate !== null ? (
          <p className="mt-1 text-sm text-text-secondary">
            {outcome.daily_rate > 0
              ? t("willBill", { amount: outcome.daily_rate })
              : t("unpricedWarning")}
            {outcome.is_critical_care ? ` · ${t("criticalCare")}` : ""}
          </p>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={onClose}
        >
          {t("close")}
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-muted p-3">
        <Spinner />
        <span className="text-sm text-text-secondary">{t("loadingBeds")}</span>
      </div>
    );
  }

  if (!ipdEnabled) {
    return (
      <div className="mt-3 rounded-md border border-info bg-info/5 p-3">
        <p className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <Lock
            className="mt-0.5 h-4 w-4 shrink-0 text-info"
            aria-hidden="true"
          />
          {tier === null ? t("noClinic") : t("tierLockedTitle")}
        </p>
        <p className="mt-1 pl-6 text-sm text-text-secondary">
          {tier === null ? t("noClinicBody") : t("tierLockedBody")}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={onClose}
        >
          {t("close")}
        </Button>
      </div>
    );
  }

  const assignable = beds.filter(isAssignable);

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-muted p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-text-primary">
          {t("chooseBed")}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-text-secondary underline-offset-4 hover:underline"
        >
          {t("cancel")}
        </button>
      </div>

      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-text-primary">
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          <span>
            {error.code === "TIER_NOT_ENABLED"
              ? t("tierLockedBody")
              : error.code === "BED_NOT_AVAILABLE"
                ? t("bedTaken")
                : error.message}
          </span>
        </p>
      ) : null}

      {assignable.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">{t("noFreeBeds")}</p>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          {groupByWard(assignable).map(({ ward, beds: wardBeds }) => (
            <div key={ward}>
              <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                {ward}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {wardBeds.map((bed) => (
                  <Button
                    key={bed.id}
                    variant="secondary"
                    size="sm"
                    disabled={busyBedId !== null}
                    onClick={() => void admit(bed)}
                  >
                    {busyBedId === bed.id ? <Spinner /> : null}
                    {bed.bed_number}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Admitted-with-no-bed is a real state, so this is a note, not a blocker. */}
      <p className="mt-3 text-xs text-text-disabled">{t("admitNote")}</p>
      <p className="mt-1">
        <Badge tone="neutral">{t("anyStaffMayAdmit")}</Badge>
      </p>
    </div>
  );
}
