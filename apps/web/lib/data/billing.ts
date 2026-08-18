import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { fromRpc, mapPostgrestError } from "./rpc";
import type { Result } from "./types";

/**
 * Shapes follow `docs/contracts/billing.md` §10.
 *
 * Two rules that shape every screen here:
 *  1. Billing staff never enter a normal charge — consultation, medicine, lab and
 *     room-rent lines are captured by triggers (§1). These screens review and
 *     invoice; they are not data entry.
 *  2. **Tax is per line, never per invoice.** One OPD bill mixes a GST-exempt
 *     consultation with taxable medicine, so there is no such quantity as "the
 *     invoice's GST rate" — never compute one (§2).
 */
export type TaxCategory = "exempt" | "taxable" | "nil_rated" | "non_gst";
export type SourceType =
  | "consultation"
  | "medicine"
  | "lab"
  | "procedure"
  | "room_rent"
  | "other";
export type InvoiceStatus = "draft" | "issued" | "paid" | "cancelled";
export type PaymentMode = "cash" | "upi" | "card" | "insurance" | "other";

export const paymentModes: readonly PaymentMode[] = [
  "cash",
  "upi",
  "card",
  "insurance",
  "other",
];

export interface PendingLine {
  id: string;
  visit_id: string;
  source_type: SourceType;
  description: string;
  quantity: number;
  unit_amount: number;
  amount: number;
  tax_category: TaxCategory;
  tax_rate: number;
  tax_amount: number;
  is_auto: boolean;
}

/** Pending charges for one visit — "pending" is a query (`invoice_id IS NULL`), not a status. */
export interface PendingVisitGroup {
  visit_id: string;
  queue_number: number | null;
  visit_date: string | null;
  patient_number: number | null;
  patient_name: string;
  lines: PendingLine[];
  subtotal: number;
  tax_total: number;
  grand_total: number;
  /** A ₹0 line means "price unknown", not "free" — surface it (§1). */
  has_unpriced: boolean;
}

export interface InvoiceTaxLine {
  tax_category: TaxCategory;
  tax_rate: number;
  taxable_amount: number;
  tax_amount: number;
}

export interface InvoiceLine {
  description: string;
  source_type: SourceType;
  hsn_sac_code: string | null;
  quantity: number;
  unit_amount: number;
  amount: number;
  tax_category: TaxCategory;
  tax_rate: number;
  tax_amount: number;
}

export interface InvoiceDetail {
  id: string;
  invoice_number: number;
  status: InvoiceStatus;
  /** false ⇒ render a BILL OF SUPPLY: no GSTIN, no tax section at all (§2). */
  is_gst_invoice: boolean;
  gstin_snapshot: string | null;
  subtotal: number;
  tax_total: number;
  grand_total: number;
  amount_paid: number;
  payment_mode: PaymentMode | null;
  issued_at: string | null;
  patient_number: number | null;
  patient_name: string;
  lines: InvoiceLine[];
  tax_summary: InvoiceTaxLine[];
}

export interface CreateInvoicePayload {
  invoice_id: string;
  invoice_number: number;
  is_gst_invoice: boolean;
  line_count: number;
  subtotal: number;
  tax_total: number;
  grand_total: number;
  status: "draft";
}

/**
 * Envelope values arrive as JSON numbers (13.5) while direct column reads arrive
 * as scale-preserving strings ("13.50") — §5. Normalise on the way in and never
 * compare the two representations.
 */
function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

interface RawPendingRow {
  id: string;
  visit_id: string;
  source_type: SourceType;
  description: string;
  quantity: unknown;
  unit_amount: unknown;
  amount: unknown;
  tax_category: TaxCategory;
  tax_rate: unknown;
  tax_amount: unknown;
  is_auto: boolean;
  patient: { patient_number: number; full_name: string } | null;
  visit: { queue_number: number; visit_date: string } | null;
}

