# Contributing

Thanks for looking. This page covers the setup, how the code is laid out, and the two kinds of
contribution that help most.

## Setup

```bash
git clone https://github.com/vijaytambe12/crossfoot.git
cd crossfoot
npm install
npm test
```

Node 20 or later.

| Command | Does |
|---|---|
| `npm test` | Runs the tests (Vitest) |
| `npm run typecheck` | Type-checks the source strictly, and the tests |
| `npm run build` | Compiles to `dist/` |
| `npm run examples` | Rebuilds, then regenerates the example PDFs and their specs |

## Layout

| File | Holds |
|---|---|
| `src/geometry.ts` | The positioned-text types, and row clustering |
| `src/pdf.ts` | PDF text extraction with pdf.js |
| `src/ocr.ts` | OCR words to positioned text |
| `src/text.ts` | Reading printed text: normalising, shapes, numbers |
| `src/spec.ts` | The `ReadingSpec` types |
| `src/author.ts` | The question shown to a model, the tool schema, and the check that turns an answer into a spec |
| `src/prompt.md` | The instructions the model is given |
| `src/read.ts` | Applying a spec, and the proof |
| `src/write.ts` | The answer, proof and repair loop |
| `src/reader.ts` | `createReader`: saved specs first, then the model |
| `src/store.ts` | Spec stores |
| `src/anthropic.ts` | The Claude adapter |
| `src/cli.ts` | The command line |

## A layout that does not read

This is the most useful thing you can send.

**Do not attach a real invoice.** It holds other people's names, addresses and prices. Reduce the
problem to a made-up document instead:

1. Find the smallest part of the layout that shows the problem. It is usually a handful of lines.
2. Rebuild it as a test with invented text. The tests in `test/read.test.ts` build documents
   from a few lines of code:

   ```ts
   const invoice = doc([
     row(100, ['Date', 20], ['Consignment', 80], ['Amount', 500]),
     row(120, ['01/02/24', 20], ['CN001', 80], ['10.00', 520]),
     row(170, ['Subtotal', 400], ['10.00', 520]),
   ]);
   ```

   Each `row` is a y position and its texts with their x positions. Keep the real positions and
   the shape of the text; change every name and number.
3. Open an issue with that test and what you expected.

`crossfoot <file.pdf> --question` prints a document's text with positions, which is a quick way
to get the numbers for step 2. Remember that its output contains the document's text.

## Changing the reader

The reader's rules exist because real documents broke simpler ones. Before you change one:

- **No layout knowledge in code.** Nothing in `src/` may know a company, a document type or a
  particular layout. If a document needs something new, it is a new word in the spec vocabulary
  that the model can use, not a special case.
- **The model never writes a value.** A new field in the tool schema must be a pointer, a
  position, a line range, a fixed word or a cell name.
- **A new way to read is a new way to be wrong.** If the reader computes something that is not
  printed, a check must be able to prove it.
- **Every change comes with a test** that builds a made-up document and shows the behaviour.

When the vocabulary changes in a way that makes a saved spec read differently, raise
`SPEC_VERSION` in `src/spec.ts`. Old specs are then set aside and written again.

`src/prompt.md` and the `description` strings in `src/author.ts` are instructions to a model.
Wording changes there change behaviour and cannot be covered by the unit tests. Say in your pull
request which model you tried the change with, and on what kind of layout.

## Style

- TypeScript, strict.
- Small functions with a comment that says why, not what.
- No new runtime dependency without a discussion first.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
