import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { mapPostgrestError, rpcUntyped, untypedClient } from "./rpc";
import type { PrescriptionItem } from "./prescriptions";
import type { Result } from "./types";

/**
 * Medication administration — `docs/contracts/nurse-tasks.md` §6–7.
 *
 * Two things drive everything here:
 *
 * **There is no client INSERT on `medication_administrations`, and that is the
 * point** (§6). The right-patient check must not be bypassable by a direct PostgREST
 * call, so every write goes through `record_medication_administration()`. There is
 * deliberately no function in this module that inserts a row.
 *
 * **The three scan failures are three different codes** (§7). `PATIENT_MISMATCH`,
 * `PATIENT_CODE_UNRECOGNISED` and `SCAN_REQUIRED` must never be collapsed into one
 * "couldn't save" message — a wrong-patient event is the entire reason barcode
 * administration exists, and an unreadable band is emphatically not a verified one
 * (rules.md §3.4). Use `scanOutcome()` below rather than testing codes ad hoc.
 */

export type AdministrationStatus = "given" | "refused" | "held";

/** How the scanned code resolved. Recorded; the raw payload never is. */
export type ScanBasis = "patient_id" | "patient_number";

export interface Administration {
  id: string;
  prescription_item_id: string;
  visit_id: string;
  administered_by: string;
  administered_at: string;
  status: AdministrationStatus;
  notes: string | null;
  scan_basis: ScanBasis | null;
}

/** An issued item a dose can be recorded against, with its own dose history. */
export interface AdministrableItem {
  item: PrescriptionItem;
  prescription_id: string;
  administrations: Administration[];
}

export interface AdministrationOutcome {
  administration_id: string;
  prescription_item_id: string;
  visit_id: string;
  status: AdministrationStatus;
  /** Show this. A silent success looks identical to a check never performed (§7). */
  patient_verified: true;
  scan_basis: ScanBasis | null;
  drug_name: string | null;
  dose: string | null;
}

export interface PreviousAdministration {
  id: string;
  administered_at: string;
  administered_by: string;
}

/**
 * What went wrong with a scan, in the terms the nurse needs.
 *
 *  `mismatch`    — resolved to a real patient, and it is not this one. Interrupt hard.
 *  `unreadable`  — resolved to nobody. Re-scan or verify by hand. NOT a pass.
 *  `missing`     — nothing was scanned. Block and prompt.
 *  `repeat`      — verified correctly, but this item already has a dose logged.
 *  `blocked`     — the drug itself must not be given (draft or cancelled script).
 *  `other`       — anything else.
 */
export type ScanOutcome =
  | "mismatch"
  | "unreadable"
  | "missing"
  | "repeat"
  | "blocked"
  | "other";

export function scanOutcome(code: string): ScanOutcome {
  switch (code) {
    case "PATIENT_MISMATCH":
      return "mismatch";
    case "PATIENT_CODE_UNRECOGNISED":
      return "unreadable";
    case "SCAN_REQUIRED":
      return "missing";
    case "ALREADY_ADMINISTERED":
      return "repeat";
    case "PRESCRIPTION_NOT_ISSUED":
    case "PRESCRIPTION_CANCELLED":
      return "blocked";
    default:
      return "other";
  }
}

/**
 * Whether the right-patient check passed, for a *failed* call.
 *
 * `ALREADY_ADMINISTERED` comes back with `patient_verified: true` — the scan was
 * correct, the dose is simply a repeat. That distinction is how the prompt gets
 * worded correctly instead of implying a wrong-patient event (§7).
 */
export function verifiedDespiteFailure(code: string) {
  return code === "ALREADY_ADMINISTERED";
}

const ITEM_SELECT =
  "id, prescription_id, drug_id, drug_name, generic_name, is_generic, dose, frequency, duration, instructions, quantity, unit_price, created_at";

