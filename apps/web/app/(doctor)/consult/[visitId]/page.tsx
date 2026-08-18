"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AlertCircle, CheckCircle2, Eye, Plus } from "lucide-react";

import { Button, Card, Spinner, Textarea } from "@/components/ui";
import { getSessionUser, type AuthUser } from "@/lib/data/auth";
import {
  createNote,
  getNotesForVisit,
  NOTE_FIELDS,
  updateNote,
  type ClinicalNote,
  type NewNoteInput,
  type NoteField,
} from "@/lib/data/notes";
import { visitPatient } from "@/lib/data/prescriptions";

type Draft = Record<NoteField, string>;

const EMPTY: Draft = {
  chief_complaint: "",
  history: "",
  examination: "",
  diagnosis: "",
  advice: "",
  follow_up_instructions: "",
  note_text: "",
};

function toDraft(note: ClinicalNote): Draft {
  return NOTE_FIELDS.reduce((acc, field) => {
    acc[field] = note[field] ?? "";
    return acc;
  }, {} as Draft);
}

/**
 * The consultation note.
 *
 * **No field is required.** rules.md §1.7 makes that a product requirement, not a
 * nicety: a doctor mid-clinic must always be able to save. An entirely empty note
 * is a legitimate save, so the button is never disabled on emptiness.
 */
export default function ConsultPage() {
  const t = useTranslations("consult");
  const locale = useLocale();
  const params = useParams<{ visitId: string }>();
  const visitId = params.visitId;

  const [session, setSession] = useState<AuthUser | null>(null);
  const [notes, setNotes] = useState<ClinicalNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const patient = visitPatient(visitId);
  // Nurses may read notes but not author them (opd-queue.md §6).
  const canWrite = session?.role === "doctor" || session?.role === "admin";

  useEffect(() => {
    let active = true;
    void Promise.all([getSessionUser(), getNotesForVisit(visitId)]).then(
      ([user, list]) => {
        if (!active) return;
        setSession(user.data);
        setNotes(list.data ?? []);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [visitId]);

  function update(field: NoteField, value: string) {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  function messageFor(code: string) {
    switch (code) {
      case "42501":
      case "PERMISSION_DENIED":
        return t("permissionError");
      case "NETWORK_ERROR":
        return t("networkError");
      default:
        return t("genericError");
    }
  }

  function buildInput(): NewNoteInput {
    const input: NewNoteInput = {};
    for (const field of NOTE_FIELDS) {
      const value = draft[field].trim();
      input[field] = value ? value : null;
    }
    return input;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setSaving(true);

    const result = editingId
      ? await updateNote(visitId, editingId, buildInput())
      : await createNote(
          visitId,
          session?.tenantId ?? "mock-tenant-1",
          session?.userId ?? "mock-user-1",
          buildInput(),
        );

    setSaving(false);
    if (result.error) {
      setFormError(messageFor(result.error.code));
      return;
    }

    setSaved(true);
    setEditingId(null);
    setDraft(EMPTY);
    const refreshed = await getNotesForVisit(visitId);
    setNotes(refreshed.data ?? []);
  }

  const timeFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <Spinner className="h-5 w-5 text-accent" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      {patient ? (
        <p className="mt-1 text-sm text-text-secondary">
          {t("forPatient", { patient: patient.patient_name })}
        </p>
      ) : null}

      {canWrite ? (
        <p className="mt-2 text-sm text-text-secondary">{t("subtitle")}</p>
      ) : (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface-muted p-4">
          <Eye
            className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium text-text-primary">
              {t("readOnlyTitle")}
            </p>
            <p className="text-sm text-text-secondary">{t("readOnlyBody")}</p>
          </div>
        </div>
      )}

      {saved ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-success/10 p-4">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium text-text-primary">{t("savedTitle")}</p>
            <p className="text-sm text-text-secondary">{t("savedBody")}</p>
          </div>
        </div>
      ) : null}

      {canWrite ? (
        <Card className="mt-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {NOTE_FIELDS.map((field) => (
              <Textarea
                key={field}
                label={t(field)}
                value={draft[field]}
                onChange={(event) => update(field, event.target.value)}
                className={field === "note_text" ? "min-h-24" : "min-h-16"}
              />
            ))}

            {formError ? (
              <p
                role="alert"
                className="flex items-center gap-1.5 text-sm text-text-secondary"
              >
                <AlertCircle
                  className="h-4 w-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
                {formError}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              {/* Never disabled on emptiness — an empty note is a valid save. */}
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <Spinner />
                    {editingId ? t("updating") : t("saving")}
                  </>
                ) : editingId ? (
                  t("update")
                ) : (
                  t("save")
                )}
              </Button>
              {editingId ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setEditingId(null);
                    setDraft(EMPTY);
                  }}
                >
                  {t("cancelEdit")}
                </Button>
              ) : null}
              <Link
                href={`/prescribe/${visitId}`}
                className="ml-auto text-sm font-medium text-accent underline-offset-4 hover:underline"
              >
                {t("prescribeLink")}
              </Link>
            </div>
          </form>
        </Card>
      ) : null}

      <section className="mt-6">
        <h2 className="text-lg font-medium">{t("previous")}</h2>
        {notes.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">{t("none")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {notes.map((note) => {
              const filled = NOTE_FIELDS.filter((f) => note[f]);
              const mine = note.author_id === session?.userId;
              return (
                <li key={note.id}>
                  <Card>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm tabular-nums text-text-secondary">
                        {timeFormat.format(new Date(note.created_at))}
                        {note.updated_at !== note.created_at
                          ? ` · ${t("editedAt", {
                              time: timeFormat.format(new Date(note.updated_at)),
                            })}`
                          : ""}
                      </p>
                      {/* Updates are author-only, so only offer it on your own. */}
                      {canWrite && mine ? (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(note.id);
                            setDraft(toDraft(note));
                            setSaved(false);
                          }}
                          className="text-sm font-medium text-accent underline-offset-4 hover:underline"
                        >
                          {t("edit")}
                        </button>
                      ) : null}
                    </div>

                    {filled.length === 0 ? (
                      <p className="mt-2 text-sm italic text-text-disabled">
                        {t("emptyNote")}
                      </p>
                    ) : (
                      <dl className="mt-2 flex flex-col gap-2">
                        {filled.map((field) => (
                          <div key={field}>
                            <dt className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                              {t(field)}
                            </dt>
                            <dd className="whitespace-pre-wrap text-sm text-text-primary">
                              {note[field]}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        {canWrite && notes.length > 0 && !editingId ? (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-text-secondary">
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("addAddendum")}
          </p>
        ) : null}
      </section>
    </div>
  );
}
