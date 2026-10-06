// What a model answers when it is shown each example document.
//
// These are written by hand so the examples and the tests run with no API key — but they are exactly
// the shape a model returns through the `pdf_reading_spec` tool. Note what is in them: fragment
// numbers (`at('Subtotal')` is the number of the fragment printing "Subtotal"), x positions, and
// cell names. There is no amount, no date and no consignment number anywhere: the answer cannot
// carry a value, only say where values are printed.

/** The freight invoice: a table. One record per consignment, starting at the date. */
export const freightAnswer = (at) => ({
  heading: ['Date', 'Con Note', 'Receiver', 'Service', 'Kg', 'Freight', 'Fuel Levy', 'Total'].map(at),
  // A record starts where a line's first text is a date and nothing else.
  records: [{ example: at('03/08/2026'), identify: 'whole_text' }],
  groups: [],
  columns: [
    { heading: [at('Date')], left: 35, right: 100, fromLine: 1, toLine: 1, type: 'date' },
    { heading: [at('Con Note')], left: 100, right: 170, fromLine: 1, toLine: 1, type: 'text' },
    // The receiver's suburb is printed on the record's second line: read to its last line.
    { heading: [at('Receiver')], left: 170, right: 295, fromLine: 1, toLine: null, type: 'text' },
    { heading: [at('Service')], left: 295, right: 365, fromLine: 1, toLine: 1, type: 'text' },
    { heading: [at('Kg')], left: 365, right: 405, fromLine: 1, toLine: 1, type: 'number' },
    { heading: [at('Freight')], left: 405, right: 460, fromLine: 1, toLine: 1, type: 'amount' },
    { heading: [at('Fuel Levy')], left: 460, right: 520, fromLine: 1, toLine: 1, type: 'amount' },
    { heading: [at('Total')], left: 520, right: 570, fromLine: 1, toLine: 1, type: 'amount' },
  ],
  labels: [],
  charges: null,
  otherAmounts: false,
  carryOver: false,
  lines: [
    { example: at('Carried forward'), role: 'end' },
    { example: at('Subtotal'), role: 'end' },
    // GST is charged once for the whole invoice: it becomes a row of its own.
    { example: at('GST 10%'), role: 'tax' },
  ],
  checks: [
    { kind: 'record', total: 'Total', parts: ['Freight', 'Fuel Levy'] },
    { kind: 'carry', cells: ['Total'], carried: at('Carried forward'), brought: at('Brought forward') },
    { kind: 'sum', cells: ['Total'], label: at('Subtotal') },
    { kind: 'sum', cells: ['Total', 'Invoice charge amount'], label: at('Total AUD') },
  ],
});

/** The courier statement: no table. One record per job, a block of labelled lines. */
export const courierAnswer = (at) => ({
  heading: [],
  records: [{ example: at('Job No:'), identify: 'exact_text' }],
  groups: [],
  columns: [],
  labels: [
    { label: at('Job No:'), where: 'right', type: 'text' },
    { label: at('Date:'), where: 'right', type: 'date' },
    // A name with its address on the line below: the label's value and the block under it.
    { label: at('Pickup:'), where: 'rightBlock', type: 'text' },
    { label: at('Delivery:'), where: 'rightBlock', type: 'text' },
    { label: at('Job total'), where: 'right', type: 'amount' },
  ],
  // Each job lists its charges one per line; every charge name becomes a cell of its own.
  charges: { nameLeft: 55, nameRight: 260, amountLeft: 260, amountRight: 305, fromLine: 1, toLine: null },
  otherAmounts: false,
  carryOver: false,
  lines: [{ example: at('Total due'), role: 'end' }],
  checks: [
    { kind: 'record', total: 'Job total', parts: ['Charges'] },
    { kind: 'sum', cells: ['Job total'], label: at('Total due') },
  ],
});

/** Turns an answer above into a `Model`: it finds each fragment's number in the prompt it is shown. */
export const scripted = (answer) => async ({ prompt }) =>
  answer((text) => {
    const found = prompt.match(new RegExp(`\\[(\\d+)\\] x=\\d+ w=\\d+ ${JSON.stringify(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:  |\\n|$)`));
    if (!found) throw new Error(`"${text}" is not shown`);
    return Number(found[1]);
  });
