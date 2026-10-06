import { readFileSync } from 'node:fs';
import { READING_SPEC_TOOL } from './author.js';

/**
 * What the model is told: one line holding it to a single tool call, then the reading-spec
 * vocabulary (`prompt.md`). The same on every call, so a provider can cache it.
 */
export const SYSTEM_PROMPT = `Reason silently. Emit exactly one ${READING_SPEC_TOOL.name} tool call and no prose.

${readFileSync(new URL('./prompt.md', import.meta.url), 'utf8')}`;