async function realGetPending(): Promise<Result<PendingVisitGroup[]>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("billing_line_items")
    .select(
      `id, visit_id, source_type, description, quantity, unit_amount, amount,
       tax_category, tax_rate, tax_amount, is_auto,
       patient:patients ( patient_number, full_name ),
       visit:visits ( queue_number, visit_date )`,
    )
    .is("invoice_id", null)
    .order("created_at");

  if (error) return { data: null, error: mapPostgrestError(error) };

  const groups = new Map<string, PendingVisitGroup>();
  for (const raw of (data ?? []) as unknown as RawPendingRow[]) {
    const line: PendingLine = {
      id: raw.id,
      visit_id: raw.visit_id,
      source_type: raw.source_type,
      description: raw.description,
      quantity: num(raw.quantity),
      unit_amount: num(raw.unit_amount),
      amount: num(raw.amount),
      tax_category: raw.tax_category,
      tax_rate: num(raw.tax_rate),
      tax_amount: num(raw.tax_amount),
      is_auto: raw.is_auto,
    };
    let group = groups.get(raw.visit_id);
    if (!group) {
      group = {
        visit_id: raw.visit_id,
        queue_number: raw.visit?.queue_number ?? null,
        visit_date: raw.visit?.visit_date ?? null,
        patient_number: raw.patient?.patient_number ?? null,
        patient_name: raw.patient?.full_name ?? "",
        lines: [],
        subtotal: 0,
        tax_total: 0,
        grand_total: 0,
        has_unpriced: false,
      };
      groups.set(raw.visit_id, group);
    }
    group.lines.push(line);
  }

  for (const group of groups.values()) {
    group.subtotal = group.lines.reduce((sum, l) => sum + l.amount, 0);
    group.tax_total = group.lines.reduce((sum, l) => sum + l.tax_amount, 0);
    group.grand_total = group.subtotal + group.tax_total;
    group.has_unpriced = group.lines.some((l) => l.amount === 0);
  }

  return { data: [...groups.values()], error: null };
}

async function realCreateInvoice(
  visitId: string,
): Promise<Result<CreateInvoicePayload>> {
  const supabase = createClient();
  return fromRpc<CreateInvoicePayload>(
    await supabase.rpc("create_invoice_for_visit", { p_visit_id: visitId }),
  );
}

async function realGetInvoice(
  invoiceId: string,
): Promise<Result<InvoiceDetail>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("invoices")
    .select(
      `id, invoice_number, status, is_gst_invoice, gstin_snapshot,
       subtotal, tax_total, grand_total, amount_paid, payment_mode, issued_at,
       patient:patients ( patient_number, full_name ),
       lines:billing_line_items ( description, source_type, hsn_sac_code, quantity,
                                  unit_amount, amount, tax_category, tax_rate, tax_amount ),
       tax_summary:invoice_tax_lines ( tax_category, tax_rate, taxable_amount, tax_amount )`,
    )
    .eq("id", invoiceId)
    .maybeSingle();

  if (error) return { data: null, error: mapPostgrestError(error) };
  if (!data) {
    return {
      data: null,
      error: {
        code: "INVOICE_NOT_FOUND",
        message: "That invoice could not be found.",
      },
    };
  }

  const row = data as unknown as Record<string, unknown>;
  const patient = row.patient as
    | { patient_number: number; full_name: string }
    | null;

  return {
    data: {
      id: row.id as string,
      invoice_number: num(row.invoice_number),
      status: row.status as InvoiceStatus,
      is_gst_invoice: Boolean(row.is_gst_invoice),
      gstin_snapshot: (row.gstin_snapshot as string | null) ?? null,
      subtotal: num(row.subtotal),
      tax_total: num(row.tax_total),
      grand_total: num(row.grand_total),
      amount_paid: num(row.amount_paid),
      payment_mode: (row.payment_mode as PaymentMode | null) ?? null,
      issued_at: (row.issued_at as string | null) ?? null,
      patient_number: patient?.patient_number ?? null,
      patient_name: patient?.full_name ?? "",
      lines: ((row.lines ?? []) as Record<string, unknown>[]).map((l) => ({
        description: l.description as string,
        source_type: l.source_type as SourceType,
        hsn_sac_code: (l.hsn_sac_code as string | null) ?? null,
        quantity: num(l.quantity),
        unit_amount: num(l.unit_amount),
        amount: num(l.amount),
        tax_category: l.tax_category as TaxCategory,
        tax_rate: num(l.tax_rate),
        tax_amount: num(l.tax_amount),
      })),
      tax_summary: ((row.tax_summary ?? []) as Record<string, unknown>[]).map(
        (s) => ({
          tax_category: s.tax_category as TaxCategory,
          tax_rate: num(s.tax_rate),
          taxable_amount: num(s.taxable_amount),
          tax_amount: num(s.tax_amount),
        }),
      ),
    },
    error: null,
  };
}

