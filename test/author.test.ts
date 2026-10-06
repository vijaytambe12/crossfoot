import { describe, expect, it } from 'vitest';
import { DocumentGeometry, Row } from '../src/geometry.js';
import { pointable, specFromAnswer, specQuestion } from '../src/author.js';

/**
 * Writing a reading spec: what the model is shown, and how its answer — pointers only — is checked
 * against the page before anything is read with it. Documents are made up.
 */
type Text = [string, number];
const row = (y: number, ...texts: Text[]): Row => ({
  y,
  fragments: texts.map(([str, x]) => ({ str, x, y, width: str.length * 5, height: 8 })),
});
const doc = (...pages: Row[][]): DocumentGeometry => ({
  pageCount: pages.length,
  pages: pages.map((rows, i) => ({ pageNumber: i + 1, width: 600, height: 840, rows })),
});
const records = (from: number, count: number, first = (i: number) => `0${i + 1}/02/24`) =>
  Array.from({ length: count }, (_, i) =>
    row(120 + 12 * i, [first(from + i), 20], [`Levy of $1.0${i}`, 80], [`${10 + i}.00`, 520]),
  );
const invoice = doc(
  [row(30, ['Terms and conditions', 20])],
  [row(100, ['Date', 20], ['Details', 80], ['Amount', 500]), ...records(0, 3)],
  [row(100, ['Date', 20], ['Details', 80], ['Amount', 500]), ...records(3, 3)],
  [
    row(100, ['Date', 20], ['Details', 80], ['Amount', 500]),
    ...records(6, 1, () => 'X900001'),
    row(200, ['Total', 400], ['66.00', 520]),
  ],
  [row(100, ['Date', 20], ['Details', 80], ['Amount', 500]), ...records(7, 2, () => 'ADJ-1')],
);
const at = (question: ReturnType<typeof specQuestion>, text: string) =>
  [...question.fragments].find(([, shown]) => shown.fragment.str === text)[0];

