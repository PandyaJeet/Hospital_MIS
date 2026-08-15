/**
 * Small layout helpers over pdf-lib, shared by the prescription and invoice
 * renderers so both documents look like they come from the same system.
 *
 * Deliberately plain: Helvetica, A4, no images, no embedded fonts beyond the
 * standard set. Two reasons — it keeps the function cold-start fast, and a
 * clinic's first requirement of a printed prescription is that it is legible on
 * cheap paper, not that it is designed.
 *
 * KNOWN LIMITATION — Devanagari / regional scripts.
 * pdf-lib's standard fonts are WinAnsi-encoded and cannot render Devanagari, so a
 * patient name or drug written in Hindi will not draw correctly. `sanitise()`
 * below replaces unrepresentable characters rather than throwing, so the document
 * still generates instead of failing outright. Proper support needs an embedded
 * Unicode font (e.g. Noto Sans Devanagari) plus fontkit, which is a real change
 * in bundle size and is not in this phase's scope. PRD §7 requires Hindi in the
 * UI, so this gap is recorded in Memory.md §6 as a Phase 3 item — the app is
 * localised before its PDFs are.
 */

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'https://esm.sh/pdf-lib@1.17.1';

export const A4 = { width: 595.28, height: 841.89 } as const;
export const MARGIN = 48;

export const INK = rgb(0.1, 0.1, 0.12);
export const MUTED = rgb(0.42, 0.45, 0.5);
export const RULE = rgb(0.82, 0.84, 0.87);

export interface Doc {
  pdf: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  /** Current vertical cursor, measured from the top of the page. */
  y: number;
}

/**
 * Replaces characters the standard fonts cannot encode. Without this, pdf-lib
 * throws on the first non-WinAnsi codepoint and the whole document fails — a
 * blank error instead of a usable prescription. Degrading one glyph is better.
 */
export function sanitise(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // Rupee sign is outside WinAnsi; spell it instead of dropping it, since an
  // amount with no currency marker on an invoice is worse than a verbose one.
  return text
    .replace(/\u20B9/g, 'Rs.')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7E]/g, '?');
}

export function formatAmount(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

export function formatDate(value: unknown): string {
  if (!value) return '';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return '';
  // dd-MMM-yyyy reads unambiguously in an Indian clinic, unlike a numeric
  // ordering that could be read as either dd/mm or mm/dd.
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

export async function startDoc(title: string): Promise<Doc> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('Hospital MIS');
  const page = pdf.addPage([A4.width, A4.height]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return { pdf, page, regular, bold, y: A4.height - MARGIN };
}

export function text(
  doc: Doc,
  value: unknown,
  opts: { size?: number; bold?: boolean; x?: number; color?: ReturnType<typeof rgb>; dy?: number } = {},
): void {
  const size = opts.size ?? 10;
  if (opts.dy !== undefined) doc.y -= opts.dy;
  doc.page.drawText(sanitise(value), {
    x: opts.x ?? MARGIN,
    y: doc.y,
    size,
    font: opts.bold ? doc.bold : doc.regular,
    color: opts.color ?? INK,
  });
}

/** Right-aligned text, for money columns. */
export function textRight(doc: Doc, value: unknown, right: number, opts: { size?: number; bold?: boolean } = {}): void {
  const size = opts.size ?? 10;
  const font = opts.bold ? doc.bold : doc.regular;
  const s = sanitise(value);
  const w = font.widthOfTextAtSize(s, size);
  doc.page.drawText(s, { x: right - w, y: doc.y, size, font, color: INK });
}

export function rule(doc: Doc, dy = 8): void {
  doc.y -= dy;
  doc.page.drawLine({
    start: { x: MARGIN, y: doc.y },
    end: { x: A4.width - MARGIN, y: doc.y },
    thickness: 0.75,
    color: RULE,
  });
}

export function space(doc: Doc, dy: number): void {
  doc.y -= dy;
}

/** Wraps long free text (advice, instructions) to the page width. */
export function paragraph(doc: Doc, value: unknown, opts: { size?: number; indent?: number } = {}): void {
  const size = opts.size ?? 10;
  const indent = opts.indent ?? 0;
  const maxWidth = A4.width - MARGIN * 2 - indent;
  const words = sanitise(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return;

  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (doc.regular.widthOfTextAtSize(candidate, size) > maxWidth) {
      doc.y -= size + 3;
      doc.page.drawText(line, { x: MARGIN + indent, y: doc.y, size, font: doc.regular, color: INK });
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    doc.y -= size + 3;
    doc.page.drawText(line, { x: MARGIN + indent, y: doc.y, size, font: doc.regular, color: INK });
  }
}

/** Footer disclaimer, drawn at a fixed offset from the bottom. */
export function footer(doc: Doc, lines: string[]): void {
  let y = MARGIN;
  for (const line of [...lines].reverse()) {
    doc.page.drawText(sanitise(line), {
      x: MARGIN,
      y,
      size: 7.5,
      font: doc.regular,
      color: MUTED,
    });
    y += 11;
  }
}
