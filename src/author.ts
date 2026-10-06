import type { ModelTool } from './model.js';
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
  SPEC_VERSION,
  SpecCharges,
  SpecCheck,
  SpecColumn,
  SpecLabel,
  SpecLine,
  cellNames,
  cellTypes,
  readsInvoiceLines,
} from './spec.js';
import { isAmount, normaliseText, numberValue, rowText, shapeOf, wordAt } from './text.js';

/**
 * Writing a reading spec: the model is shown the invoice's text as numbered fragments with their
 * positions and answers through `pdf_reading_spec`, whose vocabulary can only point — at fragments,
 * x positions and cell names — never carry a value. `specFromAnswer` checks every pointer against
 * the page and turns the answer into a spec; `readWithSpec` then decides whether the invoice
 * proves it.
 */

/** How far a printed position may sit from the answer's: positions are rounded. */
const EDGE = 3;
const FULL_PAGES = 3;
const ROWS_PER_PAGE = 110;
const EXTRA_ROWS = 40;
const CONTEXT_BELOW = 2;
const CELL_TYPES: CellType[] = ['text', 'amount', 'amounts', 'number', 'date'];
/**
 * A column holds what one place prints: charges a record lists one per line are charge lines, and
 * `amounts` only adds a second figure each charge line prints (its tax, its total with tax).
 */
const COLUMN_TYPES: CellType[] = ['text', 'amount', 'amounts', 'number', 'date', 'rates'];
const MONEY_OR_NUMBER: CellType[] = ['amount', 'amounts', 'number'];
const LINE_ROLES: SpecLine['role'][] = ['end', 'skip', 'charge', 'tax'];
const IDENTIFY = ['first_word', 'first_two_words', 'whole_text', 'exact_text'] as const;

export interface ShownFragment {
  page: number;
  row: Row;
  fragment: TextFragment;
}

export interface SpecQuestion {
  prompt: string;
  fragments: Map<number, ShownFragment>;
  /** Each page's width: an invoice can print a portrait cover and landscape tables. */
  widths: Map<number, number>;
  /** Every fragment's text on every page, normalised — including pages the model is not shown. */
  texts: string[];
}

const pointer = (description: string) => ({ type: 'integer', description });
const names = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

