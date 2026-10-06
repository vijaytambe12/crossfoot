# Reading spec reference

A reading spec is a JSON object that says how to read one layout. A model normally writes it, but
it is plain data: you can read it, diff it, edit it and write one by hand.

Two complete specs ship in [`examples/specs/`](../examples/specs).

- [The model: records and cells](#the-model-records-and-cells)
- [How text is matched](#how-text-is-matched)
- [Fields](#fields)
  - [`records`](#records) · [`columns`](#columns) · [`labels`](#labels) · [`charges`](#charges)
  - [`lines`](#lines) · [`checks`](#checks) · [`groups`](#groups) · [the rest](#the-rest)
- [Cell names and their order](#cell-names-and-their-order)
- [Versions](#versions)

## The model: records and cells

A document is a sequence of **records**, one per charged item: a consignment, a job, a line of
goods, a fee. A table prints a record on one line or a few. A form prints each record as a block
of labelled lines. To the reader these are the same thing.

Each record becomes one row. Its **cells** are found in three ways:

- by position, in **columns**
- by what they are printed beside, with **labels**
- by their own printed name, as **charges** listed one per line

Everything else on the page that prints an amount is a **line** with a role: a total, a payment,
or a charge made once for the whole invoice.

## How text is matched

Positions are in points from the top-left of the page. A printed position may sit up to 3 points
from the spec's.

Text in a spec is **normalised**: lower-cased, whitespace collapsed, and every digit replaced by
`#`. So `Fuel levy 18.25%` is stored as `fuel levy ##.##%` and matches any other rate.

A **shape** describes text by kind rather than content. Runs of letters become `a`, runs of
digits become `d`, and everything else stays:

| Printed | Shape |
|---|---|
| `24/08/26` | `d/d/d` |
| `ABC000012345` | `ad` |
| `Transport Charges` | `a a` |

## Fields

```ts
interface ReadingSpec {
  version: 4;
  pageWidth: number;
  heading: string[];
  identity: string[];
  records: RecordStart[];
  groups: { x: number }[];
  columns: SpecColumn[];
  labels: SpecLabel[];
  charges?: SpecCharges | null;
  otherAmounts: boolean;
  carryOver: boolean;
  lines: SpecLine[];
  checks: SpecCheck[];
}
```

### `records`

How a record starts. One entry per kind of first text.

```ts
interface RecordStart {
  x: number;       // where the first text of the line is printed
  words: number;   // how many leading words the shape covers; 0 means the whole text
  shape?: string;  // match by shape ...
  text?: string;   // ... or by exact normalised text
}
```

```json
{ "x": 40, "words": 0, "shape": "d/d/d" }
{ "x": 40, "words": 0, "text": "job no:" }
```

A line starts a record when its **first** fragment is at `x` and matches. The record runs to the
next start, an `end` line, a group title, or the foot of the page.

Use the narrowest match that still catches every record. `words: 0` with a shape means the whole
first text must have that shape, so an address line beginning `12 High Street` cannot pass for a
record that starts with a number.

### `columns`

Text printed between two x positions.

```ts
interface SpecColumn {
  name: string;
  left: number;
  right: number;
  fromLine: number;        // 1 is the record's first line; -1 is its last
  toLine: number | null;   // null reads to the record's last line
  type: 'text' | 'date' | 'amount' | 'number' | 'amounts' | 'rates';
}
```

```json
{ "name": "Receiver", "left": 170, "right": 295, "fromLine": 1, "toLine": null, "type": "text" }
```

A fragment goes to the column its **left edge** falls in. Columns may overlap in x when they read
different lines, which is how a stacked heading is handled.

Types:

| Type | Holds |
|---|---|
| `text` | Anything, including numbers printed with words (`14.3 kg`) |
| `date` | A date, kept as printed |
| `amount` | Money. Exactly one amount per record |
| `number` | A count, weight or quantity printed as a bare number |
| `rates` | Prices per unit (`£5.80 each`). Money-shaped, but they charge nothing and are never checked |
| `amounts` | A second figure printed on every charge line, added up. Only valid beside `charges`, and must be named in a check |

Negative line numbers handle records of varying length whose last line is special: a column with
`fromLine: -1, toLine: -1` reads only the last line.

### `labels`

A value found by the label printed with it.

```ts
interface SpecLabel {
  name: string;
  label: string;   // normalised text of the label
  where: 'right' | 'rightBlock' | 'below' | 'inText';
  type: CellType;
}
```

| `where` | Reads |
|---|---|
| `right` | The text right after the label on its line. For an `amount`, the right-most amount on the line. For a `number`, the first number after the label |
| `rightBlock` | That, plus the lines below it that start at the same x. A name with its address underneath |
| `below` | The lines under the label that start at its left edge |
| `inText` | The number that follows the label's words *inside one piece of text*: `Levy of $3.10` |

```json
{ "name": "Pickup:", "label": "pickup:", "where": "rightBlock", "type": "text" }
```

Longer labels are matched first, so `Surcharge of` never takes the amount that belongs to
`Green Surcharge of`. A label must print one value per record.

### `charges`

For records that list their charges one per line, each beside its own name:

```
Base charge                 42.00
Fuel surcharge 12%           5.04
Waiting time                15.00
```

```ts
interface SpecCharges {
  nameLeft: number;   nameRight: number;     // where the names are printed
  amountLeft: number; amountRight: number;   // where the amounts are printed
  fromLine: number;   toLine: number | null; // as for a column
}
```

Every line with an amount in the amount range is one charge. **Each charge name becomes its own
cell.** The name is the words before any figure or bracket, so `Fuel surcharge 12%` is the cell
`Fuel surcharge` and stays the same cell when the rate changes.

A record that does not print a charge leaves that cell empty. Charges are found by name, so a
charge that appears on only one invoice does not move the others.

The reader also adds a record's charges into a cell called `Charges`. Because that sum is made by
the reader and not printed, **a check must name `Charges`**: against the record's own total, or
against a document total.

### `lines`

Lines that print amounts and are not records.

```ts
interface SpecLine {
  label: string;   // normalised text that marks the line
  x: number;       // where that text is printed
  role: 'end' | 'skip' | 'charge' | 'tax';
}
```

| Role | Meaning |
|---|---|
| `end` | The records stop here on this page: where totals begin, or an amount carried forward |
| `skip` | Passed over wherever it appears: a subtotal inside the table, a payment received, a balance |
| `charge` | A charge made once for the whole invoice: an account fee, a fuel levy on the total |
| `tax` | A tax made once for the whole invoice: GST, VAT |

Lines are recognised before records, by text at a position. A payment that is printed exactly
like a record is still passed over, because the text that says what it is is checked first.

A `charge` or `tax` line is read as a **row of its own**, in four cells the reader names:

| Cell | Holds |
|---|---|
| `Invoice charge` | The line's words |
| `Invoice charge amount` | Its right-most amount |
| `Invoice charge type` | `charge` or `tax` |
| `Invoice charge proven` | `yes` when a checked total adds `Invoice charge amount` |

On those rows the records' cells are empty, and on record rows these four are empty.

Two rules to remember. A line that only restates what the records already carry, such as a fuel
levy total that is the records' own levies added up, is never a `charge`: that would count the
money twice. And a line printed like a record with a positive amount can never be `skip` or `end`.

### `checks`

What proves the read. See [proof.md](proof.md) for how they are evaluated.

```ts
type SpecCheck =
  | { kind: 'sum'; cells: string[]; label: string;
      records?: 'charges' | 'credits';
      amount?: { x: number; right: number };
      plus?: string[] }
  | { kind: 'record'; total: string; parts: string[] }
  | { kind: 'carry'; cells: string[]; carried: string; brought: string | null };
```

**`sum`**: the named cells, added over every record, equal the amount printed beside `label`.

- `records: 'charges'` counts only records that add up to zero or more; `'credits'` only those
  below zero. For invoices that total their credits apart.
- `amount` says where on the label's line the total is, when that line prints several numbers.
- `plus` lists further labels whose amounts are added to the printed total, for an invoice that
  prints its total in parts.

**`record`**: on every record that prints `total` and any of `parts`, the parts add up to the
total.

**`carry`**: on each page, the cells added over the records so far equal the amount beside
`carried`; the next page's `brought` repeats it.

Cells in a check must be `amount` or `number` cells, `Charges`, or `Invoice charge amount`.

### `groups`

Title lines that apply to the records under them, such as a route or a service printed once above
a block of records. Each entry is the x where such a title starts. The title's text is read into
a cell called `Section` on every record beneath it.

### The rest

| Field | Meaning |
|---|---|
| `version` | The vocabulary version the spec was written for |
| `pageWidth` | Width of the page the records are printed on. A spec is only tried on a document with a page of this width |
| `heading` | The table's heading rows, normalised. Skipped wherever a page repeats them |
| `identity` | Text every document of the layout prints: its heading rows, or for a form, the exact texts its records start with. A spec is only tried on a document that prints all of it |
| `otherAmounts` | `true` for records that print extra charges in no fixed place. Amounts no cell reads are then added into `Other amounts`, their text into `Other amounts: description`. Normally `false`, so that an unread amount fails the read |
| `carryOver` | `true` when a record can continue at the top of the next page |

## Cell names and their order

A row's cells are always in this order:

1. columns, in the spec's order
2. labels, in the spec's order
3. `Section`, when the spec has groups
4. `Other amounts` and `Other amounts: description`, when `otherAmounts` is true
5. the four `Invoice charge` cells, when the spec has `charge` or `tax` lines
6. `Charges`, when the spec reads charges
7. each charge name the document prints, in the order first printed

A column is named by the heading printed over it, and a label by its own text. Two cells that
would share a name are told apart as `Total` and `Total (2)`.

Charge cells are the one part of a row that can differ between two documents of a layout,
because they depend on which charges each document prints. Read charge cells by name, never by
position.

## Versions

`SPEC_VERSION` is the version of the vocabulary. It is raised when a saved spec would read
differently under a newer reader. A spec of another version is never used: the next document of
that layout has its spec written again.