function toAdministration(row: Record<string, unknown>): Administration {
  return {
    id: String(row.id ?? ""),
    prescription_item_id: String(row.prescription_item_id ?? ""),
    visit_id: String(row.visit_id ?? ""),
    administered_by: String(row.administered_by ?? ""),
    administered_at: String(row.administered_at ?? ""),
    status: (row.status as AdministrationStatus) ?? "given",
    notes: (row.notes as string | null) ?? null,
    scan_basis: (row.scan_basis as ScanBasis | null) ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Items a dose may be recorded against for one visit, newest prescription first.
 *
 * Filters to `issued`: a draft was never authorised and a cancelled one is an
 * explicit instruction not to administer. The RPC refuses both anyway, but offering
 * an unadministrable drug and then rejecting it is a worse screen than not offering
 * it (§7).
 */
async function realListItems(
  visitId: string,
): Promise<Result<AdministrableItem[]>> {
  const supabase = untypedClient(createClient());

  const { data: scripts, error: scriptError } = await supabase
    .from("prescriptions")
    .select(`id, status, issued_at, items:prescription_items(${ITEM_SELECT})`)
    .eq("visit_id", visitId)
    .eq("status", "issued")
    .order("issued_at", { ascending: false });

  if (scriptError) {
    return { data: null, error: mapPostgrestError(scriptError) };
  }

  const { data: logged, error: logError } = await supabase
    .from("medication_administrations")
    .select(
      "id, prescription_item_id, visit_id, administered_by, administered_at, status, notes, scan_basis",
    )
    .eq("visit_id", visitId)
    .order("administered_at", { ascending: false });

  // A failed history read must not hide the drug list — but it also must not be
  // reported as "no doses given", which would invite a double dose. Surface it.
  if (logError) return { data: null, error: mapPostgrestError(logError) };

  const history = ((logged ?? []) as Record<string, unknown>[]).map(
    toAdministration,
  );

  const rows: AdministrableItem[] = [];
  for (const script of (scripts ?? []) as Record<string, unknown>[]) {
    const items = (script.items ?? []) as Record<string, unknown>[];
    for (const raw of items) {
      const item = raw as unknown as PrescriptionItem;
      rows.push({
        item,
        prescription_id: String(script.id ?? ""),
        administrations: history.filter(
          (a) => a.prescription_item_id === item.id,
        ),
      });
    }
  }
  return { data: rows, error: null };
}

interface AdminPayload {
  administration_id?: string;
  prescription_item_id?: string;
  visit_id?: string;
  status?: AdministrationStatus;
  scan_basis?: ScanBasis | null;
  drug_name?: string | null;
  dose?: string | null;
}

async function realRecord(input: {
  prescriptionItemId: string;
  scannedPatientCode: string;
  status: AdministrationStatus;
  notes: string | null;
  allowRepeat: boolean;
}): Promise<Result<AdministrationOutcome>> {
  const result = await rpcUntyped<AdminPayload>(
    createClient(),
    "record_medication_administration",
    {
      p_prescription_item_id: input.prescriptionItemId,
      p_scanned_patient_code: input.scannedPatientCode,
      p_status: input.status,
      p_notes: input.notes,
      p_allow_repeat: input.allowRepeat,
    },
  );
  if (!result.data) return { data: null, error: result.error };
  const p = result.data;
  return {
    data: {
      administration_id: String(p.administration_id ?? ""),
      prescription_item_id: String(
        p.prescription_item_id ?? input.prescriptionItemId,
      ),
      visit_id: String(p.visit_id ?? ""),
      status: p.status ?? input.status,
      patient_verified: true,
      scan_basis: p.scan_basis ?? null,
      drug_name: p.drug_name ?? null,
      dose: p.dose ?? null,
    },
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

function delay(ms = 320) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minutesAgo(m: number) {
  return new Date(Date.now() - m * 60_000).toISOString();
}

function mockItem(
  id: string,
  drug: string,
  dose: string,
  frequency: string,
): PrescriptionItem {
  return {
    id,
    prescription_id: "rx-issued-1",
    drug_id: null,
    drug_name: drug,
    generic_name: null,
    is_generic: false,
    dose,
    frequency,
    duration: "3 days",
    instructions: null,
    quantity: 9,
    unit_price: null,
    created_at: minutesAgo(240),
  };
}

/** Visit `ipd-2` matches the rounds and labs mocks — the inpatient in G-01. */
let mockAdministrations: Administration[] = [
  {
    id: "ma-1",
    prescription_item_id: "item-1",
    visit_id: "ipd-2",
    administered_by: "mock-user-3",
    administered_at: minutesAgo(200),
    status: "given",
    notes: null,
    scan_basis: "patient_number",
  },
  {
    id: "ma-2",
    prescription_item_id: "item-2",
    visit_id: "ipd-2",
    administered_by: "mock-user-3",
    administered_at: minutesAgo(150),
    // A refusal is a clinically important event, not a failure to record.
    status: "refused",
    notes: "Patient declined — nauseous",
    scan_basis: "patient_number",
  },
];

const MOCK_ITEMS: PrescriptionItem[] = [
  mockItem("item-1", "Dolo 650", "650 mg", "TDS"),
  mockItem("item-2", "Pan 40", "40 mg", "OD"),
  mockItem("item-3", "Augmentin 625", "625 mg", "BD"),
];

/** The UHID of the mock visit's patient. `12`, `UHID-12` and `P/12` all resolve. */
const MOCK_PATIENT_NUMBER = 8;
const MOCK_PATIENT_ID = "mock-p-8";

function normaliseCode(code: string) {
  return code.trim();
}

/** Mirrors the server's resolution: uuid, or UHID with any prefix/punctuation. */
function resolveMockCode(
  code: string,
): { basis: ScanBasis; patientId: string } | null {
  const trimmed = normaliseCode(code);
  if (!trimmed) return null;
  if (trimmed === MOCK_PATIENT_ID) {
    return { basis: "patient_id", patientId: MOCK_PATIENT_ID };
  }
  const digits = trimmed.replace(/\D+/g, "");
  if (digits && Number(digits) === MOCK_PATIENT_NUMBER) {
    return { basis: "patient_number", patientId: MOCK_PATIENT_ID };
  }
  // A code that looks like a UHID but resolves to nobody, or a band from another
  // clinic: unrecognised, not a mismatch.
  if (digits) return { basis: "patient_number", patientId: `other-${digits}` };
  return null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function listAdministrableItems(
  visitId: string,
): Promise<Result<AdministrableItem[]>> {
  if (!USE_MOCK) return realListItems(visitId);
  await delay();
  return {
    data: MOCK_ITEMS.map((item) => ({
      item,
      prescription_id: "rx-issued-1",
      administrations: mockAdministrations.filter(
        (a) => a.prescription_item_id === item.id && a.visit_id === visitId,
      ),
    })),
    error: null,
  };
}

/**
 * Record a dose as given, refused or held.
 *
 * `p_scanned_patient_code` is required by the server. The scanner, camera and
 * decoding are the frontend's problem — by the time it reaches the database a scan is
 * just a string, which is why a keyboard-wedge ward scanner and a typed UHID are the
 * same call.
 */
export async function recordAdministration(input: {
  prescriptionItemId: string;
  scannedPatientCode: string;
  status: AdministrationStatus;
  notes?: string | null;
  allowRepeat?: boolean;
}): Promise<Result<AdministrationOutcome>> {
  if (!USE_MOCK) {
    return realRecord({
      prescriptionItemId: input.prescriptionItemId,
      scannedPatientCode: input.scannedPatientCode,
      status: input.status,
      notes: input.notes ?? null,
      allowRepeat: input.allowRepeat ?? false,
    });
  }

  await delay();
  const code = normaliseCode(input.scannedPatientCode);
  if (!code) {
    return {
      data: null,
      error: {
        code: "SCAN_REQUIRED",
        message: "Scan the patient's wristband first.",
      },
    };
  }

  const resolved = resolveMockCode(code);
  if (!resolved) {
    return {
      data: null,
      error: {
        code: "PATIENT_CODE_UNRECOGNISED",
        message: "That code didn't match any patient here.",
      },
    };
  }
  if (resolved.patientId !== MOCK_PATIENT_ID) {
    return {
      data: null,
      error: {
        // Names neither patient, deliberately. The nurse is at the wrong bedside;
        // the remedy is to stop, not to be handed a second patient's identity.
        code: "PATIENT_MISMATCH",
        message: "This band belongs to a different patient. Stop and check.",
      },
    };
  }

  const item = MOCK_ITEMS.find((i) => i.id === input.prescriptionItemId);
  if (!item) {
    return {
      data: null,
      error: {
        code: "PRESCRIPTION_ITEM_NOT_FOUND",
        message: "That medicine is no longer on the prescription.",
      },
    };
  }

  const priorGiven = mockAdministrations.find(
    (a) => a.prescription_item_id === item.id && a.status === "given",
  );
  if (priorGiven && input.status === "given" && !input.allowRepeat) {
    return {
      data: null,
      error: {
        code: "ALREADY_ADMINISTERED",
        // The scan PASSED here. `fields` carries the previous time so the caller can
        // show it without a second round trip.
        message: "This dose is already logged.",
        fields: [priorGiven.administered_at],
      },
    };
  }

  const record: Administration = {
    id: `ma-${mockAdministrations.length + 3}`,
    prescription_item_id: item.id,
    visit_id: "ipd-2",
    administered_by: "mock-user-3",
    administered_at: new Date().toISOString(),
    status: input.status,
    notes: input.notes?.trim() || null,
    scan_basis: resolved.basis,
  };
  mockAdministrations = [record, ...mockAdministrations];

  return {
    data: {
      administration_id: record.id,
      prescription_item_id: item.id,
      visit_id: record.visit_id,
      status: input.status,
      patient_verified: true,
      scan_basis: resolved.basis,
      drug_name: item.drug_name,
      dose: item.dose,
    },
    error: null,
  };
}
