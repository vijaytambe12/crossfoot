import { Row, TextFragment } from './geometry.js';

/**
 * Reading printed text: what a fragment says once digits and spacing stop mattering, the shape of
 * its words, and whether it is money. Currency-neutral — `$`, `£`, `€` and none read alike.
 */

/** Lower-cased, whitespace-collapsed, digits masked — the same on every invoice of a layout. */
export function normaliseText(text: string): string {
  return text.replace(/\d/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Where masked `words` first begin a word of masked `text` — never inside another word (`dg` in
 * `cambridge`) — and how long they run there: a count inside the words (`notification: # @`)
 * matches a count of any length.
 */
export function wordAt(text: string, words: string): { at: number; length: number } | null {
  const pattern = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/#+/g, '#+');
  // Words starting with a sign (`, surcharge of`) may follow a number directly.
  const start = /^[\p{L}#]/u.test(words) ? '(?<![\\p{L}#])' : '';
  const match = new RegExp(`${start}${pattern}`, 'u').exec(text);
  return match ? { at: match.index, length: match[0].length } : null;
}

/** `24/08/26` → `d/d/d`, `ABC000012345` → `ad`, `Transport Charges` → `a a`. */
export function tokenShape(text: string): string {
  return text
    .trim()
    .replace(/[A-Za-z]+/g, 'a')
    .replace(/\d+/g, 'd')
    .replace(/\s+/g, ' ');
}

/** The shape of a text's first `words` words (all of them when 0). */
export function shapeOf(text: string, words: number): string {
  const shape = tokenShape(text);
  return words > 0 ? shape.split(' ').slice(0, words).join(' ') : shape;
}

// `(1,234.56)`, `-12.50`, `$ 70.09`, `£412.30`, `12.50CR`, `600` — one number, nothing else.
const NUMBER =
  /^(\()?\s*(-)?\s*(\p{Sc})?\s*(-)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(\))?\s*(CR)?$/iu;
// A number inside running text: `Surcharge of £24.74,` → `£24.74`.
const NUMBER_IN_TEXT =
  /\(?-?\p{Sc}?\s?\d{1,3}(?:,\d{3})*(?!\d)(?:\.\d+)?\)?|\(?-?\p{Sc}?\s?\d+(?:\.\d+)?\)?/gu;

/**
 * A printed number as an integer count of ten-thousandths, or null. `(12.50)`, `-12.50` and
 * `12.50CR` are negative.
 */
export function numberValue(text: string): number | null {
  const match = NUMBER.exec(text.trim());
  if (!match) return null;
  const [, open, minus, , innerMinus, whole, decimals, close, credit] = match;
  if (!!open !== !!close) return null;
  const value = Number(`${whole.replace(/,/g, '')}${decimals ?? ''}`);
  if (!Number.isFinite(value)) return null;
  const negative = !!open || !!minus || !!innerMinus || !!credit;
  return Math.round(value * 10000) * (negative ? -1 : 1) || 0;
}

/** Money: a number with decimals or a currency sign — not a count, a postcode or a year. */
export function isAmount(text: string): boolean {
  const trimmed = text.trim();
  return numberValue(trimmed) !== null && /[.\p{Sc}]/u.test(trimmed);
}

/** The first number printed in running text, as printed (`£24.74`), or null. */
export function firstNumberIn(text: string): string | null {
  for (const match of text.matchAll(NUMBER_IN_TEXT)) {
    const found = match[0].trim().replace(/[,.]$/, '');
    if (numberValue(found) !== null) return found;
  }
  return null;
}

/** Ten-thousandths as the printed amount (`-1234.5` → `-1,234.50`), for messages and logs. */
export function money(value: number): string {
  const sign = value < 0 ? '-' : '';
  const [whole, cents] = (Math.abs(value) / 10000).toFixed(2).split('.');
  return `${sign}${whole.replace(/\B(?=(\d{3})+$)/g, ',')}.${cents}`;
}

export const rowText = (row: Row): string =>
  row.fragments
    .map((f) => f.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

export const centreOf = (f: TextFragment): number => f.x + f.width / 2;

/** The printed height of a row — its tallest text. */
export const lineHeight = (row: Row): number => Math.max(1, ...row.fragments.map((f) => f.height));

/**
 * A printed number as a number: `1,234.50` → 1234.5; `(12.50)`, `-12.50` and `12.50CR` → -12.5;
 * null when the text is not one number. Rows hold text exactly as printed — this is for when you
 * want to calculate with a cell.
 */
export function parseAmount(text: string): number | null {
  const value = numberValue(text);
  return value === null ? null : value / 10000;
}
