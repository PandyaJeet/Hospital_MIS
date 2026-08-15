/**
 * generate-invoice-pdf
 *
 *   POST /functions/v1/generate-invoice-pdf
 *   Authorization: Bearer <user access token>
 *   { "invoice_id": "<uuid>" }
 *
 *   200 -> application/pdf
 *   4xx/5xx -> { "error": { "code", "message" } }   (rules.md §3.7)
 *
 * TWO GENUINELY DIFFERENT DOCUMENTS, NOT ONE WITH ZEROES
 * `is_gst_invoice` selects between them:
 *
 *   true  -> "TAX INVOICE". Shows the clinic's GSTIN, HSN/SAC per line, and a
 *            rate-wise tax summary. Required because one OPD bill mixes a
 *            GST-exempt consultation with taxable medicines, so a single blended
 *            rate would be wrong.
 *   false -> "BILL OF SUPPLY". No GSTIN, no tax columns, no tax summary, no
 *            rows of 0.00. A clinic below the ₹20 lakh registration threshold
 *            must not issue something that looks like a GST invoice — printing
 *            zeroed tax boxes would misrepresent its registration status.
 *
 * The renderer does not compute tax. `tax_summary` arrives already grouped by
 * (category, rate) from invoice_tax_lines, so the arithmetic lives in SQL where
 * it is covered by the test suites. This function only formats.
 *
 * !! NOT DEPLOYED !! `supabase functions deploy` requires a personal access
 * token, which is not available on this machine. The payload it renders IS
 * verified by the local and remote suites; the rendering is not.
 */

import { clientForRequest } from '../_shared/supabase.ts';
import {
  CORS_HEADERS,
  errorResponse,
  newRequestId,
  pdfResponse,
  readJson,
  unexpectedError,
} from '../_shared/http.ts';
import {
  A4,
  MARGIN,
  MUTED,
  formatAmount,
  formatDate,
  footer,
  rule,
  space,
  startDoc,
  text,
  textRight,
} from '../_shared/pdf.ts';

interface RequestBody {
  invoice_id?: string;
}

interface TaxLine {
  tax_category: string;
  tax_rate: number | string;
  taxable_amount: number | string;
  tax_amount: number | string;
}

interface Payload {
  ok: boolean;
  invoice?: Record<string, unknown>;
  clinic?: Record<string, unknown>;
  patient?: Record<string, unknown>;
  visit?: Record<string, unknown>;
  lines?: Array<Record<string, unknown>>;
  tax_summary?: TaxLine[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORY_LABEL: Record<string, string> = {
  exempt: 'Exempt (healthcare service)',
  taxable: 'Taxable',
  nil_rated: 'Nil-rated',
  non_gst: 'Non-GST',
};

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = newRequestId();

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return errorResponse('METHOD_NOT_ALLOWED', 'Use POST.', 405);
  }

