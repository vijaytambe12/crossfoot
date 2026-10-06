# How it works

This page follows one document, `examples/freight-invoice.pdf`, through every step. It is a
two-page invoice of 29 consignments with a carried-forward figure, a subtotal, GST and a total.

- [The idea](#the-idea)
- [1. Text with positions](#1-text-with-positions)
- [2. The question](#2-the-question)
- [3. The answer](#3-the-answer)
- [4. From answer to reading spec](#4-from-answer-to-reading-spec)
- [5. Reading](#5-reading)
- [6. The proof](#6-the-proof)
- [7. Repair](#7-repair)
- [8. Saving and replay](#8-saving-and-replay)
- [Why the split matters](#why-the-split-matters)

## The idea

Extracting a document with a language model usually means asking the model for the values. The
model reads `4,578.16` and types `4578.16` into its answer. Most of the time it types the right
thing. When it does not, the answer looks exactly the same.

crossfoot never asks for a value. It asks **how the document is laid out**, and gives the model a
way to answer that cannot express a value at all. Reading is then done by code, and the document's
own arithmetic decides whether the layout was understood.

## 1. Text with positions

`extractGeometry` reads the PDF's text layer with pdf.js. Each run of text becomes a **fragment**
with its position in points, measured from the top-left of the page. Fragments on one visual line
form a **row**.

```ts
{ str: 'Subtotal', x: 420, y: 364, width: 33, height: 9 }
```

This structure, `DocumentGeometry`, is the only input the rest of the pipeline needs. A scan has
no text layer, so its geometry comes from OCR instead ([ocr.md](ocr.md)).

## 2. The question

`specQuestion` prints the geometry as numbered fragments. Run this to see it:

```bash
node dist/cli.js examples/freight-invoice.pdf --question
```

```
Pages: 2. Each line: its page, y (top to bottom), then its texts — [n] x=left edge w=width "text".

Page 1 of 2 (width 595):
p1 y=60: [1] x=40 w=174 "NORTHWIND FREIGHT"  [2] x=400 w=77 "TAX INVOICE"
...
p1 y=170: [8] x=40 w=20 "Date"  [9] x=108 w=40 "Con Note"  [10] x=175 w=38 "Receiver"  [11] x=300 w=32 "Service"  [12] x=382 w=12 "Kg"  [13] x=419 w=31 "Freight"  [14] x=469 w=42 "Fuel Levy"  [15] x=537 w=22 "Total"
p1 y=190: [16] x=40 w=45 "03/08/2026"  [17] x=108 w=52 "NF10045800"  [18] x=175 w=70 "Acme Trading Co"  [19] x=300 w=33 "Express"  [20] x=382 w=13 "4.0"  [21] x=427 w=23 "18.50"  [22] x=492 w=18 "2.22"  [23] x=537 w=23 "20.72"
p1 y=201: [24] x=175 w=79 "Port Melbourne VIC"
...
p2 y=364: [292] x=420 w=33 "Subtotal"  [293] x=525 w=35 "4,578.16"
p2 y=377: [294] x=420 w=39 "GST 10%"  [295] x=532 w=28 "457.82"
p2 y=390: [296] x=420 w=43 "Total AUD"  [297] x=525 w=35 "5,035.98"
```

The model is not shown the whole of a long document. It sees, in full, the first two pages that
print amounts and the last one. From the pages between, it sees only lines that start differently
from anything already shown, with the two lines under each. A hundred-page invoice of one kind of
line costs about the same to describe as a three-page one.

The system prompt (`SYSTEM_PROMPT`, the file `src/prompt.md`) explains the vocabulary of the
answer. It is the same on every call.

## 3. The answer

The model must answer through one tool, `pdf_reading_spec` (`READING_SPEC_TOOL`). Look at what
the schema allows:

| Kind of field | Examples | What it can hold |
|---|---|---|
| Pointers | `example`, `label`, `heading`, `carried` | The number of a fragment that was shown |
| Positions | `left`, `right`, `nameLeft`, `amountRight` | An x coordinate |
| Line ranges | `fromLine`, `toLine` | Which of a record's lines to read |
| Fixed words | `type`, `where`, `role`, `kind`, `identify` | One of a short list |
| Cell names | `cells`, `total`, `parts`, `name` | The name of a cell |

There is no place to put `4,578.16`. The one free-text field, `name`, is only for a column that
has no printed heading.

This is the answer for the freight invoice. It is the content of `freightAnswer` in
[`examples/answers.mjs`](../examples/answers.mjs), with the fragment numbers filled in:

```json
{
  "heading": [8, 9, 10, 11, 12, 13, 14, 15],
  "records": [{ "example": 16, "identify": "whole_text" }],
  "groups": [],
  "columns": [
    { "heading": [8],  "left": 35,  "right": 100, "fromLine": 1, "toLine": 1,    "type": "date" },
    { "heading": [9],  "left": 100, "right": 170, "fromLine": 1, "toLine": 1,    "type": "text" },
    { "heading": [10], "left": 170, "right": 295, "fromLine": 1, "toLine": null, "type": "text" },
    { "heading": [11], "left": 295, "right": 365, "fromLine": 1, "toLine": 1,    "type": "text" },
    { "heading": [12], "left": 365, "right": 405, "fromLine": 1, "toLine": 1,    "type": "number" },
    { "heading": [13], "left": 405, "right": 460, "fromLine": 1, "toLine": 1,    "type": "amount" },
    { "heading": [14], "left": 460, "right": 520, "fromLine": 1, "toLine": 1,    "type": "amount" },
    { "heading": [15], "left": 520, "right": 570, "fromLine": 1, "toLine": 1,    "type": "amount" }
  ],
  "labels": [],
  "charges": null,
  "otherAmounts": false,
  "carryOver": false,
  "lines": [
    { "example": 196, "role": "end" },
    { "example": 292, "role": "end" },
    { "example": 294, "role": "tax" }
  ],
  "checks": [
    { "kind": "record", "total": "Total", "parts": ["Freight", "Fuel Levy"] },
    { "kind": "carry", "cells": ["Total"], "carried": 196, "brought": 209 },
    { "kind": "sum", "cells": ["Total"], "label": 292 },
    { "kind": "sum", "cells": ["Total", "Invoice charge amount"], "label": 296 }
  ]
}
```

Read in plain words:

- A record starts on a line whose first text is a date and nothing else (fragment 16 is the
  example; `whole_text` means the shape of the whole text, here `d/d/d`).
- The receiver's column is read to the record's last line (`toLine: null`), because the suburb is
  printed on a second line.
- "Carried forward" (196) and "Subtotal" (292) are where the records stop on their pages.
- "GST 10%" (294) is a tax charged once for the whole invoice. It becomes a row of its own.
- Four things must hold: each consignment's freight and fuel levy add up to its total; the
  carried-forward figure equals the totals so far; all totals add up to the subtotal; and totals
  plus GST add up to the invoice total.

## 4. From answer to reading spec

`specFromAnswer` checks every pointer against the page before anything is read. Some of the
answers it refuses:

- a pointer at a fragment that was not shown
- a record `example` that is not the first text of its line
- a column whose heading is printed outside the column's x range
- a heading fragment that names no column, because a column left out would lose its text while
  every total still held
- a total's `label` that points at a number instead of the words beside it
- a check that adds up a text cell

A refusal here is cheap. It names the pointer and the reason, and the model answers again.

If the answer passes, it becomes a `ReadingSpec`. Pointers are replaced by what they pointed at:
positions, and text that is lower-cased with digits masked as `#`. `"GST 10%"` is stored as
`gst ##%`, so the spec also matches next month's `GST 15%`. The result is in
[`examples/specs/`](../examples/specs).

A spec describes the **layout**. It holds no value from the invoice it was written on.

## 5. Reading

`readWithSpec(geometry, spec)` walks every page, top to bottom:

1. **Page furniture is set aside.** Heading rows that repeat on each page, and headers and footers
   that print the same text at the same height on at least half the pages.
2. **Records are found.** A record runs from a line that matches a record start to the next such
   line, an `end` line, or the foot of the page.
3. **Cells are read**, in a fixed order: labels first, then charge lines, then columns. A fragment
   belongs to the column its left edge falls in.
4. **Lines that are not records are handled by role**: passed over, or read as invoice-level rows.

Every value is copied from a fragment. The only arithmetic the reader does is adding up charge
lines within a record, and that sum must be named in a check.

## 6. The proof

Reading produces rows whether or not the spec was right. The proof decides. It is described in
full in [proof.md](proof.md); the short version is that every printed amount must be accounted
for, and every check must hold to the cent.

For this invoice: 29 records, each with freight + fuel levy = total; 3,288.43 carried forward
after page 1; 4,578.16 as the subtotal; 4,578.16 + 457.82 = 5,035.98 as the invoice total.

If all of that holds, `reading.problem` is `null`.

## 7. Repair

If the proof fails on a spec that was just written, the model is asked again. The repair prompt
is the original question, the model's previous answer, and exactly what failed, with the printed
lines behind it numbered so the next answer can point at them:

```
It was refused: 1 line(s) after the last record print amounts and are no known line,
the first on page 2: "gst ##%".
The lines as printed:
- p2: GST 10% 457.82
Every line printing an amount between the records and the invoice's own total is one of: ...
Answer again, fixing that.
```

Evidence matters more than the verdict. When a total does not hold, the model is shown which
lines printing amounts no record read, which records are negative, and which of the cells add up
to an amount the invoice prints somewhere. That is usually enough to see the mistake.

By default there are three repairs after the first answer. If none is proven, the loop starts
once more from a fresh first answer, because a chain of repairs can circle. That is at most eight
model calls (`repairs` and `attempts` in the options).

If the rounds run out, the last spec that read the layout is kept and returned with
`proven: false`. If no answer read the layout at all, `read` throws.

## 8. Saving and replay

The spec is saved in the store under the hash of its content.

When the next document arrives, `reader.read` tries the saved specs, newest first. A spec is
tried only if:

- it was written for the current vocabulary (`version`),
- the document has a page of the spec's width, within 2 points, and
- the document prints the spec's **identity**: its heading rows, or for a form with no heading,
  the exact texts its records start with.

Then the proof runs. The first spec the document proves is used. If a spec reads the layout but
some check fails, the rows are returned with that problem and no model is called. If no saved
spec fits, the model writes a new one.

`reader.write(document)` skips the saved specs and writes the layout again. Use it when a
supplier changes their invoice.

## Why the split matters

**The model cannot invent a number.** Its vocabulary has no way to say one. A hallucinated value
is not a risk to be measured and managed; it is not expressible.

**A wrong layout is caught by arithmetic, not by review.** Miss a kind of record, skip a column,
or count a subtotal as a charge, and the rows stop adding up to what the invoice prints.

**The cost is per layout, not per document.** A business that receives ten thousand invoices a
month from two hundred suppliers pays for a few hundred spec-writing calls, once.
