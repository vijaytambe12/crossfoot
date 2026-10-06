# Limits and FAQ

## Limits

These are the things crossfoot does not do, or does not do well. Read them before you build on
it.

### What it cannot prove

- **Text.** Names, references and dates are read from where the spec points. Totals cannot
  confirm them. See [proof.md](proof.md#what-the-proof-does-not-cover).
- **Numbers no check adds up.** A weight column is read, but nothing verifies it unless the
  document prints a total for it and the spec checks that total.
- **Documents with no totals.** They are read, and `proven` is `true`, but only structural rules
  were checked.

### Documents it does not suit

- **Prose.** Contracts, letters, reports. There are no records.
- **Layouts you will see once.** Writing a spec costs model calls. The return comes from reading
  the same layout again.
- **Layouts that vary freely.** A spec holds x positions. A sender whose columns move from one
  document to the next needs a new spec each time.
- **Tables read down the page instead of across**, or several records side by side on one line.

### Text and numbers

- **Number format.** A comma is read as a thousands separator and a point as the decimal mark:
  `1,284.36`. European formatting (`1.284,36`) is not supported yet.
- **Credits** are recognised as `(12.50)`, `-12.50` and `12.50CR`.
- **Amounts inside text** are found by a currency sign: `$`, `£` or `€`.
- **Dates are not parsed.** A date cell is the text as printed.
- **Left to right.** Right-to-left scripts have not been tried.

### PDFs

- **Scans need OCR**, which you supply. See [ocr.md](ocr.md).
- **Scans drift.** Positions must match within 3 points. Tilt is corrected, shift and scale are
  not.
- **Text drawn as outlines** ("Print to PDF" from some programs) has no text layer and behaves
  like a scan.
- **Password-protected PDFs** are not opened.

### The model

- **A layout can defeat it.** If every round is used and nothing is proven, you get the best
  attempt with `proven: false`, or an error if no attempt read the layout.
- **The instructions were tuned with Claude.** Other models work through the same interface but
  have not been measured.
- **Long documents are sampled.** The model sees the first pages and the last, and a sample of
  the middle. A kind of line that appears only deep in a long document may be missed on the first
  answer. The proof then fails on that line and the repair shows it to the model.

### Scale

- **Every saved spec that fits is tried.** `store.list()` is called on each read. With thousands
  of specs, narrow the list yourself, for example by sender.
- **Reading is in memory.** A document's whole text is held at once. That is fine for hundreds of
  pages and untested beyond.

## FAQ

### How is this different from asking a model for JSON?

A model asked for JSON writes the values. Here it writes none. It says where the values are, code
copies them, and the totals check the result. A wrong answer from the model becomes a failed
check instead of a wrong number in your database.

### How is it different from a template-based parser?

A template is written by a person for each layout. Here the model writes it. And a template has
no way to know it has gone wrong; a reading spec is checked against the totals on every document.

### What happens when a supplier changes their layout?

The saved spec stops fitting, or fits and fails its proof. If the reader has a model and the spec
no longer fits, a new spec is written. If the old one still fits but fails, you get the rows with
`proven: false`; call `reader.write(document)` to write the layout again.

### Do I have to trust the model?

No. Nothing the model says is used until the document confirms it. That is also why a weaker
model is safe to try: it costs more rounds, not accuracy.

### Is `proven: true` a guarantee?

For the amounts, it is a strong one: every amount-printing line was accounted for and the totals
agree to the cent. It is not a guarantee for text. It is also a statement about the read, not
about the invoice being correct in the business sense. An invoice that overcharges you
consistently adds up perfectly.

### What does it cost to run?

Reading with a saved spec costs nothing but CPU: about 10 ms for the two-page example, most of it
PDF parsing. Writing a spec costs between one and eight model calls, once per layout. Each call
sends a few pages of text and the instructions.

### Can I edit a spec by hand?

Yes. It is JSON. Change it, then run a few documents through `readWithSpec` to see that they are
still proven. The spec's id is the hash of its content, so an edited spec is a new spec.

### Can I see what the model is shown?

`crossfoot <file.pdf> --question` prints the first prompt. `SYSTEM_PROMPT` is the instructions.

### Does it work in the browser?

Not as shipped. The file store and the prompt loader use Node's file system. The reading and
proof code has no such dependency.

### Which fields will I get?

The ones the document prints, under the names it prints them. crossfoot does not map them to a
fixed schema such as "invoice number, supplier, total". Mapping a layout's cells to your own
field names is a small table you keep per spec.
