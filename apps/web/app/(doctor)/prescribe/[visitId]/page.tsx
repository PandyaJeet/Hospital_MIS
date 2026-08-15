"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Badge, Button, Card, Input, Spinner } from "@/components/ui";
import { getSessionUser, type AuthUser } from "@/lib/data/auth";
import {
  addItem,
  checkSafety,
  createDraft,
  getDraftForVisit,
  issuePrescription,
  removeItem,
  searchDrugs,
  visitPatient,
  type Drug,
  type Prescription,
  type SafetyReport,
  type Severity,
} from "@/lib/data/prescriptions";

const severityTone: Record<Severity, "info" | "warning" | "critical"> = {
  low: "info",
  medium: "warning",
  high: "critical",
};

export default function PrescribeVisitPage() {
  const t = useTranslations("prescribe");
  const params = useParams<{ visitId: string }>();
  const visitId = params.visitId;

  const [session, setSession] = useState<AuthUser | null>(null);
  const [rx, setRx] = useState<Prescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    "start" | "add" | "check" | "issue" | "remove" | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [drugName, setDrugName] = useState("");
  const [selectedDrug, setSelectedDrug] = useState<Drug | null>(null);
  const [suggestions, setSuggestions] = useState<Drug[]>([]);
  const [dose, setDose] = useState("");
  const [frequency, setFrequency] = useState("");
  const [duration, setDuration] = useState("");

  const [safety, setSafety] = useState<SafetyReport | null>(null);
  const [safetyFailed, setSafetyFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [showInterrupt, setShowInterrupt] = useState(false);
  const [issuedCount, setIssuedCount] = useState<number | null>(null);

  const patient = visitPatient(visitId);

  useEffect(() => {
    let active = true;
    void Promise.all([getSessionUser(), getDraftForVisit(visitId)]).then(
      ([user, draft]) => {
        if (!active) return;
        setSession(user.data);
        setRx(draft.data ?? null);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [visitId]);

  // Autosuggest against the shared drug reference. A miss is fine — free text is
  // allowed and is what makes the safety check report `partial` (§3).
  useEffect(() => {
    const term = drugName.trim();
    if (term.length < 2) return;
    let active = true;
    void searchDrugs(term).then((result) => {
      if (active) setSuggestions(result.data ?? []);
    });
    return () => {
      active = false;
    };
  }, [drugName]);

  // Derived rather than cleared via setState, so the effect never writes state
  // synchronously. Also hides the list once a drug has been picked.
  const visibleSuggestions =
    drugName.trim().length >= 2 && !selectedDrug ? suggestions : [];

  function messageFor(code: string) {
    switch (code) {
      case "PRESCRIPTION_EMPTY":
        return t("empty");
      case "PRESCRIPTION_ALREADY_ISSUED":
        return t("alreadyIssued");
      case "NOT_PRESCRIBER":
        return t("notPrescriber");
      case "PRESCRIPTION_NOT_FOUND":
        return t("notFound");
      case "NETWORK_ERROR":
        return t("networkError");
      case "PERMISSION_DENIED":
        return t("permissionError");
      default:
        return t("genericError");
    }
  }

  const isIssued = rx?.status === "issued";

  async function reload() {
    const { data } = await getDraftForVisit(visitId);
    setRx(data ?? null);
  }

  async function onStart() {
    setActionError(null);
    setBusy("start");
    const { data, error } = await createDraft(
      visitId,
      session?.tenantId ?? "mock-tenant-1",
      session?.userId ?? "mock-user-1",
    );
    setBusy(null);
    if (error) {
      setActionError(messageFor(error.code));
      return;
    }
    setRx(data);
  }

  async function onAddItem() {
    if (!rx || !drugName.trim()) return;
    setActionError(null);
    setBusy("add");
    const { error } = await addItem(
      rx,
      session?.tenantId ?? "mock-tenant-1",
      {
        drug_id: selectedDrug?.id ?? null,
        drug_name: drugName.trim(),
        generic_name: selectedDrug?.generic_name ?? null,
        dose: dose.trim() || null,
        frequency: frequency.trim() || null,
        duration: duration.trim() || null,
      },
    );
    setBusy(null);
    if (error) {
      setActionError(messageFor(error.code));
      return;
    }
    setDrugName("");
    setSelectedDrug(null);
    setSuggestions([]);
    setDose("");
    setFrequency("");
    setDuration("");
    // Any change to the medicine list invalidates a previous safety result.
    setSafety(null);
    setSafetyFailed(false);
    setAcknowledged(false);
    await reload();
  }

  async function onRemove(itemId: string) {
    if (!rx) return;
    setActionError(null);
    setBusy("remove");
    const { error } = await removeItem(rx, itemId);
    setBusy(null);
    if (error) {
      setActionError(messageFor(error.code));
      return;
    }
    setSafety(null);
    setSafetyFailed(false);
    setAcknowledged(false);
    await reload();
  }

  async function onCheck() {
    if (!rx || rx.items.length === 0) return;
    setActionError(null);
    setSafetyFailed(false);
    setBusy("check");
    const { data, error } = await checkSafety(
      visitId,
      patient?.patient_id ?? "",
      rx.items.map((i) => i.drug_name),
    );
    setBusy(null);

    if (error) {
      // A failed check must be visible and must not read as "safe" (rules.md §3.4).
      setSafetyFailed(true);
      setSafety(null);
      return;
    }
    setSafety(data);
    setAcknowledged(false);
    // Only `high` gets a blocking interrupt; `partial` is a visible banner (§4).
    if (data?.highest_severity === "high") setShowInterrupt(true);
  }

  async function onIssue() {
    if (!rx) return;
    setActionError(null);
    if (safety?.highest_severity === "high" && !acknowledged) {
      setActionError(t("mustAcknowledge"));
      setShowInterrupt(true);
      return;
    }
    setBusy("issue");
    const { data, error } = await issuePrescription(rx);
    setBusy(null);
    if (error) {
      setActionError(messageFor(error.code));
      return;
    }
    setIssuedCount(data?.item_count ?? rx.items.length);
    await reload();
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <Spinner className="h-5 w-5 text-accent" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          {patient ? (
            <p className="mt-1 text-sm text-text-secondary">
              {t("forPatient", { patient: patient.patient_name })}
            </p>
          ) : null}
        </div>
        {rx ? (
          <Badge tone={isIssued ? "success" : "warning"}>
            {isIssued ? t("statusIssued") : t("statusDraft")}
          </Badge>
        ) : null}
      </div>

      {rx && !isIssued ? (
        <p className="mt-3 text-sm text-text-secondary">{t("draftNotice")}</p>
      ) : null}

      {issuedCount !== null ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-success/10 p-4">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium text-text-primary">{t("issuedTitle")}</p>
            <p className="text-sm text-text-secondary">
              {t("issuedBody", { count: issuedCount })}
            </p>
          </div>
        </div>
      ) : null}

      {actionError ? (
        <p
          role="alert"
          className="mt-4 flex items-center gap-1.5 text-sm text-text-secondary"
        >
          <AlertCircle
            className="h-4 w-4 shrink-0 text-warning"
            aria-hidden="true"
          />
          {actionError}
        </p>
      ) : null}

      {!rx ? (
        <Card className="mt-6">
          <h2 className="font-medium text-text-primary">{t("startTitle")}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t("startBody")}</p>
          <div className="mt-4">
            <Button disabled={busy !== null} onClick={() => void onStart()}>
              {busy === "start" ? (
                <>
                  <Spinner />
                  {t("starting")}
                </>
              ) : (
                t("start")
              )}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <Card className="mt-6">
            <h2 className="font-medium text-text-primary">{t("itemsTitle")}</h2>
            {rx.items.length === 0 ? (
              <p className="mt-2 text-sm text-text-secondary">{t("noItems")}</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {rx.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">
                        {item.drug_name}
                      </p>
                      <p className="text-sm text-text-secondary">
                        {[item.generic_name, item.dose, item.frequency, item.duration]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {item.drug_id === null ? (
                        <p className="mt-1 text-xs text-text-disabled">
                          {t("notInReference")}
                        </p>
                      ) : null}
                    </div>
                    {!isIssued ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void onRemove(item.id)}
                        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        {t("remove")}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {isIssued ? (
            <p className="mt-4 text-sm text-text-secondary">
              {t("editingLocked")}
            </p>
          ) : (
            <Card className="mt-4">
              <div className="flex flex-col gap-3">
                <div className="relative">
                  <Input
                    label={t("drug")}
                    placeholder={t("drugPlaceholder")}
                    value={drugName}
                    onChange={(event) => {
                      setDrugName(event.target.value);
                      setSelectedDrug(null);
                    }}
                  />
                  {visibleSuggestions.length > 0 ? (
                    <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface shadow-lg">
                      {visibleSuggestions.map((drug) => (
                        <li key={drug.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setDrugName(drug.brand_name);
                              setSelectedDrug(drug);
                              setSuggestions([]);
                            }}
                            className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-surface-muted"
                          >
                            <span className="text-sm font-medium text-text-primary">
                              {drug.brand_name}
                            </span>
                            <span className="text-xs text-text-secondary">
                              {[drug.generic_name, drug.strength, drug.form]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Input
                    label={t("dose")}
                    placeholder={t("dosePlaceholder")}
                    value={dose}
                    onChange={(event) => setDose(event.target.value)}
                  />
                  <Input
                    label={t("frequency")}
                    placeholder={t("frequencyPlaceholder")}
                    value={frequency}
                    onChange={(event) => setFrequency(event.target.value)}
                  />
                  <Input
                    label={t("duration")}
                    placeholder={t("durationPlaceholder")}
                    value={duration}
                    onChange={(event) => setDuration(event.target.value)}
                  />
                </div>

                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null || !drugName.trim()}
                    onClick={() => void onAddItem()}
                  >
                    {busy === "add" ? (
                      <>
                        <Spinner />
                        {t("adding")}
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        {t("addItem")}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* Safety results. Silent by default: a clean complete check shows a
              single quiet line, findings show inline, partial shows a banner,
              and only `high` interrupts (§4). */}
          {safetyFailed ? (
            <p className="mt-4 flex items-start gap-1.5 text-sm text-text-primary">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              {t("safetyUnavailable")}
            </p>
          ) : null}

          {safety ? (
            <div className="mt-4 flex flex-col gap-3">
              {safety.status === "partial" ? (
                <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning/10 p-3">
                  <Info
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <div className="text-sm text-text-primary">
                    <p>{t("safetyPartial")}</p>
                    {safety.unknown_drugs.length > 0 ? (
                      <p className="mt-1 text-text-secondary">
                        {t("unknownDrugs", {
                          drugs: safety.unknown_drugs.join(", "),
                        })}
                      </p>
                    ) : null}
                    {!safety.allergies_recorded ? (
                      <p className="mt-1 text-text-secondary">
                        {t("noAllergiesRecorded")}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {safety.findings.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {safety.findings.map((finding, index) => (
                    <li
                      key={`${finding.drug_a}-${finding.drug_b ?? "solo"}-${index}`}
                      className="rounded-md border border-border p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={severityTone[finding.severity]}>
                          {finding.finding_type === "allergy"
                            ? t("findingAllergy")
                            : t("findingInteraction")}
                          {" · "}
                          {t(
                            `severity${finding.severity.charAt(0).toUpperCase()}${finding.severity.slice(1)}`,
                          )}
                        </Badge>
                        <span className="text-sm font-medium text-text-primary">
                          {finding.drug_b
                            ? `${finding.drug_a} + ${finding.drug_b}`
                            : finding.drug_a}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-text-secondary">
                        {finding.description}
                      </p>
                      <p className="mt-1 text-xs text-text-disabled">
                        {t("matchBasis", { basis: finding.match_basis })}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : safety.status === "complete" ? (
                <p className="flex items-center gap-1.5 text-sm text-text-secondary">
                  <ShieldCheck
                    className="h-4 w-4 shrink-0 text-success"
                    aria-hidden="true"
                  />
                  {t("safetyClean")}
                </p>
              ) : null}

              {acknowledged ? (
                <p className="text-sm text-text-secondary">
                  {t("acknowledged")}
                </p>
              ) : null}

              <p className="text-xs text-text-disabled">
                {safety.reference_disclaimer}
              </p>
            </div>
          ) : null}

          {!isIssued ? (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                disabled={busy !== null || rx.items.length === 0}
                onClick={() => void onCheck()}
              >
                {busy === "check" ? (
                  <>
                    <Spinner />
                    {t("checking")}
                  </>
                ) : (
                  t("checkSafety")
                )}
              </Button>
              <Button
                type="button"
                disabled={busy !== null || rx.items.length === 0}
                onClick={() => void onIssue()}
              >
                {busy === "issue" ? (
                  <>
                    <Spinner />
                    {t("issuing")}
                  </>
                ) : (
                  t("issue")
                )}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {/* High severity is the one hard interrupt (PRD §6.1, rules.md §6.4).
          Note: this traps neither focus nor scroll — a real focus trap is still
          owed if this pattern is reused. */}
      {showInterrupt && safety ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="safety-interrupt-title"
            className="w-full max-w-md rounded-lg border border-critical bg-surface p-6"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-6 w-6 shrink-0 text-critical"
                aria-hidden="true"
              />
              <div>
                <h2
                  id="safety-interrupt-title"
                  className="text-lg font-semibold text-text-primary"
                >
                  {t("highTitle")}
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {t("highBody")}
                </p>
              </div>
            </div>

            <ul className="mt-4 flex flex-col gap-2">
              {safety.findings
                .filter((f) => f.severity === "high")
                .map((finding, index) => (
                  <li
                    key={`hi-${index}`}
                    className="rounded-md border border-critical/40 bg-critical/5 p-3 text-sm"
                  >
                    <p className="font-medium text-text-primary">
                      {finding.drug_b
                        ? `${finding.drug_a} + ${finding.drug_b}`
                        : finding.drug_a}
                    </p>
                    <p className="mt-0.5 text-text-secondary">
                      {finding.description}
                    </p>
                  </li>
                ))}
            </ul>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
              <Button
                type="button"
                variant="destructive"
                autoFocus
                onClick={() => {
                  setAcknowledged(true);
                  setShowInterrupt(false);
                }}
              >
                {t("acknowledge")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowInterrupt(false)}
              >
                {t("reviewAgain")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
