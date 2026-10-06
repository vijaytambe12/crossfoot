# API reference

Everything is exported from `crossfoot`, except the Claude adapter, which is in
`crossfoot/anthropic` so that the main entry does not load an SDK you may not use.

- [Reading](#reading): `createReader`
- [Stores](#stores): `fileStore`, `memoryStore`, `specId`
- [Models](#models): `anthropic`, the `Model` type
- [The steps](#the-steps): `extractGeometry`, `writeSpec`, `readWithSpec` and the rest
- [Helpers](#helpers): `parseAmount`, `ocrPage`, `clusterRows`

## Reading

### `createReader(options?)`

```ts
function createReader(options?: ReaderOptions): Reader;

interface ReaderOptions {
  model?: Model;        // writes the spec for a new layout; without it only saved layouts are read
  store?: SpecStore;    // default: memoryStore()
  repairs?: number;     // default 3
  attempts?: number;    // default 2
  onRefusal?: (refusal: Refusal) => void;
}

interface Reader {
  read(document: Uint8Array | DocumentGeometry): Promise<ReadResult>;
  write(document: Uint8Array | DocumentGeometry): Promise<ReadResult>;
}
```

**`read`** returns the document's rows. It uses, in order:

1. the newest saved spec that fits the layout and that the document proves
2. a saved spec that reads the layout although a check fails; the result has `proven: false`
3. a spec the model writes now, which is then saved

**`write`** skips the saved specs and has the model write the layout again.

Both accept a PDF as bytes (a `Buffer` is fine) or a `DocumentGeometry`.

Both throw when:

- the bytes are not a PDF
- the document has no text (a scan; see [ocr.md](ocr.md))
- no saved spec fits and there is no model
- the model's call throws
- the model was asked every round and no answer could read the layout at all

An unproven read does **not** throw.

### `ReadResult`

```ts
interface ReadResult {
  rows: Record<string, string>[];   // one object per record, keyed by cell name
  names: string[];                  // the cell names, in order
  records: { page: number; cells: string[] }[];   // the same data as arrays, with page numbers
  proven: boolean;
  problem: SpecProblem | null;      // set when proven is false
  via: 'saved' | 'written';
  specId: string;
  spec: ReadingSpec;
}
```

Every value is a string exactly as printed. An empty cell is `''`.

`SpecProblem` is described in [proof.md](proof.md).

### `Refusal`

Passed to `onRefusal` each time an answer from the model is not accepted.

```ts
interface Refusal {
  round: number;     // which answer, from 0
  check: string;     // 'answer', or a failure code from proof.md
  message: string;   // safe to log
}
```

## Stores

```ts
interface SpecStore {
  list(): Promise<SavedSpec[]>;              // every saved spec, newest first
  save(spec: ReadingSpec): Promise<SavedSpec>;
}

interface SavedSpec { id: string; spec: ReadingSpec }
```

### `fileStore(directory)`

One JSON file per spec, named by the first 16 characters of its id. The directory is created on
first save. Files are listed newest first by modification time.

### `memoryStore(specs?)`

Keeps specs for the life of the process. Optionally starts with specs you already have.

### `specId(spec)`

The SHA-256 of the spec's JSON. Saving the same spec twice keeps one.

### Your own store

A spec is a small JSON object, so any database works. Implement the two methods:

```js
const store = {
  list: async () => {
    const rows = await db.query('SELECT id, spec FROM reading_specs ORDER BY created_at DESC');
    return rows.map((row) => ({ id: row.id, spec: JSON.parse(row.spec) }));
  },
  save: async (spec) => {
    const id = specId(spec);
    await db.query('INSERT INTO reading_specs (id, spec) VALUES (?, ?) ON CONFLICT DO NOTHING', [
      id,
      JSON.stringify(spec),
    ]);
    return { id, spec };
  },
};
```

`list` is called on every read, and each returned spec is tried against the document. If you
hold specs for many senders, return only the ones that could apply, for example by filtering on
the sender you already know:

```js
const reader = createReader({ store: storeFor(supplierId) });
```

## Models

### `anthropic(options?)` from `crossfoot/anthropic`

Returns a `Model` backed by Claude. Options are in [models.md](models.md#claude).

### `Model`

```ts
type Model = (request: ModelRequest) => Promise<unknown>;
interface ModelRequest { system: string; prompt: string; tool: ModelTool }
interface ModelTool { name: string; description: string; input_schema: Record<string, unknown> }
```

See [models.md](models.md#the-model-interface).

## The steps

`createReader` is a thin layer over these. Use them to build a different pipeline.

### `extractGeometry(pdf)`

```ts
function extractGeometry(pdf: Uint8Array): Promise<DocumentGeometry>;
function hasText(geometry: DocumentGeometry): boolean;
```

The PDF's text layer as positioned fragments. `hasText` is `false` for a scan.

### `writeSpec(geometry, model, options?)`

```ts
function writeSpec(geometry: DocumentGeometry, model: Model, options?: WriteOptions): Promise<WrittenSpec>;

interface WrittenSpec {
  spec: ReadingSpec;
  reading: SpecReading;   // what the spec reads from this document
  rounds: number;         // how many answers the model gave
}
```

Runs the question, answer, proof and repair loop. Returns the first proven spec, or the last one
that read the layout with `reading.problem` set. Throws if no answer read the layout.

### `readWithSpec(geometry, spec)`

```ts
function readWithSpec(geometry: DocumentGeometry, spec: ReadingSpec): SpecReading;

interface SpecReading {
  names: string[];
  records: { page: number; cells: string[] }[];
  problem: SpecProblem | null;
}
```

Applies a spec and runs the proof. Synchronous, no I/O, no model. This is the whole of the replay
path.

### `printsIdentity(geometry, spec)`

Whether a document prints the text a spec's layout always prints. A cheap test before
`readWithSpec`.

### `specQuestion`, `specFromAnswer`, `specRepairQuestion`

```ts
function specQuestion(geometry: DocumentGeometry): SpecQuestion;
function specFromAnswer(answer: unknown, question: SpecQuestion): { spec: ReadingSpec } | { problem: string };
function specRepairQuestion(question: SpecQuestion, answer: unknown, problem: string): string;
```

The pieces of the loop: the prompt for a document, the check that turns a model's answer into a
spec, and the prompt for a repair. `question.prompt` is the text to send.

### `READING_SPEC_TOOL`, `SYSTEM_PROMPT`

The tool definition the model answers through, and the instructions that explain it.

### `SPEC_VERSION`, `cellNames(spec)`, `cellTypes(spec)`

The vocabulary version, and the names and types of the cells a spec produces (before any charge
cells, which depend on the document).

## Helpers

### `parseAmount(text)`

```ts
function parseAmount(text: string): number | null;
```

A printed number as a JavaScript number, or `null` if the text is not one number.

| Text | Result |
|---|---|
| `1,284.36` | `1284.36` |
| `$ 70.09` | `70.09` |
| `(12.50)` | `-12.5` |
| `-12.50` | `-12.5` |
| `12.50CR` | `-12.5` |
| `14.3 kg` | `null` |

It reads a comma as a thousands separator and a point as the decimal mark.

### `ocrPage(lines, page)`

OCR words to one page of geometry. See [ocr.md](ocr.md).

### `clusterRows(fragments)`

Groups fragments into rows by their y position. For building geometry by hand.