async function realRecordPayment(
  invoiceId: string,
  amountPaid: number,
  mode: PaymentMode,
): Promise<Result<null>> {
  const supabase = createClient();
  // Plain update — monetary totals are server-owned; only these are writable (§6).
  const { error } = await supabase
    .from("invoices")
    .update({ status: "paid", amount_paid: amountPaid, payment_mode: mode })
    .eq("id", invoiceId);
  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: null, error: null };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the GST-registered seed tenant. Flip to false to see the BILL OF
 * SUPPLY layout — no GSTIN and an empty tax summary (§2).
 */
const MOCK_GST_REGISTERED = true;

interface MockVisitCharges {
  visit_id: string;
  queue_number: number;
  patient_number: number;
  patient_name: string;
  lines: PendingLine[];
}

function taxFor(kind: "service" | "medicine"): {
  tax_category: TaxCategory;
  tax_rate: number;
} {
  if (!MOCK_GST_REGISTERED) return { tax_category: "non_gst", tax_rate: 0 };
  return kind === "service"
    ? { tax_category: "exempt", tax_rate: 0 }
    : { tax_category: "taxable", tax_rate: 5 };
}

function line(
  id: string,
  visitId: string,
  source_type: SourceType,
  description: string,
  quantity: number,
  unit_amount: number,
  kind: "service" | "medicine",
): PendingLine {
  const tax = taxFor(kind);
  const amount = quantity * unit_amount;
  return {
    id,
    visit_id: visitId,
    source_type,
    description,
    quantity,
    unit_amount,
    amount,
    tax_category: tax.tax_category,
    tax_rate: tax.tax_rate,
    tax_amount: Number(((amount * tax.tax_rate) / 100).toFixed(2)),
    is_auto: true,
  };
}

let mockPending: MockVisitCharges[] = [
  {
    visit_id: "v1",
    queue_number: 11,
    patient_number: 1,
    patient_name: "Aarav Sharma",
    lines: [
      line("bl1", "v1", "consultation", "Consultation — Dr. Verma", 1, 500, "service"),
      line("bl2", "v1", "medicine", "Dolo 650", 9, 32, "medicine"),
      // An unpriced medicine: ₹0 means "we don't know the price", not "free".
      line("bl3", "v1", "medicine", "Mox 500", 10, 0, "medicine"),
    ],
  },
  {
    visit_id: "v3",
    queue_number: 13,
    patient_number: 3,
    patient_name: "Rohan Mehta",
    lines: [
      line("bl4", "v3", "consultation", "Consultation — Dr. Verma", 1, 500, "service"),
    ],
  },
];

const mockInvoices = new Map<string, InvoiceDetail>();
let mockInvoiceSeq = 1041;

