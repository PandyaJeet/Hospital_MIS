import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { fromRpc, mapPostgrestError, rpcUntyped } from "./rpc";
import type { Result } from "./types";

/**
 * Shapes follow `docs/contracts/prescriptions.md` §9.
 *
 * The safety check returns a **severity per finding, never a boolean**, because
 * "silent by default, hard interrupt only on high" is a UI decision (§4). Never
 * treat `findings.length === 0` as safe without also reading `status`.
 */
export type PrescriptionStatus = "draft" | "issued" | "cancelled";
export type Severity = "low" | "medium" | "high";

export interface PrescriptionItem {
  id: string;
  prescription_id: string;
  drug_id: string | null;
  drug_name: string;
  generic_name: string | null;
  is_generic: boolean;
  dose: string | null;
  frequency: string | null;
  duration: string | null;
  instructions: string | null;
  quantity: number | null;
  unit_price: number | null;
  created_at: string;
}

export interface Prescription {
  id: string;
  visit_id: string;
  doctor_id: string;
  status: PrescriptionStatus;
  notes: string | null;
  issued_at: string | null;
  items: PrescriptionItem[];
}

/** Only `drug_name` is required — a half-specified item must save (rules.md §1.7). */
export interface NewItemInput {
  drug_id?: string | null;
  drug_name: string;
  generic_name?: string | null;
  is_generic?: boolean;
  dose?: string | null;
  frequency?: string | null;
  duration?: string | null;
  instructions?: string | null;
  quantity?: number | null;
}

export interface Drug {
  id: string;
  brand_name: string;
  generic_name: string;
  form: string | null;
  strength: string | null;
  drug_class: string | null;
  mrp: number | null;
  is_otc: boolean;
}

export interface SafetyFinding {
  finding_type: "interaction" | "allergy";
  severity: Severity;
  drug_a: string;
  drug_b: string | null;
  description: string;
  match_basis: string;
}

export interface SafetyReport {
  status: "complete" | "partial";
  findings: SafetyFinding[];
  warnings: Array<{
    code: "UNKNOWN_DRUGS" | "NO_ALLERGIES_RECORDED";
    message: string;
  }>;
  unknown_drugs: string[];
  checked_drug_count: number;
  highest_severity: Severity | null;
  requires_acknowledgement: boolean;
  allergies_recorded: boolean;
  reference_disclaimer: string;
}

export interface IssuePayload {
  prescription_id: string;
  status: "issued";
  item_count: number;
}

/** `cancel_prescription()` — Phase 6 addition, `prescriptions.md` §12. */
export interface CancelPayload {
  prescription_id: string;
  status: "cancelled";
  /** False when it was already cancelled — an idempotent no-op success. */
  changed: boolean;
  was_issued: boolean;
  /** Pending medicine lines deleted: the patient is not billed for undispensed drugs. */
  charges_withdrawn: number;
  /** Lines already on an issued invoice, left untouched. Needs a credit note. */
  charges_invoiced: number;
  reason: string | null;
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

const RX_SELECT =
  "id, visit_id, doctor_id, status, notes, issued_at, items:prescription_items(*)";

async function realSearchDrugs(term: string): Promise<Result<Drug[]>> {
  const supabase = createClient();
  const q = term.toLowerCase();
  const { data, error } = await supabase
    .from("drugs")
    .select("id, brand_name, generic_name, form, strength, drug_class, mrp, is_otc")
    .or(
      `brand_name_normalized.like.${q}%,generic_name_normalized.like.${q}%`,
    )
    .order("brand_name")
    .limit(20);

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: (data ?? []) as Drug[], error: null };
}

async function realGetDraftForVisit(
  visitId: string,
): Promise<Result<Prescription | null>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("prescriptions")
    .select(RX_SELECT)
    .eq("visit_id", visitId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) return { data: null, error: mapPostgrestError(error) };
  const row = (data ?? [])[0] as unknown as Prescription | undefined;
  return { data: row ?? null, error: null };
}

