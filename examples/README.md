# Examples

Everything in these documents is invented: the companies, the people and the numbers.

| File | What it is |
|---|---|
| `freight-invoice.pdf` | A two-page table. Two lines per consignment, a carried-forward figure, a subtotal, GST and a total |
| `freight-invoice-misprint.pdf` | The same invoice with one freight figure misprinted by $10.00 and every total left alone |
| `courier-statement.pdf` | No table. Each job is a block of labelled lines with its charges listed underneath |
| `specs/` | The reading spec for each of the two layouts |

## Run them

Build once (`npm install && npm run build` in the repository root), then:

```bash
node examples/quickstart.mjs
```

It reads all three documents with the saved specs. No model is called and no key is needed.

To read a PDF of your own, with Claude writing the spec for its layout:

```bash
export ANTHROPIC_API_KEY=...
node examples/with-a-model.mjs path/to/invoice.pdf
```

## How the examples are made

| File | Does |
|---|---|
| `documents.mjs` | Defines the documents |
| `pdf-writer.mjs` | Writes them as PDF, with no dependency |
| `answers.mjs` | The answer a model gives for each layout, written by hand so that the examples and tests need no key |
| `make-examples.mjs` | Writes the PDFs, runs each answer through the real pipeline, and saves the proven specs |

`answers.mjs` is worth reading. It shows exactly what a model is asked to produce, and that
nothing in it is a value from the document.

```bash
npm run examples
```
