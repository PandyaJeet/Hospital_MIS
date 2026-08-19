"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BedDouble, Lock, Plus, TriangleAlert } from "lucide-react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
} from "@/components/ui";
import { useBeds } from "@/hooks/use-beds";
import { getSessionUser, type AuthUser } from "@/lib/data/auth";
import {
  createBed,
  groupByWard,
  setBedStatus,
  setWardPricing,
  type Bed,
  type BedStatus,
  type HousekeepingStatus,
} from "@/lib/data/beds";
import type { AppError } from "@/lib/data/types";

const STATUS_TONE: Record<
  BedStatus,
  "success" | "critical" | "warning" | "neutral"
> = {
  available: "success",
  occupied: "critical",
  cleaning: "warning",
  maintenance: "neutral",
};

/** Housekeeping targets only. `occupied` is never a state somebody types in. */
const HOUSEKEEPING: HousekeepingStatus[] = [
  "available",
  "cleaning",
  "maintenance",
];

export default function BedsPage() {
  const t = useTranslations("beds");
  const { beds, wards, tier, accrual, ipdEnabled, loading, error, refresh } =
    useBeds();

  const [session, setSession] = useState<AuthUser | null>(null);
  const [busyBedId, setBusyBedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [showAddBed, setShowAddBed] = useState(false);
  const [newWard, setNewWard] = useState("");
  const [newNumber, setNewNumber] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void getSessionUser().then((result) => {
      if (active && result.data) setSession(result.data);
    });
    return () => {
      active = false;
    };
  }, []);

  const isAdmin = session?.role === "admin";
  // set_bed_status is nursing or admin only — turning a bed over is ward work,
  // not front-desk work (ipd-beds.md §5).
  const canTurnOver = session?.role === "admin" || session?.role === "nurse";
  // Accrued room rent is money, so it is shown to the roles that answer for it.
  const canSeeMoney = session?.role === "admin" || session?.role === "billing";

  async function changeStatus(bed: Bed, status: HousekeepingStatus) {
    setBusyBedId(bed.id);
    setActionError(null);
    const { error: failure } = await setBedStatus(bed.id, status);
    if (failure) setActionError(failure);
    await refresh();
    setBusyBedId(null);
  }

  async function addBed(event: React.FormEvent) {
    event.preventDefault();
    const tenantId = session?.tenantId;
    if (!tenantId) return;
    setSaving(true);
    setActionError(null);
    const { error: failure } = await createBed({
      tenant_id: tenantId,
      ward_name: newWard,
      bed_number: newNumber,
    });
    if (failure) {
      setActionError(failure);
    } else {
      setNewWard("");
      setNewNumber("");
      setShowAddBed(false);
      await refresh();
    }
    setSaving(false);
  }

  async function priceWard(wardId: string, rate: number, critical: boolean) {
    setActionError(null);
    const { error: failure } = await setWardPricing(wardId, {
      daily_rate: rate,
      is_critical_care: critical,
    });
    if (failure) setActionError(failure);
    await refresh();
  }

  const grouped = groupByWard(beds);
  const unpricedWards = wards.filter((w) => w.daily_rate === 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>
        </div>
        {isAdmin && ipdEnabled ? (
          <Button size="sm" onClick={() => setShowAddBed((v) => !v)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("addBed")}
          </Button>
        ) : null}
      </div>

      {/*
        Tier 1 can read beds but cannot create one or admit into it. Say "your plan
        doesn't include this" rather than "you're not allowed", which is what a
        generic permission error would imply (ipd-beds.md §4).
      */}
      {!loading && !ipdEnabled ? (
        <Card className="mt-6 border-info bg-info/5">
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
        </Card>
      ) : null}

      {actionError ? (
        <Card className="mt-6 border-warning bg-warning/5">
          <p className="flex items-start gap-2 text-sm text-text-primary">
            <TriangleAlert
              className="mt-0.5 h-4 w-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            <span>
              {actionError.code === "TIER_NOT_ENABLED"
                ? t("tierLockedBody")
                : actionError.message}
            </span>
          </p>
        </Card>
      ) : null}

      {showAddBed ? (
        <Card className="mt-6">
          <form
            onSubmit={(e) => void addBed(e)}
            className="flex flex-col gap-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label={t("wardName")}
                value={newWard}
                onChange={(e) => setNewWard(e.target.value)}
                required
                helperText={t("wardNameHelp")}
              />
              <Input
                label={t("bedNumber")}
                value={newNumber}
                onChange={(e) => setNewNumber(e.target.value)}
                required
                // Text, not number: '12A' and 'ICU-3' are real bed numbers.
                inputMode="text"
                helperText={t("bedNumberHelp")}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={saving || !session?.tenantId}
              >
                {saving ? t("saving") : t("createBed")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowAddBed(false)}
              >
                {t("cancel")}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {/*
        A ward created implicitly by adding a bed starts at ₹0 and bills nothing until
        someone prices it (ipd-beds.md §12.2). A plausible-looking ₹0 room charge is
        worse than a warning.
      */}
      {isAdmin && unpricedWards.length > 0 ? (
        <Card className="mt-6 border-warning bg-warning/5">
          <p className="flex items-start gap-2 text-sm font-medium text-text-primary">
            <TriangleAlert
              className="mt-0.5 h-4 w-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            {t("unpricedTitle", { count: unpricedWards.length })}
          </p>
          <p className="mt-1 pl-6 text-sm text-text-secondary">
            {t("unpricedBody")}
          </p>
          <ul className="mt-3 flex flex-col gap-2 pl-6">
            {unpricedWards.map((ward) => (
              <li key={ward.id} className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{ward.name}</span>
                <WardPriceForm
                  onSubmit={(rate, critical) =>
                    void priceWard(ward.id, rate, critical)
                  }
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/*
        Room rent accruing right now, for the roles that answer for money. A
        projection rather than a ledger — nothing here has been charged yet, which is
        why it says "so far" and is not presented as a bill (ipd-beds.md §12).
      */}
      {canSeeMoney && accrual.length > 0 ? (
        <Card className="mt-6">
          <h2 className="font-medium">{t("accrualTitle")}</h2>
          <p className="mt-1 text-sm text-text-secondary">
            {t("accrualSubtitle")}
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {accrual.map((row) => (
              <li
                key={row.bed_stay_id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2"
              >
                <span className="text-sm text-text-primary">
                  {t("uhid", { number: row.patient_number })}
                  {" · "}
                  {row.ward_name} {row.bed_number}
                  {row.is_critical_care ? ` · ${t("criticalCare")}` : ""}
                </span>
                <span className="text-sm tabular-nums text-text-secondary">
                  {t("accrualDays", { count: row.days_so_far })}
                  {" · "}
                  {row.ward_unpriced ? (
                    // An unpriced ward accrues ₹0. Saying "₹0" alone would read as
                    // a free stay rather than a missing rate.
                    <span className="text-warning">{t("accrualUnpriced")}</span>
                  ) : (
                    t("accrualAmount", { amount: row.accrued_amount })
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mt-6 flex flex-col gap-5">
        {loading ? (
          [0, 1].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-3 h-16 w-full" />
            </Card>
          ))
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
            <p className="text-sm text-text-secondary">{t("loadError")}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refresh()}
            >
              {t("retry")}
            </Button>
          </div>
        ) : grouped.length === 0 ? (
          <EmptyState
            icon={BedDouble}
            title={t("empty")}
            description={ipdEnabled ? t("emptyBody") : t("emptyBodyTier1")}
          />
        ) : (
          grouped.map(({ ward, beds: wardBeds }) => {
            const detail = wards.find((w) => w.name === ward);
            const free = wardBeds.filter((b) => b.status === "available").length;

            return (
              <section key={ward}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-medium">{ward}</h2>
                  <p className="text-sm text-text-secondary">
                    {t("freeOf", { free, total: wardBeds.length })}
                    {detail ? (
                      <>
                        {" · "}
                        {detail.daily_rate > 0
                          ? t("perDay", { amount: detail.daily_rate })
                          : t("unpriced")}
                        {detail.is_critical_care
                          ? ` · ${t("criticalCare")}`
                          : ""}
                      </>
                    ) : null}
                  </p>
                </div>

                <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                  {wardBeds.map((bed) => (
                    <li key={bed.id}>
                      <Card className="h-full">
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium tabular-nums">
                            {bed.bed_number}
                          </p>
                          <Badge tone={STATUS_TONE[bed.status]}>
                            {t(`status.${bed.status}`)}
                          </Badge>
                        </div>

                        {bed.notes ? (
                          <p className="mt-1 text-sm text-text-secondary">
                            {bed.notes}
                          </p>
                        ) : null}

                        {/*
                          An occupied bed shows no occupant. This board is a capacity
                          view; identifying who is in a bed belongs on rounds, where
                          the reader is a clinician.
                        */}
                        {bed.status === "occupied" ? (
                          <p className="mt-2 text-sm text-text-secondary">
                            {t("occupiedNote")}
                          </p>
                        ) : canTurnOver && ipdEnabled ? (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {HOUSEKEEPING.filter((s) => s !== bed.status).map(
                              (status) => (
                                <Button
                                  key={status}
                                  variant="secondary"
                                  size="sm"
                                  disabled={busyBedId === bed.id}
                                  onClick={() => void changeStatus(bed, status)}
                                >
                                  {t(`markAs.${status}`)}
                                </Button>
                              ),
                            )}
                          </div>
                        ) : null}
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Inline rate editor. The rate lives on the ward, never on an individual bed. */
function WardPriceForm({
  onSubmit,
}: {
  onSubmit: (rate: number, critical: boolean) => void;
}) {
  const t = useTranslations("beds");
  const [rate, setRate] = useState("");
  const [critical, setCritical] = useState(false);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = Number(rate);
        if (!Number.isFinite(parsed) || parsed < 0) return;
        onSubmit(parsed, critical);
      }}
    >
      <input
        type="number"
        min="0"
        step="1"
        inputMode="numeric"
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        aria-label={t("dailyRate")}
        placeholder={t("dailyRate")}
        className="h-9 w-32 rounded-md border border-border bg-surface px-2 text-sm tabular-nums text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
      <label className="flex items-center gap-1.5 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={critical}
          onChange={(e) => setCritical(e.target.checked)}
          className="h-4 w-4 rounded border-border text-accent focus-visible:ring-2 focus-visible:ring-accent"
        />
        {t("criticalCare")}
      </label>
      <Button type="submit" size="sm" variant="secondary">
        {t("setRate")}
      </Button>
    </form>
  );
}