export const READING_SPEC_TOOL: ModelTool = {
  name: 'pdf_reading_spec',
  description:
    'How to read this invoice layout: where its records start, where each cell of a record is printed, which lines are not charges, and which printed totals prove the read. Points at the page; never writes a value.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'heading',
      'records',
      'groups',
      'columns',
      'labels',
      'charges',
      'otherAmounts',
      'carryOver',
      'lines',
      'checks',
    ],
    properties: {
      heading: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'Fragments of the heading printed over the records (every row of it). Empty when there is none.',
      },
      records: {
        type: 'array',
        description: 'Each way a record starts. One entry per kind of first text.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['example', 'identify'],
          properties: {
            example: pointer('A fragment that is the FIRST text of a line starting a record.'),
            identify: { type: 'string', enum: [...IDENTIFY] },
          },
        },
      },
      groups: {
        type: 'array',
        description:
          'Title lines that apply to the records under them (a lane, a service). Usually empty.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['example'],
          properties: { example: pointer('A fragment that is a whole title line.') },
        },
      },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['heading', 'left', 'right', 'fromLine', 'toLine', 'type'],
          properties: {
            heading: {
              type: 'array',
              items: { type: 'integer' },
              description:
                'Fragments of the heading printed over this column — every row of it, a stacked heading too. The column is named by their text.',
            },
            name: {
              type: 'string',
              description: 'Only for a column with no printed heading: what its values are.',
            },
            left: { type: 'number' },
            right: { type: 'number' },
            fromLine: {
              type: 'integer',
              description:
                'First line of the record it reads: 1 is its first line, -1 its last (counting back from the end).',
            },
            toLine: {
              type: ['integer', 'null'],
              description:
                'Last line of the record it reads (1 = first, -1 = last, -2 = the one before); null for every line to the end.',
            },
            type: { type: 'string', enum: COLUMN_TYPES },
          },
        },
      },
      labels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'where', 'type'],
          properties: {
            label: pointer('The fragment printing the label. The cell is named by its text.'),
            words: {
              type: 'string',
              description: 'inText only: the label words exactly as printed inside that fragment.',
            },
            where: { type: 'string', enum: ['right', 'rightBlock', 'below', 'inText'] },
            type: { type: 'string', enum: CELL_TYPES },
          },
        },
      },
      charges: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['nameLeft', 'nameRight', 'amountLeft', 'amountRight', 'fromLine', 'toLine'],
        description:
          "A record's charges printed one per line, each with its own name (a Fuel line, a Demand Surcharge line): where their names are printed, where their amounts are, and which of the record's lines print them. Each charge becomes its own cell. Null when records print no such lines.",
        properties: {
          nameLeft: { type: 'number' },
          nameRight: { type: 'number' },
          amountLeft: { type: 'number' },
          amountRight: { type: 'number' },
          fromLine: { type: 'integer', description: 'As a column: 1 = first line, -1 = last.' },
          toLine: {
            type: ['integer', 'null'],
            description: 'As a column; null = to the last line.',
          },
        },
      },
      otherAmounts: { type: 'boolean' },
      carryOver: { type: 'boolean' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['example', 'role'],
          properties: {
            example: pointer(
              'A text that marks such a line: its first text, or one it always prints at that place.',
            ),
            role: {
              type: 'string',
              enum: LINE_ROLES,
              description:
                'end: the records stop here on its page. skip: passed over (a total the records prove, a payment, a balance). charge / tax: a charge or tax printed once for the whole invoice, read as a row of its own.',
            },
          },
        },
      },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['sum', 'record', 'carry'] },
            cells: names('sum and carry: the cells added over the records.'),
            records: {
              type: 'string',
              enum: ['all', 'charges', 'credits'],
              description:
                'sum only: which records the total counts — all (default), its charges (records of nothing or more), or its credits (below nothing), when the invoice totals them apart.',
            },
            label: pointer('sum: the label printed beside the total.'),
            amount: {
              type: ['integer', 'null'],
              description:
                "sum: the fragment printing the total, when the label's line prints several numbers (a summary row); null otherwise.",
            },
            plus: {
              type: 'array',
              items: { type: 'integer' },
              description:
                'sum: labels of further totals added to this one, when the invoice prints the total in parts (a freight total and a surcharge total). Usually empty.',
            },
            total: { type: 'string', description: 'record: the cell holding the record total.' },
            parts: names('record: the cells that add up to it.'),
            carried: pointer(
              'carry: the label printed beside the amount carried to the next page.',
            ),
            brought: {
              type: ['integer', 'null'],
              description: 'carry: the label printed beside the amount brought forward, or null.',
            },
          },
        },
      },
    },
  },
};

// ─── The question ────────────────────────────────────────────────────────────

/**
 * The invoice as numbered fragments: in full, the first pages printing amounts and the last; then
 * lines printing amounts from the other pages whose first text starts differently from anything
 * shown (another kind of record, a total) with the lines under them.
 */
