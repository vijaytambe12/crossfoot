import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { courierAnswer, freightAnswer, scripted } from '../examples/answers.mjs';
import { courierStatement, freightInvoice } from '../examples/documents.mjs';
import { Model, createReader, extractGeometry, fileStore, memoryStore } from '../src/index.js';

/**
 * The whole path on real PDFs: text extraction, a model's answer, the proof, the saved spec and
 * its replay. The model is scripted (`examples/answers.mjs`), so nothing here needs a network.
 */
const pdf = (bytes: Buffer) => new Uint8Array(bytes);
const counted = (model: Model) => {
  const prompts: string[] = [];
  const counting: Model = (request) => {
    prompts.push(request.prompt);
    return model(request);
  };
  return { model: counting, prompts };
};

describe('reading a document', () => {
  it('has the model write a layout’s spec once, then reads later documents with no model', async () => {
    const { model, prompts } = counted(scripted(freightAnswer));
    const reader = createReader({ model });

    const first = await reader.read(pdf(freightInvoice()));
    const second = await reader.read(pdf(freightInvoice()));

    expect(first).toMatchObject({ proven: true, via: 'written', problem: null });
    expect(second).toMatchObject({ proven: true, via: 'saved', specId: first.specId });
    expect(prompts).toHaveLength(1);
  });

  it('returns each record as a row keyed by the names the document prints', async () => {
    const reader = createReader({ model: scripted(freightAnswer) });

    const { rows, names } = await reader.read(pdf(freightInvoice()));

    expect(names.slice(0, 8)).toEqual([
      'Date',
      'Con Note',
      'Receiver',
      'Service',
      'Kg',
      'Freight',
      'Fuel Levy',
      'Total',
    ]);
    expect(rows[0]).toMatchObject({
      Date: '03/08/2026',
      'Con Note': 'NF10045800',
      Receiver: 'Acme Trading Co Port Melbourne VIC',
      Freight: '18.50',
      'Fuel Levy': '2.22',
      Total: '20.72',
    });
    // 29 consignments, and the GST charged once for the whole invoice as a row of its own.
    expect(rows).toHaveLength(30);
    expect(rows[29]).toMatchObject({
      'Invoice charge': 'GST 10%',
      'Invoice charge amount': '457.82',
      'Invoice charge type': 'tax',
      'Invoice charge proven': 'yes',
    });
  });

  it('reads a form of labelled blocks, each charge a cell under its printed name', async () => {
    const reader = createReader({ model: scripted(courierAnswer) });

    const { rows, proven } = await reader.read(pdf(courierStatement()));

    expect(proven).toBe(true);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      'Job No:': 'HC-20418',
      'Date:': '03/09/2026',
      'Pickup:': 'Acme Trading Co 12 Wharf Rd, Port Melbourne',
      'Delivery:': 'Blue Gum Books 8 Station St, Geelong',
      'Job total': '62.04',
      Charges: '62.04',
      'Base charge': '42.00',
      'Fuel surcharge': '5.04',
      'Waiting time': '15.00',
      'After hours delivery': '',
      'Tail lift': '',
    });
  });

  it('says which check failed when a figure is misprinted, and still returns the rows', async () => {
    const store = memoryStore();
    await createReader({ model: scripted(freightAnswer), store }).read(pdf(freightInvoice()));

    const result = await createReader({ store }).read(pdf(freightInvoice({ misprint: true })));

    expect(result.proven).toBe(false);
    expect(result.via).toBe('saved');
    expect(result.rows).toHaveLength(30);
    expect(result.problem).toMatchObject({
      check: 'record_total',
      message: 'record 7 (page 1): Freight + Fuel Levy adds up to 271.68, but its Total is 261.68',
    });
  });

  it('reads each layout with its own spec', async () => {
    const store = memoryStore();
    await createReader({ model: scripted(freightAnswer), store }).read(pdf(freightInvoice()));
    await createReader({ model: scripted(courierAnswer), store }).read(pdf(courierStatement()));
    const reader = createReader({ store });

    const [invoice, statement] = await Promise.all([
      reader.read(pdf(freightInvoice())),
      reader.read(pdf(courierStatement())),
    ]);

    expect(invoice).toMatchObject({ proven: true, via: 'saved' });
    expect(statement).toMatchObject({ proven: true, via: 'saved' });
    expect(invoice.specId).not.toBe(statement.specId);
  });

  it('refuses a layout it has no spec for when no model was given', async () => {
    await expect(createReader().read(pdf(freightInvoice()))).rejects.toThrow(
      'No saved reading spec reads this document',
    );
  });

  it('takes positioned text from anywhere — an OCR engine — in place of a PDF', async () => {
    const geometry = await extractGeometry(pdf(freightInvoice()));

    const result = await createReader({ model: scripted(freightAnswer) }).read(geometry);

    expect(result.proven).toBe(true);
  });

  it('says a document with no text needs OCR', async () => {
    const scan = { pageCount: 1, pages: [{ pageNumber: 1, width: 595, height: 842, rows: [] }] };

    await expect(createReader().read(scan)).rejects.toThrow('needs OCR first');
  });
});

