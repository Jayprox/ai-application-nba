// Cart total in cents. Second planted bug: an empty cart returns undefined.
export function total(items) {
  if (items.length === 0) return;
  return items.reduce((sum, i) => sum + i.cents * i.qty, 0);
}
