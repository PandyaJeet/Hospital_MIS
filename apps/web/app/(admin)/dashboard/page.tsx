"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, BedDouble, CheckCircle2, Info, ShieldAlert } from "lucide-react";

import { Badge, Button, Card, Skeleton } from "@/components/ui";
import { getSessionUser, type AuthUser } from "@/lib/data/auth";
import {
  getDashboardSummary,
  getOccupancy,
  getReconciliationSummary,
  getStaffActivity,
  type DashboardSummary,
  type OccupancySnapshot,
  type ReconciliationSummaryRow,
  type StaffActivityDay,
} from "@/lib/data/reporting";
import { formatMoney } from "@/lib/utils/money";

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
        {label}
      </p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums text-text-primary">
        {value}
      </p>
      {hint ? <p className="text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const tRoles = useTranslations("roles");
  const locale = useLocale();

  const [session, setSession] = useState<AuthUser | null>(null);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [occupancy, setOccupancy] = useState<OccupancySnapshot | null>(null);
  const [staff, setStaff] = useState<StaffActivityDay[]>([]);
  const [recon, setRecon] = useState<ReconciliationSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const today = new Date().toISOString().slice(0, 10);
    void Promise.all([
      getSessionUser(),
      getDashboardSummary(),
      getOccupancy(),
      getStaffActivity(today),
      getReconciliationSummary(),
    ]).then(([user, sum, occ, act, rec]) => {
      if (!active) return;
      setSession(user.data);
      if (sum.error) setFailed(true);
      else setSummary(sum.data ?? null);
      setOccupancy(occ.data ?? null);
      setStaff(act.data ?? []);
      setRecon(rec.data ?? []);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <Skeleton className="h-7 w-40" />
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-6 w-16" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // These views are admin-gated inside the view body, so a non-admin gets zero
  // rows rather than an error. Say so explicitly instead of rendering "no data".
  if (!summary && session?.role !== "admin") {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-surface p-10 text-center">
          <ShieldAlert
            className="h-6 w-6 text-text-disabled"
            aria-hidden="true"
          />
          <p className="font-medium text-text-primary">{t("notAdminTitle")}</p>
          <p className="text-sm text-text-secondary">{t("notAdminBody")}</p>
        </div>
      </div>
    );
  }

  if (failed || !summary) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-surface p-8 text-center">
          <p className="text-sm text-text-secondary">{t("loadError")}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.location.reload()}
          >
            {t("retry")}
          </Button>
        </div>
      </div>
    );
  }

  // Default the tile to warning and above — showing today's routine open charges
  // beside a broken invoice makes the broken invoice invisible.
  const actionable = recon.filter((r) => r.severity !== "info");
  const actionableCount = actionable.reduce((s, r) => s + r.finding_count, 0);
  const atStake = actionable.reduce(
    (s, r) => s + (r.total_amount_at_stake ?? 0),
    0,
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-text-secondary">{summary.tenant_name}</p>
      </div>
      {/* Never "today": a clinic day is the UTC date, i.e. 05:30 IST to 05:30 IST. */}
      <p className="mt-1 text-xs text-text-secondary">{t("clinicDayNote")}</p>

      <Card className="mt-6">
        <h2 className="font-medium text-text-primary">{t("todayTitle")}</h2>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Metric label={t("visits")} value={String(summary.visits_today)} />
          <Metric
            label={t("completed")}
            value={String(summary.visits_completed_today)}
          />
          <Metric label={t("openNow")} value={String(summary.visits_open_now)} />
          <Metric
            label={t("newPatients")}
            value={String(summary.new_patients_today)}
          />
          <Metric
            label={t("revenue")}
            value={formatMoney(summary.revenue_today, locale)}
          />
          <Metric
            label={t("collected")}
            value={formatMoney(summary.collected_today, locale)}
          />
        </div>
      </Card>

      <Card className="mt-4">
        <h2 className="font-medium text-text-primary">{t("last30Title")}</h2>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Metric label={t("visits")} value={String(summary.visits_30d)} />
          <Metric
            label={t("newPatients")}
            value={String(summary.new_patients_30d)}
          />
          <Metric
            label={t("revenue")}
            value={formatMoney(summary.revenue_30d, locale)}
          />
          <Metric
            label={t("outstanding")}
            value={formatMoney(summary.outstanding_30d, locale)}
          />
          <Metric
            label={t("totalPatients")}
            value={String(summary.total_patients)}
          />
          <Metric
            label={t("staffCount")}
            value={String(summary.active_staff)}
            hint={t("staffActiveInactive", {
              active: summary.active_staff,
              inactive: summary.inactive_staff,
            })}
          />
        </div>
      </Card>

      <Card className="mt-4">
        <div className="flex items-center gap-2">
          <BedDouble
            className="h-4 w-4 text-text-secondary"
            aria-hidden="true"
          />
          <h2 className="font-medium text-text-primary">
            {t("occupancyTitle")}
          </h2>
        </div>
        {/* occupancy_pct is NULL when no beds exist — "no ward" is not "0% full". */}
        {!occupancy || occupancy.total_beds === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">{t("noWard")}</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Metric
                label={t("occupancy")}
                value={
                  occupancy.occupancy_pct === null
                    ? "—"
                    : `${occupancy.occupancy_pct}%`
                }
              />
              <Metric
                label={t("totalBeds")}
                value={String(occupancy.total_beds)}
              />
              <Metric label={t("occupied")} value={String(occupancy.occupied)} />
              <Metric
                label={t("inpatients")}
                value={String(occupancy.current_inpatients)}
              />
            </div>
            {occupancy.admitted_without_bed > 0 ? (
              <p className="mt-3 flex items-start gap-1.5 text-sm text-text-primary">
                <Info
                  className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
                <span>
                  {t("admittedWithoutBed", {
                    count: occupancy.admitted_without_bed,
                  })}
                  <span className="block text-text-secondary">
                    {t("admittedWithoutBedNote")}
                  </span>
                </span>
              </p>
            ) : null}
          </>
        )}
      </Card>

      <Card className="mt-4">
        <h2 className="font-medium text-text-primary">{t("reconTitle")}</h2>
        {actionableCount === 0 ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-text-secondary">
            <CheckCircle2
              className="h-4 w-4 shrink-0 text-success"
              aria-hidden="true"
            />
            {t("reconClean")}
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="flex items-center gap-1.5 text-sm text-text-primary">
              <AlertTriangle
                className="h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              {t("reconFindings", { count: actionableCount })}
              {atStake > 0
                ? ` · ${t("reconAtStake", { amount: formatMoney(atStake, locale) })}`
                : ""}
            </p>
            <Link
              href="/reconciliation"
              className="ml-auto text-sm font-medium text-accent underline-offset-4 hover:underline"
            >
              {t("viewRecon")}
            </Link>
          </div>
        )}
      </Card>

      <Card className="mt-4">
        <h2 className="font-medium text-text-primary">{t("activityTitle")}</h2>
        {/* Explicitly not utilization: no roster exists, so the denominator can't. */}
        <p className="mt-1 text-xs text-text-secondary">{t("activityNote")}</p>

        {staff.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">{t("noActivity")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {staff.map((person) => (
              <li
                key={person.staff_id}
                className="border-t border-border pt-3 first:border-0 first:pt-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-text-primary">
                    {person.staff_name ?? "—"}
                  </p>
                  <Badge tone={person.staff_is_active ? "neutral" : "warning"}>
                    {tRoles(person.staff_role)}
                  </Badge>
                </div>
                <p className="mt-1 text-sm tabular-nums text-text-secondary">
                  {t("actions")}: {person.recorded_actions_total}
                  {person.consulting_minutes !== null
                    ? ` · ${t("consultingMinutes")}: ${t("minutes", {
                        count: person.consulting_minutes,
                      })}`
                    : ""}
                  {person.avg_consultation_minutes !== null
                    ? ` (${t("avgConsultation", {
                        count: person.avg_consultation_minutes,
                      })})`
                    : ""}
                </p>
                {/* Untimed count sits next to the average, per the contract. */}
                {person.consultations_untimed > 0 ? (
                  <p className="mt-0.5 text-xs text-text-disabled">
                    {t("untimed", { count: person.consultations_untimed })} ·{" "}
                    {t("untimedNote")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
