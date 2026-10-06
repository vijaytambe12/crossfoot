// Reads the example documents with the specs shipped beside them. No model, no network, no key.
//
//   npm run build && node examples/quickstart.mjs
import { readFile } from 'node:fs/promises';
import { createReader, fileStore, parseAmount } from 'crossfoot';

const here = (name) => new URL(name, import.meta.url);
const reader = createReader({ store: fileStore(here('specs').pathname) });

for (const name of ['freight-invoice.pdf', 'freight-invoice-misprint.pdf', 'courier-statement.pdf']) {
  const result = await reader.read(await readFile(here(name)));
  console.log(`\n${name}`);
  console.log(`  ${result.rows.length} rows, read by a ${result.via} spec`);
  console.log(`  cells: ${result.names.join(' | ')}`);
  console.log(result.proven ? '  proven' : `  NOT PROVEN: ${result.problem.message}`);
}

// Values are text as printed. parseAmount turns one into a number when you want to calculate.
const invoice = await reader.read(await readFile(here('freight-invoice.pdf')));
const freight = invoice.rows.reduce((sum, row) => sum + (parseAmount(row.Freight) ?? 0), 0);
console.log(`\nFreight before fuel levy and GST: ${freight.toFixed(2)}`);