async function realCreateDraft(
  visitId: string,
  tenantId: string,
  doctorId: string,
): Promise<Result<Prescription>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("prescriptions")
    .insert({ tenant_id: tenantId, visit_id: visitId, doctor_id: doctorId })
    .select(RX_SELECT)
    .single();

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: data as unknown as Prescription, error: null };
}

async function realAddItem(
  prescriptionId: string,
  tenantId: string,
  input: NewItemInput,
): Promise<Result<PrescriptionItem>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("prescription_items")
    .insert({
      prescription_id: prescriptionId,
      tenant_id: tenantId,
      drug_id: input.drug_id ?? null,
      drug_name: input.drug_name,
      generic_name: input.generic_name ?? null,
      is_generic: input.is_generic ?? false,
      dose: input.dose ?? null,
      frequency: input.frequency ?? null,
      duration: input.duration ?? null,
      instructions: input.instructions ?? null,
      quantity: input.quantity ?? null,
    })
    .select("*")
    .single();

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: data as unknown as PrescriptionItem, error: null };
}

async function realRemoveItem(itemId: string): Promise<Result<null>> {
  const supabase = createClient();
  const { error } = await supabase
    .from("prescription_items")
    .delete()
    .eq("id", itemId);
  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: null, error: null };
}

async function realCheckSafety(
  patientId: string,
  drugNames: string[],
): Promise<Result<SafetyReport>> {
  const supabase = createClient();
  return fromRpc<SafetyReport>(
    await supabase.rpc("check_prescription_safety", {
      p_patient_id: patientId,
      p_drug_names: drugNames,
    }),
  );
}

async function realIssue(
  prescriptionId: string,
): Promise<Result<IssuePayload>> {
  const supabase = createClient();
  return fromRpc<IssuePayload>(
    await supabase.rpc("issue_prescription", {
      p_prescription_id: prescriptionId,
    }),
  );
}

/**
 * `cancel_prescription` is a Phase 6 function and `database.types.ts` predates it, so
 * this goes through the untyped escape hatch rather than the typed `rpc()`. Revisit
 * once `npm run db:types` has been re-run (Memory.md §1).
 */
