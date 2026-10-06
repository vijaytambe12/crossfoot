import { describe, expect, it } from 'vitest';
import { DocumentGeometry, Row } from '../src/geometry.js';
import { ReadingSpec, SPEC_VERSION } from '../src/spec.js';
import { rowText } from '../src/text.js';
import { readWithSpec, printsIdentity } from '../src/read.js';

/**
 * A reading spec applied by code: records, their cells, and the invoice's own proof. The documents
 * here are made up — shapes any invoice might take (a one-line table, records over several lines
 * with stacked headings and amounts inside text, a form of labelled blocks) — never a real one.
 */
type Text = [string, number, number?];
const row = (y: number, ...texts: Text[]): Row => ({
  y,
  fragments: texts.map(([str, x, width]) => ({
    str,
    x,
    y,
    width: width ?? str.length * 5,
    height: 8,
  })),
});
const doc = (...pages: Row[][]): DocumentGeometry => ({
  pageCount: pages.length,
  pages: pages.map((rows, i) => ({ pageNumber: i + 1, width: 600, height: 840, rows })),
});
const spec = (over: Partial<ReadingSpec>): ReadingSpec => ({
  version: SPEC_VERSION,
  pageWidth: 600,
  heading: [],
  identity: [],
  records: [],
  groups: [],
  columns: [],
  labels: [],
  otherAmounts: false,
  carryOver: false,
  lines: [],
  checks: [],
  ...over,
});

