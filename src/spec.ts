/**
 * A reading spec: how to read one invoice layout, written once per layout by a language model — pointing at
 * printed text, never writing a value — and applied by code to every invoice of that layout
 * (`pdf-spec-read.util.ts`). No layout is special to the code: a table's line items and a form's
 * labelled blocks are both RECORDS, and each record's cells come from columns (text by position)
 * or labels (text by what it is printed beside). The invoice's own printed totals prove the read.
 */

/**
 * What the vocabulary means. Raised when a saved spec would read differently under today's reader
 * (3: charge lines read one by one, amounts inside text, `rates`; 4: invoice-level charge and tax
 * lines as rows) — an older spec is never reused, so its layout's spec is written again on the next
 * invoice.
 */
export const SPEC_VERSION = 4;

/**
 * `amount` and `number` cells hold one printed number each; `amounts` adds several amounts of one
 * kind a record prints one per line (its extra charges); `text` and `date` hold any text; `rates`
 * holds prices per unit as printed (`£5.80 each`, `£4.35 /kg`) — money-shaped, charging nothing.
 */
export type CellType = 'text' | 'amount' | 'amounts' | 'number' | 'date' | 'rates';

/**
 * How a record starts: its first text at `x`, either exactly `text` (lower-cased, digits masked)
 * or of `shape` in its first `words` words (all of them when 0) — `d/d/d` for a date, `ad` for a
 * code like `ABC000012345`.
 */
export interface RecordStart {
  x: number;
  words: number;
  shape?: string;
  text?: string;
}

/** A column: text printed between `left` and `right` on the record's lines `fromLine`–`toLine` (1 = first; negative counts back from the last, -1 = last; null = to its last line). */
export interface SpecColumn {
  name: string;
  left: number;
  right: number;
  fromLine: number;
  toLine: number | null;
  type: CellType;
}

/**
 * A value printed beside a label inside a record: `right` — the text right of the label on its
 * line (for an amount, the right-most amount there); `rightBlock` — that and the lines below it
 * starting at the same x; `below` — the text printed under the label; `inText` — the number
 * printed after the label's words inside the same text (`Green Surcharge of £9.60`).
 */
export interface SpecLabel {
  name: string;
  label: string;
  where: 'right' | 'rightBlock' | 'below' | 'inText';
  type: CellType;
}

/**
 * A record's charge lines: each of its lines (`fromLine`–`toLine`, as a column's) printing an amount
 * between `amountLeft` and `amountRight` is one charge, named by the text printed between `nameLeft`
 * and `nameRight` on that line — its words before any figure or bracket, so a rate printed in the
 * name (`Fuel Levy 22%`) does not make next month's charge another cell. Every charge name found on
 * the invoice is a cell of its own on every record, empty where a record does not print it; a name
 * printed twice in one record adds. Checks add all of a record's charges as `Charges`.
 */
export interface SpecCharges {
  nameLeft: number;
  nameRight: number;
  amountLeft: number;
  amountRight: number;
  fromLine: number;
  toLine: number | null;
}

/**
 * A line printing amounts that is not a record, known by the text `label` printed at `x` (its
 * first text, or one it always prints at that place — a payment's description): `end` — the
 * records stop here on its page (totals, an amount carried forward); `skip` — passed over wherever
 * it is (a subtotal, a payment received); `charge` / `tax` — a charge or tax printed once for the
 * whole invoice (an account fee, a fuel levy, GST), read as a row of its own in the invoice cells
 * wherever it follows a record, below an `end` line too.
 */
export interface SpecLine {
  label: string;
  x: number;
  role: 'end' | 'skip' | 'charge' | 'tax';
}

/**
 * - `sum` — the cells, added over every record (or, with `records`, over the charges — records
 *   adding up to nothing or more — or the credits, below nothing), equal the amount beside `label`;
 * - `record` — on every record printing `total` and any of its `parts`, it equals them added together;
 * - `carry` — each page's amount beside `carried` equals the cells added over the records so far,
 *   and the next page's amount beside `brought` repeats it.
 */
