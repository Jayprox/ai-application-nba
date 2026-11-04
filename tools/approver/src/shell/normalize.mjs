// Text normalisation applied before parsing (story 2.6): NFKC, zero-width removal, lookalike letters
// mapped to ASCII. The parser then removes quote splitting and backslashes word by word.

// Cyrillic and Greek letters that look like Latin ones. Not exhaustive; anything non-ASCII in the
// original text also blocks an allow, so a missed lookalike can only end in ask, never allow.
const CONFUSABLES = {
  'а': 'a', 'в': 'b', 'с': 'c', 'ԁ': 'd', 'е': 'e', 'һ': 'h', 'і': 'i', 'ј': 'j', 'к': 'k', 'ӏ': 'l', 'м': 'm',
  'о': 'o', 'р': 'p', 'ԛ': 'q', 'ѕ': 's', 'т': 't', 'ս': 'u', 'ѵ': 'v', 'ԝ': 'w', 'х': 'x', 'у': 'y', 'ɡ': 'g',
  'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'І': 'I', 'Ј': 'J', 'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P',
  'Ѕ': 'S', 'Т': 'T', 'Х': 'X', 'У': 'Y',
  'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'ν': 'v', 'χ': 'x',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P',
  'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
};
const CONF_RE = new RegExp('[' + Object.keys(CONFUSABLES).join('') + ']', 'g');
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/;

export function normalizeText(raw) {
  const s = String(raw);
  const nonAscii = /[^\x00-\x7f]/.test(s);
  const control = CONTROL_RE.test(s);
  let t = s.normalize('NFKC').replace(INVISIBLE_RE, '').replace(/\0/g, '');
  t = t.replace(CONF_RE, (ch) => CONFUSABLES[ch]);
  // Remaining control characters act like blanks (so they cannot glue two words into one).
  t = t.replace(/[\x01-\x08\x0b-\x1f\x7f]/g, ' ');
  return { text: t, nonAscii, control };
}

export const baseLower = (name) => String(name).split('/').pop().toLowerCase();

// Rough word list for the fallback scan when parsing failed: strips quotes and backslashes so that
// c"ur"l and \curl still show up, then splits on shell metacharacters.
export function looseWords(normalized) {
  return normalized.replace(/['"\\`]/g, '').split(/[\s;&|(){}<>$=,]+/).filter(Boolean);
}

// Comma brace expansion as bash does it ({a,b}c -> ac bc), capped. Ranges ({1..3}) are not expanded.
export function expandBraces(word, cap = 64) {
  const out = [];
  const rec = (w, depth) => {
    if (out.length >= cap) return;
    let hit = null; const re = /\{([^{}]*)\}/g; let m;
    while ((m = re.exec(w))) { if (m[1].includes(',')) { hit = m; break; } }
    if (!hit || depth > 6) { out.push(w); return; }
    for (const part of hit[1].split(',')) rec(w.slice(0, hit.index) + part + w.slice(hit.index + hit[0].length), depth + 1);
  };
  rec(word, 0);
  return out;
}
