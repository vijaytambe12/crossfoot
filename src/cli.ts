#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { specQuestion } from './author.js';
import { extractGeometry } from './pdf.js';
import { ReadResult, createReader } from './reader.js';
import { fileStore } from './store.js';

const USAGE = `crossfoot — read an invoice PDF and prove the read against its own totals

  crossfoot <file.pdf> [options]

  --specs <dir>     where reading specs are kept          (default ./specs)
  --format <f>      json | csv                            (default json)
  --model <id>      Claude model that writes a new spec   (default claude-opus-5-5)
  --fresh           write this layout's spec again, whatever is saved
  --question        print what the model would be shown, and stop
  -h, --help

A layout with a saved spec is read with no model and no network. A new layout needs
ANTHROPIC_API_KEY. Rows go to stdout, the verdict to stderr.
Exit code: 0 proven, 2 read but not proven, 1 could not be read.`;

/** Rows and help go to stdout, so they pipe; the verdict and progress go to stderr. */
const print = (text: string) => process.stdout.write(`${text}\n`);
const note = (text: string) => process.stderr.write(`${text}\n`);

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      specs: { type: 'string', default: './specs' },
      format: { type: 'string', default: 'json' },
      model: { type: 'string' },
      fresh: { type: 'boolean', default: false },
      question: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [file] = positionals;
  if (values.help || !file) {
    print(USAGE);
    return values.help ? 0 : 1;
  }
  const pdf = new Uint8Array(await readFile(file));
  if (values.question) {
    print(specQuestion(await extractGeometry(pdf)).prompt);
    return 0;
  }
  // Loaded only when there is a key: reading saved layouts needs no model at all.
  const model = process.env.ANTHROPIC_API_KEY
    ? (await import('./anthropic.js')).anthropic({ model: values.model })
    : undefined;
  const reader = createReader({
    model,
    store: fileStore(values.specs),
    onRefusal: ({ round, message }) => note(`  answer ${round + 1} refused: ${message}`),
  });
  const result = await (values.fresh ? reader.write(pdf) : reader.read(pdf));
  print(values.format === 'csv' ? csv(result) : JSON.stringify(result.rows, null, 2));
  const how = result.via === 'saved' ? 'saved spec, no model' : 'spec written by the model';
  const summary = `${result.rows.length} rows · ${how} · spec ${result.specId.slice(0, 12)}`;
  if (result.proven) note(`✓ proven · ${summary}`);
  else note(`✗ NOT PROVEN · ${summary}\n  ${result.problem?.message}`);
  return result.proven ? 0 : 2;
}

function csv({ names, records }: ReadResult): string {
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [names, ...records.map((r) => r.cells)].map((row) => row.map(cell).join(',')).join('\n');
}

main().then(
  (code) => (process.exitCode = code),
  (error: Error) => {
    const hint = process.env.ANTHROPIC_API_KEY ? '' : '\n  Set ANTHROPIC_API_KEY to read a new layout.';
    note(`✗ ${error.message}${error.message.startsWith('No saved reading spec') ? hint : ''}`);
    process.exitCode = 1;
  },
);
