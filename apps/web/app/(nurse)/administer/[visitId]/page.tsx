"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  BadgeCheck,
  CircleAlert,
  Pill,
  ScanLine,
  TriangleAlert,
} from "lucide-react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  Spinner,
  Textarea,
  type BadgeProps,
} from "@/components/ui";
import {
  listAdministrableItems,
  recordAdministration,
  scanOutcome,
  verifiedDespiteFailure,
  type AdministrableItem,
  type AdministrationOutcome,
  type AdministrationStatus,
  type ScanOutcome,
} from "@/lib/data/medications";
import type { AppError, Result } from "@/lib/data/types";

const STATUS_TONE: Record<AdministrationStatus, NonNullable<BadgeProps["tone"]>> =
  {
    given: "success",
    refused: "warning",
    held: "neutral",
  };

const STATUSES: AdministrationStatus[] = ["given", "refused", "held"];

interface PendingRepeat {
  itemId: string;
  status: AdministrationStatus;
  notes: string;
  previousAt: string | null;
}

export default function AdministerPage() {
  const t = useTranslations("administer");
  const params = useParams<{ visitId: string }>();
  const visitId = params.visitId;

  const [rows, setRows] = useState<AdministrableItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<AppError | null>(null);

  /**
   * The scanned wristband. Held once for the whole screen rather than per row: a
   * nurse scans at the bedside then works down that patient's list, and re-scanning
   * for every tablet is the friction that gets a check skipped.
   */
  const [scanCode, setScanCode] = useState("");
  const [notes, setNotes] = useState("");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<AdministrationOutcome | null>(null);
  const [failure, setFailure] = useState<{
    kind: ScanOutcome;
    error: AppError;
  } | null>(null);
  const [pendingRepeat, setPendingRepeat] = useState<PendingRepeat | null>(null);

  const apply = useCallback((result: Result<AdministrableItem[]>) => {
    if (result.error) {
      setLoadError(result.error);
    } else {
      setRows(result.data ?? []);
      setLoadError(null);
    }
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await listAdministrableItems(visitId));
  }, [apply, visitId]);

  useEffect(() => {
    let active = true;
    void listAdministrableItems(visitId).then((result) => {
      if (active) apply(result);
    });
    return () => {
      active = false;
    };
  }, [apply, visitId]);

  async function record(
    itemId: string,
    status: AdministrationStatus,
    allowRepeat = false,
    noteOverride?: string,
  ) {
    setBusyItemId(itemId);
    setOutcome(null);
    setFailure(null);

    const { data, error } = await recordAdministration({
      prescriptionItemId: itemId,
      scannedPatientCode: scanCode,
      status,
      notes: (noteOverride ?? notes).trim() || null,
      allowRepeat,
    });
    setBusyItemId(null);

    if (error) {
      const kind = scanOutcome(error.code);
      if (kind === "repeat") {
        // The scan passed; this is only a second dose. Ask, showing the previous
        // time, rather than reporting it like a safety failure.
        setPendingRepeat({
          itemId,
          status,
          notes: noteOverride ?? notes,
          previousAt: error.fields?.[0] ?? null,
        });
        return;
      }
      setFailure({ kind, error });
      return;
    }

    if (data) {
      setOutcome(data);
      setNotes("");
      setPendingRepeat(null);
      await refresh();
    }
  }

  const scanned = scanCode.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>

      <Card className="mt-6">
        <Input
          label={t("scanLabel")}
          value={scanCode}
          onChange={(e) => setScanCode(e.target.value)}
          autoFocus
          autoComplete="off"
          // A ward scanner is a keyboard wedge, so it types into the focused field.
          // A typed UHID is the same call — the server resolves either form.
          helperText={t("scanHelp")}
        />
        <p className="mt-2 flex items-start gap-1.5 text-xs text-text-disabled">
          <ScanLine className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("scanPrivacyNote")}
        </p>
      </Card>

      {/* Verified is stated, never assumed: a silent success is indistinguishable
          from a check that never ran (nurse-tasks.md §7). */}
      {outcome ? (
        <Card className="mt-4 border-success bg-success/5">
          <p className="flex items-start gap-2 font-medium text-text-primary">
            <BadgeCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-success"
              aria-hidden="true"
            />
            {t(`recorded.${outcome.status}`, {
              drug: outcome.drug_name ?? t("thisMedicine"),
            })}
          </p>
          <p className="mt-1 pl-7 text-sm text-text-primary">
            {t("patientVerified")}
            {outcome.scan_basis
              ? ` · ${t(`basis.${outcome.scan_basis}`)}`
              : ""}
          </p>
          {outcome.dose ? (
            <p className="mt-0.5 pl-7 text-sm text-text-secondary">
              {outcome.dose}
            </p>
          ) : null}
        </Card>
      ) : null}

      {/*
        Three failures, three messages. Collapsing them would hide the one error class
        this whole mechanism exists to catch (nurse-tasks.md §7, rules.md §3.4).
        `mismatch` gets the modal below instead.
      */}
      {failure && failure.kind !== "mismatch" ? (
        <Card className="mt-4 border-warning bg-warning/5">
          <p
            role="alert"
            className="flex items-start gap-2 text-sm font-medium text-text-primary"
          >
            <TriangleAlert
              className="mt-0.5 h-4 w-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            <span>
              {failure.kind === "unreadable"
                ? t("unrecognisedTitle")
                : failure.kind === "missing"
                  ? t("scanRequiredTitle")
                  : failure.kind === "blocked"
                    ? t(
                        failure.error.code === "PRESCRIPTION_CANCELLED"
                          ? "cancelledTitle"
                          : "notIssuedTitle",
                      )
                    : failure.error.message}
            </span>
          </p>
          {failure.kind === "unreadable" || failure.kind === "missing" ? (
            <p className="mt-1 pl-6 text-sm text-text-secondary">
              {failure.kind === "unreadable"
                ? t("unrecognisedBody")
                : t("scanRequiredBody")}
            </p>
          ) : null}
          {/* Never let a failed check read as a pass. */}
          {!verifiedDespiteFailure(failure.error.code) ? (
            <p className="mt-1 pl-6 text-sm font-medium text-warning">
              {t("notVerified")}
            </p>
          ) : null}
        </Card>
      ) : null}

      <h2 className="mt-8 text-lg font-medium">{t("medicinesTitle")}</h2>

      <div className="mt-3 flex flex-col gap-3">
        {loading ? (
          [0, 1].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-2 h-3 w-24" />
            </Card>
          ))
        ) : loadError ? (
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
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Pill}
            title={t("empty")}
            description={t("emptyBody")}
          />
        ) : (
          rows.map(({ item, administrations }) => {
            const busy = busyItemId === item.id;
            const askingRepeat = pendingRepeat?.itemId === item.id;

            return (
              <Card key={item.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-text-primary">
                      {item.drug_name}
                    </p>
                    <p className="text-sm text-text-secondary">
                      {[item.dose, item.frequency, item.duration]
                        .filter(Boolean)
                        .join(" · ") || t("noDoseRecorded")}
                    </p>
                    {item.instructions ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        {item.instructions}
                      </p>
                    ) : null}
                  </div>
                  {administrations.length > 0 ? (
                    <Badge tone={STATUS_TONE[administrations[0].status]}>
                      {t(`status.${administrations[0].status}`)}
                    </Badge>
                  ) : null}
                </div>

                {/* Dose history, so a repeat is a judgement rather than a guess.
                    The log is append-only — nothing here can be corrected yet. */}
                {administrations.length > 0 ? (
                  <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
                    {administrations.map((entry) => (
                      <li key={entry.id} className="text-sm">
                        <span className="text-text-primary">
                          {t(`status.${entry.status}`)}
                        </span>{" "}
                        <span className="text-text-secondary">
                          {new Date(entry.administered_at).toLocaleString()}
                        </span>
                        {entry.notes ? (
                          <span className="text-text-secondary">
                            {" · "}
                            {entry.notes}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {askingRepeat ? (
                  <div className="mt-3 rounded-md border border-warning bg-warning/5 p-3">
                    <p className="text-sm font-medium text-text-primary">
                      {t("repeatTitle")}
                    </p>
                    <p className="mt-1 text-sm text-text-secondary">
                      {pendingRepeat.previousAt
                        ? t("repeatBodyWithTime", {
                            time: new Date(
                              pendingRepeat.previousAt,
                            ).toLocaleString(),
                          })
                        : t("repeatBody")}
                    </p>
                    {/* The scan passed. Say so, or this reads as a safety failure. */}
                    <p className="mt-1 text-sm text-success">
                      {t("repeatStillVerified")}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void record(
                            item.id,
                            pendingRepeat.status,
                            true,
                            pendingRepeat.notes,
                          )
                        }
                      >
                        {busy ? <Spinner /> : null}
                        {t("repeatConfirm")}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPendingRepeat(null)}
                      >
                        {t("cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    {STATUSES.map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant={status === "given" ? "primary" : "secondary"}
                        // Blocked until something is scanned. The server enforces
                        // this with SCAN_REQUIRED; disabling it here explains why
                        // instead of letting the nurse discover it by failing.
                        disabled={busy || !scanned}
                        onClick={() => void record(item.id, status)}
                      >
                        {busy ? <Spinner /> : null}
                        {t(`action.${status}`)}
                      </Button>
                    ))}
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>

      {rows.length > 0 ? (
        <div className="mt-6">
          <Textarea
            label={t("notesLabel")}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            helperText={t("notesHelp")}
          />
        </div>
      ) : null}

      {!scanned && rows.length > 0 ? (
        <p className="mt-3 text-sm text-text-secondary">{t("scanFirst")}</p>
      ) : null}

      <p className="mt-8 text-xs text-text-disabled">{t("appendOnlyNote")}</p>

      {/*
        Wrong patient is the one error class this mechanism exists to catch, so it
        interrupts rather than sitting in a banner (nurse-tasks.md §7).

        It names neither patient, by design — the nurse is at the wrong bedside and
        the remedy is to stop, not to be handed a second patient's identity.

        Note: like the prescribe interrupt, this traps neither focus nor scroll. A
        real focus trap is still owed if this pattern spreads further.
      */}
      {failure?.kind === "mismatch" ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="mismatch-title"
            className="w-full max-w-md rounded-lg border border-critical bg-surface p-6"
          >
            <div className="flex items-start gap-2">
              <CircleAlert
                className="mt-0.5 h-6 w-6 shrink-0 text-critical"
                aria-hidden="true"
              />
              <div>
                <h2
                  id="mismatch-title"
                  className="text-lg font-semibold text-critical"
                >
                  {t("mismatchTitle")}
                </h2>
                <p className="mt-1 text-sm text-text-primary">
                  {t("mismatchBody")}
                </p>
              </div>
            </div>

            <p className="mt-4 rounded-md border border-critical/40 bg-critical/5 p-3 text-sm text-text-primary">
              {t("mismatchNothingRecorded")}
            </p>

            <div className="mt-5 flex justify-end">
              <Button
                onClick={() => {
                  setFailure(null);
                  // Clear the band so the next action cannot inherit a code already
                  // known to be wrong.
                  setScanCode("");
                }}
              >
                {t("mismatchAcknowledge")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