export function specQuestion(geometry: DocumentGeometry, reason?: string): SpecQuestion {
  const fragments = new Map<number, ShownFragment>();
  const shown = new Set<Row>();
  const line = (page: number, row: Row) => {
    shown.add(row);
    return numbered(fragments, page, row);
  };
  const printsAmount = (row: Row) => row.fragments.some((f) => isAmount(f.str));
  // Pages are chosen by where the money is. A document that prints NO amounts anywhere is a
  // supporting list rather than a bill — a consignment manifest of con notes, dimensions and
  // weights, uploaded beside the invoice it belongs to — and choosing none of its pages showed the
  // model an empty question, which it answered by pointing at fragments that do not exist. Show it
  // the document instead; with nothing to add up the answer simply carries no checks.
  const priced = geometry.pages.some((page) => page.rows.some(printsAmount));
  const content = priced
    ? geometry.pages.filter((page) => page.rows.some(printsAmount))
    : geometry.pages;
  const full = [
    ...new Set([...content.slice(0, FULL_PAGES - 1), content[content.length - 1]]),
  ].filter(Boolean);
  const sections = full.map(
    (page) =>
      `Page ${page.pageNumber} of ${geometry.pageCount} (width ${Math.round(page.width)}):\n${page.rows
        .slice(0, ROWS_PER_PAGE)
        .map((row) => line(page.pageNumber, row))
        .join('\n')}`,
  );
  const kindOf = (row: Row) =>
    `${Math.round(row.fragments[0].x / 6)}|${shapeOf(row.fragments[0].str, 2)}`;
  const kinds = new Set([...shown].map(kindOf));
  const extra: string[] = [];
  for (const page of geometry.pages) {
    if (full.includes(page)) continue;
    page.rows.forEach((row, i) => {
      // Rows that start differently from anything shown: the money ones on a bill, any of them on
      // a document that prints none (its later pages would otherwise never be sampled).
      if (extra.length >= EXTRA_ROWS || (priced && !printsAmount(row)) || kinds.has(kindOf(row)))
        return;
      kinds.add(kindOf(row));
      const context = page.rows.slice(i, i + 1 + CONTEXT_BELOW).filter((r) => !shown.has(r));
      extra.push(...context.map((r) => line(page.pageNumber, r)));
    });
  }
  if (extra.length)
    sections.push(
      `Lines from other pages that start differently, with the lines under them:\n${extra.join('\n')}`,
    );
  const prompt = [
    ...(reason ? [`A reading spec for this layout could not be proven: ${reason}.`] : []),
    `Pages: ${geometry.pageCount}. Each line: its page, y (top to bottom), then its texts — [n] x=left edge w=width "text".`,
    ...sections,
  ].join('\n\n');
  const widths = new Map(geometry.pages.map((page) => [page.pageNumber, page.width]));
  const texts = geometry.pages.flatMap((page) =>
    page.rows.flatMap((row) => row.fragments.map((f) => normaliseText(f.str))),
  );
  return { prompt, fragments, widths, texts };
}

/** A printed line as the model sees it: each fragment numbered — by the number it has, or the next. */
function numbered(fragments: Map<number, ShownFragment>, page: number, row: Row): string {
  const known = new Map([...fragments].map(([n, shown]) => [shown.fragment, n]));
  const texts = row.fragments.map((fragment) => {
    let n = known.get(fragment);
    if (n === undefined) {
      n = fragments.size + 1;
      fragments.set(n, { page, row, fragment });
    }
    return `[${n}] x=${Math.round(fragment.x)} w=${Math.round(fragment.width)} ${JSON.stringify(fragment.str)}`;
  });
  return `p${page} y=${Math.round(row.y)}: ${texts.join('  ')}`;
}

/**
 * The lines a refusal names, numbered so the next answer can point at them: a model is shown some
 * pages only, and evidence naming a line it cannot point at is a repair it cannot make.
 */
export function pointable(question: SpecQuestion, lines: { page: number; row: Row }[]): string {
  if (!lines.length) return '';
  const text = lines.map(({ page, row }) => numbered(question.fragments, page, row));
  return `\nThose lines, to point at:\n${text.join('\n')}`;
}

/** The same question again, with the previous answer and exactly why it was refused. */
export function specRepairQuestion(
  question: SpecQuestion,
  answer: unknown,
  problem: string,
): string {
  return `${question.prompt}\n\nYour previous answer:\n${JSON.stringify(answer)}\n\nIt was refused: ${problem}\nAnswer again, fixing that.`;
}

// ─── The answer ──────────────────────────────────────────────────────────────

type Answer = {
  heading: number[];
  records: { example: number; identify: (typeof IDENTIFY)[number] }[];
  groups: { example: number }[];
  columns: (Omit<SpecColumn, 'name'> & { heading: number[]; name?: string })[];
  labels: {
    label: number;
    words?: string;
    where: SpecLabel['where'];
    type: CellType;
  }[];
  charges?: SpecCharges | null;
  otherAmounts: boolean;
  carryOver: boolean;
  lines: { example: number; role: SpecLine['role'] }[];
  checks: {
    kind: SpecCheck['kind'];
    cells?: string[];
    records?: 'all' | 'charges' | 'credits';
    label?: number;
    amount?: number | null;
    plus?: number[];
    total?: string;
    parts?: string[];
    carried?: number;
    brought?: number | null;
  }[];
};

type Converted = { spec: ReadingSpec } | { problem: string };
/** The fragment a pointer names — nothing when it points at none, which every use checks first. */
type At = (n: unknown) => ShownFragment;

/**
 * Every heading fragment names a column — or is printed over the charge lines' names or amounts: a
 * column left out loses its text while the totals hold.
 */
