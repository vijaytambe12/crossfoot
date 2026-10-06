export { createReader } from './reader.js';
export type { ReadResult, Reader, ReaderOptions } from './reader.js';

export { fileStore, memoryStore, specId } from './store.js';
export type { SavedSpec, SpecStore } from './store.js';

export type { Model, ModelRequest, ModelTool } from './model.js';

// The steps `createReader` is made of, for building your own pipeline.
export { extractGeometry, hasText } from './pdf.js';
export { clusterRows } from './geometry.js';
export type { DocumentGeometry, PageGeometry, Row, TextFragment } from './geometry.js';
export { writeSpec } from './write.js';
export type { Refusal, WriteOptions, WrittenSpec } from './write.js';
export { printsIdentity, readWithSpec } from './read.js';
export type { SpecProblem, SpecProblemCheck, SpecReading, SpecRecord } from './read.js';
export { READING_SPEC_TOOL, specFromAnswer, specQuestion, specRepairQuestion } from './author.js';
export type { SpecQuestion } from './author.js';
export { SYSTEM_PROMPT } from './prompt.js';
export { SPEC_VERSION, cellNames, cellTypes } from './spec.js';
export type {
  CellType,
  ReadingSpec,
  RecordStart,
  SpecCharges,
  SpecCheck,
  SpecColumn,
  SpecLabel,
  SpecLine,
} from './spec.js';
export { parseAmount } from './text.js';
export { ocrPage } from './ocr.js';
export type { OcrWord } from './ocr.js';