  try {
    const body = await readJson<RequestBody>(req);
    const id = body?.invoice_id;

    if (!id || !UUID_RE.test(id)) {
      return errorResponse('VALIDATION_ERROR', 'A valid invoice_id is required.', 400);
    }

    const { client, token } = clientForRequest(req);
    if (!token) {
      return errorResponse('NOT_AUTHENTICATED', 'Please sign in and try again.', 401);
    }

    const { data, error } = await client.rpc('get_invoice_for_pdf', { p_invoice_id: id });

    if (error) {
      if (error.code === '42501' || error.code === 'PGRST301') {
        return errorResponse('NOT_FOUND', 'That invoice could not be found.', 404);
      }
      console.error(`[${requestId}] rpc failed code=${error.code ?? 'unknown'}`);
      return errorResponse('PDF_GENERATION_FAILED', 'Could not load the invoice.', 502);
    }

    const payload = data as Payload | null;
    if (!payload || payload.ok !== true) {
      return errorResponse('NOT_FOUND', 'That invoice could not be found.', 404);
    }

    const inv = payload.invoice ?? {};
    const clinic = payload.clinic ?? {};
    const patient = payload.patient ?? {};
    const lines = payload.lines ?? [];
    const taxSummary = payload.tax_summary ?? [];
    const isGst = inv.is_gst_invoice === true;

    const doc = await startDoc(isGst ? 'Tax Invoice' : 'Bill of Supply');
    const RIGHT = A4.width - MARGIN;

    // ---- header ----
    text(doc, clinic.name ?? 'Clinic', { size: 17, bold: true });
    const headingWidth = doc.bold.widthOfTextAtSize(isGst ? 'TAX INVOICE' : 'BILL OF SUPPLY', 12);
    doc.page.drawText(isGst ? 'TAX INVOICE' : 'BILL OF SUPPLY', {
      x: RIGHT - headingWidth, y: doc.y, size: 12, font: doc.bold,
    });

    if (clinic.address) text(doc, clinic.address, { size: 9, color: MUTED, dy: 14 });
    if (clinic.phone) text(doc, `Phone: ${clinic.phone}`, { size: 9, color: MUTED, dy: 12 });
    // GSTIN only on a real GST invoice.
    if (isGst && inv.gstin) text(doc, `GSTIN: ${inv.gstin}`, { size: 9, bold: true, dy: 12 });
    rule(doc, 14);

    // ---- invoice / patient block ----
    space(doc, 16);
    text(doc, `Invoice No: ${inv.invoice_number ?? ''}`, { size: 10, bold: true });
    doc.page.drawText(`Date: ${formatDate(inv.issued_at ?? inv.created_at)}`, {
      x: RIGHT - 150, y: doc.y, size: 10, font: doc.regular,
    });

    text(doc, `Patient: ${patient.name ?? ''}`, { size: 10, dy: 14 });
    doc.page.drawText(`UHID: ${patient.patient_number ?? ''}`, {
      x: RIGHT - 150, y: doc.y, size: 10, font: doc.regular,
    });
    if (patient.phone) text(doc, `Phone: ${patient.phone}`, { size: 9, color: MUTED, dy: 12 });

    rule(doc, 16);

    // ---- line items ----
    // Column layout differs between the two documents: a bill of supply has no
    // HSN/SAC or tax columns at all, which leaves the description room to breathe.
    const COL = isGst
      ? { desc: MARGIN, hsn: 250, qty: 315, rate: 380, taxable: 450, tax: 505, total: RIGHT }
      : { desc: MARGIN, hsn: 0, qty: 340, rate: 420, taxable: 0, tax: 0, total: RIGHT };

    space(doc, 16);
    text(doc, 'Description', { size: 9, bold: true, color: MUTED });
    if (isGst) doc.page.drawText('HSN/SAC', { x: COL.hsn, y: doc.y, size: 9, font: doc.bold, color: MUTED });
    doc.page.drawText('Qty', { x: COL.qty, y: doc.y, size: 9, font: doc.bold, color: MUTED });
    doc.page.drawText('Rate', { x: COL.rate, y: doc.y, size: 9, font: doc.bold, color: MUTED });
    if (isGst) {
      doc.page.drawText('Taxable', { x: COL.taxable, y: doc.y, size: 9, font: doc.bold, color: MUTED });
      doc.page.drawText('Tax', { x: COL.tax, y: doc.y, size: 9, font: doc.bold, color: MUTED });
    }
    textRight(doc, 'Amount', COL.total, { size: 9, bold: true });
    rule(doc, 6);

    for (const line of lines) {
      space(doc, 15);
      // Truncate rather than wrap so the table stays aligned; the full text is
      // always available on screen.
      const desc = String(line.description ?? '');
      text(doc, desc.length > 42 ? `${desc.slice(0, 41)}\u2026` : desc, { size: 9.5 });
      if (isGst) {
        doc.page.drawText(String(line.hsn_sac_code ?? '-'), { x: COL.hsn, y: doc.y, size: 9, font: doc.regular });
      }
      doc.page.drawText(formatAmount(line.quantity), { x: COL.qty, y: doc.y, size: 9, font: doc.regular });
      doc.page.drawText(formatAmount(line.unit_amount), { x: COL.rate, y: doc.y, size: 9, font: doc.regular });
      if (isGst) {
        doc.page.drawText(formatAmount(line.amount), { x: COL.taxable, y: doc.y, size: 9, font: doc.regular });
        doc.page.drawText(formatAmount(line.tax_amount), { x: COL.tax, y: doc.y, size: 9, font: doc.regular });
      }
      textRight(doc, formatAmount(Number(line.amount ?? 0) + Number(line.tax_amount ?? 0)), COL.total, { size: 9.5 });
    }

    rule(doc, 10);

    // ---- rate-wise tax summary: GST invoices only ----
    if (isGst && taxSummary.length > 0) {
      space(doc, 18);
      text(doc, 'Tax summary', { size: 10, bold: true });
      space(doc, 4);
      text(doc, 'Category', { size: 8.5, bold: true, color: MUTED, dy: 12 });
      doc.page.drawText('Rate', { x: 250, y: doc.y, size: 8.5, font: doc.bold, color: MUTED });
      doc.page.drawText('Taxable value', { x: 330, y: doc.y, size: 8.5, font: doc.bold, color: MUTED });
      textRight(doc, 'Tax', COL.total, { size: 8.5, bold: true });

      for (const t of taxSummary) {
        space(doc, 13);
        text(doc, CATEGORY_LABEL[t.tax_category] ?? t.tax_category, { size: 9 });
        doc.page.drawText(`${formatAmount(t.tax_rate)}%`, { x: 250, y: doc.y, size: 9, font: doc.regular });
        doc.page.drawText(formatAmount(t.taxable_amount), { x: 330, y: doc.y, size: 9, font: doc.regular });
        textRight(doc, formatAmount(t.tax_amount), COL.total, { size: 9 });
      }
      rule(doc, 10);
    }

    // ---- totals ----
    space(doc, 18);
    text(doc, 'Subtotal', { size: 10, x: 380 });
    textRight(doc, formatAmount(inv.subtotal), COL.total, { size: 10 });

    // A bill of supply shows no tax row at all, rather than "Tax 0.00".
    if (isGst) {
      space(doc, 14);
      text(doc, 'Total tax', { size: 10, x: 380 });
      textRight(doc, formatAmount(inv.tax_total), COL.total, { size: 10 });
    }

    space(doc, 16);
    text(doc, 'Grand total', { size: 12, bold: true, x: 380 });
    textRight(doc, `Rs. ${formatAmount(inv.grand_total)}`, COL.total, { size: 12, bold: true });

    if (Number(inv.amount_paid ?? 0) > 0) {
      space(doc, 15);
      text(doc, `Paid${inv.payment_mode ? ` (${inv.payment_mode})` : ''}`, { size: 10, x: 380 });
      textRight(doc, formatAmount(inv.amount_paid), COL.total, { size: 10 });

      const due = Number(inv.grand_total ?? 0) - Number(inv.amount_paid ?? 0);
      if (Math.abs(due) > 0.005) {
        space(doc, 14);
        text(doc, 'Balance due', { size: 10, bold: true, x: 380 });
        textRight(doc, formatAmount(due), COL.total, { size: 10, bold: true });
      }
    }

    footer(doc, [
      isGst
        ? 'Tax invoice issued under the GST Act. Consultation is an exempt healthcare service; medicines are taxable.'
        : 'Bill of supply. This clinic is not registered under GST, so no tax is charged.',
      inv.status === 'draft' ? 'DRAFT — not yet issued.' : '',
      'Computer-generated document.',
    ].filter(Boolean));

    const bytes = await doc.pdf.save();
    return pdfResponse(bytes, `invoice-${inv.invoice_number ?? 'bill'}.pdf`);
  } catch (err) {
    return unexpectedError(err, requestId);
  }
});