describe('a reading spec applied to an invoice', () => {
  describe('a table of one line per record', () => {
    const invoice = (total = '60.00') =>
      doc([
        row(40, ['Invoice 123', 20]),
        row(100, ['Date', 20], ['Consignment', 80], ['Amount', 500]),
        row(120, ['01/02/24', 20], ['CN001', 80], ['10.00', 520]),
        row(132, ['02/02/24', 20], ['CN002', 80], ['20.00', 520]),
        row(144, ['03/02/24', 20], ['CN003', 80], ['30.00', 520]),
        row(170, ['Subtotal', 400], [total, 520]),
        row(182, ['GST', 400], ['6.00', 520]),
      ]);
    const table = spec({
      heading: ['date consignment amount'],
      identity: ['date consignment amount'],
      records: [{ x: 20, words: 1, shape: 'd/d/d' }],
      columns: [
        { name: 'Date', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'date' },
        { name: 'Consignment', left: 75, right: 300, fromLine: 1, toLine: 1, type: 'text' },
        { name: 'Amount', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      // GST follows the records: every line there is named — here passed over, not a row.
      lines: [
        { label: 'subtotal', x: 400, role: 'end' },
        { label: 'gst', x: 400, role: 'skip' },
      ],
      checks: [{ kind: 'sum', cells: ['Amount'], label: 'subtotal' }],
    });

    it('reads one record per line and proves it by the printed subtotal', () => {
      const read = readWithSpec(invoice(), table);

      expect(read.problem).toBeNull();
      expect(read.names).toEqual(['Date', 'Consignment', 'Amount']);
      expect(read.records.map((r) => r.cells)).toEqual([
        ['01/02/24', 'CN001', '10.00'],
        ['02/02/24', 'CN002', '20.00'],
        ['03/02/24', 'CN003', '30.00'],
      ]);
      expect(printsIdentity(invoice(), table)).toBe(true);
    });

    it('refuses a spec that leaves out a column its records print', () => {
      const withoutDate = { ...table, columns: table.columns.slice(1) };

      expect(readWithSpec(invoice(), withoutDate).problem).toMatchObject({
        check: 'unread_text',
        evidence: 'The line as printed: "01/02/24 CN001 10.00". No cell reads: "01/02/24" at x=20',
      });
    });

    it('refuses the read when the records do not add up to the printed total', () => {
      expect(readWithSpec(invoice('61.00'), table).problem).toMatchObject({
        check: 'total',
        message:
          'Amount over the 3 records adds up to 60.00, but the invoice prints 61.00 beside "subtotal"',
      });
    });

    it('refuses a line printing an amount that belongs to no record', () => {
      const withFee = invoice();
      withFee.pages[0].rows.splice(3, 0, row(126, ['Account fee', 80], ['5.00', 520]));

      expect(readWithSpec(withFee, table).problem.lines.map((l) => rowText(l.row))).toEqual([
        'Account fee 5.00',
      ]);
      expect(readWithSpec(withFee, table).problem).toMatchObject({
        check: 'unread_amount',
        // A line under a record may not be the record's at all: the evidence says how to set it aside.
        evidence: expect.stringContaining(
          'If this line is not the record’s — a total, a subtotal, a payment — give it as a `lines` entry',
        ),
      });
      const onItsOwn = invoice();
      onItsOwn.pages[0].rows.splice(1, 0, row(110, ['Adjustment', 80], ['5.00', 520]));
      const records = readWithSpec(onItsOwn, table);
      // Above the first record: a page header, not read.
      expect(records.problem).toBeNull();
    });

    it('passes over a payment printed like a record, by the text it prints at its place', () => {
      const withPayment = invoice();
      withPayment.pages[0].rows.splice(
        2,
        0,
        row(114, ['31/01/24', 20], ['Payment received', 80], ['(45.00)', 520]),
      );

      expect(readWithSpec(withPayment, table).problem).toMatchObject({ check: 'total' });
      const read = readWithSpec(withPayment, {
        ...table,
        lines: [...table.lines, { label: 'payment received', x: 80, role: 'skip' }],
      });
      expect(read.problem).toBeNull();
      expect(read.records).toHaveLength(3);
    });

    it('refuses to pass over a line printed like a record with a positive amount — a charge a subtotal leaves out', () => {
      const withFee = invoice('60.00');
      withFee.pages[0].rows.splice(
        5,
        0,
        row(156, ['04/02/24', 20], ['Late fee', 80], ['5.00', 520]),
      );

      const read = readWithSpec(withFee, {
        ...table,
        lines: [...table.lines, { label: 'late fee', x: 80, role: 'skip' }],
      });

      expect(read.problem).toMatchObject({ check: 'hidden_charge' });
    });

    it('shows the model what a failed total leaves out: lines no record reads, and records below nothing', () => {
      const withPayment = invoice();
      withPayment.pages[0].rows.splice(
        2,
        0,
        row(114, ['31/01/24', 20], ['Payment received', 80], ['(45.00)', 520]),
      );
      withPayment.pages[0].rows.splice(6, 0, row(160, ['Adjustment', 80], ['2.00', 520]));

      const problem = readWithSpec(withPayment, {
        ...table,
        lines: [...table.lines, { label: 'adjustment', x: 80, role: 'skip' }],
      }).problem;

      expect(problem.check).toBe('total');
      expect(problem.evidence).toContain(
        'Lines printing amounts on the record pages that no record reads (3):\n- p1: Adjustment 2.00',
      );
      expect(problem.evidence).toContain(
        '1 records add up to less than nothing in Amount (without them the records add up to 60.00), e.g.:\n- 31/01/24 | Payment received | (45.00)',
      );
      expect(problem.evidence).toContain(
        '- Amount over its charges (records of nothing or more) adds up to 60.00, printed on page 1: Subtotal 60.00',
      );
    });

    it('points a failed total at the one the records do add up to, printed elsewhere on the invoice', () => {
      const withSummary = invoice('55.00');
      withSummary.pages[0].rows.splice(
        0,
        0,
        row(20, ['Total of this invoice', 300], ['60.00', 520]),
      );

      expect(readWithSpec(withSummary, table).problem.evidence).toContain(
        "Totals the records' cells add up to, as the invoice prints them:\n- Amount adds up to 60.00, printed on page 1: Total of this invoice 60.00",
      );
    });

    it('names the cell a failed total is off by: read by the checked cells too, or left out of them', () => {
      const withFuel = (subtotal: string) =>
        doc([
          row(100, ['Date', 20], ['Fuel', 400], ['Amount', 500]),
          row(120, ['01/02/24', 20], ['1.00', 400], ['10.00', 520]),
          row(132, ['02/02/24', 20], ['2.00', 400], ['20.00', 520]),
          row(170, ['Subtotal', 300], [subtotal, 520]),
        ]);
      const fuel = spec({
        ...table,
        heading: ['date fuel amount'],
        columns: [
          { name: 'Date', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'date' },
          { name: 'Fuel', left: 390, right: 450, fromLine: 1, toLine: 1, type: 'amount' },
          { name: 'Amount', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
        ],
        lines: [{ label: 'subtotal', x: 300, role: 'end' }],
      });

      expect(readWithSpec(withFuel('33.00'), fuel).problem.evidence).toContain(
        'The records add up to 3.00 less than printed — what Fuel adds up to: the total may include Fuel.',
      );
      expect(readWithSpec(withFuel('27.00'), fuel).problem.evidence).toContain(
        'The records add up to 3.00 more than printed — what Fuel adds up to: Amount may be reading Fuel’s amounts too (check the columns’ edges), or the total leaves Fuel out.',
      );
    });

    it('checks a total at the place its summary row prints it', () => {
      // No GST line under the records: this is about where the summary row prints its total.
      const withSummary = invoice();
      withSummary.pages[0].rows = withSummary.pages[0].rows.filter(
        (r) => r.fragments[0].str !== 'GST',
      );
      withSummary.pages[0].rows.unshift(
        row(20, ['Consignments', 20], ['3', 300], ['60.00', 400], ['6.00', 460], ['66.00', 520]),
      );
      const at = (x: number) => ({
        ...table,
        checks: [
          {
            kind: 'sum' as const,
            cells: ['Amount'],
            label: 'consignments',
            amount: { x, right: x + 25 },
          },
        ],
      });

      expect(readWithSpec(withSummary, at(400)).problem).toBeNull();
      expect(readWithSpec(withSummary, at(520)).problem).toMatchObject({
        check: 'total',
        detail: { printed: '66.00' },
      });
    });

    it('checks a total printed in parts, and points a failed one at the parts that make it', () => {
      const inParts = doc([
        row(100, ['Date', 20], ['Consignment', 80], ['Amount', 500]),
        row(120, ['01/02/24', 20], ['CN001', 80], ['10.00', 520]),
        row(132, ['02/02/24', 20], ['CN002', 80], ['20.00', 520]),
        row(170, ['Freight total', 300], ['25.00', 520]),
        row(182, ['Surcharge total', 300], ['5.00', 520]),
      ]);
      const parts = (plus: string[]) =>
        spec({
          ...table,
          lines: [
            { label: 'freight total', x: 300, role: 'end' },
            { label: 'surcharge total', x: 300, role: 'skip' },
          ],
          checks: [{ kind: 'sum', cells: ['Amount'], label: 'freight total', plus }],
        });

      expect(readWithSpec(inParts, parts(['surcharge total'])).problem).toBeNull();
      expect(readWithSpec(inParts, parts([])).problem.evidence).toContain(
        '- Amount adds up to 30.00 = 25.00 + 5.00, printed on page 1: Freight total 25.00 / Surcharge total 5.00',
      );
    });

    describe('invoice-level charges and tax: rows of their own, in the same columns on every invoice', () => {
      const INVOICE = [
        'Invoice charge',
        'Invoice charge amount',
        'Invoice charge type',
        'Invoice charge proven',
      ];
      const consignments = [
        row(100, ['Date', 20], ['Consignment', 80], ['Amount', 500]),
        row(120, ['01/02/24', 20], ['CN001', 80], ['10.00', 520]),
        row(132, ['02/02/24', 20], ['CN002', 80], ['20.00', 520]),
      ];
      // Below the records: a total they prove, charges and tax printed once for the whole invoice
      // (two levy lines at different rates), the invoice's own total, then a payment slip.
      const summary = () =>
        doc([
          ...consignments,
          row(150, ['Base total', 400], ['30.00', 520]),
          row(162, ['Account fee', 400], ['2.00', 520]),
          row(174, ['Fuel levy 38.11%', 400], ['5.00', 520]),
          row(186, ['Fuel levy 39.67%', 400], ['6.00', 520]),
          row(198, ['GST', 400], ['4.30', 520]),
          row(210, ['Grand total', 400], ['47.30', 520]),
          row(240, ['Amount due', 400], ['47.30', 520]),
        ]);
      const invoiceLines = [
        { label: 'base total', x: 400, role: 'end' as const },
        { label: 'account fee', x: 400, role: 'charge' as const },
        { label: 'fuel levy ##.##%', x: 400, role: 'charge' as const },
        { label: 'gst', x: 400, role: 'tax' as const },
      ];
      const grandTotal = {
        kind: 'sum' as const,
        cells: ['Amount', 'Invoice charge amount'],
        label: 'grand total',
      };
      const summarised = {
        ...table,
        lines: invoiceLines,
        checks: [{ kind: 'sum' as const, cells: ['Amount'], label: 'base total' }, grandTotal],
      };

      it('reads each as a row of its own, in fixed columns, proven by the invoice’s own total', () => {
        const read = readWithSpec(summary(), summarised);

        expect(read.problem).toBeNull();
        expect(read.names).toEqual(['Date', 'Consignment', 'Amount', ...INVOICE]);
        // The payment slip after the invoice's own total is not the invoice's.
        expect(read.records.map((r) => r.cells)).toEqual([
          ['01/02/24', 'CN001', '10.00', '', '', '', ''],
          ['02/02/24', 'CN002', '20.00', '', '', '', ''],
          ['', '', '', 'Account fee', '2.00', 'charge', 'yes'],
          ['', '', '', 'Fuel levy 38.11%', '5.00', 'charge', 'yes'],
          ['', '', '', 'Fuel levy 39.67%', '6.00', 'charge', 'yes'],
          ['', '', '', 'GST', '4.30', 'tax', 'yes'],
        ]);
      });

      it('refuses an amount left unaccounted between the records and the invoice’s total — an end line hides nothing', () => {
        const problem = readWithSpec(summary(), {
          ...summarised,
          lines: invoiceLines.filter((l) => l.role !== 'charge' || l.label === 'account fee'),
        }).problem;

        expect(problem).toMatchObject({
          check: 'unknown_line',
          message:
            '2 line(s) after the last record print amounts and are no known line, the first on page 1: "fuel levy ##.##%"',
        });
        expect(problem.evidence).toContain('a charge or tax printed once for the whole invoice');
        expect(problem.lines.map((l) => rowText(l.row))).toEqual([
          'Fuel levy 38.11% 5.00',
          'Fuel levy 39.67% 6.00',
        ]);
      });

      it('refuses a total the records already prove made a row: counted twice, the invoice’s total fails', () => {
        const problem = readWithSpec(summary(), {
          ...table,
          lines: [
            ...invoiceLines.slice(1),
            { label: 'base total', x: 400, role: 'charge' as const },
            { label: 'grand total', x: 400, role: 'end' as const },
          ],
          checks: [grandTotal],
        }).problem;

        expect(problem).toMatchObject({ check: 'total' });
      });

      it('never reads a charge line printed before the first record — a cover page restating the invoice', () => {
        const withCover = doc(
          [row(100, ['Fuel levy 38.11%', 400], ['11.00', 520])],
          summary().pages[0].rows,
        );

        const read = readWithSpec(withCover, summarised);

        expect(read.problem).toBeNull();
        expect(read.records.filter((r) => r.cells[5] === 'charge')).toHaveLength(3);
      });

      it('marks the rows unproven when the invoice prints no total that includes them', () => {
        const noGrandTotal = doc([
          ...consignments,
          row(150, ['Freight total', 400], ['30.00', 520]),
          row(162, ['Fuel levy', 400], ['5.00', 520]),
          row(174, ['GST', 400], ['3.50', 520]),
        ]);

        const read = readWithSpec(noGrandTotal, {
          ...table,
          lines: [
            { label: 'fuel levy', x: 400, role: 'charge' },
            { label: 'gst', x: 400, role: 'tax' },
          ],
          checks: [{ kind: 'sum', cells: ['Amount'], label: 'freight total' }],
        });

        expect(read.problem).toBeNull();
        expect(read.records.slice(-2).map((r) => r.cells.slice(3))).toEqual([
          ['Fuel levy', '5.00', 'charge', 'no'],
          ['GST', '3.50', 'tax', 'no'],
        ]);
      });

      it('knows the invoice’s own total by its label wherever it prints on its line', () => {
        const sharedLine = doc([
          ...consignments,
          row(150, ['Sub total', 400], ['30.00', 520]),
          row(162, ['GST', 400], ['3.00', 520]),
          // A notice printed first on the line the total prints on.
          row(174, ['WE ARE NOT COMMON CARRIERS', 20], ['Invoice total:', 400], ['33.00', 520]),
        ]);

        const read = readWithSpec(sharedLine, {
          ...table,
          lines: [
            { label: 'sub total', x: 400, role: 'end' },
            { label: 'gst', x: 400, role: 'tax' },
          ],
          checks: [
            { kind: 'sum', cells: ['Amount'], label: 'sub total' },
            { ...grandTotal, label: 'invoice total:' },
          ],
        });

        expect(read.problem).toBeNull();
        expect(read.records.pop().cells.slice(3)).toEqual(['GST', '3.00', 'tax', 'yes']);
      });

      it('refuses rows left unproven when the invoice prints the total they make with the records', () => {
        const withTotalDue = doc([
          ...consignments,
          row(150, ['Sub total', 400], ['30.00', 520]),
          row(162, ['GST', 400], ['3.00', 520]),
          row(174, ['Total due', 400], ['33.00', 520]),
        ]);

        const { problem } = readWithSpec(withTotalDue, {
          ...table,
          lines: [
            { label: 'gst', x: 400, role: 'tax' },
            { label: 'total due', x: 400, role: 'skip' },
          ],
          checks: [{ kind: 'sum', cells: ['Amount'], label: 'sub total' }],
        });

        expect(problem).toMatchObject({
          check: 'uncovered',
          message:
            'the invoice-level rows are not proven, but the invoice prints 33.00 beside "total due" — the records and those rows added up',
        });
        expect(problem.evidence).toContain('That is the invoice’s own total: check against it');
        expect(problem.lines.map((l) => rowText(l.row))).toEqual(['Total due 33.00']);
      });

      it('refuses a line passed over as not a charge when the invoice’s own total charges it', () => {
        const withTotalDue = doc([
          ...consignments,
          row(150, ['Sub total', 400], ['30.00', 520]),
          row(162, ['GST', 400], ['3.00', 520]),
          row(174, ['Total due', 400], ['33.00', 520]),
        ]);

        const { problem } = readWithSpec(withTotalDue, {
          ...table,
          lines: [
            { label: 'sub total', x: 400, role: 'end' },
            { label: 'gst', x: 400, role: 'skip' },
            { label: 'total due', x: 400, role: 'skip' },
          ],
          checks: [{ kind: 'sum', cells: ['Amount'], label: 'sub total' }],
        });

        expect(problem).toMatchObject({
          check: 'uncovered',
          message:
            '1 line(s) passed over as not charges are charged: the invoice prints 33.00 beside "total due" — the records, the invoice-level rows and those lines added up',
        });
        expect(problem.evidence).toContain('is a `charge` or `tax` line');
        expect(problem.lines.map((l) => rowText(l.row))).toEqual(['GST 3.00', 'Total due 33.00']);
      });

      it('never takes a line restating what the records carry for a charge passed over', () => {
        // GST printed on every record, then again, added up, under them: not charged twice.
        const perRecordTax = doc([
          row(100, ['Date', 20], ['Consignment', 80], ['GST', 410], ['Amount', 500]),
          row(120, ['01/02/24', 20], ['CN001', 80], ['1.00', 420], ['11.00', 520]),
          row(132, ['02/02/24', 20], ['CN002', 80], ['2.00', 420], ['22.00', 520]),
          row(150, ['Total', 450], ['33.00', 520]),
          row(162, ['GST included', 450], ['3.00', 520]),
          row(174, ['Total incl. GST', 450], ['36.00', 520]),
        ]);

        const read = readWithSpec(perRecordTax, {
          ...table,
          heading: ['date consignment gst amount'],
          columns: [
            ...table.columns.slice(0, 2),
            { name: 'GST', left: 400, right: 450, fromLine: 1, toLine: 1, type: 'amount' },
            { name: 'Amount', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
          ],
          lines: [
            { label: 'total', x: 450, role: 'end' },
            { label: 'gst included', x: 450, role: 'skip' },
            { label: 'total incl. gst', x: 450, role: 'skip' },
          ],
          checks: [{ kind: 'sum', cells: ['Amount'], label: 'total' }],
        });

        expect(read.problem).toBeNull();
      });

      it('looks for the invoice’s own total from every total the records are checked against', () => {
        const twoColumns = doc([
          row(100, ['Date', 20], ['Consignment', 80], ['Fuel', 410], ['Amount', 500]),
          row(120, ['01/02/24', 20], ['CN001', 80], ['4.00', 420], ['10.00', 520]),
          row(132, ['02/02/24', 20], ['CN002', 80], ['8.00', 420], ['20.00', 520]),
          row(150, ['Fuel total', 300], ['12.00', 420], ['Total charges', 450], ['30.00', 520]),
          row(162, ['GST', 450], ['3.00', 520]),
          row(174, ['Amount due', 450], ['33.00', 520]),
        ]);

        const { problem } = readWithSpec(twoColumns, {
          ...table,
          heading: ['date consignment fuel amount'],
          columns: [
            ...table.columns.slice(0, 2),
            { name: 'Fuel', left: 400, right: 450, fromLine: 1, toLine: 1, type: 'amount' },
            { name: 'Amount', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
          ],
          lines: [
            { label: 'fuel total', x: 300, role: 'end' },
            { label: 'gst', x: 450, role: 'tax' },
            { label: 'amount due', x: 450, role: 'skip' },
          ],
          checks: [
            { kind: 'sum', cells: ['Fuel'], label: 'fuel total' },
            { kind: 'sum', cells: ['Amount'], label: 'total charges' },
          ],
        });

        expect(problem).toMatchObject({ check: 'uncovered', detail: { printed: '33.00' } });
      });

      it('reads a charge printed in the table under the last record, or in a section of its own, the same way', () => {
        const inTable = doc([
          ...consignments,
          row(144, ['Fuel surcharge', 80], ['5.00', 520]),
          row(160, ['Total', 400], ['35.00', 520]),
        ]);
        const inSection = doc([
          ...consignments,
          row(150, ['Total freight', 400], ['30.00', 520]),
          row(170, ['SURCHARGES THIS PERIOD', 20]),
          row(182, ['FUEL SURCHARGE', 20], ['5.00', 520]),
          row(194, ['Total surcharges', 400], ['5.00', 520]),
        ]);

        const tabled = readWithSpec(inTable, {
          ...table,
          lines: [{ label: 'fuel surcharge', x: 80, role: 'charge' }],
          checks: [{ ...grandTotal, label: 'total' }],
        });
        const sectioned = readWithSpec(inSection, {
          ...table,
          lines: [{ label: 'fuel surcharge', x: 20, role: 'charge' }],
          checks: [{ ...grandTotal, label: 'total freight', plus: ['total surcharges'] }],
        });

        expect(tabled.problem).toBeNull();
        expect(sectioned.problem).toBeNull();
        expect(tabled.records.pop().cells.slice(3)).toEqual([
          'Fuel surcharge',
          '5.00',
          'charge',
          'yes',
        ]);
        expect(sectioned.records.pop().cells.slice(3)).toEqual([
          'FUEL SURCHARGE',
          '5.00',
          'charge',
          'yes',
        ]);
      });

      it('names the line to the model when the records fall short of the total by exactly what it prints', () => {
        const inTable = doc([
          ...consignments,
          row(144, ['Fuel surcharge', 80], ['5.00', 520]),
          row(160, ['Total', 400], ['35.00', 520]),
        ]);

        const { problem } = readWithSpec(inTable, {
          ...table,
          lines: [{ label: 'fuel surcharge', x: 80, role: 'end' }],
          checks: [{ kind: 'sum', cells: ['Amount'], label: 'total' }],
        });

        expect(problem).toMatchObject({ check: 'total' });
        expect(problem.evidence).toContain(
          'The records add up to 5.00 less than the total — exactly what this line prints: "Fuel surcharge 5.00". A charge printed once for the whole invoice is a `charge` line: read as a row of its own, and counted by a total that adds Invoice charge amount.',
        );
      });
    });

    it('refuses an invoice with no printed total checked, and one where no line starts a record', () => {
      expect(readWithSpec(invoice(), { ...table, checks: [] }).problem).toMatchObject({
        check: 'uncovered',
      });
      expect(
        readWithSpec(invoice(), { ...table, records: [{ x: 20, words: 1, shape: 'ad' }] }).problem,
      ).toMatchObject({ check: 'no_records' });
    });
  });

  describe('records printed over several lines, across pages', () => {
    // Two kinds of record number; a stacked heading naming what the record's third line prints;
    // a breakdown whose amounts are printed inside text; an amount carried from page to page.
    const heading = [
      row(100, ['Ref', 20], ['Service', 200], ['Net', 520]),
      row(108, ['Postcode', 60], ['Quantity', 200]),
    ];
    const record = (
      y: number,
      ref: string,
      service: string,
      qty: string,
      net: string,
      levy?: [string, string],
    ) => [
      row(y, [ref, 20], ['10 Jan', 60], [service, 200], [net, 520]),
      row(y + 8, ['2024', 60]),
      row(y + 16, ['AB1 2CD', 60], [qty, 200]),
      ...(levy
        ? [row(y + 24, [`Cost before levy $${levy[0]}, Levy of $${levy[1]}`, 200, 220])]
        : []),
    ];
    const invoice = (carried = '30.00') =>
      doc(
        [
          row(40, ['Page 1 of 2', 480]),
          ...heading,
          ...record(130, 'X1000001', 'Standard', '4', '10.00', ['9.00', '1.00']),
          ...record(170, '5550000001', 'Express', '2', '20.00', ['18.00', '2.00']),
          row(300, ['Carried forward', 300], [carried, 520]),
        ],
        [
          row(40, ['Page 2 of 2', 480]),
          ...heading,
          row(120, ['Brought forward', 300], ['30.00', 520]),
          ...record(130, 'X1000002', 'Handling', '1', '5.00'),
          row(200, ['Net total', 300], ['35.00', 520]),
        ],
      );
    const stacked = spec({
      heading: ['ref service net', 'postcode quantity'],
      identity: ['ref service net'],
      records: [
        { x: 20, words: 1, shape: 'ad' },
        { x: 20, words: 1, shape: 'd' },
      ],
      columns: [
        { name: 'Ref', left: 15, right: 58, fromLine: 1, toLine: 1, type: 'text' },
        { name: 'Date', left: 58, right: 190, fromLine: 1, toLine: 2, type: 'text' },
        { name: 'Postcode', left: 58, right: 190, fromLine: 3, toLine: 3, type: 'text' },
        { name: 'Service', left: 190, right: 450, fromLine: 1, toLine: 1, type: 'text' },
        { name: 'Quantity', left: 190, right: 450, fromLine: 3, toLine: 3, type: 'number' },
        { name: 'Net', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      labels: [
        { name: 'Cost before levy', label: 'cost before levy', where: 'inText', type: 'amount' },
        { name: 'Levy', label: 'levy of', where: 'inText', type: 'amount' },
      ],
      lines: [
        { label: 'carried forward', x: 300, role: 'end' },
        { label: 'brought forward', x: 300, role: 'skip' },
        { label: 'net total', x: 300, role: 'end' },
      ],
      checks: [
        { kind: 'sum', cells: ['Net'], label: 'net total' },
        { kind: 'record', total: 'Net', parts: ['Cost before levy', 'Levy'] },
        { kind: 'carry', cells: ['Net'], carried: 'carried forward', brought: 'brought forward' },
      ],
    });

    it('reads every kind of record with the lines under it, stacked columns and amounts inside text', () => {
      const read = readWithSpec(invoice(), stacked);

      expect(read.problem).toBeNull();
      expect(read.records.map((r) => r.cells)).toEqual([
        ['X1000001', '10 Jan 2024', 'AB1 2CD', 'Standard', '4', '10.00', '$9.00', '$1.00'],
        ['5550000001', '10 Jan 2024', 'AB1 2CD', 'Express', '2', '20.00', '$18.00', '$2.00'],
        ['X1000002', '10 Jan 2024', 'AB1 2CD', 'Handling', '1', '5.00', '', ''],
      ]);
    });

    it('refuses a breakdown that does not add up to its record, and an amount carried wrongly', () => {
      const broken = invoice();
      const text = broken.pages[0].rows
        .flatMap((r) => r.fragments)
        .find((f) => f.str.startsWith('Cost before levy $9'));
      text.str = 'Cost before levy $9.00, Levy of $1.50';
      expect(readWithSpec(broken, stacked).problem).toMatchObject({ check: 'record_total' });

      expect(readWithSpec(invoice('31.00'), stacked).problem).toMatchObject({
        check: 'carry',
        message:
          'on page 1, Net over the records so far adds up to 30.00, but the invoice carries 31.00',
      });
    });

    it('reads a record continued at the top of the next page when records carry over', () => {
      const continued = invoice();
      continued.pages[1].rows.splice(3, 0, row(124, ['Extra note', 200]));

      const read = readWithSpec(continued, { ...stacked, carryOver: true });

      expect(read.problem).toBeNull();
      expect(read.records[1].cells[3]).toBe('Express');
    });
  });

  describe('a form: a block of labelled lines per record', () => {
    const block = (y: number, id: string, charges: [string, string][], total: string) => [
      row(y, ['Date shipped', 40], ['01/03/2024', 150], ['Consignor', 300], ['Consignee', 450]),
      row(y + 8, ['Waybill', 40], [id, 150], ['ACME PTY', 300], ['JANE DOE', 450]),
      row(
        y + 16,
        ['Delivered', 40],
        ['03/03/2024 10:21', 150],
        ['1 HIGH ST', 300],
        ['2 LOW RD', 450],
      ),
      row(y + 24, ['J.DOE', 150], ['SYDNEY', 300], ['PERTH', 450]),
      ...charges.map(([label, amount], i) => row(y + 36 + 8 * i, [label, 300], [amount, 520])),
      row(y + 36 + 8 * charges.length, ['Total', 300], [total, 520]),
    ];
    const invoice = () =>
      doc([
        row(20, ['Account 123', 40]),
        ...block(
          60,
          'W0001',
          [
            ['Freight', '100.00'],
            ['Discount', '(20.00)'],
            ['Fuel', '8.00'],
          ],
          '88.00',
        ),
        ...block(
          160,
          'W0002',
          [
            ['Freight', '50.00'],
            ['Fuel', '4.00'],
            ['Remote area', '3.00'],
          ],
          '57.00',
        ),
        row(300, ['Amount due', 300], ['145.00', 520]),
      ]);
    const form = spec({
      identity: ['date shipped'],
      records: [{ x: 40, words: 0, text: 'date shipped' }],
      labels: [
        { name: 'Date shipped', label: 'date shipped', where: 'right', type: 'date' },
        { name: 'Waybill', label: 'waybill', where: 'right', type: 'text' },
        { name: 'Delivered', label: 'delivered', where: 'rightBlock', type: 'text' },
        { name: 'Consignor', label: 'consignor', where: 'below', type: 'text' },
        { name: 'Consignee', label: 'consignee', where: 'below', type: 'text' },
        { name: 'Freight', label: 'freight', where: 'right', type: 'amount' },
        { name: 'Discount', label: 'discount', where: 'right', type: 'amount' },
        { name: 'Fuel', label: 'fuel', where: 'right', type: 'amount' },
        { name: 'Total', label: 'total', where: 'right', type: 'amount' },
      ],
      otherAmounts: true,
      lines: [{ label: 'amount due', x: 300, role: 'end' }],
      checks: [
        { kind: 'record', total: 'Total', parts: ['Freight', 'Discount', 'Fuel', 'Other amounts'] },
        { kind: 'sum', cells: ['Total'], label: 'amount due' },
      ],
    });

    it('reads each block as one record — values right of, beside and under their labels, and charges it was not told of', () => {
      const read = readWithSpec(invoice(), form);

      expect(read.problem).toBeNull();
      const rows = read.records.map((r) =>
        Object.fromEntries(read.names.map((n, i) => [n, r.cells[i]])),
      );
      expect(rows[0]).toMatchObject({
        Waybill: 'W0001',
        Delivered: '03/03/2024 10:21 J.DOE',
        Consignor: 'ACME PTY 1 HIGH ST SYDNEY',
        Consignee: 'JANE DOE 2 LOW RD PERTH',
        Discount: '(20.00)',
        Total: '88.00',
        'Other amounts': '',
      });
      expect(rows[1]).toMatchObject({
        Discount: '',
        'Other amounts': '3.00',
        'Other amounts: description': 'Remote area',
      });
    });

    it('refuses an amount no cell reads when the spec does not collect other amounts', () => {
      const problem = readWithSpec(invoice(), { ...form, otherAmounts: false }).problem;
      expect(problem).toMatchObject({ check: 'unread_amount' });
      // Where it sits in the record, from both ends: a column's lines can be counted either way.
      expect(problem.evidence).toContain('It is line 7 of the record’s 8 (-2 from its end).');
    });
  });

  it('checks a total printed under its own column against that column, not the right-most amount', () => {
    const invoice = doc([
      row(100, ['Date', 20], ['Net', 400], ['GST', 460], ['Gross', 520]),
      row(120, ['01/02/24', 20], ['10.00', 400], ['1.00', 460], ['11.00', 520]),
      row(132, ['02/02/24', 20], ['20.00', 400], ['2.00', 460], ['22.00', 520]),
      row(160, ['Totals', 200], ['30.00', 400], ['3.00', 460], ['33.00', 520]),
    ]);
    const columns = spec({
      heading: ['date net gst gross'],
      records: [{ x: 20, words: 1, shape: 'd/d/d' }],
      columns: [
        { name: 'Date', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'date' },
        { name: 'Net', left: 390, right: 450, fromLine: 1, toLine: 1, type: 'amount' },
        { name: 'GST', left: 450, right: 510, fromLine: 1, toLine: 1, type: 'amount' },
        { name: 'Gross', left: 510, right: 570, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      lines: [{ label: 'totals', x: 200, role: 'end' }],
      checks: [
        { kind: 'sum', cells: ['Net'], label: 'totals' },
        { kind: 'sum', cells: ['GST'], label: 'totals' },
        { kind: 'sum', cells: ['Gross'], label: 'totals' },
      ],
    });

    expect(readWithSpec(invoice, columns).problem).toBeNull();
  });

  it('checks a count printed in a totals row under its own column', () => {
    const invoice = doc([
      row(100, ['Date', 20], ['Items', 300], ['Amount', 500]),
      row(120, ['01/02/24', 20], ['2', 300], ['10.00', 520]),
      row(132, ['02/02/24', 20], ['3', 300], ['20.00', 520]),
      row(160, ['Totals', 200], ['5', 300], ['30.00', 520]),
    ]);
    const counted = spec({
      heading: ['date items amount'],
      records: [{ x: 20, words: 1, shape: 'd/d/d' }],
      columns: [
        { name: 'Date', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'date' },
        { name: 'Items', left: 290, right: 350, fromLine: 1, toLine: 1, type: 'number' },
        { name: 'Amount', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      lines: [{ label: 'totals', x: 200, role: 'end' }],
      checks: [
        { kind: 'sum', cells: ['Items'], label: 'totals' },
        { kind: 'sum', cells: ['Amount'], label: 'totals' },
      ],
    });

    expect(readWithSpec(invoice, counted).problem).toBeNull();
  });

  it('keeps a page’s last record’s own lines, however alike they are page to page, and passes over its footer', () => {
    const page = (n: number) => [
      row(100, ['Date', 20], ['Reference', 80], ['Amount', 500]),
      row(120, [`0${n}/02/24`, 20], ['10.00', 520]),
      row(129, [`REF ${n}001`, 80]),
      row(140, [`0${n}/03/24`, 20], ['20.00', 520]),
      row(149, [`REF ${n}002`, 80]),
      row(300, [`Page ${n} of 2`, 500]),
    ];
    const invoice = doc(page(1), [...page(2), row(200, ['Total', 400], ['60.00', 520])]);
    const referenced = spec({
      heading: ['date reference amount'],
      records: [{ x: 20, words: 1, shape: 'd/d/d' }],
      columns: [
        { name: 'Date', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'date' },
        { name: 'Reference', left: 75, right: 450, fromLine: 2, toLine: 2, type: 'text' },
        { name: 'Amount', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      lines: [{ label: 'total', x: 400, role: 'end' }],
      checks: [{ kind: 'sum', cells: ['Amount'], label: 'total' }],
    });

    const read = readWithSpec(invoice, referenced);

    expect(read.problem).toBeNull();
    expect(read.records.map((r) => r.cells[1])).toEqual([
      'REF 1001',
      'REF 1002',
      'REF 2001',
      'REF 2002',
    ]);
  });

  it('adds up the amounts a label prints on each of a record’s lines', () => {
    const invoice = doc([
      row(100, ['Waybill', 40], ['W0001', 150], ['Freight', 300], ['50.00', 520]),
      row(108, ['Other charges', 300], ['Fuel surcharge', 380], ['6.50', 520]),
      row(116, ['Other charges', 300], ['Remote area', 380], ['3.50', 520]),
      row(124, ['Total', 300], ['60.00', 520]),
      row(150, ['Amount due', 300], ['60.00', 520]),
    ]);
    const other = spec({
      records: [{ x: 40, words: 0, text: 'waybill' }],
      labels: [
        { name: 'Waybill', label: 'waybill', where: 'right', type: 'text' },
        { name: 'Freight', label: 'freight', where: 'right', type: 'amount' },
        { name: 'Other charges', label: 'other charges', where: 'right', type: 'amounts' },
        { name: 'Total', label: 'total', where: 'right', type: 'amount' },
      ],
      columns: [{ name: 'Charge', left: 370, right: 450, fromLine: 2, toLine: null, type: 'text' }],
      lines: [{ label: 'amount due', x: 300, role: 'end' }],
      checks: [
        { kind: 'record', total: 'Total', parts: ['Freight', 'Other charges'] },
        { kind: 'sum', cells: ['Total'], label: 'amount due' },
      ],
    });

    const read = readWithSpec(invoice, other);

    expect(read.problem).toBeNull();
    expect(read.records[0].cells).toEqual([
      'Fuel surcharge Remote area',
      'W0001',
      '50.00',
      '10.00',
      '60.00',
    ]);
  });

  it('carries a record over a page break below the next page’s heading only, never its page header', () => {
    const heading = row(100, ['Date', 20], ['Note', 80], ['Amount', 500]);
    const invoice = doc(
      [
        heading,
        row(120, ['01/02/24', 20], ['10.00', 520]),
        row(140, ['02/02/24', 20], ['20.00', 520]),
      ],
      [
        row(40, ['Invoice amount', 300], ['60.00', 520]),
        heading,
        row(110, ['continued', 80]),
        row(120, ['03/02/24', 20], ['30.00', 520]),
        row(160, ['Total', 400], ['60.00', 520]),
      ],
    );
    const carried = spec({
      heading: ['date note amount'],
      records: [{ x: 20, words: 1, shape: 'd/d/d' }],
      columns: [
        { name: 'Date', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'date' },
        { name: 'Note', left: 75, right: 450, fromLine: 1, toLine: null, type: 'text' },
        { name: 'Amount', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      carryOver: true,
      lines: [{ label: 'total', x: 400, role: 'end' }],
      checks: [{ kind: 'sum', cells: ['Amount'], label: 'total' }],
    });

    const read = readWithSpec(invoice, carried);

    expect(read.problem).toBeNull();
    expect(read.records.map((r) => r.cells[1])).toEqual(['', 'continued', '']);
  });

  it('reads no value for a label printed right before another label', () => {
    const invoice = doc([
      row(100, ['Shipped', 40], ['01/03/24', 150]),
      row(108, ['Reference', 40], ['Freight', 300], ['80.00', 520]),
      row(116, ['Total', 300], ['80.00', 520]),
      row(140, ['Amount due', 300], ['80.00', 520]),
    ]);
    const labelled = spec({
      records: [{ x: 40, words: 0, text: 'shipped' }],
      labels: [
        { name: 'Shipped', label: 'shipped', where: 'right', type: 'date' },
        { name: 'Reference', label: 'reference', where: 'right', type: 'text' },
        { name: 'Freight', label: 'freight', where: 'right', type: 'amount' },
        { name: 'Total', label: 'total', where: 'right', type: 'amount' },
      ],
      lines: [{ label: 'amount due', x: 300, role: 'end' }],
      checks: [
        { kind: 'record', total: 'Total', parts: ['Freight'] },
        { kind: 'sum', cells: ['Total'], label: 'amount due' },
      ],
    });

    const read = readWithSpec(invoice, labelled);

    expect(read.problem).toBeNull();
    expect(read.records[0].cells).toEqual(['01/03/24', '', '80.00', '80.00']);
  });

  it('reads a rate and its amount printed after one label, named twice', () => {
    const invoice = doc([
      row(100, ['Job', 20], ['Charge', 500]),
      row(120, ['1001', 20], ['40.00', 520]),
      row(128, ['Fuel levy %', 80], ['12.50', 400], ['$5.00', 520]),
      row(150, ['Total', 400], ['45.00', 520]),
    ]);
    const rated = spec({
      heading: ['job charge'],
      records: [{ x: 20, words: 0, shape: 'd' }],
      columns: [
        { name: 'Job', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'text' },
        { name: 'Charge', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      labels: [
        { name: 'Fuel levy %', label: 'fuel levy %', where: 'right', type: 'number' },
        { name: 'Fuel levy % (2)', label: 'fuel levy %', where: 'right', type: 'amount' },
      ],
      lines: [{ label: 'total', x: 400, role: 'end' }],
      checks: [{ kind: 'sum', cells: ['Charge', 'Fuel levy % (2)'], label: 'total' }],
    });

    const read = readWithSpec(invoice, rated);

    expect(read.problem).toBeNull();
    expect(read.records[0].cells).toEqual(['1001', '40.00', '12.50', '$5.00']);
  });

  it('reads an amount printed into a text run where it falls under an amount column', () => {
    // The PDF merged the description and its amount into one text run.
    const invoice = doc([
      row(100, ['Job', 20], ['Description', 80], ['Charge', 500]),
      row(120, ['1001', 20], ['Freight', 80], ['40.00', 520]),
      row(128, ['Remote area 8.25', 80, 520]),
      row(150, ['Total', 400], ['48.25', 520]),
    ]);
    const fused = spec({
      heading: ['job description charge'],
      records: [{ x: 20, words: 0, shape: 'd' }],
      columns: [
        { name: 'Job', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'text' },
        { name: 'Description', left: 75, right: 450, fromLine: 1, toLine: null, type: 'text' },
        { name: 'Charge', left: 450, right: 560, fromLine: 1, toLine: null, type: 'amounts' },
      ],
      lines: [{ label: 'total', x: 400, role: 'end' }],
      checks: [{ kind: 'sum', cells: ['Charge'], label: 'total' }],
    });

    const read = readWithSpec(invoice, fused);

    expect(read.problem).toBeNull();
    expect(read.records[0].cells).toEqual(['1001', 'Freight Remote area', '48.25']);
  });

  it('reads lines counted from a record’s end: a total printed alone on its last line', () => {
    const invoice = doc([
      row(100, ['Job', 20], ['Charge', 500]),
      row(120, ['1001', 20], ['Freight', 80], ['40.00', 520]),
      row(128, ['Fuel', 80], ['4.00', 520]),
      row(136, ['44.00', 520]),
      row(150, ['1002', 20], ['Freight', 80], ['10.00', 520]),
      row(158, ['10.00', 520]),
      row(180, ['Total', 400], ['54.00', 520]),
    ]);
    const totalled = spec({
      heading: ['job charge'],
      records: [{ x: 20, words: 0, shape: 'd' }],
      columns: [
        { name: 'Job', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'text' },
        { name: 'Item', left: 75, right: 450, fromLine: 1, toLine: -2, type: 'text' },
        { name: 'Charge', left: 450, right: 560, fromLine: 1, toLine: -2, type: 'amounts' },
        { name: 'Record total', left: 450, right: 560, fromLine: -1, toLine: -1, type: 'amount' },
      ],
      lines: [{ label: 'total', x: 400, role: 'end' }],
      checks: [
        { kind: 'record', total: 'Record total', parts: ['Charge'] },
        { kind: 'sum', cells: ['Record total'], label: 'total' },
      ],
    });

    const read = readWithSpec(invoice, totalled);

    expect(read.problem).toBeNull();
    expect(read.records.map((r) => r.cells)).toEqual([
      ['1001', 'Freight Fuel', '44.00', '44.00'],
      ['1002', 'Freight', '10.00', '10.00'],
    ]);
  });

  it('adds up several amounts of one kind a record prints one per line', () => {
    const invoice = doc([
      row(100, ['Date', 20], ['Extras', 300], ['Freight', 520]),
      row(120, ['01/02/24', 20], ['10.00', 520]),
      row(128, ['Tail lift', 300], ['5.00', 450]),
      row(136, ['Waiting', 300], ['2.50', 450]),
      row(150, ['02/02/24', 20], ['20.00', 520]),
      row(170, ['Totals', 200], ['7.50', 450], ['30.00', 520]),
    ]);
    const extras = spec({
      heading: ['date extras freight'],
      records: [{ x: 20, words: 0, shape: 'd/d/d' }],
      columns: [
        { name: 'Date', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'date' },
        { name: 'Extras', left: 290, right: 440, fromLine: 2, toLine: null, type: 'text' },
        {
          name: 'Extras amount',
          left: 440,
          right: 500,
          fromLine: 2,
          toLine: null,
          type: 'amounts',
        },
        { name: 'Freight', left: 500, right: 570, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      lines: [{ label: 'totals', x: 200, role: 'end' }],
      checks: [
        { kind: 'sum', cells: ['Freight'], label: 'totals' },
        { kind: 'sum', cells: ['Extras amount'], label: 'totals' },
      ],
    });

    const read = readWithSpec(invoice, extras);

    expect(read.problem).toBeNull();
    expect(read.records.map((r) => r.cells)).toEqual([
      ['01/02/24', 'Tail lift Waiting', '7.50', '10.00'],
      ['02/02/24', '', '', '20.00'],
    ]);
  });

  it('refuses a record that prints no amount — a line the record start matched by mistake', () => {
    const invoice = doc([
      row(40, ['12 High Street', 20]),
      row(100, ['Job', 20], ['Charge', 500]),
      row(120, ['1001', 20], ['10.00', 520]),
      row(150, ['Total', 400], ['10.00', 520]),
    ]);
    const loose = spec({
      records: [{ x: 20, words: 1, shape: 'd' }],
      columns: [
        { name: 'Job', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'text' },
        { name: 'Charge', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      lines: [{ label: 'total', x: 400, role: 'end' }],
      checks: [{ kind: 'sum', cells: ['Charge'], label: 'total' }],
    });

    const problem = readWithSpec(invoice, loose).problem;
    expect(problem).toMatchObject({
      check: 'no_amount',
      evidence: 'The line it starts on: "12 High Street"', // for the model, never logged
      detail: { shape: 'd a a' },
    });
    expect(problem.message).not.toMatch(/high/i);
    expect(
      readWithSpec(invoice, { ...loose, records: [{ x: 20, words: 0, shape: 'd' }] }).problem,
    ).toBeNull();
  });

  it('carries a title line down onto the records under it', () => {
    const invoice = doc([
      row(100, ['Date', 20], ['Amount', 500]),
      row(110, ['SYDNEY - PERTH', 20]),
      row(120, ['01/02/24', 20], ['10.00', 520]),
      row(130, ['MELBOURNE - HOBART', 20]),
      row(140, ['02/02/24', 20], ['20.00', 520]),
      row(160, ['Total', 400], ['30.00', 520]),
    ]);
    const titled = spec({
      heading: ['date amount'],
      records: [{ x: 20, words: 1, shape: 'd/d/d' }],
      groups: [{ x: 20 }],
      columns: [
        { name: 'Date', left: 15, right: 75, fromLine: 1, toLine: 1, type: 'date' },
        { name: 'Amount', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      lines: [{ label: 'total', x: 400, role: 'end' }],
      checks: [{ kind: 'sum', cells: ['Amount'], label: 'total' }],
    });

    const read = readWithSpec(invoice, titled);

    expect(read.problem).toBeNull();
    expect(read.records.map((r) => r.cells)).toEqual([
      ['01/02/24', '10.00', 'SYDNEY - PERTH'],
      ['02/02/24', '20.00', 'MELBOURNE - HOBART'],
    ]);
  });

  describe('charge lines: each charge a record prints on its own line, as its own cell', () => {
    // A consignment described on its first line, then one line per charge — the charges each
    // record prints differ, and a name carries a rate that changes from invoice to invoice.
    const invoice = (subtotal = '216.94') =>
      doc([
        row(100, ['Description', 20], ['Amount', 500]),
        row(120, ['24-02-26 - CN001 - From A to B', 20]),
        row(132, ['Transport Charges', 20], ['114.60', 520]),
        row(144, ['Fuel Levy 22% / 6% Tolls', 20], ['32.09', 520]),
        row(160, ['25-02-26 - CN002 - From A to C', 20]),
        row(172, ['Transport Charges', 20], ['50.00', 520]),
        row(184, ['Remote Area', 20], ['8.25', 520]),
        row(196, ['Fuel Levy 22% / 6% Tolls', 20], ['12.00', 520]),
        row(220, ['Subtotal', 400], [subtotal, 520]),
      ]);
    const charged = spec({
      heading: ['description amount'],
      records: [{ x: 20, words: 1, shape: 'd-d-d' }],
      columns: [
        { name: 'Description', left: 15, right: 450, fromLine: 1, toLine: null, type: 'text' },
      ],
      charges: {
        nameLeft: 15,
        nameRight: 450,
        amountLeft: 450,
        amountRight: 560,
        fromLine: 1,
        toLine: null,
      },
      lines: [{ label: 'subtotal', x: 400, role: 'end' }],
      checks: [{ kind: 'sum', cells: ['Charges'], label: 'subtotal' }],
    });

    it('tells the model a figure printed on a charge line beside the charge is read by a column over those lines', () => {
      const withQuantity = invoice();
      withQuantity.pages[0].rows[2].fragments.splice(1, 0, {
        str: '1.00',
        x: 380,
        y: 132,
        width: 20,
        height: 8,
      });

      const { problem } = readWithSpec(withQuantity, {
        ...charged,
        columns: [{ ...charged.columns[0], toLine: 1 }],
        charges: { ...charged.charges, nameRight: 300, fromLine: 2 },
      });

      expect(problem).toMatchObject({ check: 'unread_amount' });
      expect(problem.evidence).toContain(
        'It is printed on a charge line, between the charge’s name and its amount: a figure each charge prints (a quantity, a rate) is read by a column over the charges’ lines at its place — or by the charges’ name range, when it is part of the name.',
      );
    });

    it('reads each charge as a cell named by its charge, on every record, and proves them all', () => {
      const read = readWithSpec(invoice(), charged);

      expect(read.problem).toBeNull();
      // `Charges` is the record's charges added — the sum the checks prove.
      expect(read.names).toEqual([
        'Description',
        'Charges',
        'Transport Charges',
        'Fuel Levy',
        'Remote Area',
      ]);
      expect(read.records.map((r) => r.cells)).toEqual([
        ['24-02-26 - CN001 - From A to B', '146.69', '114.60', '32.09', ''],
        ['25-02-26 - CN002 - From A to C', '70.25', '50.00', '12.00', '8.25'],
      ]);
    });

    it('refuses charges that do not add up to the printed total', () => {
      expect(readWithSpec(invoice('217.00'), charged).problem).toMatchObject({
        check: 'total',
        message:
          'Charges over the 2 records adds up to 216.94, but the invoice prints 217.00 beside "subtotal"',
      });
    });

    it('adds a charge printed twice in a record, and reads a charge whose amount is printed into its text', () => {
      const twice = invoice('226.94');
      twice.pages[0].rows.splice(3, 0, row(138, ['Transport Charges', 20], ['10.00', 520]));
      const merged = twice.pages[0].rows.find((r) => r.fragments[0].str === 'Remote Area');
      merged.fragments = [{ str: 'Remote Area 8.25', x: 300, y: merged.y, width: 240, height: 8 }];

      const read = readWithSpec(twice, charged);

      expect(read.problem).toBeNull();
      expect(read.records.map((r) => r.cells)).toEqual([
        ['24-02-26 - CN001 - From A to B', '156.69', '124.60', '32.09', ''],
        ['25-02-26 - CN002 - From A to C', '70.25', '50.00', '12.00', '8.25'],
      ]);
    });

    it('reads a record’s extra charges beside its own amounts, proven by the record’s total', () => {
      const withExtras = doc([
        row(
          100,
          ['Waybill', 20],
          ['Standard', 200],
          ['Extra Charges', 300],
          ['Amount', 420],
          ['Total', 520],
        ),
        row(
          120,
          ['1234567890', 20],
          ['50.00', 220],
          ['FUEL SURCHARGE', 300],
          ['12.34', 430],
          ['65.34', 520],
        ),
        row(132, ['DEMAND SURCHARGE', 300], ['3.00', 430]),
        row(
          150,
          ['2233445566', 20],
          ['40.00', 220],
          ['FUEL SURCHARGE', 300],
          ['9.87', 430],
          ['49.87', 520],
        ),
        row(170, ['Invoice total', 400], ['115.21', 520]),
      ]);
      const extras = spec({
        heading: ['waybill standard extra charges amount total'],
        records: [{ x: 20, words: 0, shape: 'd' }],
        columns: [
          { name: 'Waybill', left: 15, right: 150, fromLine: 1, toLine: 1, type: 'text' },
          { name: 'Standard', left: 200, right: 280, fromLine: 1, toLine: 1, type: 'amount' },
          { name: 'Total', left: 500, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
        ],
        charges: {
          nameLeft: 290,
          nameRight: 420,
          amountLeft: 420,
          amountRight: 480,
          fromLine: 1,
          toLine: null,
        },
        lines: [{ label: 'invoice total', x: 400, role: 'end' }],
        checks: [
          { kind: 'record', total: 'Total', parts: ['Standard', 'Charges'] },
          { kind: 'sum', cells: ['Total'], label: 'invoice total' },
        ],
      });

      const read = readWithSpec(withExtras, extras);

      expect(read.problem).toBeNull();
      expect(read.names).toEqual([
        'Waybill',
        'Standard',
        'Total',
        'Charges',
        'FUEL SURCHARGE',
        'DEMAND SURCHARGE',
      ]);
      expect(read.records.map((r) => r.cells)).toEqual([
        ['1234567890', '50.00', '65.34', '15.34', '12.34', '3.00'],
        ['2233445566', '40.00', '49.87', '9.87', '9.87', ''],
      ]);
      const wrong = JSON.parse(JSON.stringify(withExtras));
      wrong.pages[0].rows[2].fragments[1].str = '4.00';
      expect(readWithSpec(wrong, extras).problem).toMatchObject({ check: 'record_total' });
    });

    it('names a charge that shares a cell’s name apart from that cell', () => {
      const clash = invoice();
      clash.pages[0].rows[2].fragments[0].str = 'Description';

      expect(readWithSpec(clash, charged).names).toEqual([
        'Description',
        'Charges',
        'Description (charge)',
        'Fuel Levy',
        'Transport Charges',
        'Remote Area',
      ]);
    });
  });

  describe('amounts printed inside text', () => {
    const invoice = doc([
      row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
      row(120, ['J1234567', 20], ['TRACKED 48', 100], ['143.14', 520]),
      row(132, [
        '64 items: @ £2.11 each Total Cost Pre Surcharge £135.04, Surcharge of £8.10',
        100,
        360,
      ]),
      row(160, ['Total Net', 400], ['143.14', 520]),
    ]);
    const posted = spec({
      heading: ['docket service net'],
      records: [{ x: 20, words: 0, shape: 'ad' }],
      columns: [
        { name: 'Docket', left: 15, right: 95, fromLine: 1, toLine: 1, type: 'text' },
        { name: 'Service', left: 95, right: 450, fromLine: 1, toLine: null, type: 'text' },
        { name: 'Net', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
      ],
      lines: [{ label: 'total net', x: 400, role: 'end' }],
      checks: [{ kind: 'sum', cells: ['Net'], label: 'total net' }],
    });

    it('refuses a text cell holding an amount no label reads', () => {
      expect(readWithSpec(invoice, posted).problem).toMatchObject({
        check: 'amount_in_text',
        message: 'the text cell "Service" of record 1 (page 1) holds 3 amounts no cell reads',
        evidence: expect.stringContaining('3 kinds, in 1 record'),
      });
    });

    it('shows each kind of unread amount once, from every record, so one answer can read them all', () => {
      const kinds = doc([
        row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['64 items: @ £2.11 each', 100], ['135.04', 520]),
        row(140, ['J1234568', 20], ['64 items: @ £2.11 each', 100], ['135.04', 520]),
        row(160, ['J1234569', 20], ['Notification: 649 @ £0.00 each', 100], ['0.00', 520]),
        row(180, ['J1234570', 20], ['Return to Sender: 1 @ £1.98 each', 100], ['1.98', 520]),
        row(200, ['Total Net', 400], ['272.06', 520]),
      ]);

      const { evidence } = readWithSpec(kinds, posted).problem;

      expect(evidence).toContain('3 kinds, in 4 records');
      expect(evidence).toContain(
        'record 4 (page 1), "Service": "Return to Sender: 1 @ £1.98 each"',
      );
      expect(evidence).toContain('record 1 (page 1), "Service": "64 items: @ £2.11 each" — £2.11');
      expect(evidence).toContain(
        'record 3 (page 1), "Service": "Notification: 649 @ £0.00 each" — £0.00',
      );
      expect(evidence).not.toContain('record 2');
    });

    it('reads amounts inside text by their labels, and keeps the text as printed in its column', () => {
      const labelled = spec({
        ...posted,
        labels: [
          { name: 'items: @', label: 'items: @', where: 'inText', type: 'amount' },
          {
            name: 'Total Cost Pre Surcharge',
            label: 'total cost pre surcharge',
            where: 'inText',
            type: 'amount',
          },
          { name: 'Surcharge of', label: 'surcharge of', where: 'inText', type: 'amount' },
        ],
      });

      const read = readWithSpec(invoice, labelled);

      expect(read.problem).toBeNull();
      expect(read.records.map((r) => r.cells)).toEqual([
        [
          'J1234567',
          'TRACKED 48 64 items: @ £2.11 each Total Cost Pre Surcharge £135.04, Surcharge of £8.10',
          '143.14',
          '£2.11',
          '£135.04',
          '£8.10',
        ],
      ]);
    });

    it('reads an amount of four digits or more printed without a thousands comma whole', () => {
      const large = doc([
        row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['Total Cost Pre Surcharge £1369.39', 100], ['1,369.39', 520]),
        row(160, ['Total Net', 400], ['1,369.39', 520]),
      ]);
      const labelled = spec({
        ...posted,
        labels: [
          {
            name: 'Total Cost Pre Surcharge',
            label: 'total cost pre surcharge',
            where: 'inText',
            type: 'amount',
          },
        ],
      });

      const read = readWithSpec(large, labelled);

      expect(read.problem).toBeNull();
      expect(read.records[0].cells[3]).toBe('£1369.39');
    });

    it('reads an amount a wrapped text prints at the start of its next line', () => {
      const wrapped = doc([
        row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['Road freight DG $35.00 Extra Charge:', 100], ['145.70', 520]),
        row(132, ['$110.70 Futile', 100]),
        row(160, ['Total Net', 400], ['145.70', 520]),
      ]);
      const labelled = spec({
        ...posted,
        labels: [
          { name: 'DG', label: 'dg', where: 'inText', type: 'amount' },
          { name: 'Extra Charge:', label: 'extra charge:', where: 'inText', type: 'amount' },
        ],
      });

      const read = readWithSpec(wrapped, labelled);

      expect(read.problem).toBeNull();
      expect(read.records[0].cells.slice(3)).toEqual(['$35.00', '$110.70']);
    });

    it('reads a label whose words wrap onto the next line with its amount', () => {
      const wrapped = doc([
        row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['Road freight DG $35.00 Extra', 100], ['47.30', 520]),
        row(132, ['Charge: $12.30 PU', 100]),
        row(160, ['Total Net', 400], ['47.30', 520]),
      ]);
      const labelled = spec({
        ...posted,
        labels: [
          { name: 'DG', label: 'dg', where: 'inText', type: 'amount' },
          { name: 'Extra Charge:', label: 'extra charge:', where: 'inText', type: 'amount' },
        ],
      });

      const read = readWithSpec(wrapped, labelled);

      expect(read.problem).toBeNull();
      expect(read.records[0].cells.slice(3)).toEqual(['$35.00', '$12.30']);
    });

    it('never reads a number printed after other words than the label', () => {
      const worded = doc([
        row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['Extra Charge: waived, Tolls $12.30', 100], ['12.30', 520]),
        row(160, ['Total Net', 400], ['12.30', 520]),
      ]);
      const labelled = spec({
        ...posted,
        labels: [
          { name: 'Extra Charge:', label: 'extra charge:', where: 'inText', type: 'amount' },
        ],
      });

      expect(readWithSpec(worded, labelled).problem).toMatchObject({ check: 'amount_in_text' });
    });

    it('reads label words starting with a sign right after a number', () => {
      const signed = doc([
        row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['Weight 12, Surcharge of £8.10', 100], ['8.10', 520]),
        row(160, ['Total Net', 400], ['8.10', 520]),
      ]);
      const labelled = spec({
        ...posted,
        labels: [
          { name: ', Surcharge of', label: ', surcharge of', where: 'inText', type: 'amount' },
        ],
      });

      const read = readWithSpec(signed, labelled);

      expect(read.problem).toBeNull();
      expect(read.records[0].cells[3]).toBe('£8.10');
    });

    it('keeps a column of rates as printed: prices per unit charge nothing by themselves', () => {
      const rated = doc([
        row(100, ['Docket', 20], ['Rate', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['£5.80 each', 100], ['72.40', 520]),
        row(132, ['£6.10 each', 100]),
        row(160, ['Total Net', 400], ['72.40', 520]),
      ]);
      const rates = spec({
        ...posted,
        heading: ['docket rate net'],
        columns: [
          { name: 'Docket', left: 15, right: 95, fromLine: 1, toLine: 1, type: 'text' },
          { name: 'Rate', left: 95, right: 450, fromLine: 1, toLine: null, type: 'rates' },
          { name: 'Net', left: 450, right: 560, fromLine: 1, toLine: 1, type: 'amount' },
        ],
      });

      const read = readWithSpec(rated, rates);

      expect(read.problem).toBeNull();
      expect(read.records[0].cells).toEqual(['J1234567', '£5.80 each £6.10 each', '72.40']);
    });

    it('matches a count printed inside a label whatever its number of digits', () => {
      const counted = doc([
        row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['Notification: 649 @ £0.10 each', 100], ['64.90', 520]),
        row(160, ['Total Net', 400], ['64.90', 520]),
      ]);
      const labelled = spec({
        ...posted,
        labels: [
          { name: 'Notification', label: 'notification: # @', where: 'inText', type: 'amount' },
        ],
      });

      const read = readWithSpec(counted, labelled);

      expect(read.problem).toBeNull();
      expect(read.records[0].cells[3]).toBe('£0.10');
    });

    it('matches a label only at the start of a word, so a short one never reads inside another word', () => {
      const place = doc([
        row(100, ['Docket', 20], ['Service', 100], ['Net', 520]),
        row(120, ['J1234567', 20], ['To Cambridge 3 units DG $35.00', 100], ['35.00', 520]),
        row(160, ['Total Net', 400], ['35.00', 520]),
      ]);
      const labelled = spec({
        ...posted,
        labels: [{ name: 'DG', label: 'dg', where: 'inText', type: 'amount' }],
      });

      const read = readWithSpec(place, labelled);

      expect(read.problem).toBeNull();
      expect(read.records[0].cells[3]).toBe('$35.00');
    });
  });
});
