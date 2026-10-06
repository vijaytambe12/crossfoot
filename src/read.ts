import {
  DocumentGeometry,
  Row,
  TextFragment,
} from './geometry.js';
import {
  CHARGES,
  CellType,
  INVOICE_AMOUNT,
  INVOICE_CHARGE,
  INVOICE_PROVEN,
  INVOICE_TYPE,
  OTHER_AMOUNTS,
  OTHER_DESCRIPTION,
  ReadingSpec,
  SECTION,
  SpecCharges,
  SpecCheck,
  SpecColumn,
  SpecLabel,
  cellNames,
  cellTypes,
  readsInvoiceLines,
} from './spec.js';
import {
  firstNumberIn,
  isAmount,
  lineHeight,
  money,
  normaliseText,
  numberValue,
  rowText,
  shapeOf,
  wordAt,
} from './text.js';

/**
 * A reading spec applied to one invoice: its records and their cells, and whether the invoice
 * proves them. Nothing here knows any issuer or layout — every decision comes from the spec, and
 * the invoice's own printed amounts decide whether the read stands:
 * - every line printing an amount is a record's, or a line the spec knows is not a charge;
 * - every amount a record prints is read by one of its cells (or `Other amounts`) — an amount printed
 *   inside a text too;
 * - every amount cell holds one number;
 * - every check holds, and the records printing amounts are all covered by a printed total.
 */

/** How far a printed position may sit from the spec's: positions are rounded. */
const EDGE = 3;

export interface SpecRecord {
  page: number;
  cells: string[];
}

export type SpecProblemCheck =
  | 'no_records'
  | 'unknown_line'
  | 'unread_amount'
  | 'unread_text'
  | 'amount_in_text'
  | 'no_amount'
  | 'hidden_charge'
  | 'label'
  | 'cell'
  | 'total'
  | 'record_total'
  | 'carry'
  | 'uncovered';

/**
 * Why the invoice does not prove the read. `message` and `detail` hold labels with digits masked,
 * cell names and money sums only — they reach logs and the user. `evidence` is what is printed
 * behind it, shown only to the model that wrote the spec so it can see what to change.
 */
export interface SpecProblem {
  check: SpecProblemCheck;
  message: string;
  detail?: Record<string, unknown>;
  evidence?: string;
  /** The printed lines the evidence names — numbered for the model, which may not have been shown them. */
  lines?: Line[];
}

export interface SpecReading {
  names: string[];
  records: SpecRecord[];
  problem: SpecProblem | null;
}

export interface Line {
  page: number;
  row: Row;
}

interface Walked {
  page: number;
  lines: Line[];
  group: string;
}

export function readWithSpec(geometry: DocumentGeometry, spec: ReadingSpec): SpecReading {
  const walk = walkRecords(geometry, spec);
  const built = walk.records.map((record) => recordCells(record, spec));
  const table = tableOf(spec, built);
  const records = [
    ...built.map(({ cells, charges }, i) => ({
      page: walk.records[i].page,
      cells: [
        ...cells,
        ...(spec.charges ? [added([...charges.values()])] : []),
        ...table.charges.map((name) => charges.get(name) ?? ''),
      ],
    })),
    ...walk.invoice.flatMap((line) => invoiceRow(line, table, spec)),
  ];
  const problem =
    (walk.records.length ? null : noRecords()) ??
    hiddenCharge(walk.hidden) ??
    unknownLine(walk.loose) ??
    unreadTail(walk.tail) ??
    built.find((b) => b.problem)?.problem ??
    cellProblem(records, table) ??
    moneylessRecord(records, table, walk.records) ??
    amountInText(records, table, spec) ??
    built.find((b) => b.unreadText)?.unreadText ??
    checkProblem(geometry, spec, table, walk, records);
  return { names: table.names, records, problem };
}

/**
 * A reading's cells: the spec's, then — when it reads charge lines — `Charges`, a record's charges
 * added (the sum its checks prove), and each charge name the invoice prints, in the order first printed.
 */
interface Table {
  names: string[];
  types: CellType[];
  charges: string[];
}

function tableOf(spec: ReadingSpec, built: Built[]): Table {
  const charges = [...new Set(built.flatMap((b) => [...b.charges.keys()]))];
  const sum = spec.charges ? [CHARGES] : [];
  return {
    names: [...cellNames(spec), ...sum, ...charges],
    types: [...cellTypes(spec), ...[...sum, ...charges].map((): CellType => 'amount')],
    charges,
  };
}

function amountOf(table: Table, record: SpecRecord, name: string): number {
  return numberValue(record.cells[table.names.indexOf(name)] ?? '') ?? 0;
}

function printsCell(table: Table, record: SpecRecord, name: string): boolean {
  return !!record.cells[table.names.indexOf(name)];
}

/** Whether the document prints every identity text of the spec — as a whole row or as one text. */
export function printsIdentity(geometry: DocumentGeometry, spec: ReadingSpec): boolean {
  const printed = new Set<string>();
  for (const row of geometry.pages.flatMap((page) => page.rows)) {
    printed.add(normaliseText(rowText(row)));
    for (const f of row.fragments) printed.add(normaliseText(f.str));
  }
  return spec.identity.every((text) => printed.has(text));
}

const isMoney = (type: string) => type === 'amount' || type === 'amounts';

/**
 * Every record is a charged item, so it prints an amount: a "record" that prints none is text the
 * record starts matched by mistake (an address line starting with a number, like a job number).
 */
function moneylessRecord(
  records: SpecRecord[],
  { types }: Table,
  walked: Walked[],
): SpecProblem | null {
  if (!types.some(isMoney)) return null;
  const index = records.findIndex((r) => !r.cells.some((cell, c) => cell && isMoney(types[c])));
  if (index < 0) return null;
  const start = walked[index].lines[0].row;
  return {
    check: 'no_amount',
    message: `record ${index + 1} (page ${records[index].page}) prints no amount: its start matched a line that is not a charge`,
    // Likely an address, not a charge: logged by its shape only.
    detail: { record: index + 1, page: records[index].page, shape: shapeOf(rowText(start), 0) },
    evidence: `The line it starts on: ${JSON.stringify(rowText(start))}`,
  };
}

/** A money amount printed inside a text: `Surcharge of £24.74`. */
const CURRENCY_AMOUNT = /[$£€]\s?\(?-?\d[\d,]*(?:\.\d+)?\)?/g;

/**
 * An amount printed inside a text is a value like any other: a text cell holding one that no cell
 * of its record reads (an `inText` label, by the words before it) leaves it unread.
 */
function amountInText(records: SpecRecord[], table: Table, spec: ReadingSpec): SpecProblem | null {
  const texts = [...spec.columns, ...spec.labels].filter(
    (c) => c.type === 'text' || c.type === 'date',
  );
  const labelled = spec.labels.filter((l) => l.where === 'inText');
  const unread: UnreadInText[] = [];
  for (const [r, record] of records.entries()) {
    const read = labelled.map((l) => amountOf(table, record, l.name));
    for (const { name } of texts) {
      const cell = record.cells[table.names.indexOf(name)] ?? '';
      const amounts = (cell.match(CURRENCY_AMOUNT) ?? []).filter((amount) => {
        const at = read.indexOf(numberValue(amount) ?? NaN);
        if (at >= 0) read.splice(at, 1);
        return at < 0;
      });
      if (amounts.length) unread.push({ record: r, page: record.page, name, cell, amounts });
    }
  }
  if (!unread.length) return null;
  const [first] = unread;
  const count = first.amounts.length;
  return {
    check: 'amount_in_text',
    message: `the text cell "${first.name}" of record ${first.record + 1} (page ${first.page}) holds ${count} amount${count === 1 ? '' : 's'} no cell reads`,
    detail: { cell: first.name, record: first.record + 1, page: first.page, amounts: count },
    evidence: inTextEvidence(unread),
  };
}

