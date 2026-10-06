# Security

## Reporting a vulnerability

Please report it privately, through
[a private security advisory](https://github.com/vijaytambe12/crossfoot/security/advisories/new).
Do not open a public issue.

You should hear back within a week. Fixes are released for the latest version.

## What to know when you run it

**PDFs are untrusted input.** They are parsed by [pdf.js](https://github.com/mozilla/pdf.js) with
script evaluation turned off. Keep the `pdfjs-dist` dependency up to date, and treat parsing a
PDF from an unknown sender like opening any other file from them.

**A document's text is sent to your model provider when a spec is written.** The first pages, the
last page and a sample of the rest; see
[docs/models.md](docs/models.md#what-the-model-is-sent). Nothing is sent when a document is read
by a saved spec. Run a reader with no model where documents must not leave your network.

**A document can contain text aimed at the model.** The model is shown the document's text, so a
hostile document can try to instruct it. The design limits what that can achieve: the model's
answer can only point at printed text, so it cannot make the output contain a value the document
does not print, and its answer is not used unless the document's own totals agree with it. It
could still be steered into a spec that does not read the layout, which shows up as an unproven
read. Do not treat `proven` as a statement that a document is honest, only that it was read as
printed.

**`problem.evidence` quotes the document.** `problem.message` and `problem.detail` do not, and
are safe to log. Keep `evidence` out of logs that are less protected than the documents
themselves.

**Reading specs are data, not code.** A spec is JSON holding positions, masked text and cell
names. Loading one from an untrusted source cannot run code, but it can make a document read
wrongly; the proof still applies.
