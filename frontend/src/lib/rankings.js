// Ranking display helpers (pure; tested).
/** 1 -> "1st", 22 -> "22nd", 13 -> "13th". */
export function ordinal(n) {
  if (n == null) return '';
  const v = n % 100;
  return `${n}${v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`;
}

/** Props board note: "vs BOS: 27th of 30 vs guards" (null when there's nothing to say). */
export function matchupText(m) {
  if (!m || m.rank == null) return null;
  return `${m.opponent}: ${ordinal(m.rank)} of ${m.of} vs ${m.position_label.toLowerCase()}`;
}
