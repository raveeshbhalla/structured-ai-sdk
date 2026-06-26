import { PromptError } from "./errors";

export const PROMPT_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "pai-sdk prompt config",
  description:
    "A prompt definition: model + params + output schema + message templates with strict {{variable}} slots. Simple form: top-level system/user. General form: a messages list.",
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      description: "Prompt name (identifies it in logs and traces).",
    },
    version: {
      type: ["string", "integer"],
      description: "Optional version marker.",
    },
    description: { type: "string" },
    model: {
      description:
        "provider/model-id string or AI SDK model reference. Optional; can be supplied at call time instead.",
    },
    params: {
      type: "object",
      description:
        "generate_text keyword arguments applied on every call (per-call overrides win).",
      properties: {
        max_output_tokens: { type: "integer", minimum: 1 },
        temperature: { type: "number" },
        top_p: { type: "number" },
        top_k: { type: "integer" },
        presence_penalty: { type: "number" },
        frequency_penalty: { type: "number" },
        stop_sequences: { type: "array", items: { type: "string" } },
        seed: { type: "integer" },
        max_retries: { type: "integer", minimum: 0 },
      },
      additionalProperties: true,
    },
    output: {
      description:
        "Structured output: either field-type shorthand or a full JSON Schema via {schema: {...}}.",
      oneOf: [
        {
          type: "object",
          required: ["schema"],
          additionalProperties: false,
          properties: {
            schema: { type: "object" },
            name: { type: "string" },
            description: { type: "string" },
          },
        },
        {
          allOf: [
            { $ref: "#/definitions/outputShorthand" },
            { not: { required: ["schema"] } },
          ],
        },
      ],
    },
    system: {
      $ref: "#/definitions/simpleMessage",
      description:
        "Simple form: the system prompt template. Optimizable by default.",
    },
    user: {
      $ref: "#/definitions/simpleMessage",
      description: "Simple form: the user message template. Never optimized.",
    },
    messages: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/definitions/message" },
    },
    tools: {
      type: "object",
      additionalProperties: { $ref: "#/definitions/tool" },
    },
    tool_choice: {
      oneOf: [
        { enum: ["auto", "none", "required"] },
        {
          type: "object",
          required: ["type", "tool_name"],
          additionalProperties: false,
          properties: {
            type: { const: "tool" },
            tool_name: { type: "string" },
          },
        },
      ],
    },
    max_steps: {
      type: "integer",
      minimum: 1,
      description: "Tool-loop step budget.",
    },
  },
  definitions: {
    templateString: {
      type: "string",
      description:
        "Text with {{variable}} placeholders. Plain identifiers only, with optional whitespace; backslashes before mustache openers use escape parity.",
    },
    simpleMessage: {
      oneOf: [
        { $ref: "#/definitions/templateString" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            template: { $ref: "#/definitions/templateString" },
            content: {
              type: "string",
              description: "Literal text; no interpolation, braces left alone.",
            },
            optimize: { type: "boolean" },
            id: { type: "string" },
          },
        },
      ],
    },
    message: {
      type: "object",
      required: ["role"],
      additionalProperties: false,
      properties: {
        role: { enum: ["system", "user", "assistant"] },
        template: { $ref: "#/definitions/templateString" },
        content: { type: "string" },
        optimize: { type: "boolean", default: false },
        id: { type: "string" },
      },
      oneOf: [
        {
          required: ["template"],
          not: { required: ["content"] },
        },
        {
          required: ["content"],
          not: { required: ["template"] },
        },
      ],
    },
    outputFieldType: {
      oneOf: [
        { type: "null" },
        {
          type: "string",
          pattern: "^(string|number|integer|int|boolean|bool)(\\[\\])*$",
        },
        { type: "array", minItems: 1 },
        { $ref: "#/definitions/outputShorthand" },
      ],
    },
    outputShorthand: {
      type: "object",
      minProperties: 1,
      additionalProperties: { $ref: "#/definitions/outputFieldType" },
    },
    tool: {
      type: "object",
      additionalProperties: false,
      properties: {
        description: { type: "string" },
        optimize: { type: "boolean", default: false },
        input: {
          oneOf: [
            {
              type: "object",
              required: ["schema"],
              additionalProperties: false,
              properties: { schema: { type: "object" } },
            },
            {
              allOf: [
                { $ref: "#/definitions/outputShorthand" },
                { not: { required: ["schema"] } },
              ],
            },
          ],
        },
        strict: { type: "boolean" },
      },
    },
  },
} as const;

const SHORTHAND_TYPES: Record<string, Record<string, string>> = {
  string: { type: "string" },
  number: { type: "number" },
  integer: { type: "integer" },
  int: { type: "integer" },
  boolean: { type: "boolean" },
  bool: { type: "boolean" },
};

export function compileOutputShorthand(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, fieldSchema(value)]),
    ),
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

function fieldSchema(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { type: "string" };
  }

  if (typeof value === "string") {
    if (value.endsWith("[]")) {
      return { type: "array", items: fieldSchema(value.slice(0, -2)) };
    }
    const schema = SHORTHAND_TYPES[value];
    if (schema) {
      return { ...schema };
    }
    throw new PromptError(
      `Unknown output field type '${value}' (expected string, number, integer, boolean, '<type>[]', enum values, or nested mapping).`,
    );
  }

  if (Array.isArray(value)) {
    return { enum: [...value] };
  }

  if (typeof value === "object") {
    return compileOutputShorthand(value as Record<string, unknown>);
  }

  throw new PromptError(`Unknown output field type: ${String(value)}`);
}
