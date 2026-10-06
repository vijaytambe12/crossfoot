import {
  READING_SPEC_TOOL,
  pointable,
  specFromAnswer,
  specQuestion,
  specRepairQuestion,
} from './author.js';
import type { DocumentGeometry } from './geometry.js';
import type { Model } from './model.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { SpecReading, readWithSpec } from './read.js';
import type { ReadingSpec } from './spec.js';

/** One answer the document did not accept, and why — for progress output and logs. */
export interface Refusal {
  /** Which answer this was, from 0. */
  round: number;
  /** `answer` when the answer itself was malformed; otherwise the proof check that failed. */
  check: string;
  /** Labels with digits masked, cell names and sums only — never a line of the document. */
  message: string;
}

export interface WriteOptions {
  /** Answers after the first, each shown exactly why the one before was refused. Default 3. */
  repairs?: number;
  /** Fresh starts: one set of repairs can circle, and a new first answer usually reads the layout. Default 2. */
  attempts?: number;
  onRefusal?: (refusal: Refusal) => void;
}

export interface WrittenSpec {
  spec: ReadingSpec;
  /** What the spec reads from this document. `reading.problem` is null when the document proves it. */
  reading: SpecReading;
  /** How many answers the model gave. */
  rounds: number;
}

/**
 * Has `model` write the reading spec for this document's layout. Every answer is checked against
 * the page and then against the document's own totals; a refused answer goes back with exactly
 * what failed. Returns the first proven spec — or, when the rounds run out, the last one that read
 * the layout, with `reading.problem` saying what did not hold. Throws when no answer read it at all.
 */
export async function writeSpec(
  geometry: DocumentGeometry,
  model: Model,
  options: WriteOptions = {},
): Promise<WrittenSpec> {
  const perAttempt = (options.repairs ?? 3) + 1;
  const rounds = (options.attempts ?? 2) * perAttempt;
  const question = specQuestion(geometry);
  let prompt = question.prompt;
  let last: WrittenSpec | null = null;
  let problem = '';
  for (let round = 0; round < rounds; round++) {
    if (round % perAttempt === 0) prompt = question.prompt;
    const answer = await model({ system: SYSTEM_PROMPT, prompt, tool: READING_SPEC_TOOL });
    const converted = convert(answer, question);
    let refusal: Pick<Refusal, 'check' | 'message'>;
    if ('spec' in converted) {
      const reading = readWithSpec(geometry, converted.spec);
      last = { spec: converted.spec, reading, rounds: round + 1 };
      if (!reading.problem) return last;
      const { check, message, evidence, lines } = reading.problem;
      problem = (evidence ? `${message}.\n${evidence}` : message) + pointable(question, lines ?? []);
      refusal = { check, message };
    } else {
      problem = converted.problem;
      refusal = { check: 'answer', message: converted.problem };
    }
    options.onRefusal?.({ round, ...refusal });
    prompt = specRepairQuestion(question, answer, problem);
  }
  if (!last) throw new Error(`No way to read this layout could be found (${problem})`);
  return last;
}

/** A model can answer with anything: an answer the checker cannot even walk is refused like any other. */
function convert(answer: unknown, question: ReturnType<typeof specQuestion>) {
  try {
    return specFromAnswer(answer, question);
  } catch {
    return { problem: `the answer does not follow the ${READING_SPEC_TOOL.name} schema` };
  }
}
