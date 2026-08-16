import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError } from "./rpc";
import type { Result } from "./types";

/**
 * Clinical notes — `docs/contracts/opd-queue.md` §6.
 *
 * **Every clinical column is nullable and that is a product requirement**
 * (rules.md §1.7): no mandatory field may block a doctor from saving. An empty
 * note is a legitimate state — it means the encounter was opened and saved before
 * anything was written. Do not add client-side required-field validation that the
 * schema deliberately refuses to impose.
 *
 * Note-taking is plain CRUD rather than an RPC, precisely so nothing in the path
 * can reject a save.
 *
 * Visibility: admin, doctor and nurse can read. **Billing gets no rows** — it does
 * not need a diagnosis to raise an invoice, and a default front-desk grant on
 * clinical notes is what DPDP alignment gets judged on. Writing is doctor/admin
 * only, and `author_id` must be the caller: a note cannot be attributed to a
 * colleague. There is no delete.
 */
export const NOTE_FIELDS = [
  "chief_complaint",
  "history",
  "examination",
  "diagnosis",
  "advice",
  "follow_up_instructions",
  "note_text",
] as const;

export type NoteField = (typeof NOTE_FIELDS)[number];

export interface ClinicalNote {
  id: string;
  visit_id: string;
  author_id: string;
  template_type: string | null;
  chief_complaint: string | null;
  history: string | null;
  examination: string | null;
  diagnosis: string | null;
  advice: string | null;
  follow_up_instructions: string | null;
  note_text: string | null;
  created_at: string;
  updated_at: string;
}

export type NewNoteInput = Partial<Record<NoteField, string | null>> & {
  template_type?: string | null;
};

const NOTE_SELECT =
  "id, visit_id, author_id, template_type, chief_complaint, history, examination, diagnosis, advice, follow_up_instructions, note_text, created_at, updated_at";

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realGetNotes(visitId: string): Promise<Result<ClinicalNote[]>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("clinical_notes")
    .select(NOTE_SELECT)
    .eq("visit_id", visitId)
    .order("created_at", { ascending: false });

  // A nurse reading is fine; billing legitimately gets zero rows rather than an
  // error, so an empty list is not evidence of a problem.
  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: (data ?? []) as unknown as ClinicalNote[], error: null };
}

async function realCreateNote(
  visitId: string,
  tenantId: string,
  authorId: string,
  input: NewNoteInput,
): Promise<Result<ClinicalNote>> {
  const supabase = createClient();
  // tenant_id is accepted but pinned by the policy to the caller's own tenant —
  // a forged value is rejected, not trusted.
  const { data, error } = await supabase
    .from("clinical_notes")
    .insert({
      tenant_id: tenantId,
      visit_id: visitId,
      author_id: authorId,
      ...input,
    })
    .select(NOTE_SELECT)
    .single();

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: data as unknown as ClinicalNote, error: null };
}

async function realUpdateNote(
  noteId: string,
  input: NewNoteInput,
): Promise<Result<ClinicalNote>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("clinical_notes")
    .update(input)
    .eq("id", noteId)
    .select(NOTE_SELECT)
    .single();

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: data as unknown as ClinicalNote, error: null };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

const mockNotes = new Map<string, ClinicalNote[]>();
let mockSeq = 0;

function delay(ms = 320) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getNotesForVisit(
  visitId: string,
): Promise<Result<ClinicalNote[]>> {
  if (!USE_MOCK) return realGetNotes(visitId);
  await delay();
  return { data: mockNotes.get(visitId) ?? [], error: null };
}

export async function createNote(
  visitId: string,
  tenantId: string,
  authorId: string,
  input: NewNoteInput,
): Promise<Result<ClinicalNote>> {
  if (!USE_MOCK) return realCreateNote(visitId, tenantId, authorId, input);
  await delay();
  mockSeq += 1;
  const now = new Date().toISOString();
  const note: ClinicalNote = {
    id: `note-${mockSeq}`,
    visit_id: visitId,
    author_id: authorId,
    template_type: input.template_type ?? null,
    chief_complaint: input.chief_complaint ?? null,
    history: input.history ?? null,
    examination: input.examination ?? null,
    diagnosis: input.diagnosis ?? null,
    advice: input.advice ?? null,
    follow_up_instructions: input.follow_up_instructions ?? null,
    note_text: input.note_text ?? null,
    created_at: now,
    updated_at: now,
  };
  // Multiple notes per visit are allowed — a doctor may save early and add an
  // addendum after results. Newest first.
  mockNotes.set(visitId, [note, ...(mockNotes.get(visitId) ?? [])]);
  return { data: note, error: null };
}

export async function updateNote(
  visitId: string,
  noteId: string,
  input: NewNoteInput,
): Promise<Result<ClinicalNote>> {
  if (!USE_MOCK) return realUpdateNote(noteId, input);
  await delay();
  const list = mockNotes.get(visitId) ?? [];
  const note = list.find((n) => n.id === noteId);
  if (!note) {
    return {
      data: null,
      error: { code: "NOTE_NOT_FOUND", message: "That note was not found." },
    };
  }
  Object.assign(note, input, { updated_at: new Date().toISOString() });
  return { data: note, error: null };
}