export type SpecCheck =
  | {
      kind: 'sum';
      cells: string[];
      label: string;
      records?: 'charges' | 'credits';
      /** Where the label's line prints the total, when it prints several (a summary row). */
      amount?: { x: number; right: number };
      /** Labels of further totals added to this one: a total printed in parts. */
      plus?: string[];
    }
  | { kind: 'record'; total: string; parts: string[] }
  | { kind: 'carry'; cells: string[]; carried: string; brought: string | null };

export interface ReadingSpec {
  version: typeof SPEC_VERSION;
  pageWidth: number;
  /** The table's heading rows (lower-cased, digits masked) — passed over wherever a page repeats them. */
  heading: string[];
  /** Text (lower-cased, digits masked) every invoice of the layout prints: its heading rows, else its labels. */
  identity: string[];
  records: RecordStart[];
  /** Lines that title the records under them (a lane, a service), at these x positions. Their text is the `Section` cell. */
  groups: { x: number }[];
  columns: SpecColumn[];
  labels: SpecLabel[];
  /** Charges a record prints one per line, each read as its own cell; absent in specs written before them. */
  charges?: SpecCharges | null;
  /** Amounts a record prints that no cell reads are added into `Other amounts`, their text in `Other amounts: description`. */
  otherAmounts: boolean;
  /** Lines at the top of a page, before its first record, continue the last record of the page before. */
  carryOver: boolean;
  lines: SpecLine[];
  checks: SpecCheck[];
}

export const SECTION = 'Section';
export const OTHER_AMOUNTS = 'Other amounts';
export const OTHER_DESCRIPTION = 'Other amounts: description';
/** What a check adds for all of a record's charge lines. Not a cell: each charge is its own. */
export const CHARGES = 'Charges';

/**
 * The cells of an invoice-level charge or tax line's row — named by the reader, never the model, so
 * they are the same on every issuer's invoice. Records leave them empty, and those rows leave the
 * records' cells empty. `proven` is `yes` when a checked total adds `Invoice charge amount`.
 */
export const INVOICE_CHARGE = 'Invoice charge';
export const INVOICE_AMOUNT = 'Invoice charge amount';
export const INVOICE_TYPE = 'Invoice charge type';
export const INVOICE_PROVEN = 'Invoice charge proven';
const INVOICE_CELLS = [INVOICE_CHARGE, INVOICE_AMOUNT, INVOICE_TYPE, INVOICE_PROVEN];

/** Whether the spec reads charges or tax printed once for the whole invoice. */
export function readsInvoiceLines(spec: ReadingSpec): boolean {
  return spec.lines.some((line) => line.role === 'charge' || line.role === 'tax');
}

/**
 * The cells every row has under `spec`, in order: columns, labels, then Section, Other amounts and
 * the invoice cells when used. A reading adds the charge names its invoice prints after them
 * (`SpecReading.names`).
 */
export function cellNames(spec: ReadingSpec): string[] {
  return [
    ...spec.columns.map((c) => c.name),
    ...spec.labels.map((l) => l.name),
    ...(spec.groups.length ? [SECTION] : []),
    ...(spec.otherAmounts ? [OTHER_AMOUNTS, OTHER_DESCRIPTION] : []),
    ...(readsInvoiceLines(spec) ? INVOICE_CELLS : []),
  ];
}

export function cellTypes(spec: ReadingSpec): CellType[] {
  return [
    ...spec.columns.map((c) => c.type),
    ...spec.labels.map((l) => l.type),
    ...(spec.groups.length ? (['text'] as CellType[]) : []),
    ...(spec.otherAmounts ? (['amount', 'text'] as CellType[]) : []),
    ...(readsInvoiceLines(spec) ? (['text', 'amount', 'text', 'text'] as CellType[]) : []),
  ];
}