async function realCancel(
  prescriptionId: string,
  reason: string | null,
): Promise<Result<CancelPayload>> {
  return rpcUntyped<CancelPayload>(createClient(), "cancel_prescription", {
    p_prescription_id: prescriptionId,
    p_reason: reason,
  });
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

interface MockDrug extends Drug {
  allergy_tags: string[];
  interaction_generics: string[];
}

const MOCK_DRUGS: MockDrug[] = [
  {
    id: "d1",
    brand_name: "Dolo 650",
    generic_name: "Paracetamol",
    form: "Tablet",
    strength: "650 mg",
    drug_class: "Analgesic",
    mrp: 32,
    is_otc: true,
    allergy_tags: [],
    interaction_generics: ["paracetamol"],
  },
  {
    id: "d2",
    brand_name: "Mox 500",
    generic_name: "Amoxicillin",
    form: "Capsule",
    strength: "500 mg",
    drug_class: "Antibiotic",
    mrp: 78,
    is_otc: false,
    allergy_tags: ["penicillin", "beta_lactam"],
    interaction_generics: ["amoxicillin"],
  },
  {
    id: "d3",
    brand_name: "Warf 5",
    generic_name: "Warfarin",
    form: "Tablet",
    strength: "5 mg",
    drug_class: "Anticoagulant",
    mrp: 65,
    is_otc: false,
    allergy_tags: [],
    interaction_generics: ["warfarin"],
  },
  {
    id: "d4",
    brand_name: "Ecosprin 75",
    generic_name: "Aspirin",
    form: "Tablet",
    strength: "75 mg",
    drug_class: "Antiplatelet",
    mrp: 12,
    is_otc: true,
    allergy_tags: ["salicylate"],
    interaction_generics: ["aspirin"],
  },
  {
    id: "d5",
    brand_name: "Combiflam",
    generic_name: "Ibuprofen + Paracetamol",
    form: "Tablet",
    strength: "400/325 mg",
    drug_class: "Analgesic",
    mrp: 45,
    is_otc: true,
    allergy_tags: [],
    // Constituents, so a combination still matches a single-molecule pair (§4).
    interaction_generics: ["ibuprofen", "paracetamol"],
  },
  {
    id: "d6",
    brand_name: "Amlong 5",
    generic_name: "Amlodipine",
    form: "Tablet",
    strength: "5 mg",
    drug_class: "Antihypertensive",
    mrp: 55,
    is_otc: false,
    allergy_tags: [],
    interaction_generics: ["amlodipine"],
  },
  {
    id: "d7",
    brand_name: "Atorva 10",
    generic_name: "Atorvastatin",
    form: "Tablet",
    strength: "10 mg",
    drug_class: "Statin",
    mrp: 90,
    is_otc: false,
    allergy_tags: [],
    interaction_generics: ["atorvastatin"],
  },
  {
    id: "d8",
    brand_name: "Pan 40",
    generic_name: "Pantoprazole",
    form: "Tablet",
    strength: "40 mg",
    drug_class: "PPI",
    mrp: 120,
    is_otc: false,
    allergy_tags: [],
    interaction_generics: ["pantoprazole"],
  },
];

const MOCK_PAIRS: Array<{
  a: string;
  b: string;
  severity: Severity;
  description: string;
}> = [
  {
    a: "aspirin",
    b: "warfarin",
    severity: "high",
    description: "Markedly increased bleeding risk when combined.",
  },
  {
    a: "ibuprofen",
    b: "warfarin",
    severity: "high",
    description: "NSAID with an anticoagulant increases bleeding risk.",
  },
  {
    a: "amlodipine",
    b: "atorvastatin",
    severity: "low",
    description: "Mildly raised statin exposure; usually well tolerated.",
  },
];

/** Mirrors the queue mock: visit id -> patient id + free-text allergies. */
const MOCK_VISITS: Record<
  string,
  { patient_id: string; patient_name: string; allergies: string | null }
> = {
  v1: {
    patient_id: "mock-p-1",
    patient_name: "Aarav Sharma",
    allergies: "Penicillin",
  },
  v2: {
    patient_id: "mock-p-2",
    patient_name: "Priya Patel",
    allergies: null,
  },
  v3: {
    patient_id: "mock-p-3",
    patient_name: "Rohan Mehta",
    allergies: "Sulfa drugs, Aspirin",
  },
};

const DISCLAIMER =
  "Starter reference dataset — not clinically reviewed. Absence of a finding is not evidence of safety.";

const mockStore = new Map<string, Prescription>();
let mockSeq = 0;

function delay(ms = 350) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findDrug(name: string): MockDrug | undefined {
  const n = name.trim().toLowerCase();
  return MOCK_DRUGS.find(
    (d) =>
      d.brand_name.toLowerCase() === n || d.generic_name.toLowerCase() === n,
  );
}

function mockSafety(visitId: string, drugNames: string[]): SafetyReport {
  const visit = MOCK_VISITS[visitId];
  const allergies = visit?.allergies ?? null;
  const findings: SafetyFinding[] = [];
  const unknown: string[] = [];
  const resolved: MockDrug[] = [];

  for (const name of drugNames) {
    const drug = findDrug(name);
    if (drug) resolved.push(drug);
    else unknown.push(name);
  }

  // Allergy findings are always high — prescribing into a documented allergy is
  // the archetypal hard-interrupt case (§4).
  if (allergies) {
    const lower = allergies.toLowerCase();
    for (const drug of resolved) {
      const tag = [...drug.allergy_tags, drug.generic_name.toLowerCase()].find(
        (t) => lower.includes(t.toLowerCase()),
      );
      if (tag) {
        findings.push({
          finding_type: "allergy",
          severity: "high",
          drug_a: drug.brand_name,
          drug_b: null,
          description: `Patient's recorded allergies mention "${tag}".`,
          match_basis: `allergy_tag:${tag}`,
        });
      }
    }
  }

  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      for (const pair of MOCK_PAIRS) {
        const aHasA = resolved[i].interaction_generics.includes(pair.a);
        const aHasB = resolved[i].interaction_generics.includes(pair.b);
        const bHasA = resolved[j].interaction_generics.includes(pair.a);
        const bHasB = resolved[j].interaction_generics.includes(pair.b);
        if ((aHasA && bHasB) || (aHasB && bHasA)) {
          findings.push({
            finding_type: "interaction",
            severity: pair.severity,
            drug_a: resolved[i].brand_name,
            drug_b: resolved[j].brand_name,
            description: pair.description,
            match_basis: "interaction_pair",
          });
        }
      }
    }
  }

  const warnings: SafetyReport["warnings"] = [];
  if (unknown.length > 0) {
    warnings.push({
      code: "UNKNOWN_DRUGS",
      message: "Some drugs are not in the reference list.",
    });
  }
  if (!allergies) {
    warnings.push({
      code: "NO_ALLERGIES_RECORDED",
      // An empty allergy field means nobody asked, not that there are none.
      message: "No allergy history recorded for this patient.",
    });
  }

  const order: Severity[] = ["low", "medium", "high"];
  const highest =
    findings.length > 0
      ? findings.reduce<Severity>(
          (acc, f) =>
            order.indexOf(f.severity) > order.indexOf(acc) ? f.severity : acc,
          "low",
        )
      : null;
  const status = warnings.length > 0 ? "partial" : "complete";

  return {
    status,
    findings,
    warnings,
    unknown_drugs: unknown,
    checked_drug_count: resolved.length,
    highest_severity: highest,
    requires_acknowledgement: highest === "high" || status === "partial",
    allergies_recorded: Boolean(allergies),
    reference_disclaimer: DISCLAIMER,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function visitPatient(visitId: string) {
  return MOCK_VISITS[visitId] ?? null;
}

export async function searchDrugs(term: string): Promise<Result<Drug[]>> {
  if (!USE_MOCK) return realSearchDrugs(term);
  await delay(200);
  const q = term.trim().toLowerCase();
  if (!q) return { data: [], error: null };
  return {
    data: MOCK_DRUGS.filter(
      (d) =>
        d.brand_name.toLowerCase().startsWith(q) ||
        d.generic_name.toLowerCase().startsWith(q),
    ).slice(0, 20),
    error: null,
  };
}

export async function getDraftForVisit(
  visitId: string,
): Promise<Result<Prescription | null>> {
  if (!USE_MOCK) return realGetDraftForVisit(visitId);
  await delay();
  return { data: mockStore.get(visitId) ?? null, error: null };
}

export async function createDraft(
  visitId: string,
  tenantId: string,
  doctorId: string,
): Promise<Result<Prescription>> {
  if (!USE_MOCK) return realCreateDraft(visitId, tenantId, doctorId);
  await delay(250);
  const rx: Prescription = {
    id: `rx-${visitId}`,
    visit_id: visitId,
    doctor_id: doctorId,
    status: "draft",
    notes: null,
    issued_at: null,
    items: [],
  };
  mockStore.set(visitId, rx);
  return { data: rx, error: null };
}

export async function addItem(
  prescription: Prescription,
  tenantId: string,
  input: NewItemInput,
): Promise<Result<PrescriptionItem>> {
  if (!USE_MOCK) return realAddItem(prescription.id, tenantId, input);
  await delay(200);
  mockSeq += 1;
  const item: PrescriptionItem = {
    id: `item-${mockSeq}`,
    prescription_id: prescription.id,
    drug_id: input.drug_id ?? null,
    drug_name: input.drug_name,
    generic_name: input.generic_name ?? null,
    is_generic: input.is_generic ?? false,
    dose: input.dose ?? null,
    frequency: input.frequency ?? null,
    duration: input.duration ?? null,
    instructions: input.instructions ?? null,
    quantity: input.quantity ?? null,
    unit_price: null,
    created_at: new Date().toISOString(),
  };
  const stored = mockStore.get(prescription.visit_id);
  if (stored) stored.items = [...stored.items, item];
  return { data: item, error: null };
}

export async function removeItem(
  prescription: Prescription,
  itemId: string,
): Promise<Result<null>> {
  if (!USE_MOCK) return realRemoveItem(itemId);
  await delay(150);
  const stored = mockStore.get(prescription.visit_id);
  if (stored) stored.items = stored.items.filter((i) => i.id !== itemId);
  return { data: null, error: null };
}

export async function checkSafety(
  visitId: string,
  patientId: string,
  drugNames: string[],
): Promise<Result<SafetyReport>> {
  if (!USE_MOCK) return realCheckSafety(patientId, drugNames);
  await delay(500);
  if (drugNames.length === 0) {
    return {
      data: null,
      error: {
        code: "VALIDATION_ERROR",
        message: "Add at least one drug to check.",
      },
    };
  }
  return { data: mockSafety(visitId, drugNames), error: null };
}

export async function issuePrescription(
  prescription: Prescription,
): Promise<Result<IssuePayload>> {
  if (!USE_MOCK) return realIssue(prescription.id);
  await delay(400);
  const stored = mockStore.get(prescription.visit_id);
  if (!stored) {
    return {
      data: null,
      error: {
        code: "PRESCRIPTION_NOT_FOUND",
        message: "That prescription could not be found.",
      },
    };
  }
  if (stored.status === "issued") {
    return {
      data: null,
      error: {
        code: "PRESCRIPTION_ALREADY_ISSUED",
        message: "This prescription has already been issued.",
      },
    };
  }
  if (stored.items.length === 0) {
    return {
      data: null,
      error: {
        code: "PRESCRIPTION_EMPTY",
        message: "Add at least one medicine before issuing.",
      },
    };
  }
  stored.status = "issued";
  stored.issued_at = new Date().toISOString();
  return {
    data: {
      prescription_id: stored.id,
      status: "issued",
      item_count: stored.items.length,
    },
    error: null,
  };
}

/**
 * Retract an issued prescription (`prescriptions.md` §12).
 *
 * Permitted to **the prescriber or any admin**, which is deliberately wider than who
 * may issue: an un-retracted wrong prescription is a drug that may still be
 * administered, and "wait for the prescriber" is not an answer on a ward at 2am.
 * Stopping is safer to over-permit than starting.
 *
 * A nurse cannot cancel, but is already protected —
 * `record_medication_administration()` refuses a cancelled item.
 *
 * Cancelling twice is an idempotent no-op success (`changed: false`), so a
 * double-tapped button is harmless.
 */
export async function cancelPrescription(
  prescriptionId: string,
  reason: string | null = null,
): Promise<Result<CancelPayload>> {
  if (!USE_MOCK) return realCancel(prescriptionId, reason?.trim() || null);

  await delay(300);
  const stored = [...mockStore.values()].find((p) => p.id === prescriptionId);
  if (!stored) {
    return {
      data: null,
      error: {
        code: "PRESCRIPTION_NOT_FOUND",
        message: "That prescription could not be found.",
      },
    };
  }

  const wasIssued = stored.status === "issued";
  const alreadyCancelled = stored.status === "cancelled";
  stored.status = "cancelled";

  return {
    data: {
      prescription_id: stored.id,
      status: "cancelled",
      changed: !alreadyCancelled,
      was_issued: wasIssued,
      // Issuing fires the medicine billing trigger, so by the time a script can be
      // cancelled the charges usually exist. Pending ones go; invoiced ones do not.
      charges_withdrawn: wasIssued ? stored.items.length : 0,
      charges_invoiced: 0,
      reason: reason?.trim() || null,
    },
    error: null,
  };
}