function namelessHeading(answer: Answer, at: At): string | null {
  const named = new Set(
    answer.columns.flatMap((c) => (Array.isArray(c?.heading) ? c.heading : [])),
  );
  const c = answer.charges;
  const over = (x: number, left: number, right: number) => x >= left - EDGE && x < right + EDGE;
  const overCharges = (n: number) =>
    !!c &&
    (over(at(n).fragment.x, c.nameLeft, c.nameRight) ||
      over(at(n).fragment.x, c.amountLeft, c.amountRight));
  const nameless = answer.heading.find((n) => !named.has(n) && !overCharges(n));
  return nameless === undefined
    ? null
    : `the heading's [${nameless}] ${JSON.stringify(at(nameless).fragment.str)} names no column: give the column printed under it`;
}

/** A cell adding up several amounts is a sum the reader made, not one printed: a check must prove it. */
function unprovenSum(spec: ReadingSpec): string | null {
  const checked = new Set(
    spec.checks.flatMap((c) => (c.kind === 'record' ? [c.total, ...c.parts] : c.cells)),
  );
  if (spec.charges && !checked.has(CHARGES))
    return `charges are read one by one, but no check names ${CHARGES}: prove them by a total (a sum check naming ${CHARGES}), or by a record's own total (a record check with ${CHARGES} among its parts)`;
  const unproven = [...spec.columns, ...spec.labels].find(
    (c) => c.type === 'amounts' && !checked.has(c.name),
  );
  return unproven
    ? `"${unproven.name}" adds up several amounts in each record, but no check names it: prove it by a total, or by a record's own total (a record check)`
    : null;
}

/** Where a record's charge lines print their names and amounts, and which of its lines they are. */
function checkCharges(
  charges: SpecCharges | null | undefined,
  pageWidth: number,
): { charges: SpecCharges | null } | { problem: string } {
  if (!charges) return { charges: null };
  const { nameLeft, nameRight, amountLeft, amountRight, fromLine, toLine } = charges;
  for (const [what, left, right] of [
    ['name', nameLeft, nameRight],
    ['amount', amountLeft, amountRight],
  ] as const) {
    if (!Number.isFinite(left) || !Number.isFinite(right) || left >= right)
      return { problem: `charges need ${what}Left < ${what}Right` };
    if (left < -EDGE || right > pageWidth + EDGE)
      return { problem: `charges' ${what}s run off the page (0–${pageWidth})` };
  }
  const lines = linesProblem(fromLine, toLine);
  if (lines) return { problem: `charges ${lines}` };
  return { charges: { nameLeft, nameRight, amountLeft, amountRight, fromLine, toLine } };
}

/** The spec the answer describes, or what is wrong with it — every pointer checked against the page. */
export function specFromAnswer(input: unknown, question: SpecQuestion): Converted {
  const answer = input as Answer;
  const lists = ['heading', 'records', 'groups', 'columns', 'labels', 'lines', 'checks'] as const;
  if (!answer || lists.some((key) => !Array.isArray(answer[key])))
    return { problem: `the answer must give ${lists.join(', ')} as lists` };
  const at: At = (n) => question.fragments.get(n as number) as ShownFragment;
  const missing = [
    ...answer.heading,
    ...answer.records.map((r) => r?.example),
    ...answer.groups.map((g) => g?.example),
    ...answer.labels.map((l) => l?.label),
    ...answer.lines.map((l) => l?.example),
  ].find((n) => !at(n));
  if (missing !== undefined) return { problem: `[${missing}] is not a fragment shown` };

  const numeric = answer.lines.find((l) => numberValue(at(l.example).fragment.str) !== null);
  if (numeric)
    return { problem: `[${numeric.example}] is an amount: a line is marked by a text it prints` };
  const records = recordStarts(answer, at);
  if ('problem' in records) return records;
  // The spec's page is the one its records are printed on.
  const pageWidth = question.widths.get(at(answer.records[0].example).page) as number;
  const columns = checkColumns(
    answer.columns,
    pageWidth,
    at,
    new Set(answer.heading),
    !!answer.charges,
  );
  if ('problem' in columns) return columns;
  const labels = checkLabels(answer.labels, at, question.texts);
  if ('problem' in labels) return labels;
  const charges = checkCharges(answer.charges, pageWidth);
  if ('problem' in charges) return charges;
  const nameless = namelessHeading(answer, at);
  if (nameless) return { problem: nameless };
  const spec: ReadingSpec = {
    version: SPEC_VERSION,
    pageWidth,
    heading: [...new Set(answer.heading.map((n) => normaliseText(rowText(at(n).row))))],
    identity: [],
    records: records.records,
    groups: answer.groups.map((g) => ({ x: at(g.example).fragment.x })),
    columns: columns.columns,
    labels: labels.labels,
    charges: charges.charges,
    otherAmounts: answer.otherAmounts === true,
    carryOver: answer.carryOver === true,
    lines: answer.lines.map((l) => ({
      label: normaliseText(at(l.example).fragment.str),
      x: at(l.example).fragment.x,
      role: LINE_ROLES.includes(l.role) ? l.role : 'skip',
    })),
    checks: [],
  };
  uniqueNames(spec);
  const checks = checkChecks(answer.checks, spec, at);
  if ('problem' in checks) return checks;
  spec.checks = checks.checks;
  const unproven = unprovenSum(spec);
  if (unproven) return { problem: unproven };
  spec.identity = spec.heading.length
    ? spec.heading
    : spec.records.flatMap((r) => (r.text ? [r.text] : []));
  return { spec };
}

