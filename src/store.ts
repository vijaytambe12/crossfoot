import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadingSpec } from './spec.js';

export interface SavedSpec {
  id: string;
  spec: ReadingSpec;
}

/** Where reading specs are kept between documents. A spec is plain JSON: any database will do. */
export interface SpecStore {
  /** Every saved spec, newest first. */
  list(): Promise<SavedSpec[]>;
  save(spec: ReadingSpec): Promise<SavedSpec>;
}

/** A spec's id: the hash of its content, so saving the same spec twice keeps one. */
export function specId(spec: ReadingSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

/** Specs kept for the life of the process. */
export function memoryStore(specs: ReadingSpec[] = []): SpecStore {
  const saved = specs.map((spec) => ({ id: specId(spec), spec }));
  return {
    list: async () => [...saved],
    save: async (spec) => {
      const entry = { id: specId(spec), spec };
      const at = saved.findIndex((s) => s.id === entry.id);
      if (at >= 0) saved.splice(at, 1);
      saved.unshift(entry);
      return entry;
    },
  };
}

/** Specs kept as one JSON file each in `directory` — readable, diffable, fit for version control. */
export function fileStore(directory: string): SpecStore {
  return {
    list: async () => {
      const names = (await readdir(directory).catch(() => [])).filter((n) => n.endsWith('.json'));
      const files = await Promise.all(
        names.map(async (name) => {
          const path = join(directory, name);
          const [text, { mtimeMs }] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
          const spec = JSON.parse(text) as ReadingSpec;
          return { id: specId(spec), spec, mtimeMs };
        }),
      );
      return files.sort((a, b) => b.mtimeMs - a.mtimeMs).map(({ id, spec }) => ({ id, spec }));
    },
    save: async (spec) => {
      const id = specId(spec);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${id.slice(0, 16)}.json`), `${JSON.stringify(spec, null, 2)}\n`);
      return { id, spec };
    },
  };
}
