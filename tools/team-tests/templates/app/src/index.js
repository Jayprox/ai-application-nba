import { formatPrice } from './price.js';

export function label(name, cents) {
  return `${name}: ${formatPrice(cents)}`;
}