function recordStarts(
  answer: Answer,
  at: At,
): { records: ReadingSpec['records'] } | { problem: string } {
  if (!answer.records.length) return { problem: 'give at least one way a record starts' };
  const records: ReadingSpec['records'] = [];
  for (const { example, identify } of answer.records) {
    const { row, fragment } = at(example);
    if (row.fragments[0] !== fragment)
      return { problem: `[${example}] is not the first text of its line` };
    if (!IDENTIFY.includes(identify)) return { problem: `[${example}] needs identify` };
    const words = identify === 'first_word' ? 1 : identify === 'first_two_words' ? 2 : 0;
    records.push(
      identify === 'exact_text'
        ? { x: fragment.x, words: 0, text: normaliseText(fragment.str) }
        : { x: fragment.x, words, shape: shapeOf(fragment.str, words) },
    );
  }
  return { records };
}

/** Every column named by its own text: the heading fragments printed over it, top row first, as printed. */
const headingKey = (c: Answer['columns'][number]) =>
  JSON.stringify([...(Array.isArray(c?.heading) ? c.heading : [])].sort());

function checkColumns(
  columns: Answer['columns'],
  pageWidth: number,
  at: At,
  heading: Set<number>,
  charges: boolean,
): { columns: SpecColumn[] } | { problem: string } {
  const named: SpecColumn[] = [];
  for (const [i, c] of columns.entries()) {
    const over = Array.isArray(c?.heading) ? c.heading : [];
    const stray = over.find((n) => !heading.has(n) || !at(n));
    if (stray !== undefined)
      return { problem: `column ${i}: [${stray}] is not one of the heading's fragments` };
    const outside = over.find((n) => {
      const f = at(n).fragment;
      return f.x + f.width < c.left - EDGE || f.x > c.right + EDGE;
    });
    if (outside !== undefined) {
      const f = at(outside).fragment;
      return {
        problem: `column ${i}: its heading [${outside}] ${JSON.stringify(f.str)} is printed at ${Math.round(f.x)}–${Math.round(f.x + f.width)}, outside it (${Math.round(c.left)}–${Math.round(c.right)})`,
      };
    }
    const printed = over
      .map((n) => at(n))
      .sort((a, b) => a.row.y - b.row.y || a.fragment.x - b.fragment.x)
      .map((shown) => shown.fragment.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Columns sharing one printed heading (its different lines) take the names the model gave them.
    const shared =
      over.length > 0 && columns.filter((o) => headingKey(o) === headingKey(c)).length > 1;
    const name = (shared && c?.name?.trim()) || printed || c?.name?.trim() || `Column ${i + 1}`;
    if (!Number.isFinite(c.left) || !Number.isFinite(c.right) || c.left >= c.right)
      return { problem: `column "${name}" needs left < right` };
    if (c.left < -EDGE || c.right > pageWidth + EDGE)
      return { problem: `column "${name}" runs off the page (0–${pageWidth})` };
    const lines = linesProblem(c.fromLine, c.toLine);
    if (lines) return { problem: `column "${name}" ${lines}` };
    if (c.type === 'amounts' && !charges)
      return {
        problem: `column "${name}" adds several amounts into one: a record listing its charges one per line reads them as charges — each charge its own cell`,
      };
    if (!COLUMN_TYPES.includes(c.type)) return { problem: `column "${name}" has no type` };
    const { left, right, fromLine, toLine, type } = c;
    named.push({ name, left, right, fromLine, toLine, type });
  }
  return { columns: named };
}

/**
 * An `inText` label's words may be printed anywhere on the invoice: they often print in only some
 * records, on pages the model was not shown, and reach it only as repair evidence.
 */
function checkLabels(
  labels: Answer['labels'],
  at: At,
  texts: string[],
): { labels: SpecLabel[] } | { problem: string } {
  const out: SpecLabel[] = [];
  for (const l of labels) {
    const text = at(l.label).fragment.str;
    const name = (l.where === 'inText' ? (l.words ?? '') : text).replace(/\s+/g, ' ').trim();
    if (!['right', 'rightBlock', 'below', 'inText'].includes(l.where))
      return { problem: `label "${name}" has no where` };
    if (!CELL_TYPES.includes(l.type)) return { problem: `label "${name}" has no type` };
    if (l.where !== 'inText') {
      out.push({ name, label: normaliseText(text), where: l.where, type: l.type });
      continue;
    }
    const words = normaliseText(l.words ?? '');
    if (!words || !texts.some((t) => wordAt(t, words)))
      return {
        problem: `label "${name}": "${l.words ?? ''}" is printed inside no text of the invoice`,
      };
    if (l.type !== 'amount' && l.type !== 'number')
      return { problem: `label "${name}" is inText, which reads a number: type amount or number` };
    // Named by its words without the signs around them: `, Surcharge of £` is `Surcharge of`.
    const bare = name.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '') || name;
    out.push({ name: bare, label: words, where: 'inText', type: l.type });
  }
  return { labels: out };
}