describe('writing a spec with a model', () => {
  it('tells the model exactly why its answer was refused, and keeps the repaired one', async () => {
    // The first answer leaves out the Receiver column; the second is right.
    const right = scripted(freightAnswer);
    const { model, prompts } = counted(async (request) => {
      const answer = await right(request);
      return prompts.length > 1
        ? answer
        : { ...answer, columns: answer.columns.filter((_, i) => i !== 2) };
    });
    const refusals: string[] = [];
    const reader = createReader({ model, onRefusal: (r) => refusals.push(r.check) });

    const result = await reader.read(pdf(freightInvoice()));

    expect(result.proven).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Your previous answer:');
    expect(prompts[1]).toContain('It was refused: the heading');
    expect(prompts[1]).toContain('"Receiver" names no column');
    expect(refusals).toEqual(['answer']);
  });

  it('asks again when the model answers without calling the tool', async () => {
    const right = scripted(freightAnswer);
    const { model, prompts } = counted(async (request) =>
      prompts.length > 1 ? right(request) : undefined,
    );

    const result = await createReader({ model }).read(pdf(freightInvoice()));

    expect(result.proven).toBe(true);
    expect(prompts).toHaveLength(2);
  });

  it('keeps the best spec it reached when no answer is proven, and replays it', async () => {
    // Every answer forgets the GST line: the read works, but a line after the records is unnamed.
    const right = scripted(freightAnswer);
    const { model, prompts } = counted(async (request) => {
      const answer = await right(request);
      return { ...answer, lines: answer.lines.slice(0, 2), checks: answer.checks.slice(0, 3) };
    });
    const store = memoryStore();

    const written = await createReader({ model, store, repairs: 1, attempts: 2 }).read(
      pdf(freightInvoice()),
    );
    const replayed = await createReader({ store }).read(pdf(freightInvoice()));

    expect(prompts).toHaveLength(4);
    expect(written).toMatchObject({ proven: false, via: 'written' });
    expect(written.problem.check).toBe('unknown_line');
    expect(written.rows).toHaveLength(29);
    expect(replayed).toMatchObject({ proven: false, via: 'saved', specId: written.specId });
  });

  it('fails when no answer reads the layout at all', async () => {
    const reader = createReader({ model: async () => ({ nonsense: true }), repairs: 0, attempts: 1 });

    await expect(reader.read(pdf(freightInvoice()))).rejects.toThrow(
      'No way to read this layout could be found',
    );
  });

  it('writes the layout again on request, whatever is saved', async () => {
    const { model, prompts } = counted(scripted(freightAnswer));
    const reader = createReader({ model });

    await reader.read(pdf(freightInvoice()));
    const again = await reader.write(pdf(freightInvoice()));

    expect(again).toMatchObject({ proven: true, via: 'written' });
    expect(prompts).toHaveLength(2);
  });
});

describe('keeping specs in files', () => {
  it('saves one JSON file per layout and reads with them in a later process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crossfoot-'));
    const saving = createReader({ model: scripted(courierAnswer), store: fileStore(directory) });
    const { specId } = await saving.read(pdf(courierStatement()));

    const files = await readdir(directory);
    const later = await createReader({ store: fileStore(directory) }).read(pdf(courierStatement()));

    expect(files).toEqual([`${specId.slice(0, 16)}.json`]);
    expect(JSON.parse(await readFile(join(directory, files[0]), 'utf8'))).toMatchObject({
      records: [{ text: 'job no:' }],
    });
    expect(later).toMatchObject({ proven: true, via: 'saved', specId });
  });

  it('reads the example documents with the specs shipped beside them', async () => {
    const reader = createReader({ store: fileStore('examples/specs') });

    for (const name of ['freight-invoice.pdf', 'courier-statement.pdf']) {
      const result = await reader.read(new Uint8Array(await readFile(`examples/${name}`)));
      expect(result).toMatchObject({ proven: true, via: 'saved' });
    }
  });
});
