// Reads any PDF, having Claude write the reading spec if its layout is new.
//
//   export ANTHROPIC_API_KEY=...
//   npm run build && node examples/with-a-model.mjs path/to/invoice.pdf
//
// The spec is saved in ./specs, so the second run on the same layout makes no model call.
import { readFile } from 'node:fs/promises';
import { createReader, fileStore } from 'crossfoot';
import { anthropic } from 'crossfoot/anthropic';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: node examples/with-a-model.mjs <file.pdf>');

const reader = createReader({
  model: anthropic(),
  store: fileStore('./specs'),
  onRefusal: ({ round, check, message }) => console.log(`answer ${round + 1} refused [${check}]: ${message}`),
});

const result = await reader.read(await readFile(file));
console.table(result.rows.slice(0, 10));
console.log(`${result.rows.length} rows · ${result.via} spec ${result.specId.slice(0, 12)}`);
console.log(result.proven ? 'proven' : `NOT PROVEN: ${result.problem.message}`);