describe('writing a reading spec', () => {
  const question = specQuestion(invoice);

  it('shows the first pages printing amounts and the last in full, and lines from the others that start differently', () => {
    expect(question.prompt).toContain('Page 2 of 5 (width 600):');
    expect(question.prompt).toContain('Page 3 of 5 (width 600):');
    expect(question.prompt).toContain('Page 5 of 5 (width 600):');
    expect(question.prompt).not.toContain('Terms and conditions'); // no amounts: never needed
    expect(question.prompt).toContain('Lines from other pages that start differently');
    expect(question.prompt).toContain('"X900001"');
    expect(question.prompt).toContain('"Total"');
  });

  const answer = (over: Record<string, unknown> = {}) => ({
    heading: [at(question, 'Date'), at(question, 'Details'), at(question, 'Amount')],
    records: [
      { example: at(question, '01/02/24'), identify: 'first_word' },
      { example: at(question, 'X900001'), identify: 'first_word' },
      { example: at(question, 'ADJ-1'), identify: 'exact_text' },
    ],
    groups: [],
    columns: [
      {
        heading: [at(question, 'Date')],
        left: 15,
        right: 75,
        fromLine: 1,
        toLine: 1,
        type: 'text',
      },
      {
        heading: [at(question, 'Details')],
        left: 75,
        right: 450,
        fromLine: 1,
        toLine: 1,
        type: 'text',
      },
      {
        heading: [at(question, 'Amount')],
        left: 450,
        right: 560,
        fromLine: 1,
        toLine: null,
        type: 'amount',
      },
    ],
    labels: [
      {
        label: at(question, 'Levy of $1.00'),
        words: 'Levy of',
        where: 'inText',
        type: 'amount',
      },
    ],
    otherAmounts: false,
    carryOver: false,
    lines: [{ example: at(question, 'Total'), role: 'end' }],
    checks: [{ kind: 'sum', cells: ['Amount'], label: at(question, 'Total') }],
    ...over,
  });

  it('turns pointers into a spec: record starts by the shape or text of their example, labels by their words', () => {
    const converted = specFromAnswer(answer(), question);

    expect(converted).toMatchObject({
      spec: {
        pageWidth: 600,
        heading: ['date details amount'],
        identity: ['date details amount'],
        records: [
          { x: 20, words: 1, shape: 'd/d/d' },
          { x: 20, words: 1, shape: 'ad' },
          { x: 20, words: 0, text: 'adj-#' },
        ],
        columns: [{ name: 'Date' }, { name: 'Details' }, { name: 'Amount' }],
        labels: [{ name: 'Levy of', label: 'levy of', where: 'inText', type: 'amount' }],
        lines: [{ label: 'total', role: 'end' }],
        checks: [{ kind: 'sum', cells: ['Amount'], label: 'total' }],
      },
    });
  });

  it('turns charge lines into the spec, and lets a check add them all as Charges', () => {
    const charges = {
      nameLeft: 75,
      nameRight: 450,
      amountLeft: 450,
      amountRight: 560,
      fromLine: 2,
      toLine: null,
    };
    const converted = specFromAnswer(
      answer({
        charges,
        checks: [{ kind: 'sum', cells: ['Amount', 'Charges'], label: at(question, 'Total') }],
      }),
      question,
    );

    expect(converted).toMatchObject({
      spec: { charges, checks: [{ kind: 'sum', cells: ['Amount', 'Charges'], label: 'total' }] },
    });
    // Without charge lines there is nothing to add as Charges.
    expect(
      specFromAnswer(
        answer({ checks: [{ kind: 'sum', cells: ['Charges'], label: at(question, 'Total') }] }),
        question,
      ),
    ).toEqual({ problem: expect.stringContaining('"Charges" names no cell') });
  });

  it('takes inText words printed anywhere on the invoice, not only in the fragment pointed at', () => {
    const later = doc(
      [row(100, ['Date', 20], ['Details', 80], ['Amount', 500]), ...records(0, 3)],
      [row(100, ['Date', 20], ['Details', 80], ['Amount', 500]), ...records(3, 3)],
      [
        row(100, ['Date', 20], ['Details', 80], ['Amount', 500]),
        row(120, ['07/02/24', 20], ['Admin fee of $3.00', 80], ['13.00', 520]),
      ],
      [
        row(100, ['Date', 20], ['Details', 80], ['Amount', 500]),
        ...records(7, 1),
        row(200, ['Total', 400], ['66.00', 520]),
      ],
    );
    const shown = specQuestion(later);
    const find = (text: string) => at(shown, text);
    // A record like the others, on a page not shown: the words reach the model only as evidence.
    expect(shown.prompt).not.toContain('Admin fee');

    const converted = specFromAnswer(
      {
        heading: [find('Date'), find('Details'), find('Amount')],
        records: [{ example: find('01/02/24'), identify: 'first_word' }],
        groups: [],
        columns: answer().columns,
        labels: [
          { label: find('Levy of $1.00'), words: 'Admin fee of', where: 'inText', type: 'amount' },
        ],
        otherAmounts: false,
        carryOver: false,
        lines: [{ example: find('Total'), role: 'end' }],
        checks: [{ kind: 'sum', cells: ['Amount'], label: find('Total') }],
      },
      shown,
    );

    expect(converted).toMatchObject({
      spec: { labels: [{ name: 'Admin fee of', label: 'admin fee of', where: 'inText' }] },
    });
  });

  it('names an inText cell by its words without the signs around them', () => {
    const converted = specFromAnswer(
      answer({
        labels: [
          {
            label: at(question, 'Levy of $1.00'),
            words: 'Levy of $',
            where: 'inText',
            type: 'amount',
          },
        ],
      }),
      question,
    );

    expect(converted).toMatchObject({
      spec: { labels: [{ name: 'Levy of', label: 'levy of $', where: 'inText' }] },
    });
  });

  it('takes an amounts column only beside charges: a second figure each charge line prints, proven', () => {
    const charges = {
      nameLeft: 75,
      nameRight: 300,
      amountLeft: 300,
      amountRight: 450,
      fromLine: 2,
      toLine: null,
    };
    const lineTotals = answer().columns.map((c) =>
      c.heading[0] === at(question, 'Amount') ? { ...c, fromLine: 2, type: 'amounts' } : c,
    );

    expect(
      specFromAnswer(
        answer({
          charges,
          columns: lineTotals,
          checks: [{ kind: 'sum', cells: ['Charges', 'Amount'], label: at(question, 'Total') }],
        }),
        question,
      ),
    ).toMatchObject({ spec: { columns: [{}, {}, { name: 'Amount', type: 'amounts' }] } });
    expect(
      specFromAnswer(
        answer({
          charges,
          columns: lineTotals,
          checks: [{ kind: 'sum', cells: ['Charges'], label: at(question, 'Total') }],
        }),
        question,
      ),
    ).toEqual({ problem: expect.stringContaining('"Amount" adds up several amounts') });
  });

  it('takes charge and tax lines, whose amounts a check adds as Invoice charge amount', () => {
    const converted = specFromAnswer(
      answer({
        lines: [
          { example: at(question, 'Total'), role: 'end' },
          { example: at(question, 'ADJ-1'), role: 'charge' },
        ],
        checks: [
          { kind: 'sum', cells: ['Amount', 'Invoice charge amount'], label: at(question, 'Total') },
        ],
      }),
      question,
    );

    expect(converted).toMatchObject({
      spec: {
        lines: [
          { label: 'total', role: 'end' },
          { label: 'adj-#', role: 'charge' },
        ],
        checks: [{ cells: ['Amount', 'Invoice charge amount'] }],
      },
    });
    // With no charge or tax line there is no Invoice charge amount to add.
    expect(
      specFromAnswer(
        answer({
          checks: [{ kind: 'sum', cells: ['Invoice charge amount'], label: at(question, 'Total') }],
        }),
        question,
      ),
    ).toEqual({ problem: expect.stringContaining('"Invoice charge amount" names no cell') });
  });

  it('takes a column of rates, which no check may add', () => {
    const rates = answer().columns.map((c) =>
      c.heading[0] === at(question, 'Details') ? { ...c, type: 'rates' } : c,
    );

    expect(specFromAnswer(answer({ columns: rates }), question)).toMatchObject({
      spec: { columns: [{ name: 'Date' }, { name: 'Details', type: 'rates' }, { name: 'Amount' }] },
    });
    expect(
      specFromAnswer(
        answer({
          columns: rates,
          checks: [{ kind: 'sum', cells: ['Details'], label: at(question, 'Total') }],
        }),
        question,
      ),
    ).toEqual({ problem: expect.stringContaining('"Details" is a rates cell') });
  });

  it('numbers the lines a refusal names, so the next answer can point at lines it was not shown', () => {
    const shown = specQuestion(invoice);
    const size = shown.fragments.size;
    const hidden = invoice.pages[0].rows[0]; // page 1 prints no amount, so it is never shown
    const already = invoice.pages[3].rows[2]; // `Total`, shown among lines that start differently

    const text = pointable(shown, [
      { page: 1, row: hidden },
      { page: 4, row: already },
    ]);

    expect(text).toContain(`p1 y=30: [${size + 1}] x=20 w=100 "Terms and conditions"`);
    expect(text).toContain(`[${at(question, 'Total')}] x=400 w=25 "Total"`);
    expect(shown.fragments.get(size + 1).fragment).toBe(hidden.fragments[0]);
    expect(shown.fragments.size).toBe(size + hidden.fragments.length);
  });

  it('keeps where a total is printed when the check points at it', () => {
    const converted = specFromAnswer(
      answer({
        checks: [
          {
            kind: 'sum',
            cells: ['Amount'],
            label: at(question, 'Total'),
            amount: at(question, '66.00'),
          },
        ],
      }),
      question,
    );

    expect('spec' in converted && converted.spec.checks[0]).toEqual({
      kind: 'sum',
      cells: ['Amount'],
      label: 'total',
      amount: { x: 520, right: 545 },
    });
  });

  it('keeps the further totals a check adds to its own', () => {
    const converted = specFromAnswer(
      answer({
        checks: [
          {
            kind: 'sum',
            cells: ['Amount'],
            label: at(question, 'Total'),
            plus: [at(question, 'Total')],
          },
        ],
      }),
      question,
    );

    expect('spec' in converted && converted.spec.checks[0]).toMatchObject({ plus: ['total'] });
  });

  it('names a column by its heading printed over it, a stacked one top row first, and tells two of one name apart', () => {
    const stacked = doc([
      row(90, ['Charge', 420], ['Charge', 500]),
      row(100, ['Date', 20], ['ex GST', 420], ['inc GST', 500]),
      row(120, ['01/02/24', 20], ['10.00', 420], ['11.00', 500]),
      row(140, ['Total', 300], ['10.00', 420], ['11.00', 500]),
    ]);
    const shown = specQuestion(stacked);
    const find = (text: string, x: number) =>
      [...shown.fragments].find(([, f]) => f.fragment.str === text && f.fragment.x === x)[0];
    const column = (heading: number[], left: number, right: number) => ({
      heading,
      left,
      right,
      fromLine: 1,
      toLine: 1,
      type: 'amount',
    });

    const converted = specFromAnswer(
      answer({
        heading: [
          find('Charge', 420),
          find('Charge', 500),
          find('ex GST', 420),
          find('inc GST', 500),
        ],
        records: [{ example: find('01/02/24', 20), identify: 'whole_text' }],
        columns: [
          column([find('Charge', 420), find('ex GST', 420)], 410, 490),
          column([find('Charge', 500), find('inc GST', 500)], 490, 580),
          column([find('Charge', 420)], 410, 490),
        ],
        labels: [],
        lines: [{ example: find('Total', 300), role: 'end' }],
        checks: [{ kind: 'sum', cells: ['Charge ex GST'], label: find('Total', 300) }],
      }),
      shown,
    );

    expect('spec' in converted && converted.spec.columns.map((c) => c.name)).toEqual([
      'Charge ex GST',
      'Charge inc GST',
      'Charge',
    ]);
  });

  it('names a second column under one printed heading as the model named it', () => {
    const amount = answer().columns[2];
    const converted = specFromAnswer(
      answer({
        columns: [
          ...answer().columns,
          { ...amount, name: 'Fuel levy', fromLine: -1, toLine: -1 },
          { ...amount, fromLine: 2, toLine: 2 },
        ],
      }),
      question,
    );
    // Every column under a shared heading takes the name the model gave it, the first one too.
    const named = specFromAnswer(
      answer({
        columns: [
          ...answer().columns.slice(0, 2),
          { ...amount, name: 'Amount (header)', toLine: 1 },
          { ...amount, name: 'Amount', fromLine: 2 },
        ],
      }),
      question,
    );

    expect('spec' in converted && converted.spec.columns.map((c) => c.name)).toEqual([
      'Date',
      'Details',
      'Amount',
      'Fuel levy',
      'Amount (2)',
    ]);
    expect('spec' in named && named.spec.columns.map((c) => c.name)).toEqual([
      'Date',
      'Details',
      'Amount (header)',
      'Amount',
    ]);
  });

  it.each([
    [
      'a fragment it was not shown',
      { records: [{ example: 9999, identify: 'first_word' }] },
      '[9999] is not a fragment shown',
    ],
    [
      'a record start that is not its line’s first text',
      { records: [{ example: at(question, 'Levy of $1.00'), identify: 'first_word' }] },
      'is not the first text of its line',
    ],
    [
      'a heading printed outside its column',
      {
        columns: [
          {
            heading: [at(question, 'Amount')],
            left: 15,
            right: 75,
            fromLine: 1,
            toLine: 1,
            type: 'text',
          },
        ],
      },
      'column 0: its heading [3] "Amount" is printed at 500–530, outside it (15–75)',
    ],
    [
      'a heading no column is named by',
      {
        columns: [
          {
            heading: [at(question, 'Date')],
            left: 15,
            right: 75,
            fromLine: 1,
            toLine: 1,
            type: 'text',
          },
          {
            heading: [at(question, 'Amount')],
            left: 450,
            right: 560,
            fromLine: 1,
            toLine: 1,
            type: 'amount',
          },
        ],
      },
      '"Details" names no column',
    ],
    [
      'a total over a text cell',
      { checks: [{ kind: 'sum', cells: ['Date'], label: at(question, 'Total') }] },
      'check 0: "Date" is a text cell — a check adds amount or number cells: "Amount", "Levy of"',
    ],
    [
      'inText words printed nowhere on the invoice',
      {
        labels: [
          {
            label: at(question, 'Levy of $1.00'),
            words: 'Discount of',
            where: 'inText',
            type: 'amount',
          },
        ],
      },
      'label "Discount of": "Discount of" is printed inside no text of the invoice',
    ],
    [
      'a check naming one charge line',
      {
        charges: {
          nameLeft: 75,
          nameRight: 450,
          amountLeft: 450,
          amountRight: 560,
          fromLine: 2,
          toLine: null,
        },
        checks: [{ kind: 'record', total: 'Total', parts: ['Charges'] }],
      },
      'Charges are only named together, as "Charges": a charge line a check needs alone (a record\'s own total) is read by a label (where: right), which takes it out of the charges',
    ],
    [
      'a line marked by an amount instead of its text',
      {
        lines: [
          { example: at(question, 'Total'), role: 'end' },
          { example: at(question, '10.00'), role: 'tax' },
        ],
      },
      'is an amount: a line is marked by a text it prints',
    ],
    [
      'a total over a cell that does not exist',
      { checks: [{ kind: 'sum', cells: ['Charge'], label: at(question, 'Total') }] },
      'check 0: "Charge" names no cell — a check adds amount or number cells: "Amount", "Levy of"',
    ],
    [
      'a column adding several amounts into one',
      {
        columns: answer().columns.map((c) =>
          c.heading[0] === at(question, 'Details') ? { ...c, toLine: null, type: 'amounts' } : c,
        ),
      },
      'column "Details" adds several amounts into one: a record listing its charges one per line reads them as charges',
    ],
    [
      'charge lines no check proves',
      {
        charges: {
          nameLeft: 75,
          nameRight: 450,
          amountLeft: 450,
          amountRight: 560,
          fromLine: 2,
          toLine: null,
        },
      },
      'charges are read one by one, but no check names Charges',
    ],
    [
      'charge lines with no width',
      {
        charges: {
          nameLeft: 450,
          nameRight: 75,
          amountLeft: 450,
          amountRight: 560,
          fromLine: 2,
          toLine: null,
        },
      },
      'charges need nameLeft < nameRight',
    ],
    [
      'a total amount not printed on its label’s line',
      {
        checks: [
          {
            kind: 'sum',
            cells: ['Amount'],
            label: at(question, 'Total'),
            amount: at(question, 'Date'),
          },
        ],
      },
      'is not a number printed right of its label',
    ],
    [
      'a total label with no amount beside it',
      { checks: [{ kind: 'sum', cells: ['Amount'], label: at(question, 'Date') }] },
      'has no amount printed right of it',
    ],
    [
      'a column reading line 0',
      { columns: [{ heading: [], left: 15, right: 75, fromLine: 0, toLine: 1, type: 'text' }] },
      'needs fromLine 1 or more, or -1 or less (from the record’s end)',
    ],
    [
      'a column with no width',
      { columns: [{ heading: [], left: 75, right: 15, fromLine: 1, toLine: 1, type: 'text' }] },
      'needs left < right',
    ],
  ])('refuses an answer pointing at %s', (_, over, problem) => {
    expect(specFromAnswer(answer(over), question)).toEqual({
      problem: expect.stringContaining(problem),
    });
  });

  // A supporting list uploaded beside the invoice it belongs to — a consignment manifest of con
  // notes, dimensions and counts — prints no money anywhere. Pages are chosen by where the money
  // is, so it was shown NOTHING and answered by pointing at fragments that did not exist.
  it('shows a document that prints no amounts at all, so there is something to point at', () => {
    const manifest = doc([
      row(30, ['Northwind Freight — Consignment Manifest', 20]),
      row(100, ['Con Note', 20], ['Unit Type', 120], ['Units', 300]),
      row(120, ['NWF50001', 20], ['Carton/Box', 120], ['1', 300]),
      row(132, ['NWF50002', 20], ['Carton/Box', 120], ['2', 300]),
    ]);

    const shown = specQuestion(manifest);

    expect(shown.prompt).toContain('Page 1 of 1 (width 600):');
    expect(shown.prompt).toContain('"Con Note"');
    expect(shown.prompt).toContain('"NWF50001"');
    expect(at(shown, 'Con Note')).toBeDefined();
  });
});
