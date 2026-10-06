/** A tool definition in the JSON Schema form every major model API accepts. */
export interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  /** Instructions for the model: the reading-spec vocabulary. The same on every call, so cache it. */
  system: string;
  /** The document as numbered text fragments — and, on a repair, the last answer and why it failed. */
  prompt: string;
  /** The one tool the model must call. */
  tool: ModelTool;
}

/**
 * Any language model: asked one question, it returns the INPUT of its call to `request.tool`
 * (the parsed JSON object). `anthropic()` is one; wrapping another provider is a few lines.
 */
export type Model = (request: ModelRequest) => Promise<unknown>;
