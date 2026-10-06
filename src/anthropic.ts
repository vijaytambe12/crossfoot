import Anthropic from '@anthropic-ai/sdk';
import type { Model } from './model.js';

export interface AnthropicOptions {
  /** Default: `new Anthropic()`, which reads `ANTHROPIC_API_KEY` from the environment. */
  client?: Anthropic;
  /** Default `claude-opus-5-5`. A spec is written once per layout, so the strongest model pays for itself. */
  model?: string;
  /** How hard the model thinks. Default `high`. Pass `null` for a model that does not take an effort. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** Default 32000: the answer is small, but the model reasons before it. */
  maxTokens?: number;
}

/** Claude as the model that writes reading specs. */
export function anthropic(options: AnthropicOptions = {}): Model {
  const client = options.client ?? new Anthropic();
  const effort = options.effort === undefined ? 'high' : options.effort;
  return async ({ system, prompt, tool }) => {
    const message = await client.messages
      .stream({
        model: options.model ?? 'claude-opus-5-5',
        max_tokens: options.maxTokens ?? 32000,
        ...(effort ? { output_config: { effort } } : {}),
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: [tool as Anthropic.Tool],
        messages: [{ role: 'user', content: prompt }],
      })
      .finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('The model declined to read this document');
    if (message.stop_reason === 'max_tokens')
      throw new Error('The model ran out of tokens before it answered: raise maxTokens');
    // No forced tool choice (the newest models refuse it): an answer with no call is asked again.
    for (const block of message.content)
      if (block.type === 'tool_use' && block.name === tool.name) return block.input;
    return undefined;
  };
}
