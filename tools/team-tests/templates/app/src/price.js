// Formats a price in cents as a dollar string.
export function formatPrice(cents) {
  if (!cents) return '';
  return `$${(cents / 100).toFixed(2)}`;
}
