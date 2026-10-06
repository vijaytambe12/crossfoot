import type { DocumentGeometry } from './geometry.js';
import type { Model } from './model.js';
import { extractGeometry, hasText } from './pdf.js';
import { SpecProblem, SpecReading, SpecRecord, printsIdentity, readWithSpec } from './read.js';
import { ReadingSpec, SPEC_VERSION } from './spec.js';
import { SpecStore, memoryStore, specId } from './store.js';
import { WriteOptions, writeSpec } from './write.js';

export interface ReaderOptions extends WriteOptions {
  /** Writes the spec for a layout no saved spec reads. Without one, only saved layouts are read. */
  model?: Model;
  /** Where specs are kept. Default: in memory, for the life of the process. */
  store?: SpecStore;
}

export interface ReadResult {
  /** One object per record, keyed by cell name. Every value is text exactly as printed. */
  rows: Record<string, string>[];
  /** The cell names, in order. */
  names: string[];
  /** The same records as arrays, with the page each was read from. */
  records: SpecRecord[];
  /** Whether the document's own printed totals prove the read. */
  proven: boolean;
  /** What did not hold when `proven` is false. `evidence` quotes the document; `message` does not. */
  problem: SpecProblem | null;
  /** `saved`: read by a saved spec, with no model call. `written`: the model wrote the spec just now. */
  via: 'saved' | 'written';
  specId: string;
  spec: ReadingSpec;
}

export interface Reader {
  /**
   * Reads a document: with the newest saved spec it proves; else with a saved spec that reads its
   * layout but leaves a check unproven; else with one the model writes now.
   */
  read(document: Uint8Array | DocumentGeometry): Promise<ReadResult>;
  /** Has the model write this layout's spec again, whatever is saved — after a layout change. */
  write(document: Uint8Array | DocumentGeometry): Promise<ReadResult>;
}

export function createReader(options: ReaderOptions = {}): Reader {
  const store = options.store ?? memoryStore();

  async function write(geometry: DocumentGeometry): Promise<ReadResult> {
    if (!options.model)
      throw new Error('No saved reading spec reads this document, and no model was given to write one');
    const written = await writeSpec(geometry, options.model, options);
    // Kept even when unproven: the checks run again on every read, and writing the layout again
    // for each document would cost the same rounds to reach the same answer.
    const { id } = await store.save(written.spec);
    return result(id, written.spec, written.reading, 'written');
  }

  async function read(geometry: DocumentGeometry): Promise<ReadResult> {
    let unproven: ReadResult | null = null;
    for (const { id, spec } of await store.list()) {
      if (!fits(geometry, spec)) continue;
      const reading = readWithSpec(geometry, spec);
      if (!reading.problem) return result(id, spec, reading, 'saved');
      if (reading.records.length && !unproven) unproven = result(id, spec, reading, 'saved');
    }
    return unproven ?? write(geometry);
  }

  return {
    read: async (document) => read(await geometryOf(document)),
    write: async (document) => write(await geometryOf(document)),
  };
}

async function geometryOf(document: Uint8Array | DocumentGeometry): Promise<DocumentGeometry> {
  const geometry = document instanceof Uint8Array ? await extractGeometry(document) : document;
  if (!hasText(geometry))
    throw new Error('The document has no text to read. A scanned PDF needs OCR first: pass its words as geometry');
  return geometry;
}

/** A saved spec is tried on a document of its page width that prints its identity. */
function fits(geometry: DocumentGeometry, spec: ReadingSpec): boolean {
  return (
    spec.version === SPEC_VERSION &&
    geometry.pages.some((page) => Math.abs(page.width - spec.pageWidth) <= 2) &&
    printsIdentity(geometry, spec)
  );
}

function result(
  id: string,
  spec: ReadingSpec,
  reading: SpecReading,
  via: ReadResult['via'],
): ReadResult {
  return {
    rows: reading.records.map(({ cells }) =>
      Object.fromEntries(reading.names.map((name, i) => [name, cells[i] ?? ''])),
    ),
    names: reading.names,
    records: reading.records,
    proven: !reading.problem,
    problem: reading.problem,
    via,
    specId: id,
    spec,
  };
}

export { specId };
