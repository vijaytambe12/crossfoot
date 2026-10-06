# Models

A model is used for one thing: writing the reading spec for a layout that has not been seen
before. After that, documents of the layout are read without it.

- [Claude](#claude)
- [The model interface](#the-model-interface)
- [Another provider](#another-provider)
- [A model you host](#a-model-you-host)
- [Choosing a model](#choosing-a-model)
- [What the model is sent](#what-the-model-is-sent)
- [Running with no model](#running-with-no-model)

## Claude

```js
import { createReader } from 'crossfoot';
import { anthropic } from 'crossfoot/anthropic';

const reader = createReader({ model: anthropic() });
```

With no arguments it creates a client from the environment (`ANTHROPIC_API_KEY`) and uses
`claude-opus-5-5`.

| Option | Default | Meaning |
|---|---|---|
| `client` | `new Anthropic()` | Your own configured client: a proxy, custom headers, timeouts |
| `model` | `claude-opus-5-5` | Any Claude model id |
| `effort` | `high` | How hard the model thinks. Pass `null` for a model that does not accept an effort |
| `maxTokens` | `32000` | The answer is small, but the model reasons before it |

```js
import Anthropic from '@anthropic-ai/sdk';

const model = anthropic({
  client: new Anthropic({ apiKey: process.env.MY_KEY, maxRetries: 4 }),
  model: 'claude-sonnet-5-5',
  effort: 'medium',
});
```

The system prompt is sent with a cache marker, so repair rounds and later layouts reuse it.

## The model interface

```ts
interface ModelRequest {
  system: string;   // the instructions; identical on every call
  prompt: string;   // the document as numbered fragments, plus the last answer and why it failed on a repair
  tool: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;   // JSON Schema
  };
}

type Model = (request: ModelRequest) => Promise<unknown>;
```

Your function must return **the input of the model's call to `tool`**, as a parsed object.

- If the model answers without calling the tool, return `undefined`. The loop treats that as a
  refused answer and asks again.
- If the call fails (network, rate limit, refusal), throw. The error reaches the caller of
  `reader.read`.

You do not need to validate the answer. Every pointer in it is checked against the page, and
nothing is accepted until the document proves it.

## Another provider

Any model with tool calling works. This is the shape for an OpenAI-style chat API. It is a
sketch to adapt, and is not tested by this project:

```js
import OpenAI from 'openai';

const client = new OpenAI();

/** @type {import('crossfoot').Model} */
const model = async ({ system, prompt, tool }) => {
  const response = await client.chat.completions.create({
    model: 'your-model',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    tools: [
      {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
      },
    ],
    tool_choice: { type: 'function', function: { name: tool.name } },
  });
  const call = response.choices[0].message.tool_calls?.[0];
  return call ? JSON.parse(call.function.arguments) : undefined;
};
```

The tool schema is standard JSON Schema. It uses `"type": ["integer", "null"]` for optional
pointers, which some providers' strict modes do not accept; leave strict mode off.

## A model you host

Nothing ties the interface to an API. If your model runs locally and can produce JSON that
follows a schema, wrap it the same way: send `system` and `prompt`, constrain the output to
`tool.input_schema`, and return the parsed object.

This is the route to take when a document's text may not leave your network.

## Choosing a model

Writing a spec is the hard part of the job: the model has to work out a layout from positions.
It happens once per layout, so the strongest model you have access to is usually the right
choice. The saving is in the thousands of later reads that use no model.

A weaker model does not produce wrong numbers. It produces more refused answers. You can see how
it is doing:

```js
const reader = createReader({
  model,
  repairs: 3,    // answers after the first, per attempt
  attempts: 2,   // fresh starts
  onRefusal: ({ round, check, message }) => console.warn(`answer ${round + 1} refused [${check}]: ${message}`),
});
```

If a model regularly uses every round, it is too weak for your layouts.

The instructions in `src/prompt.md` were written and tuned with Claude. Another model may need
its own wording; `SYSTEM_PROMPT` is exported, and your `Model` function is free to send something
else.

## What the model is sent

When a spec is written, the prompt contains the document's text:

- in full, the first two pages that print amounts and the last one (up to 110 lines each)
- from other pages, about 40 lines that start differently from anything already shown

On a repair, the prompt also contains the model's previous answer and the printed lines that the
failed check points at.

Run `crossfoot <file.pdf> --question` to see the exact first prompt for a document.

Nothing is sent when a document is read by a saved spec.

## Running with no model

```js
const reader = createReader({ store: fileStore('./specs') });
```

This reader only replays. A document whose layout has no spec makes `read` throw. Use it to
separate the two jobs:

- **Onboarding**, where a person adds a new supplier: a reader with a model, and a review of the
  first result.
- **Production**, where documents flow through unattended: a reader with no model, which makes no
  network calls and cannot spend money.
