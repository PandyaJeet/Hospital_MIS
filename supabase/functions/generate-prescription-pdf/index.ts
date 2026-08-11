/**
 * generate-prescription-pdf
 *
 *   POST /functions/v1/generate-prescription-pdf
 *   Authorization: Bearer <user access token>
 *   { "prescription_id": "<uuid>" }
 *
 *   200 -> application/pdf
 *   4xx/5xx -> { "error": { "code", "message" } }   (rules.md §3.7)
 *
 * All data comes from ONE call to get_prescription_for_pdf(), a SECURITY INVOKER
 * Postgres function running under the caller's own JWT. This function therefore
 * holds no authority of its own — see _shared/supabase.ts. It fetches a payload
 * and draws it; every question of "may this person see this?" is answered by RLS
 * before the first byte is laid out.
 *
 * !! NOT DEPLOYED !! Deploying an Edge Function requires a Supabase personal
 * access token (`supabase functions deploy`), which is not available on this
 * machine — only a database password. The data layer this renders IS verified:
 * get_prescription_for_pdf() is covered by the local and remote suites. What
 * remains unverified is the rendering itself. See the handover notes.
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
  formatDate,
  footer,
  paragraph,
  rule,
  space,
  startDoc,
  text,
} from '../_shared/pdf.ts';

interface RequestBody {
  prescription_id?: string;
}

interface Payload {
  ok: boolean;
  code?: string;
  message?: string;
  prescription?: Record<string, unknown>;
  clinic?: Record<string, unknown>;
  doctor?: Record<string, unknown>;
  patient?: Record<string, unknown>;
  visit?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const id = body?.prescription_id;

    if (!id || !UUID_RE.test(id)) {
      return errorResponse('VALIDATION_ERROR', 'A valid prescription_id is required.', 400);
    }

    const { client, token } = clientForRequest(req);
    if (!token) {
      return errorResponse('NOT_AUTHENTICATED', 'Please sign in and try again.', 401);
    }

    const { data, error } = await client.rpc('get_prescription_for_pdf', {
      p_prescription_id: id,
    });

    if (error) {
      // RLS/permission denials land here. Answer the same way as "not found" so
      // the endpoint cannot be used to probe which prescription ids exist in
      // other clinics.
      if (error.code === '42501' || error.code === 'PGRST301') {
        return errorResponse('NOT_FOUND', 'That prescription could not be found.', 404);
      }
      // Deliberately not forwarding error.message — it can contain row data
      // (rules.md §3.3 and §1.3).
      console.error(`[${requestId}] rpc failed code=${error.code ?? 'unknown'}`);
      return errorResponse('PDF_GENERATION_FAILED', 'Could not load the prescription.', 502);
    }

    const payload = data as Payload | null;

    if (!payload || payload.ok !== true) {
      return errorResponse('NOT_FOUND', 'That prescription could not be found.', 404);
    }

    const clinic = payload.clinic ?? {};
    const patient = payload.patient ?? {};
    const visit = payload.visit ?? {};
    const rx = payload.prescription ?? {};
    const doctor = payload.doctor ?? {};
    const items = payload.items ?? [];

    const doc = await startDoc('Prescription');
    const RIGHT = A4.width - MARGIN;

    // ---- clinic header ----
    text(doc, clinic.name ?? 'Clinic', { size: 17, bold: true });
    if (clinic.address) text(doc, clinic.address, { size: 9, color: MUTED, dy: 14 });
    if (clinic.phone) text(doc, `Phone: ${clinic.phone}`, { size: 9, color: MUTED, dy: 12 });
    rule(doc, 14);

    // ---- patient / visit block ----
    space(doc, 16);
    text(doc, `Patient: ${patient.name ?? ''}`, { size: 11, bold: true });
    doc.page.drawText(`Date: ${formatDate(rx.issued_at ?? rx.created_at)}`, {
      x: RIGHT - 150, y: doc.y, size: 10, font: doc.regular,
    });

    const ageGender = [
      patient.age_years ? `${patient.age_years} yrs` : '',
      patient.gender ? String(patient.gender) : '',
    ].filter(Boolean).join(', ');

    text(doc, `UHID: ${patient.patient_number ?? ''}${ageGender ? `   |   ${ageGender}` : ''}`, {
      size: 9, color: MUTED, dy: 14,
    });
    if (visit.queue_number) {
      text(doc, `Token: ${visit.queue_number}   |   Visit: ${visit.visit_type ?? ''}`, {
        size: 9, color: MUTED, dy: 12,
      });
    }

    // Allergies get prominence, not a footnote — this is the line that prevents
    // a dispensing error at the counter.
    if (patient.allergies) {
      space(doc, 14);
      text(doc, `ALLERGIES: ${patient.allergies}`, { size: 10, bold: true });
    }

    rule(doc, 16);

    // ---- items ----
    space(doc, 18);
    text(doc, 'Rx', { size: 13, bold: true });
    space(doc, 6);

    if (items.length === 0) {
      text(doc, 'No medicines prescribed.', { size: 10, color: MUTED, dy: 16 });
    } else {
      items.forEach((item, i) => {
        space(doc, 16);
        const name = [item.drug_name, item.is_generic && item.generic_name ? `(${item.generic_name})` : '']
          .filter(Boolean).join(' ');
        text(doc, `${i + 1}. ${name}`, { size: 11, bold: true });

        // dose/frequency/duration are all nullable by design (rules.md §1.7), so
        // only render what the doctor actually filled in rather than printing
        // empty labels.
        const detail = [item.dose, item.frequency, item.duration]
          .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
          .join('  |  ');
        if (detail) text(doc, detail, { size: 10, x: MARGIN + 16, dy: 13 });
        if (item.quantity) text(doc, `Qty: ${item.quantity}`, { size: 9, color: MUTED, x: MARGIN + 16, dy: 12 });
        if (item.instructions) paragraph(doc, String(item.instructions), { size: 9, indent: 16 });
      });
    }

    if (rx.notes) {
      space(doc, 18);
      text(doc, 'Advice', { size: 11, bold: true });
      paragraph(doc, String(rx.notes), { size: 10 });
    }

    // ---- signature ----
    space(doc, 46);
    doc.page.drawLine({
      start: { x: RIGHT - 190, y: doc.y },
      end: { x: RIGHT, y: doc.y },
      thickness: 0.75,
    });
    space(doc, 12);
    doc.page.drawText(String(doctor.name ?? 'Doctor'), {
      x: RIGHT - 190, y: doc.y, size: 10, font: doc.bold,
    });

    footer(doc, [
      'This is a computer-generated prescription.',
      rx.status === 'issued'
        ? ''
        : 'DRAFT — not yet issued. Not valid for dispensing.',
    ].filter(Boolean));

    const bytes = await doc.pdf.save();
    // Filename carries the UHID, never the patient's name: it shows up in
    // browser download history and shared folders (rules.md §1.3).
    return pdfResponse(bytes, `prescription-${patient.patient_number ?? 'rx'}.pdf`);
  } catch (err) {
    return unexpectedError(err, requestId);
  }
});