function delay(ms = 400) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toGroup(v: MockVisitCharges): PendingVisitGroup {
  const subtotal = v.lines.reduce((s, l) => s + l.amount, 0);
  const tax_total = v.lines.reduce((s, l) => s + l.tax_amount, 0);
  return {
    visit_id: v.visit_id,
    queue_number: v.queue_number,
    visit_date: new Date().toISOString().slice(0, 10),
    patient_number: v.patient_number,
    patient_name: v.patient_name,
    lines: v.lines,
    subtotal,
    tax_total,
    grand_total: subtotal + tax_total,
    has_unpriced: v.lines.some((l) => l.amount === 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getPendingCharges(): Promise<
  Result<PendingVisitGroup[]>
> {
  if (!USE_MOCK) return realGetPending();
  await delay();
  return { data: mockPending.map(toGroup), error: null };
}

export async function createInvoiceForVisit(
  visitId: string,
): Promise<Result<CreateInvoicePayload>> {
  if (!USE_MOCK) return realCreateInvoice(visitId);
  await delay();

  const existing = [...mockInvoices.values()].find(
    (inv) => inv.id === `inv-${visitId}`,
  );
  if (existing) {
    return {
      data: null,
      error: {
        code: "INVOICE_ALREADY_EXISTS",
        message: "An invoice already exists for this visit.",
        fields: [existing.id],
      },
    };
  }

  const group = mockPending.find((v) => v.visit_id === visitId);
  if (!group || group.lines.length === 0) {
    return {
      data: null,
      error: {
        code: "NO_PENDING_CHARGES",
        message: "There are no pending charges for this visit.",
      },
    };
  }

  const g = toGroup(group);
  mockInvoiceSeq += 1;

  // Rate-wise summary: one row per (category, rate) present. Empty for a
  // non-GST tenant, which is what makes the document a bill of supply.
  const buckets = new Map<string, InvoiceTaxLine>();
  if (MOCK_GST_REGISTERED) {
    for (const l of g.lines) {
      const key = `${l.tax_category}:${l.tax_rate}`;
      const bucket = buckets.get(key) ?? {
        tax_category: l.tax_category,
        tax_rate: l.tax_rate,
        taxable_amount: 0,
        tax_amount: 0,
      };
      bucket.taxable_amount += l.amount;
      bucket.tax_amount += l.tax_amount;
      buckets.set(key, bucket);
    }
  }

  const invoice: InvoiceDetail = {
    id: `inv-${visitId}`,
    invoice_number: mockInvoiceSeq,
    status: "draft",
    is_gst_invoice: MOCK_GST_REGISTERED,
    gstin_snapshot: MOCK_GST_REGISTERED ? "27AABCU9603R1ZM" : null,
    subtotal: g.subtotal,
    tax_total: g.tax_total,
    grand_total: g.grand_total,
    amount_paid: 0,
    payment_mode: null,
    issued_at: null,
    patient_number: g.patient_number,
    patient_name: g.patient_name,
    lines: g.lines.map((l) => ({
      description: l.description,
      source_type: l.source_type,
      hsn_sac_code: null,
      quantity: l.quantity,
      unit_amount: l.unit_amount,
      amount: l.amount,
      tax_category: l.tax_category,
      tax_rate: l.tax_rate,
      tax_amount: l.tax_amount,
    })),
    tax_summary: [...buckets.values()],
  };

  mockInvoices.set(invoice.id, invoice);
  // Invoicing consumes the pending lines — nothing is left pending afterwards.
  mockPending = mockPending.filter((v) => v.visit_id !== visitId);

  return {
    data: {
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      is_gst_invoice: invoice.is_gst_invoice,
      line_count: invoice.lines.length,
      subtotal: invoice.subtotal,
      tax_total: invoice.tax_total,
      grand_total: invoice.grand_total,
      status: "draft",
    },
    error: null,
  };
}

export async function getInvoice(
  invoiceId: string,
): Promise<Result<InvoiceDetail>> {
  if (!USE_MOCK) return realGetInvoice(invoiceId);
  await delay();
  const invoice = mockInvoices.get(invoiceId);
  if (!invoice) {
    return {
      data: null,
      error: {
        code: "INVOICE_NOT_FOUND",
        message: "That invoice could not be found.",
      },
    };
  }
  return { data: invoice, error: null };
}

export async function recordPayment(
  invoiceId: string,
  amountPaid: number,
  mode: PaymentMode,
): Promise<Result<null>> {
  if (!USE_MOCK) return realRecordPayment(invoiceId, amountPaid, mode);
  await delay();
  const invoice = mockInvoices.get(invoiceId);
  if (!invoice) {
    return {
      data: null,
      error: {
        code: "INVOICE_NOT_FOUND",
        message: "That invoice could not be found.",
      },
    };
  }
  invoice.status = "paid";
  invoice.amount_paid = amountPaid;
  invoice.payment_mode = mode;
  invoice.issued_at = invoice.issued_at ?? new Date().toISOString();
  return { data: null, error: null };
}
