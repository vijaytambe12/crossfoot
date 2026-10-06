// Writes the example PDFs and the reading spec for each layout. Run with `npm run examples`.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createReader, fileStore } from '../dist/index.js';
import { courierAnswer, freightAnswer, scripted } from './answers.mjs';
import { courierStatement, freightInvoice } from './documents.mjs';

const here = (name) => new URL(name, import.meta.url);
await rm(here('specs'), { recursive: true, force: true });
await mkdir(here('specs'), { recursive: true });

const documents = [
  ['freight-invoice.pdf', freightInvoice(), freightAnswer],
  ['courier-statement.pdf', courierStatement(), courierAnswer],
];
for (const [name, pdf, answer] of documents) {
  await writeFile(here(name), pdf);
  const reader = createReader({
    model: scripted(answer),
    store: fileStore(here('specs').pathname),
    onRefusal: (refusal) => console.log(`  refused: ${refusal.message}`),
  });
  const result = await reader.read(new Uint8Array(pdf));
  console.log(`${name}: ${result.rows.length} rows, ${result.proven ? 'proven' : `NOT PROVEN — ${result.problem.message}`}`);
  if (!result.proven) process.exitCode = 1;
}
// The same invoice with one freight figure misprinted by $10.00 — and every total left as it was.
await writeFile(here('freight-invoice-misprint.pdf'), freightInvoice({ misprint: true }));
