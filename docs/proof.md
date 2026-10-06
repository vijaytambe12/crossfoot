# The proof

A read is **proven** when the document's own printed figures confirm it. This page lists what is
checked, every way a read can fail, and what the proof does not cover.

- [What is checked](#what-is-checked)
- [The three kinds of check](#the-three-kinds-of-check)
- [Failure codes](#failure-codes)
- [Reading a problem](#reading-a-problem)
- [To the cent](#to-the-cent)
- [What the proof does not cover](#what-the-proof-does-not-cover)

## What is checked

**Every amount is accounted for.**

- A line that prints an amount, after the first record on its page, must belong to a record or be
  a line the spec names.
- An amount printed inside a record must be read by one of the record's cells.
- An amount written inside a sentence (`Surcharge of £24.74`) must be read too.
- Lines between the last record and the invoice's own total must each be named: a checked total,
  an invoice-level charge or tax, or a line to pass over.

**Every cell is what it claims.**

- An `amount` or `number` cell holds exactly one number.
- Every text on a record's first line is read by some cell.
- A record must print an amount. One that prints none is text that was mistaken for a record,
  such as an address line that starts with a number.

**The totals agree.**

- Every check in the spec holds.
- Every record that prints an amount is counted by at least one printed total.

**Nothing is quietly excused.**

- A line that looks like a record and prints a positive amount can never be passed over, even if
  one printed subtotal happens to leave it out.
- A line passed over as "not a charge" is refused if the invoice's own total turns out to include
  it.

## The three kinds of check

A spec carries checks. Each compares something the reader added up with something the document
prints.

| Kind | What must be equal |
|---|---|
| `sum` | Named cells added over all records, and the amount printed beside a label (`Subtotal`, `Total AUD`) |
| `record` | Within each record, its parts added together, and its own printed total |
| `carry` | Named cells added over the records so far, and each page's "carried forward" figure; the next page's "brought forward" figure must repeat it |

A `sum` can count only charges (records of zero or more) or only credits, for invoices that total
them apart. It can add several printed totals together, for an invoice that prints its total in
parts.

More checks catch more mistakes. The example freight invoice has four.

## Failure codes

`result.problem.check` is one of these.

| Code | What happened | Usual cause |
|---|---|---|
| `no_records` | No line starts a record | The record start does not match this document |
| `unknown_line` | A line prints an amount, is in no record and is not named | A kind of record the spec does not know, or an unnamed total or fee |
| `unread_amount` | A record prints an amount that no cell reads | A column or charge is missing from the spec |
| `unread_text` | Text on a record's first line that no cell reads | A column was left out |
| `amount_in_text` | A text cell contains a money amount that no cell reads | An amount written inside a description |
| `no_amount` | A record prints no amount | The record start matched a line that is not a record |
| `hidden_charge` | A line printed like a record, with a positive amount, is being passed over | A real charge was marked as a line to skip |
| `label` | A label appears several times in one record beside different values | The label is not unique within a record |
| `cell` | An amount or number cell does not hold one number | A column's edges take in a neighbour's text |
| `total` | Records do not add up to a printed total, or the total cannot be found | A missed record, a double-counted line, the wrong total chosen, **or a real error on the invoice** |
| `record_total` | A record's parts do not add up to its own total | A misread cell, **or a real error on the invoice** |
| `carry` | A carried-forward figure disagrees with the records so far | A record missed on that page |
| `uncovered` | A record prints an amount that no printed total counts | No check covers that kind of record |

While a spec is being written, a refusal can also have the code `answer`: the model's answer was
malformed or pointed at something that is not on the page. You see it in `onRefusal`, never in a
result.

## Reading a problem

```ts
interface SpecProblem {
  check: SpecProblemCheck;          // a code from the table above
  message: string;                  // safe to log
  detail?: Record<string, unknown>; // safe to log
  evidence?: string;                // quotes the document
}
```

`message` and `detail` are built only from labels with their digits masked, cell names, counts
and sums. They contain no line of the document, so they can go to logs and dashboards.

`evidence` is what was shown to the model for a repair. It quotes printed lines. Treat it like the
document itself.

### A failed proof is not always a wrong read

A proof fails for one of two reasons:

1. **The spec misreads the layout.** Common for a new spec, and what the repair loop is for.
2. **The invoice is wrong.** It was misprinted, or its own arithmetic does not hold.

With a saved spec that has proven many earlier invoices, the second is the likely one. The
misprint example shows it:

```
record 7 (page 1): Freight + Fuel Levy adds up to 271.68, but its Total is 261.68
```

The read is correct. The invoice contradicts itself, and you have just been told where.

## To the cent

Amounts are held as whole ten-thousandths, so a figure printed finer than cents (`2.8331`) is
kept exactly. Two sums agree when they are equal after rounding to the cent.

This is not a loosened check. An invoice that prints per-unit figures to four decimals usually
prints its total rounded to cents, so its own lines land a fraction of a cent from its own total.
A charge that is actually missing is at least one cent. And the checks add up the whole document,
so an error repeated on every record passes one cent and fails.

## What the proof does not cover

**Text is not proven.** Totals confirm amounts. They say nothing about a name, a reference or a
date. Those cells are read from the place the spec points at. Two rules protect them: every
heading fragment must name a column, and every text on a record's first line must be read by some
cell. That makes it hard to drop a column or shift one without failing. It does not make a text
cell proven.

**A number that no check adds up is not proven.** A weight or quantity column is read like any
other cell, and the cell must hold one number, but unless a check names it, nothing confirms it.

**A document with no money has nothing to prove.** A packing list or manifest can be read, and
`proven` will be `true`, but that only means the structural rules held. There were no totals to
check.

**Two errors can cancel.** If a document prints one total and no other figure to check against, a
missed charge and a double-counted one of the same amount would balance. The rules that every
amount-printing line must be accounted for exist to close this, and documents with several checks
close it further. It is narrow, but it is not zero.

**OCR errors that keep the arithmetic.** If OCR misreads a digit, the totals will almost always
fail. A misread letter in a text cell will not be noticed.