/** Cells printed under one name are told apart as headings would be: `Charge`, `Charge (2)`. */
function uniqueNames(spec: ReadingSpec): void {
  const reserved = [
    SECTION,
    OTHER_AMOUNTS,
    OTHER_DESCRIPTION,
    ...(spec.charges ? [CHARGES] : []),
    ...(readsInvoiceLines(spec)
      ? [INVOICE_CHARGE, INVOICE_AMOUNT, INVOICE_TYPE, INVOICE_PROVEN]
      : []),
  ];
  const seen = new Map<string, number>(reserved.map((name) => [name, 1]));
  const rename = (name: string) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count > 1 ? `${name} (${count})` : name;
  };
  spec.columns.forEach((c) => (c.name = rename(c.name)));
  spec.labels.forEach((l) => (l.name = rename(l.name)));
}

/** Lines count from a record's first (1) or back from its last (-1); null reads to the last. */
function linesProblem(fromLine: number, toLine: number | null): string | null {
  if (!Number.isInteger(fromLine) || fromLine === 0)
    return 'needs fromLine 1 or more, or -1 or less (from the record’s end)';
  const sameEnd = Math.sign(toLine ?? 0) === Math.sign(fromLine);
  if (
    toLine !== null &&
    (!Number.isInteger(toLine) || toLine === 0 || (sameEnd && toLine < fromLine))
  )
    return 'needs toLine null or at least fromLine';
  return null;
}

/** The label printed beside a total: words, with an amount right of it. */
function totalLabel(at: At, n: unknown, what: string): { label: string } | { problem: string } {
  const shown = at(n);
  if (!shown) return { problem: `${what}: [${n}] is not a fragment shown` };
  if (!/[a-z]/i.test(shown.fragment.str))
    return {
      problem: `${what}: [${n}] prints a number, not a label — point at the words printed beside the total`,
    };
  const printsAmount = shown.row.fragments.some((f) => f.x > shown.fragment.x && isAmount(f.str));
  if (!printsAmount) return { problem: `${what}: [${n}] has no amount printed right of it` };
  return { label: normaliseText(shown.fragment.str) };
}

