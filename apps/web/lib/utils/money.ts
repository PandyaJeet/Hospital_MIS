/**
 * Format a rupee amount for display.
 *
 * Money arrives from the backend either as a JSON number (RPC envelopes) or a
 * scale-preserving string (direct column reads) — billing.md §5. Normalise to a
 * number before calling this, and never compare the two representations.
 */
export function formatMoney(amount: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