interface UnreadInText {
  record: number;
  page: number;
  name: string;
  cell: string;
  amounts: string[];
}

/**
 * Each kind of unread amount once — told apart by the words printed before it — with a text
 * printing it, from every record: shown one record at a time, a model reads one kind per round.
 */
function inTextEvidence(unread: UnreadInText[]): string {
  const kinds = new Map<string, string>();
  for (const { record, page, name, cell, amounts } of unread) {
    for (const amount of amounts) {
      const before = cell.slice(0, cell.indexOf(amount)).trim().split(' ').slice(-3).join(' ');
      const kind = normaliseText(before).replace(/#+/g, '#');
      if (!kinds.has(kind))
        kinds.set(
          kind,
          `- record ${record + 1} (page ${page}), "${name}": ${JSON.stringify(cell)} — ${amount}`,
        );
    }
  }
  const records = new Set(unread.map((u) => u.record)).size;
  return [
    `Amounts printed inside text that no cell reads, one of each kind (${kinds.size} kinds, in ${records} record${records === 1 ? '' : 's'}):`,
    ...[...kinds.values()].slice(0, IN_TEXT_KINDS_SHOWN),
    'Read each by an inText label — the words printed right before it, a count among them kept (any count matches) — or the cell as an amount. A column of prices per unit (`£5.80 each`, `£4.35 /kg`), which charge nothing by themselves, is `rates`.',
  ].join('\n');
}

/** Kinds of unread in-text amount shown to the model in one round. */
const IN_TEXT_KINDS_SHOWN = 12;

const noRecords = (): SpecProblem => ({
  check: 'no_records',
  message: 'no line of the invoice starts a record',
});

// ─── Records ──────────────────────────────────────────────────────────────────

/**
 * Pages in order, rows top to bottom. A record runs from its start to the next start, a group
 * title, an `end` line or — unless the spec carries records over — the foot of its page. Rows
 * before a page's first record belong to nothing (a page header) unless they carry over. A row
 * printing an amount after the page's first record and in no record is `loose`: unexplained.
 */
function walkRecords(geometry: DocumentGeometry, spec: ReadingSpec): Walk {
  const furniture = furnitureRows(geometry, spec);
  const heading = new Set(spec.heading);
  const totals = totalLabels(spec);
  const records: Walked[] = [];
  const loose: Line[] = [];
  const hidden: Line[] = [];
  const invoice: InvoiceLine[] = [];
  // The lines printing amounts since the last record started that are not its own.
  let after: (Line & { role: Role | null })[] = [];
  let current: Walked | null = null;
  const title = { text: '', page: 0, y: 0 };
  const close = () => {
    if (current) records.push(current);
    current = null;
  };
  for (const page of geometry.pages) {
    let started = false;
    let ended = false;
    // A record carries over below the page's heading, when it repeats one: above it is page header.
    const headingY =
      page.rows.find((row) => heading.has(normaliseText(rowText(row))))?.y ?? -Infinity;
    for (const row of page.rows) {
      const line = { page: page.pageNumber, row };
      if (furniture.has(row) || heading.has(normaliseText(rowText(row)))) continue;
      const role = roleOf(row, spec, totals);
      // An opening balance printed like a record, before any record, is not a charge left out.
      const recordsStarted = records.length > 0 || !!current;
      const printsAmount = row.fragments.some((f) => isAmount(f.str));
      if (recordsStarted && printsAmount && (ended || role)) after.push({ ...line, role });
      // Charged once for the whole invoice: read wherever it follows a record, below an end line too.
      if (recordsStarted && (role === 'charge' || role === 'tax')) {
        invoice.push({ ...line, role });
        continue;
      }
      if (ended) continue;
      if ((role === 'end' || role === 'skip') && recordsStarted && chargesLikeARecord(row, spec))
        hidden.push(line);
      if (role === 'end') {
        close();
        ended = true;
      } else if (role) {
        continue;
      } else if (startsRecord(row, spec)) {
        close();
        current = { page: page.pageNumber, lines: [line], group: title.text };
        started = true;
        after = [];
      } else if (isGroupTitle(row, spec)) {
        close();
        setTitle(title, row, page.pageNumber);
      } else if (current && (started || (spec.carryOver && row.y > headingY))) {
        current.lines.push(line);
      } else if (started && printsAmount) {
        loose.push(line);
      } else if (recordsStarted && printsAmount) {
        after.push({ ...line, role: null });
      }
    }
    if (!spec.carryOver) close();
  }
  close();
  return { records, loose, hidden, invoice, ...afterRecords(after, spec, records) };
}

type Role = 'end' | 'skip' | 'charge' | 'tax' | 'total';

/** A charge or tax printed once for the whole invoice, read as a row of its own. */
type InvoiceLine = Line & { role: 'charge' | 'tax' };

interface Walk {
  records: Walked[];
  loose: Line[];
  hidden: Line[];
  invoice: InvoiceLine[];
  /** Lines between the last record and the invoice's own total that no line of the spec names. */
  tail: Line[];
  /** Lines there passed over as not charges (`skip`) — charged money, when the invoice's total holds them. */
  skipped: Line[];
}

/**
 * The lines printing amounts after the last record, up to the invoice's own total (a total adding
 * `Invoice charge amount`) — or to the end of the last record's page — that no line of the spec
 * names. An `end` line hides nothing there: a charge printed once for the whole invoice sits exactly
 * between the records and that total, and passing it over would drop it with every check holding.
 */
function afterRecords(
  after: (Line & { role: Role | null })[],
  spec: ReadingSpec,
  records: Walked[],
): { tail: Line[]; skipped: Line[] } {
  const last = records[records.length - 1];
  if (!last) return { tail: [], skipped: [] };
  const own = new Set(
    spec.checks.flatMap((c) =>
      c.kind === 'sum' && c.cells.includes(INVOICE_AMOUNT) ? [c.label, ...(c.plus ?? [])] : [],
    ),
  );
  // A check finds its label anywhere on a line (a notice or a footer can print first).
  const prints = (row: Row, labels: Set<string>) =>
    row.fragments.some((f) => labels.has(normaliseText(f.str)));
  const cut = after.map((a) => prints(a.row, own)).lastIndexOf(true);
  const lastPage = last.lines[last.lines.length - 1].page;
  const region = cut >= 0 ? after.slice(0, cut) : after.filter((a) => a.page === lastPage);
  const totals = totalLabels(spec);
  const line = ({ page, row }: Line) => ({ page, row });
  return {
    tail: region.filter((a) => !a.role && !prints(a.row, totals)).map(line),
    skipped: region.filter((a) => a.role === 'skip').map(line),
  };
}

function unreadTail(tail: Line[]): SpecProblem | null {
  if (!tail.length) return null;
  const [first] = tail;
  const shown = tail.slice(0, SHOWN);
  return {
    check: 'unknown_line',
    message: `${tail.length} line(s) after the last record print amounts and are no known line, the first on page ${first.page}: "${lineLabel(first.row)}"`,
    detail: { lines: tail.length, page: first.page, label: lineLabel(first.row) },
    evidence: [
      'The lines as printed:',
      ...shown.map((l) => `- p${l.page}: ${rowText(l.row)}`),
      'Every line printing an amount between the records and the invoice’s own total is one of: a total the records prove (a check’s total, or `skip`), a charge or tax printed once for the whole invoice (a `charge` or `tax` line, read as a row of its own), or a line that is not a charge (`skip`). An `end` line does not pass over them.',
    ].join('\n'),
    lines: shown,
  };
}

/**
 * An invoice-level line's row: its printed words, its right-most amount (or a number its words run
 * into), charge or tax, and whether a checked total adds it. Every other cell is empty.
 */
function invoiceRow(line: InvoiceLine, table: Table, spec: ReadingSpec): SpecRecord[] {
  const { fragments } = line.row;
  const amounts = fragments.filter((f) => isAmount(f.str));
  const tail = amounts.length ? null : tailOf(fragments[fragments.length - 1]);
  const amount = amounts.length
    ? amounts[amounts.length - 1].str
    : tail && isAmount(tail.number)
      ? tail.number
      : null;
  if (amount === null) return [];
  const words = fragments
    .filter((f) => !isAmount(f.str))
    .map((f) => (tail && f === fragments[fragments.length - 1] ? tail.head : f.str));
  const proven = spec.checks.some((c) => c.kind !== 'record' && c.cells.includes(INVOICE_AMOUNT));
  const cells = table.names.map(() => '');
  const set = (name: string, value: string) => (cells[table.names.indexOf(name)] = value);
  set(INVOICE_CHARGE, clean(words.join(' ')));
  set(INVOICE_AMOUNT, clean(amount));
  set(INVOICE_TYPE, line.role);
  set(INVOICE_PROVEN, proven ? 'yes' : 'no');
  return [{ page: line.page, cells }];
}

/**
 * A line printed like a record — its start matches — printing a positive amount is a charge, so it
 * can never be passed over: a subtotal that leaves such lines out would otherwise prove a read
 * that drops them. Payments and credits (amounts below nothing) may be.
 */
function chargesLikeARecord(row: Row, spec: ReadingSpec): boolean {
  return (
    startsRecord(row, spec) && row.fragments.some((f) => isAmount(f.str) && (numberValue(f.str) ?? 0) > 0)
  );
}

function hiddenCharge(hidden: Line[]): SpecProblem | null {
  if (!hidden.length) return null;
  const [first] = hidden;
  return {
    check: 'hidden_charge',
    message: `${hidden.length} line(s) printed like a record, with a positive amount, are passed over as not charges, the first on page ${first.page}: "${lineLabel(first.row)}"`,
    detail: { lines: hidden.length, page: first.page, label: lineLabel(first.row) },
    evidence: `The line as printed: ${JSON.stringify(rowText(first.row))}. A charge is a record: check it against a total that includes it.`,
    lines: [first],
  };
}

/** The labels of the printed totals the checks read. */
function totalLabels(spec: ReadingSpec): Set<string> {
  return new Set(
    spec.checks.flatMap((check) =>
      check.kind === 'sum'
        ? [check.label, ...(check.plus ?? [])]
        : check.kind === 'carry'
          ? [check.carried, ...(check.brought ? [check.brought] : [])]
          : [],
    ),
  );
}

/**
 * An `end` or `skip` line — known by its text at its place, before anything else, so a payment
 * printed like a record (a date first) is still passed over — or a printed total a check reads.
 */
function roleOf(row: Row, spec: ReadingSpec, totals: Set<string>): Role | null {
  for (const line of spec.lines)
    if (
      row.fragments.some(
        (f) => Math.abs(f.x - line.x) <= EDGE && normaliseText(f.str) === line.label,
      )
    )
      return line.role;
  return totals.has(normaliseText(row.fragments[0].str)) ? 'total' : null;
}

/**
 * A page header or footer: printed at the same height with the same text (digits masked) on at
 * least half the pages, printing no amount, and above every record start or below every one — a
 * record's own lines repeat too (a year under a date, printed at the same height on every page).
 */
function furnitureRows(geometry: DocumentGeometry, spec: ReadingSpec): Set<Row> {
  if (geometry.pageCount < 2) return new Set();
  const starts = geometry.pages.flatMap((page) =>
    page.rows.filter((row) => startsRecord(row, spec)).map((row) => row.y),
  );
  const [top, bottom] = [Math.min(...starts), Math.max(...starts)];
  const pagesOf = new Map<string, Set<number>>();
  const keyOf = (row: Row) => `${Math.round(row.y / 4)}|${normaliseText(rowText(row))}`;
  for (const page of geometry.pages)
    for (const row of page.rows) {
      const key = keyOf(row);
      pagesOf.set(key, (pagesOf.get(key) ?? new Set()).add(page.pageNumber));
    }
  const least = Math.max(2, Math.ceil(geometry.pageCount / 2));
  return new Set(
    geometry.pages.flatMap((page) => {
      const footer = footerTop(page.rows, bottom);
      return page.rows.filter(
        (row) =>
          (row.y < top || row.y >= footer) &&
          (pagesOf.get(keyOf(row))?.size ?? 0) >= least &&
          !row.fragments.some((f) => isAmount(f.str)),
      );
    }),
  );
}

/**
 * Where a page's footer can start: the first line below every record start that follows a gap of
 * more than two lines. The lines right under the page's last record are that record's own, however
 * alike they are from page to page.
 */
function footerTop(rows: Row[], bottom: number): number {
  const sorted = [...rows].sort((a, b) => a.y - b.y);
  const gapped = sorted.find(
    (row, i) => row.y > bottom && i > 0 && row.y - sorted[i - 1].y > 2 * lineHeight(row),
  );
  return gapped?.y ?? Infinity;
}

export function startsRecord(row: Row, spec: ReadingSpec): boolean {
  const first = row.fragments[0];
  if (!first) return false;
  return spec.records.some(
    (start) =>
      Math.abs(first.x - start.x) <= EDGE &&
      (start.text !== undefined
        ? normaliseText(first.str) === start.text
        : shapeOf(first.str, start.words) === start.shape),
  );
}

function isGroupTitle(row: Row, spec: ReadingSpec): boolean {
  const [only, ...rest] = row.fragments;
  return (
    !!only &&
    !rest.length &&
    !isAmount(only.str) &&
    spec.groups.some((g) => Math.abs(only.x - g.x) <= EDGE)
  );
}

/** A title printed right under the one before (within 1.5 text heights) continues it. */
function setTitle(title: { text: string; page: number; y: number }, row: Row, page: number): void {
  const text = rowText(row);
  const continues = title.page === page && row.y - title.y <= 1.5 * lineHeight(row);
  title.text = continues ? `${title.text} ${text}` : text;
  title.page = page;
  title.y = row.y;
}

function unknownLine(loose: Line[]): SpecProblem | null {
  if (!loose.length) return null;
  const [first] = loose;
  return {
    check: 'unknown_line',
    message: `${loose.length} line(s) print amounts in no record and are no known line, the first on page ${first.page}: "${lineLabel(first.row)}"`,
    detail: { lines: loose.length, page: first.page, label: lineLabel(first.row) },
    evidence: `The line as printed: ${JSON.stringify(rowText(first.row))}`,
    lines: [first],
  };
}

/** How a line is named in a message or a log: its first text, digits masked — never the whole line. */
function lineLabel(row: Row): string {
  return normaliseText(row.fragments[0]?.str ?? '');
}

// ─── Cells ───────────────────────────────────────────────────────────────────

interface Built {
  cells: string[];
  /** The record's charge lines: each charge's amount under its name. */
  charges: Map<string, string>;
  problem: SpecProblem | null;
  /** Checked after every record is known to print an amount: a line matched by mistake reads nothing. */
  unreadText?: SpecProblem;
}

/**
 * Labels first (they take their text), then charge lines, then columns, then the Section and Other
 * amounts cells. A text a label reads an amount from inside is still read whole by its column.
 */
function recordCells(record: Walked, spec: ReadingSpec): Built {
  const consumed = new Set<TextFragment>();
  const inText = new Set<TextFragment>();
  const labelled = readLabels(record, spec, consumed, inText);
  if ('problem' in labelled) return { cells: [], charges: new Map(), problem: labelled.problem };
  const charges = spec.charges ? readCharges(record, spec, consumed) : new Map<string, string>();
  const columns = readColumns(record, spec.columns, consumed, inText);
  // A record's own line is all data: text on it no cell reads is a column the spec left out.
  const unreadText = record.lines[0].row.fragments.filter(
    (f) => !consumed.has(f) && !inText.has(f) && !isAmount(f.str),
  );
  const other = otherAmounts(record, consumed);
  const cells = [
    ...columns,
    ...labelled.values,
    ...(spec.groups.length ? [record.group] : []),
    ...(spec.otherAmounts ? [other.amount, other.description] : []),
    // A record leaves the invoice-level cells empty.
    ...(readsInvoiceLines(spec) ? ['', '', '', ''] : []),
  ];
  if (other.lines.length && !spec.otherAmounts)
    return {
      cells,
      charges,
      problem: unreadAmount(record, other.lines[0], other.unread, spec.charges),
    };
  return {
    cells,
    charges,
    problem: null,
    unreadText: unreadText.length ? unreadTextProblem(record, unreadText) : undefined,
  };
}

const placed = (fragments: TextFragment[]) =>
  fragments.map((f) => `${JSON.stringify(f.str)} at x=${Math.round(f.x)}`).join(', ');

function unreadTextProblem(record: Walked, unread: TextFragment[]): SpecProblem {
  return {
    check: 'unread_text',
    message: `a record on page ${record.page} prints text on its first line that no cell reads`,
    detail: { page: record.page, texts: unread.length },
    evidence: `The line as printed: ${JSON.stringify(rowText(record.lines[0].row))}. No cell reads: ${placed(unread)}`,
  };
}

/** How a line under a record that is not the record's is kept out of it. */
const SET_ASIDE =
  ' If this line is not the record’s — a total, a subtotal, a payment — give it as a `lines` entry: `end` where the records stop on its page, `skip` otherwise. If it is, read it by a cell.';

/** How a figure printed on a charge line, beside the charge, is read. */
const CHARGE_FIGURE =
  ' It is printed on a charge line, between the charge’s name and its amount: a figure each charge prints (a quantity, a rate) is read by a column over the charges’ lines at its place — or by the charges’ name range, when it is part of the name.';

/** An amount a record prints that no cell reads — with where its line sits in the record. */
function unreadAmount(
  record: Walked,
  line: Row,
  unread: TextFragment[],
  charges: SpecCharges | null | undefined,
): SpecProblem {
  const at = record.lines.findIndex((l) => l.row === line);
  const count = record.lines.length;
  const lineAt = (n: number) => (n > 0 ? n : count + 1 + n);
  const onChargeLine =
    !!charges &&
    at + 1 >= lineAt(charges.fromLine) &&
    (charges.toLine === null || at + 1 <= lineAt(charges.toLine)) &&
    unread.some((f) => line.fragments.includes(f) && f.x < charges.amountLeft);
  return {
    check: 'unread_amount',
    message: `a record on page ${record.page} prints an amount no cell reads, on the line "${lineLabel(line)}"`,
    detail: { page: record.page, label: lineLabel(line) },
    evidence: `The line as printed: ${JSON.stringify(rowText(line))}. No cell reads: ${placed(
      unread.filter((f) => line.fragments.includes(f)),
    )}. It is line ${at + 1} of the record’s ${count} (${at - count} from its end).${onChargeLine ? CHARGE_FIGURE : at > 0 ? SET_ASIDE : ''}`,
    lines: [record.lines[at]],
  };
}

/**
 * Each text goes to the column its left edge falls in, among the columns reading its line — or,
 * printed just outside every one, to the nearest within a few points.
 */
function readColumns(
  record: Walked,
  columns: SpecColumn[],
  consumed: Set<TextFragment>,
  inText: Set<TextFragment>,
): string[] {
  const texts = columns.map(() => [] as string[]);
  const count = record.lines.length;
  // Line numbers count from the record's first line, or (negative) back from its last.
  const lineAt = (line: number) => (line > 0 ? line : count + 1 + line);
  record.lines.forEach(({ row }, i) => {
    const reading = columns
      .map((column, c) => ({ column, c }))
      .filter(
        ({ column }) =>
          i + 1 >= lineAt(column.fromLine) &&
          (column.toLine === null || i + 1 <= lineAt(column.toLine)),
      );
    for (const f of row.fragments) {
      if (consumed.has(f)) continue;
      const distance = ({ column }: { column: SpecColumn }) =>
        f.x < column.left ? column.left - f.x : f.x >= column.right ? f.x - column.right : 0;
      const inside = reading.find((r) => distance(r) === 0);
      const near = reading
        .filter((r) => distance(r) <= EDGE)
        .sort((a, b) => distance(a) - distance(b))[0];
      const target = inside ?? near;
      if (!target) continue;
      // A text a label read an amount from is text: only a text column reads it, whole.
      if (inText.has(f) && !['text', 'date'].includes(target.column.type)) continue;
      consumed.add(f);
      const tail = inText.has(f) ? null : numberTail(f, reading);
      if (tail && tail.column !== target) {
        texts[target.c].push(tail.head);
        texts[tail.column.c].push(tail.number);
      } else texts[target.c].push(f.str);
    }
  });
  return texts.map((t, c) => (columns[c].type === 'amounts' ? added(t) : clean(t.join(' '))));
}

/**
 * A number the PDF merged onto the end of a text run, where it is printed under a number column
 * (`Remote area 8.25` reaching into the amounts): the text before it, the number, and that column.
 * Where it is printed is estimated from its place in the run.
 */
function numberTail<T extends { column: SpecColumn }>(
  f: TextFragment,
  reading: T[],
): { head: string; number: string; column: T } | null {
  const tail = tailOf(f);
  const column =
    tail &&
    reading.find(
      ({ column: c }) =>
        ['amount', 'amounts', 'number'].includes(c.type) && tail.x >= c.left && tail.x < c.right,
    );
  return column ? { head: tail.head, number: tail.number, column } : null;
}

/** A text run's last word when it is a number: the text before it, the number and where it is printed. */
function tailOf(f: TextFragment): { head: string; number: string; x: number } | null {
  const split = /^(.*\S)\s+(\S+)$/.exec(f.str);
  if (!split || numberValue(split[2]) === null) return null;
  const x = f.x + (f.width * (f.str.length - split[2].length)) / f.str.length;
  return { head: split[1], number: split[2], x };
}

/**
 * A record's charge lines: each line printing an amount in the charges' amount range (or a name
 * whose text run ends in one printed there) is a charge, named by the text in the name range.
 */
function readCharges(
  record: Walked,
  spec: ReadingSpec,
  consumed: Set<TextFragment>,
): Map<string, string> {
  const c = spec.charges as SpecCharges;
  const own = new Set([...cellNames(spec), CHARGES]);
  const within = (x: number, left: number, right: number) => x >= left - EDGE && x < right + EDGE;
  const count = record.lines.length;
  const lineAt = (line: number) => (line > 0 ? line : count + 1 + line);
  const found = new Map<string, string[]>();
  record.lines.forEach(({ row }, i) => {
    if (i + 1 < lineAt(c.fromLine) || (c.toLine !== null && i + 1 > lineAt(c.toLine))) return;
    const free = row.fragments.filter((f) => !consumed.has(f));
    const printed = free
      .filter((f) => isAmount(f.str) && within(f.x, c.amountLeft, c.amountRight))
      .pop();
    const words = free.filter((f) => !isAmount(f.str) && within(f.x, c.nameLeft, c.nameRight));
    const merged = printed
      ? null
      : words
          .map((f) => ({ f, tail: tailOf(f) }))
          .find(
            ({ tail }) =>
              tail && isAmount(tail.number) && within(tail.x, c.amountLeft, c.amountRight),
          );
    if (!printed && !merged) return;
    [...words, ...(printed ? [printed] : [])].forEach((f) => consumed.add(f));
    const text = words.map((f) => (f === merged?.f ? (merged.tail?.head ?? '') : f.str)).join(' ');
    const named = chargeName(text);
    const name = own.has(named) ? `${named} (charge)` : named;
    found.set(name, [...(found.get(name) ?? []), merged ? (merged.tail?.number ?? '') : (printed?.str ?? '')]);
  });
  return new Map(
    [...found].map(([name, amounts]) => [
      name,
      amounts.length === 1 ? clean(amounts[0]) : added(amounts),
    ]),
  );
}

/** A charge's name: its words before any figure or bracket — `Fuel Levy 22% / 6% Tolls` is `Fuel Levy`. */
function chargeName(text: string): string {
  return (
    clean(text)
      .split(/[\d([$£€]/)[0]
      .replace(/[^\p{L}]+$/u, '') || 'Charge'
  );
}

/** Several amounts of one kind printed one per line, added — or the text as read when one is not a number. */
function added(texts: string[]): string {
  const values = texts.map((t) => numberValue(t));
  if (!texts.length) return '';
  if (values.some((v) => v === null)) return clean(texts.join(' '));
  return money((values as number[]).reduce((sum, v) => sum + v, 0)).replace(/,/g, '');
}

/**
 * Every label's value in the record, in the spec's order. Longer labels are matched first, so a
 * label inside another (`Surcharge of` in `Green Surcharge of`) never reads the other's amount.
 */
function readLabels(
  record: Walked,
  spec: ReadingSpec,
  consumed: Set<TextFragment>,
  inText: Set<TextFragment>,
): { values: string[] } | { problem: SpecProblem } {
  const labelTexts = new Set(spec.labels.map((l) => l.label));
  const blanked = new Map<TextFragment, string>();
  const values = new Map<SpecLabel, string>();
  // Longest first; of one label named twice, the amount first, so the number reads what is left.
  const byLength = [...spec.labels].sort(
    (a, b) =>
      b.label.length - a.label.length || Number(b.type === 'amount') - Number(a.type === 'amount'),
  );
  for (const label of byLength) {
    const found = labelValues(record, label, labelTexts, consumed, inText, blanked);
    // Amounts of one kind, one per line, are added; any other label prints one value.
    if (label.type === 'amounts') {
      values.set(label, added(found.filter(Boolean)));
      continue;
    }
    if (new Set(found).size > 1)
      return {
        problem: {
          check: 'label',
          message: `the label "${label.label}" is printed ${found.length} times in a record on page ${record.page}, beside different values`,
          detail: { label: label.label, page: record.page, times: found.length },
        },
      };
    values.set(label, found[0] ?? '');
  }
  return { values: spec.labels.map((label) => values.get(label) ?? '') };
}

function labelValues(
  record: Walked,
  label: SpecLabel,
  labelTexts: Set<string>,
  consumed: Set<TextFragment>,
  inText: Set<TextFragment>,
  blanked: Map<TextFragment, string>,
): string[] {
  if (label.where === 'inText') return inTextValues(record, label.label, blanked, inText);
  const found: string[] = [];
  record.lines.forEach((line, i) => {
    for (const f of line.row.fragments) {
      if (normaliseText(f.str) !== label.label) continue;
      // A label may be named twice (a rate, then its amount), so its text is never used up.
      consumed.add(f);
      found.push(besideValue(record, i, f, label, labelTexts, consumed));
    }
  });
  return found;
}

/**
 * The number printed right after the label's words — nothing but signs and spaces between — in each
 * of a record's texts. A text wrapping onto the lines below at its left edge is one text (`Extra` /
 * `Charge: $12.30`). What a label reads is blanked so no shorter label reads it again.
 */
function inTextValues(
  record: Walked,
  label: string,
  blanked: Map<TextFragment, string>,
  inText: Set<TextFragment>,
): string[] {
  const found: string[] = [];
  for (const run of textRuns(record)) {
    const text = run.map((f) => clean(f.str)).join(' ');
    const masked = blanked.get(run[0]) ?? text.toLowerCase().replace(/\d/g, '#');
    const match = wordAt(masked, label);
    if (!match) continue;
    const after = match.at + match.length;
    const value = firstNumberIn(text.slice(after));
    if (value === null) continue;
    const end = text.indexOf(value, after) + value.length;
    if (/\p{L}/u.test(text.slice(after, end - value.length))) continue;
    blanked.set(run[0], masked.slice(0, match.at) + ' '.repeat(end - match.at) + masked.slice(end));
    let from = 0;
    for (const f of run) {
      const to = from + clean(f.str).length;
      if (from < end && to > match.at) inText.add(f);
      from = to + 1;
    }
    found.push(value);
  }
  return found;
}

/** A record's texts, each fragment joined by those printed at its left edge on the lines below. */
function textRuns(record: Walked): TextFragment[][] {
  const placed = new Set<TextFragment>();
  const runs: TextFragment[][] = [];
  record.lines.forEach((line, i) => {
    for (const f of line.row.fragments) {
      if (placed.has(f)) continue;
      const run = [f];
      for (const below of record.lines.slice(i + 1)) {
        const g = below.row.fragments.find((h) => !placed.has(h) && Math.abs(h.x - f.x) <= EDGE);
        if (!g) break;
        run.push(g);
      }
      run.forEach((g) => placed.add(g));
      runs.push(run);
    }
  });
  return runs;
}

function besideValue(
  record: Walked,
  index: number,
  label: TextFragment,
  spec: SpecLabel,
  labelTexts: Set<string>,
  consumed: Set<TextFragment>,
): string {
  const row = record.lines[index].row;
  const right = row.fragments
    .filter((g) => g.x > label.x && !consumed.has(g))
    .sort((a, b) => a.x - b.x);
  if (spec.where === 'below') return belowValue(record, index, label, labelTexts, consumed);
  if (spec.type === 'amount' || spec.type === 'amounts' || spec.type === 'number') {
    const numbers = right.filter((g) => numberValue(g.str) !== null);
    // A number is the one printed next (a rate, a weight); an amount the right-most, after them.
    const pick =
      spec.type === 'number'
        ? numbers[0]
        : (numbers.filter((g) => isAmount(g.str)).pop() ?? numbers.pop());
    if (!pick) return '';
    consumed.add(pick);
    return clean(pick.str);
  }
  // The label's value is the text right after it — a label printed right after it has none.
  const value = right[0];
  if (!value || labelTexts.has(normaliseText(value.str))) return '';
  consumed.add(value);
  if (spec.where === 'right') return clean(value.str);
  return clean([value.str, ...blockBelow(record, index, value.x, labelTexts, consumed)].join(' '));
}

/** Text starting at `x` on the record's following lines of the same page, until a line prints none there. */
function blockBelow(
  record: Walked,
  index: number,
  x: number,
  labelTexts: Set<string>,
  consumed: Set<TextFragment>,
): string[] {
  const texts: string[] = [];
  for (let i = index + 1; i < record.lines.length; i++) {
    if (record.lines[i].page !== record.lines[index].page) break;
    const next = record.lines[i].row.fragments.find(
      (g) => !consumed.has(g) && Math.abs(g.x - x) <= EDGE,
    );
    if (!next || labelTexts.has(normaliseText(next.str))) break;
    consumed.add(next);
    texts.push(next.str);
  }
  return texts;
}

/**
 * The text printed under the label — lines starting at its left edge, up to the next text on its
 * line — on the record's following lines of the same page, until a line starts elsewhere, prints
 * another label there, or a gap of more than two and a half lines opens.
 */
function belowValue(
  record: Walked,
  index: number,
  label: TextFragment,
  labelTexts: Set<string>,
  consumed: Set<TextFragment>,
): string {
  const labelRow = record.lines[index].row;
  const end =
    labelRow.fragments.filter((g) => g.x > label.x).sort((a, b) => a.x - b.x)[0]?.x ?? Infinity;
  const texts: string[] = [];
  let lastY = labelRow.y;
  for (let i = index + 1; i < record.lines.length; i++) {
    const { row, page } = record.lines[i];
    if (page !== record.lines[index].page || row.y - lastY > 2.5 * lineHeight(row)) break;
    const under = row.fragments.filter(
      (g) => !consumed.has(g) && g.x >= label.x - EDGE && g.x < end - EDGE,
    );
    if (!under.length || Math.abs(under[0].x - label.x) > EDGE) break;
    if (under.some((g) => labelTexts.has(normaliseText(g.str)))) break;
    under.forEach((g) => consumed.add(g));
    texts.push(...under.map((g) => g.str));
    lastY = row.y;
  }
  return clean(texts.join(' '));
}

/** Amounts no cell took, added together, with the other text printed on their lines. */
function otherAmounts(
  record: Walked,
  consumed: Set<TextFragment>,
): { amount: string; description: string; lines: Row[]; unread: TextFragment[] } {
  let sum = 0;
  const unread: TextFragment[] = [];
  const descriptions: string[] = [];
  const lines: Row[] = [];
  for (const { row } of record.lines) {
    const amounts = row.fragments.filter((f) => !consumed.has(f) && isAmount(f.str));
    if (!amounts.length) continue;
    lines.push(row);
    amounts.forEach((f) => (sum += numberValue(f.str) ?? 0));
    unread.push(...amounts);
    const words = row.fragments.filter((f) => !consumed.has(f) && !isAmount(f.str));
    descriptions.push(words.map((f) => f.str).join(' '));
    [...amounts, ...words].forEach((f) => consumed.add(f));
  }
  return {
    amount: lines.length ? money(sum).replace(/,/g, '') : '',
    description: clean(descriptions.join('; ')),
    lines,
    unread,
  };
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** An amount or number cell holds one printed number, or nothing. */
function cellProblem(records: SpecRecord[], { names, types }: Table): SpecProblem | null {
  for (const [r, record] of records.entries()) {
    for (const [c, value] of record.cells.entries()) {
      const numeric = types[c] === 'amount' || types[c] === 'amounts' || types[c] === 'number';
      if (!numeric || !value || numberValue(value) !== null) continue;
      return {
        check: 'cell',
        message: `the ${types[c]} cell "${names[c]}" of record ${r + 1} (page ${record.page}) does not read ${types[c] === 'amounts' ? 'only numbers' : 'one number'}`,
        detail: { cell: names[c], record: r + 1, page: record.page },
        evidence: `It reads: ${JSON.stringify(value)}`,
      };
    }
  }
  return null;
}

// ─── Checks ──────────────────────────────────────────────────────────────────

/**
 * Money agrees when it agrees TO THE CENT.
 *
 * Amounts are held in ten-thousandths so a line printed finer than cents (`2.8331`, a per-kilo fuel
 * figure) is read as printed. An invoice that prints such lines usually prints its TOTAL rounded to
 * cents, so adding the lines lands a fraction of a cent away from the figure beside it: one real
 * invoice read 365.4195 against a printed $365.42. Both render as "365.42", so exact equality
 * refused a read that is right, with a message naming the same number twice.
 *
 * Comparing to the cent is not a loosened proof. An invoice is paid in cents, a charge actually
 * missed is at least one, and the checks sum the WHOLE document — so an error repeated on every
 * record accumulates past a cent and still fails.
 */
const agrees = (a: number, b: number) => Math.round(a / 100) === Math.round(b / 100);

function checkProblem(
  geometry: DocumentGeometry,
  spec: ReadingSpec,
  table: Table,
  walk: Walk,
  records: SpecRecord[],
): SpecProblem | null {
  // Rows read already — a record's lines and invoice-level lines — never serve as a printed total.
  const inRecords = new Set([
    ...walk.records.flatMap((r) => r.lines.map((l) => l.row)),
    ...walk.invoice.map((l) => l.row),
  ]);
  const printed = (label: string, cells: string[], amount?: { x: number; right: number }) =>
    printedAmounts(geometry, label, inRecords, columnOf(spec, cells), amount);
  const sumOf = (cells: string[], upTo = Infinity, which?: 'charges' | 'credits') =>
    counted(records, table, cells, which)
      .filter((r) => r.page <= upTo)
      .reduce((sum, r) => sum + cells.reduce((s, name) => s + amountOf(table, r, name), 0), 0);
  for (const check of spec.checks) {
    if (check.kind !== 'sum') {
      const problem =
        check.kind === 'record'
          ? recordProblem(check, records, table)
          : carryProblem(check, (label) => printed(label, check.cells), sumOf);
      if (problem) return problem;
      continue;
    }
    const totals = inParts(printed(check.label, check.cells, check.amount), check.plus, printed);
    const read = sumOf(check.cells, Infinity, check.records);
    const count = counted(records, table, check.cells, check.records).length;
    const problem = sumProblem(check, totals, read, count);
    if (!problem) continue;
    const values = [...new Set(totals.map((p) => p.value))];
    if (problem.check === 'total')
      problem.evidence = [
        totalEvidence(geometry, inRecords, records, table, check),
        ...(values.length === 1 ? shortByLine(read - values[0], geometry, inRecords, records) : []),
        ...(values.length === 1 ? offBy(read - values[0], check, table, sumOf) : []),
        printedSums(geometry, inRecords, records, table),
      ].join('\n');
    return problem;
  }
  const uncovered = coverageProblem(spec, records, table);
  if (uncovered) uncovered.evidence = printedSums(geometry, inRecords, records, table);
  return uncovered ?? invoiceTotalProblem(geometry, spec, table, records, inRecords, walk.skipped);
}

/**
 * Money the invoice's own total charges must be read. A line printing exactly what a checked total
 * of the records, the invoice-level rows and — when some — lines passed over as not charges add up to
 * is that total: rows no total proves must be proven by it, and passed-over lines it holds are charges.
 * Rows stay unproven only when the invoice prints no such total.
 */
function invoiceTotalProblem(
  geometry: DocumentGeometry,
  spec: ReadingSpec,
  table: Table,
  records: SpecRecord[],
  read: Set<Row>,
  skipped: Line[],
): SpecProblem | null {
  const typeAt = table.names.indexOf(INVOICE_TYPE);
  const rows = typeAt < 0 ? [] : records.filter((r) => r.cells[typeAt]);
  const unproven = rows.length > 0 && rows[0].cells[table.names.indexOf(INVOICE_PROVEN)] !== 'yes';
  const rowsTotal = rows.reduce((sum, r) => sum + amountOf(table, r, INVOICE_AMOUNT), 0);
  // A line restating what a money cell of the records adds up to is not charged again.
  const moneyCells = table.names.filter((_, c) => isMoney(table.types[c]));
  const restates = (value: number) =>
    moneyCells.some((name) =>
      agrees(
        records.reduce((sum, r) => sum + amountOf(table, r, name), 0),
        value,
      ),
    );
  const passed = skipped.flatMap((line) => {
    const amount = line.row.fragments.filter((f) => isAmount(f.str)).pop();
    const value = amount ? numberValue(amount.str) : null;
    return value !== null && !restates(value) ? [{ line, value }] : [];
  });
  const options = [
    ...(unproven ? [{ extra: 0, lines: [] as Line[] }] : []),
    ...passed.map((p) => ({ extra: p.value, lines: [p.line] })),
  ];
  const bases = spec.checks.filter(
    (c): c is Extract<SpecCheck, { kind: 'sum' }> =>
      c.kind === 'sum' && !c.cells.includes(INVOICE_AMOUNT),
  );
  for (const base of bases)
    for (const { extra, lines } of options) {
      const target =
        records.reduce(
          (sum, r) => sum + base.cells.reduce((s, n) => s + amountOf(table, r, n), 0),
          0,
        ) +
        rowsTotal +
        extra;
      const total = printedTotal(geometry, read, lines, target);
      if (total) return invoiceTotalFound(target, total, lines, [...base.cells, INVOICE_AMOUNT]);
    }
  return null;
}

/** A line not read already printing `target`, with the words before it. */
function printedTotal(
  geometry: DocumentGeometry,
  read: Set<Row>,
  exclude: Line[],
  target: number,
): (Line & { label: TextFragment }) | null {
  const passed = new Set(exclude.map((l) => l.row));
  for (const page of geometry.pages)
    for (const row of page.rows) {
      if (read.has(row) || passed.has(row)) continue;
      const printed = row.fragments.find(
        (f) => isAmount(f.str) && agrees(numberValue(f.str) ?? NaN, target),
      );
      const label =
        printed &&
        row.fragments.filter((f) => f.x < printed.x && numberValue(f.str) === null).pop();
      if (label) return { page: page.pageNumber, row, label };
    }
  return null;
}

function invoiceTotalFound(
  target: number,
  total: Line & { label: TextFragment },
  passed: Line[],
  cells: string[],
): SpecProblem {
  const beside = `the invoice prints ${money(target)} beside "${normaliseText(total.label.str)}"`;
  const check = `That is the invoice’s own total: check against it — a sum of ${cells.map((c) => `"${c}"`).join(', ')}, labelled by ${JSON.stringify(total.label.str)}.`;
  return {
    check: 'uncovered',
    message: passed.length
      ? `${passed.length} line(s) passed over as not charges are charged: ${beside} — the records, the invoice-level rows and those lines added up`
      : `the invoice-level rows are not proven, but ${beside} — the records and those rows added up`,
    detail: {
      printed: money(target),
      label: normaliseText(total.label.str),
      passed: passed.length,
    },
    evidence: [
      ...passed.map(
        (l) =>
          `The line passed over: ${JSON.stringify(rowText(l.row))} — a line the invoice’s own total charges is a \`charge\` or \`tax\` line, read as a row of its own.`,
      ),
      `The total as printed: ${JSON.stringify(rowText(total.row))}. ${check}`,
    ].join('\n'),
    lines: [...passed, { page: total.page, row: total.row }],
  };
}

const SHOWN = 12;

/**
 * What a model needs to see to mend a total that does not hold: the lines printing amounts on the
 * record pages that no record read (a kind of record missed, or a total), and the records whose
 * checked cells add up to less than nothing (payments or credits the total leaves out).
 */
function totalEvidence(
  geometry: DocumentGeometry,
  inRecords: Set<Row>,
  records: SpecRecord[],
  table: Table,
  check: Extract<SpecCheck, { kind: 'sum' }>,
): string {
  const pages = new Set(records.map((r) => r.page));
  const unread = geometry.pages
    .filter((page) => pages.has(page.pageNumber))
    .flatMap((page) =>
      page.rows
        .filter((row) => !inRecords.has(row) && row.fragments.some((f) => isAmount(f.str)))
        .map((row) => `- p${page.pageNumber}: ${rowText(row)}`),
    );
  const negative = counted(records, table, check.cells, 'credits');
  const charges = counted(records, table, check.cells, 'charges').reduce(
    (sum, r) => sum + check.cells.reduce((s, name) => s + amountOf(table, r, name), 0),
    0,
  );
  return [
    unread.length
      ? `Lines printing amounts on the record pages that no record reads (${unread.length}):\n${unread.slice(0, SHOWN).join('\n')}`
      : 'Every line printing an amount on the record pages is read into a record.',
    ...(negative.length
      ? [
          `${negative.length} records add up to less than nothing in ${check.cells.join(' + ')} (without them the records add up to ${money(charges)}), e.g.:\n${negative
            .slice(0, 3)
            .map((r) => `- ${r.cells.filter(Boolean).join(' | ')}`)
            .join('\n')}`,
        ]
      : []),
  ].join('\n');
}

/**
 * A line on the record pages, outside every record, printing exactly what the records fall short of
 * the total by: a charge printed once in the table (a fuel surcharge under the last record).
 */
function shortByLine(
  difference: number,
  geometry: DocumentGeometry,
  inRecords: Set<Row>,
  records: SpecRecord[],
): string[] {
  if (difference >= 0) return [];
  const pages = new Set(records.map((r) => r.page));
  const line = geometry.pages
    .filter((page) => pages.has(page.pageNumber))
    .flatMap((page) => page.rows)
    .find(
      (row) =>
        !inRecords.has(row) &&
        row.fragments.some((f) => isAmount(f.str) && numberValue(f.str) === -difference),
    );
  if (!line) return [];
  return [
    `The records add up to ${money(-difference)} less than the total — exactly what this line prints: ${JSON.stringify(rowText(line))}. A charge printed once for the whole invoice is a \`charge\` line: read as a row of its own, and counted by a total that adds ${INVOICE_AMOUNT}.`,
  ];
}

/** The money cell a failed total is off by exactly: read by the checked cells too, or left out of them. */
function offBy(
  difference: number,
  check: Extract<SpecCheck, { kind: 'sum' }>,
  { names, types, charges }: Table,
  sumOf: (cells: string[]) => number,
): string[] {
  const counts = (n: string) =>
    check.cells.includes(n) || (check.cells.includes(CHARGES) && charges.includes(n));
  const name = names.find(
    (n, c) => isMoney(types[c]) && !counts(n) && sumOf([n]) === Math.abs(difference),
  );
  if (!name || !difference) return [];
  const cells = check.cells.join(' + ');
  return difference > 0
    ? [
        `The records add up to ${money(difference)} more than printed — what ${name} adds up to: ${cells} may be reading ${name}’s amounts too (check the columns’ edges), or the total leaves ${name} out.`,
      ]
    : [
        `The records add up to ${money(-difference)} less than printed — what ${name} adds up to: the total may include ${name}.`,
      ];
}

/**
 * Which of the records' amount cells, added over every record, the invoice prints somewhere — and
 * beside what: the total a model is looking for is often printed on another page (a summary).
 */
function printedSums(
  geometry: DocumentGeometry,
  inRecords: Set<Row>,
  records: SpecRecord[],
  table: Table,
): string {
  const { names, types } = table;
  const moneyCells = names.filter((_, c) => isMoney(types[c]));
  const printed = geometry.pages.flatMap((page) =>
    page.rows
      .filter((row) => !inRecords.has(row))
      .flatMap((row) =>
        row.fragments
          .filter((f) => isAmount(f.str))
          .map((f) => ({ value: numberValue(f.str) as number, page: page.pageNumber, row })),
      ),
  );
  const found = moneyCells.flatMap((name) => {
    return (['all', 'charges'] as const).flatMap((which) => {
      const over = counted(records, table, [name], which === 'all' ? undefined : which);
      if (which === 'charges' && over.length === records.length) return [];
      const sum = over.reduce((total, r) => total + amountOf(table, r, name), 0);
      const rows = printed.filter((p) => sum !== 0 && agrees(p.value, sum)).slice(0, 2);
      const scope = which === 'all' ? '' : ' over its charges (records of nothing or more)';
      if (!rows.length) return inTwoParts(printed, sum, `- ${name}${scope}`);
      return rows.map(
        (at) =>
          `- ${name}${scope} adds up to ${money(sum)}, printed on page ${at.page}: ${rowText(at.row)}`,
      );
    });
  });
  return found.length
    ? `Totals the records' cells add up to, as the invoice prints them:\n${found.join('\n')}`
    : 'No single cell of the records adds up to an amount the invoice prints.';
}

/** The records a check counts: all, or its charges (nothing or more) or credits (below nothing). */
function counted(
  records: SpecRecord[],
  table: Table,
  cells: string[],
  which?: 'charges' | 'credits',
): SpecRecord[] {
  if (!which) return records;
  return records.filter((r) => {
    const sum = cells.reduce((s, name) => s + amountOf(table, r, name), 0);
    return which === 'charges' ? sum >= 0 : sum < 0;
  });
}

/** The one column a check adds up, when it adds up one — where a totals row prints its total. */
function columnOf(spec: ReadingSpec, cells: string[]): SpecColumn | null {
  if (cells.length !== 1) return null;
  return spec.columns.find((c) => c.name === cells[0]) ?? null;
}

/**
 * A total printed in parts: each further label's one amount added to the total's. A part not
 * printed exactly once leaves nothing to compare, and the check says so.
 */
function inParts(
  totals: { page: number; value: number }[],
  plus: string[] | undefined,
  printed: (label: string, cells: string[]) => { value: number }[],
): { page: number; value: number }[] {
  if (!plus?.length) return totals;
  let extra = 0;
  for (const label of plus) {
    const values = [...new Set(printed(label, []).map((p) => p.value))];
    if (values.length !== 1) return [];
    extra += values[0];
  }
  return totals.map((t) => ({ ...t, value: t.value + extra }));
}

/**
 * Totals printed beside `label` outside every record, one per row: the number at the place the
 * check points at (a summary row printing several); else the one in the summed column (a totals
 * row printing each column's total under it — a count too); else the right-most amount.
 */
function printedAmounts(
  geometry: DocumentGeometry,
  label: string,
  inRecords: Set<Row>,
  column: SpecColumn | null,
  amount?: { x: number; right: number },
): { page: number; value: number }[] {
  const found: { page: number; value: number }[] = [];
  for (const page of geometry.pages)
    for (const row of page.rows) {
      if (inRecords.has(row)) continue;
      const at = row.fragments.find((f) => normaliseText(f.str) === label);
      if (!at) continue;
      const numbers = row.fragments.filter((f) => f.x > at.x && numberValue(f.str) !== null);
      const pick = amount
        ? numbers.find(
            (f) =>
              Math.abs(f.x - amount.x) <= EDGE || Math.abs(f.x + f.width - amount.right) <= EDGE,
          )
        : ((column &&
            numbers.find((f) => f.x >= column.left - EDGE && f.x < column.right + EDGE)) ??
          numbers.filter((f) => isAmount(f.str)).pop());
      if (pick) found.push({ page: page.pageNumber, value: numberValue(pick.str) as number });
    }
  return found;
}

/** Two amounts printed on one page, on different lines, that add up to `sum`: a total printed in parts. */
function inTwoParts(
  printed: { value: number; page: number; row: Row }[],
  sum: number,
  what: string,
): string[] {
  const shown = printed.slice(0, 200); // ponytail: pairs are O(n²); invoices print few totals
  for (const [i, a] of shown.entries())
    for (const b of shown.slice(i + 1))
      if (a.page === b.page && a.row !== b.row && sum && agrees(a.value + b.value, sum))
        return [
          `${what} adds up to ${money(sum)} = ${money(a.value)} + ${money(b.value)}, printed on page ${a.page}: ${rowText(a.row)} / ${rowText(b.row)}`,
        ];
  return [];
}

function sumProblem(
  check: Extract<SpecCheck, { kind: 'sum' }>,
  printed: { value: number }[],
  read: number,
  count: number,
): SpecProblem | null {
  const values = [...new Set(printed.map((p) => p.value))];
  if (values.length === 1 && agrees(values[0], read)) return null;
  const detail = { label: check.label, cells: check.cells, records: count, read: money(read) };
  if (!values.length)
    return {
      check: 'total',
      message: `no amount is printed beside "${[check.label, ...(check.plus ?? [])].join('" and "')}" outside the records (each exactly once)`,
      detail,
    };
  if (values.length > 1)
    return {
      check: 'total',
      message: `"${check.label}" is printed beside ${values.length} different amounts`,
      detail: { ...detail, printed: values.map(money) },
    };
  return {
    check: 'total',
    message: `${check.cells.join(' + ')} over the ${count} records adds up to ${money(read)}, but the invoice prints ${money(values[0])} beside "${check.label}"`,
    detail: { ...detail, printed: money(values[0]) },
  };
}

function recordProblem(
  check: Extract<SpecCheck, { kind: 'record' }>,
  records: SpecRecord[],
  table: Table,
): SpecProblem | null {
  for (const [i, record] of records.entries()) {
    const printed = (name: string) => printsCell(table, record, name);
    if (!printed(check.total) || !check.parts.some(printed)) continue;
    const total = amountOf(table, record, check.total);
    const parts = check.parts.reduce((sum, name) => sum + amountOf(table, record, name), 0);
    if (agrees(total, parts)) continue;
    return {
      check: 'record_total',
      message: `record ${i + 1} (page ${record.page}): ${check.parts.join(' + ')} adds up to ${money(parts)}, but its ${check.total} is ${money(total)}`,
      detail: {
        record: i + 1,
        page: record.page,
        total: check.total,
        read: money(parts),
        printed: money(total),
      },
    };
  }
  return null;
}

function carryProblem(
  check: Extract<SpecCheck, { kind: 'carry' }>,
  printed: (label: string) => { page: number; value: number }[],
  sumOf: (cells: string[], upTo?: number) => number,
): SpecProblem | null {
  const wrong = [
    ...printed(check.carried).map((p) => ({ ...p, read: sumOf(check.cells, p.page) })),
    ...(check.brought ? printed(check.brought) : []).map((p) => ({
      ...p,
      read: sumOf(check.cells, p.page - 1),
    })),
  ].find((p) => !agrees(p.value, p.read));
  if (!wrong) return null;
  return {
    check: 'carry',
    message: `on page ${wrong.page}, ${check.cells.join(' + ')} over the records so far adds up to ${money(wrong.read)}, but the invoice carries ${money(wrong.value)}`,
    detail: { page: wrong.page, read: money(wrong.read), printed: money(wrong.value) },
  };
}

/**
 * Every record printing an amount must be counted by a printed total, or a missing one goes unseen.
 * An invoice-level row is exempt: it is read from its own line, and says whether a total proved it.
 */
function coverageProblem(
  spec: ReadingSpec,
  records: SpecRecord[],
  table: Table,
): SpecProblem | null {
  const { types } = table;
  const totals = spec.checks.filter((c) => c.kind !== 'record') as Exclude<
    SpecCheck,
    { kind: 'record' }
  >[];
  const covers = (check: (typeof totals)[number], record: SpecRecord) =>
    check.cells.some((name) => printsCell(table, record, name)) &&
    (check.kind !== 'sum' || counted([record], table, check.cells, check.records).length > 0);
  const invoiceRow = (record: SpecRecord) => !!record.cells[table.names.indexOf(INVOICE_TYPE)];
  const index = records.findIndex(
    (record) =>
      !invoiceRow(record) &&
      record.cells.some((cell, c) => cell && isMoney(types[c])) &&
      !totals.some((check) => covers(check, record)),
  );
  if (index < 0) return null;
  return {
    check: 'uncovered',
    message: totals.length
      ? `record ${index + 1} (page ${records[index].page}) prints an amount no printed total counts`
      : 'no printed total is checked, so a missing record would go unseen',
    detail: { record: index + 1, page: records[index].page, totals: totals.length },
  };
}

export { OTHER_AMOUNTS, OTHER_DESCRIPTION, SECTION };