/** Where the label's line prints the total a check points at: a number right of the label. */
function totalAt(
  at: At,
  label: unknown,
  n: unknown,
  what: string,
): { x: number; right: number } | { problem: string } | null {
  if (n === null || n === undefined) return null;
  const shown = at(n);
  const beside = at(label);
  if (
    !shown ||
    shown.row !== beside.row ||
    shown.fragment.x <= beside.fragment.x ||
    numberValue(shown.fragment.str) === null
  )
    return { problem: `${what}: amount [${n}] is not a number printed right of its label` };
  return { x: shown.fragment.x, right: shown.fragment.x + shown.fragment.width };
}

/** Which name a check cannot add, and the names it could: a bare refusal had models repeat it. */
function notNumeric(i: number, names: string[], spec: ReadingSpec): { problem: string } {
  const all = [...cellNames(spec), ...(spec.charges ? [CHARGES] : [])];
  const types = [...cellTypes(spec), 'amount' as CellType];
  const numeric = (name: string) => MONEY_OR_NUMBER.includes(types[all.indexOf(name)]);
  const bad = names.find((name) => !numeric(name)) ?? '';
  const at = all.indexOf(bad);
  const could = all.filter(numeric).map((name) => `"${name}"`);
  const oneCharge =
    at < 0 && spec.charges
      ? `. Charges are only named together, as "${CHARGES}": a charge line a check needs alone (a record's own total) is read by a label (where: right), which takes it out of the charges`
      : '';
  return {
    problem: `check ${i}: "${bad}" ${at < 0 ? 'names no cell' : `is a ${types[at]} cell`} — a check adds amount or number cells: ${could.join(', ')}${oneCharge}`,
  };
}

/** A sum check: its label, where it prints the total (when pointed at), and the parts it adds. */
function sumCheck(
  c: Answer['checks'][number],
  cells: string[],
  at: At,
  what: string,
): SpecCheck | { problem: string } {
  const label = totalLabel(at, c.label, what);
  if ('problem' in label) return label;
  const amount = totalAt(at, c.label, c.amount, what);
  if (amount && 'problem' in amount) return amount;
  const plus: string[] = [];
  for (const n of Array.isArray(c.plus) ? c.plus : []) {
    const part = totalLabel(at, n, what);
    if ('problem' in part) return part;
    plus.push(part.label);
  }
  return {
    kind: 'sum',
    cells,
    label: label.label,
    ...(c.records === 'charges' || c.records === 'credits' ? { records: c.records } : {}),
    ...(amount && 'x' in amount ? { amount } : {}),
    ...(plus.length ? { plus } : {}),
  };
}

function checkChecks(
  checks: Answer['checks'],
  spec: ReadingSpec,
  at: At,
): { checks: SpecCheck[] } | { problem: string } {
  const all = cellNames(spec);
  const types = cellTypes(spec);
  const numeric = (name: string) =>
    (name === CHARGES && !!spec.charges) || MONEY_OR_NUMBER.includes(types[all.indexOf(name)]);
  const labelOf = (n: unknown, what: string) => totalLabel(at, n, what);
  const out: SpecCheck[] = [];
  for (const [i, c] of checks.entries()) {
    const cells = c?.cells ?? [];
    if (c?.kind === 'record') {
      const parts = c.parts ?? [];
      if (!parts.length) return { problem: `check ${i}: a record check needs parts` };
      if (![c.total ?? '', ...parts].every(numeric))
        return notNumeric(i, [c.total ?? '', ...parts], spec);
      out.push({ kind: 'record', total: c.total ?? '', parts });
      continue;
    }
    if (!cells.length) return { problem: `check ${i}: name the cells it adds` };
    if (!cells.every(numeric)) return notNumeric(i, cells, spec);
    if (c?.kind === 'sum') {
      const sum = sumCheck(c, cells, at, `check ${i}`);
      if ('problem' in sum) return sum;
      out.push(sum);
    } else if (c?.kind === 'carry') {
      const carried = labelOf(c.carried, `check ${i}`);
      if ('problem' in carried) return carried;
      const brought =
        c.brought === null || c.brought === undefined ? null : labelOf(c.brought, `check ${i}`);
      if (brought && 'problem' in brought) return brought;
      out.push({
        kind: 'carry',
        cells,
        carried: carried.label,
        brought: brought && 'label' in brought ? brought.label : null,
      });
    } else return { problem: `check ${i} has no kind` };
  }
  return { checks: out };
}
