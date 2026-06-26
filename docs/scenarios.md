# Structured AI SDK Scenario Guide

This guide shows how to use `structured-ai-sdk` in the situations it was built
for: typed prompt definitions, shared JSON/YAML prompt configs, structured
output, tools, optimizer-safe prompt mutation, and traceable model calls.

The short version: define or load a prompt, render it with variables, and call
`generate` or `stream`. The wrapper handles prompt templating and config
contracts; the Vercel AI SDK still performs the model call.

## Mental Model

A prompt config is a data object with:

- `name`: stable prompt name for logs and traces
- `model`: an AI SDK model object or model string
- `params`: default AI SDK call options, written in `pai-sdk` snake_case
- `system` and `user`, or a full `messages` array
- optional `output`: structured-output schema
- optional `tools`: serializable tool interfaces
- optional `max_steps`: tool-loop budget

Rendering creates typed model messages that preserve:

- rendered `content`
- original `template`
- bound `variables`
- stable message `id`
- `optimize` flag

AI SDK providers only see the rendered prompt. Your logs and optimizers can see
the full structured trace.

## Scenario 1: Code-Authored Prompt With TypeScript Inference

Use this when the prompt lives in TypeScript and you want compile-time checks
for variables, tool inputs, and structured output.

```ts
import { openai } from "@ai-sdk/openai";
import { definePrompt } from "structured-ai-sdk";

const prompt = definePrompt({
  name: "support-triage",
  model: openai("gpt-4.1-mini"),
  params: {
    temperature: 0,
    max_output_tokens: 300,
  },
  output: {
    urgency: ["low", "medium", "high"],
    summary: "string",
    tags: "string[]",
  },
  system: "You triage tickets for {company}.",
  user: "Ticket: {ticket}",
} as const);

const result = await prompt.generate({
  company: "Acme",
  ticket: "Checkout is down.",
});

result.output.urgency; // "low" | "medium" | "high"
result.output.tags; // string[]
```

Why `as const` matters: TypeScript can only infer literal template variables
and enum values when the config is preserved as a literal type.

## Scenario 2: Load The Same YAML/JSON Config Used By `pai-sdk`

Use this when prompts live in a repo, database, or prompt service and need to
run in both Python `pai-sdk` and TypeScript.

```yaml
# prompts/support-triage.yaml
name: support-triage
model: openai/gpt-4.1-mini
params:
  temperature: 0
  max_output_tokens: 300
output:
  urgency: [low, medium, high]
  summary: string
system: |
  You triage support tickets for {company}. Be decisive.
user: "Ticket: {ticket}"
```

```ts
import { loadPrompt } from "structured-ai-sdk";

const prompt = loadPrompt("prompts/support-triage.yaml");

const result = await prompt.generate({
  company: "Acme",
  ticket: "Checkout is down.",
});
```

Runtime-loaded configs are validated and safe to run. Since TypeScript cannot
see YAML contents at compile time, variable and output types are runtime-first
unless you add your own generic wrapper or codegen later.

### Model Strings In JSON/YAML

JSON and YAML configs can only store serializable model strings:

```yaml
model: openai/gpt-4.1-mini
```

The wrapper passes that string through to AI SDK. In AI SDK 7, model strings are
useful for AI Gateway-style calls. If you want direct provider-package calls,
load the prompt from YAML and override the model in code:

```ts
import { openai } from "@ai-sdk/openai";
import { loadPrompt } from "structured-ai-sdk";

const prompt = loadPrompt("prompts/support-triage.yaml");

const result = await prompt.generate(
  {
    company: "Acme",
    ticket: "Checkout is down.",
  },
  {
    model: openai("gpt-4.1-mini"),
  },
);
```

## Scenario 3: Structured Output

Use shorthand for common object outputs:

```ts
const prompt = definePrompt({
  name: "lead-score",
  model,
  output: {
    score: "number",
    qualified: "boolean",
    reasons: "string[]",
    contact: {
      name: "string",
      employee_count: "integer",
    },
  },
  system: "Score sales leads for {company}.",
  user: "{lead}",
} as const);
```

The shorthand compiles to strict JSON Schema:

- all fields are required
- nested objects are supported
- arrays use `type[]`, such as `string[]`
- enum fields use arrays of literals, such as `[low, medium, high]`
- `null` or an empty YAML value means `string`
- additional properties are rejected

Use full JSON Schema when you need more control:

```ts
const prompt = definePrompt({
  name: "extract-date",
  model,
  output: {
    schema: {
      type: "object",
      properties: {
        iso_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      },
      required: ["iso_date"],
      additionalProperties: false,
    },
    name: "date_extraction",
    description: "Extract exactly one ISO date.",
  },
  system: "Extract dates.",
  user: "{text}",
} as const);
```

Internally this becomes `Output.object({ schema: jsonSchema(...) })`.

## Scenario 4: Tools Declared In Config, Handlers Bound In Code

Use this when tool interfaces should be optimizable/configurable, but tool
behavior must remain code.

```ts
const weatherPrompt = definePrompt({
  name: "weather-helper",
  model,
  system: "Use tools when needed.",
  user: "Question: {question}",
  tools: {
    get_weather: {
      description: "Get current weather. Call for weather questions.",
      optimize: true,
      input: {
        city: "string",
      },
    },
  },
  tool_choice: "auto",
  max_steps: 3,
} as const);

const result = await weatherPrompt.generate(
  { question: "Weather in Paris?" },
  {
    handlers: {
      get_weather: async ({ city }) => {
        return { city, forecast: "72F and sunny" };
      },
    },
  },
);
```

Rules:

- config declares tool name, description, input schema, and `strict`
- `handlers` bind executable functions by name at call time
- undeclared handlers throw, which catches typos
- declared tools without handlers are client-side tools; AI SDK returns calls
  instead of executing them automatically
- `max_steps` maps to AI SDK `isStepCount(n)`
- `tool_choice: { type: "tool", tool_name: "get_weather" }` maps to AI SDK
  `{ type: "tool", toolName: "get_weather" }`

Tool descriptions can be optimized when `optimize: true`; names and schemas
are the stable contract.

## Scenario 5: Streaming

Use `prompt.stream` when you want AI SDK streaming, with the same rendered
prompt and config behavior.

```ts
const stream = prompt.stream({
  company: "Acme",
  ticket: "The export job has been stuck for 45 minutes.",
});

for await (const delta of stream.textStream) {
  process.stdout.write(delta);
}

const finalOutput = await stream.output;
```

If the config has `output`, the stream uses the corresponding AI SDK structured
output mode.

## Scenario 6: Optimizer Or GEPA-Style Prompt Mutation

Use this when an optimizer may rewrite instructions but must not break call
sites.

```ts
const prompt = definePrompt({
  name: "support-triage",
  model,
  messages: [
    {
      id: "instructions",
      role: "system",
      optimize: true,
      template: "You triage tickets for {company}. Be decisive.",
    },
    {
      id: "ticket",
      role: "user",
      template: "Ticket: {ticket}",
    },
  ],
} as const);

const evolved = prompt.withTemplate(
  "instructions",
  "You are {company}'s senior incident triage assistant. Be precise.",
);

console.log(prompt.contentHash());
console.log(evolved.contentHash());
```

The mutation contract is enforced:

- only messages with `optimize: true` can be rewritten
- the new template must preserve the exact variable set
- mutation returns a new `Prompt`; the original is unchanged
- `contentHash()` gives a stable candidate identity
- `toDict()` serializes the evolved config back to JSON/YAML-compatible data

Tool descriptions have the same pattern:

```ts
const evolved = prompt.withToolDescription(
  "get_weather",
  "Fetch current weather. Always call before answering weather questions.",
);
```

This package does not run GEPA itself. It provides the safe mutation substrate
for a GEPA runner or evaluation system.

## Scenario 7: Trace Logging And Replay

Use `render`, `dumpMessages`, and `loadMessages` when you need logs that
separate instructions from variable bindings.

```ts
import { dumpMessages, loadMessages } from "structured-ai-sdk";

const rendered = prompt.render({
  company: "Acme",
  ticket: "Checkout is down.",
});

const trace = dumpMessages(rendered);

await db.traces.insert({
  promptName: prompt.name,
  promptHash: prompt.contentHash(),
  messages: trace,
});

const replayableMessages = loadMessages(trace);
```

Each typed message includes the rendered `content` plus the original
`template`, `variables`, `id`, and `optimize` metadata.

## Scenario 8: Multiple System Blocks And Prompt Safety

AI SDK 7 prefers trusted system instructions in the top-level `instructions`
field instead of mixed into `messages`.

`structured-ai-sdk` keeps your config shape intact for traces, but when calling
AI SDK it:

- renders system messages into `instructions`
- renders user/assistant messages into `messages`
- keeps `render()` returning the full typed message list

This lets configs use multiple system blocks for optimizer control:

```ts
const prompt = definePrompt({
  name: "policy-plus-instructions",
  model,
  messages: [
    {
      id: "instructions",
      role: "system",
      optimize: true,
      template: "Answer for {audience}.",
    },
    {
      id: "policy",
      role: "system",
      content: "Never reveal internal secrets.",
    },
    {
      id: "question",
      role: "user",
      template: "{question}",
    },
  ],
} as const);
```

The optimizer can rewrite `instructions` but cannot rewrite the frozen policy
block.

## Scenario 9: Hosted Prompt Service

Use `loadPromptUrl` when prompts are served by an internal service.

```ts
import { loadPromptUrl } from "structured-ai-sdk";

const prompt = await loadPromptUrl("https://prompts.internal/support-triage", {
  headers: {
    authorization: `Bearer ${process.env.PROMPT_SERVICE_TOKEN}`,
  },
  format: "json",
});

const result = await prompt.generate({
  company: "Acme",
  ticket: "Checkout is down.",
});
```

The server should return the same JSON/YAML config shape used by `pai-sdk`.
Validate uploads with `prompt-config.schema.json`.

## Scenario 10: Local OpenAI Smoke Test

The repo includes a sample at `samples/openai-triage.ts`.

Create `~/.config/structured-ai-sdk/.env.local`:

```bash
OPENAI_API_KEY=sk-...
# optional
OPENAI_MODEL=gpt-4.1-mini
```

Then run:

```bash
direnv allow
direnv exec . npm run sample:openai
```

The sample prints:

- selected model
- prompt content hash
- rendered typed messages
- validated structured output
- token usage
- finish reason

## Prompt Config Reference

### Simple Form

```yaml
name: support-triage
model: openai/gpt-4.1-mini
params:
  temperature: 0
system: "You triage tickets for {company}."
user: "Ticket: {ticket}"
```

Simple form defaults:

- `system` normalizes to message id `system`
- `system` is `optimize: true`
- `user` normalizes to message id `user`
- `user` is not optimizable

### General Form

```yaml
name: support-triage
messages:
  - id: instructions
    role: system
    optimize: true
    template: "You triage tickets for {company}."
  - id: policy
    role: system
    content: "Never reveal internal data."
  - id: ticket
    role: user
    template: "Ticket: {ticket}"
```

Use general form for:

- multiple system blocks
- frozen policy text
- few-shot assistant turns
- stable optimizer ids
- per-message `optimize` control

Each message must have exactly one of `template` or `content`.

## Template Rules

Supported:

```txt
Hello {name}
Literal braces: {{ and }}
```

Rejected:

```txt
{}
{0}
{user.name}
{items[0]}
{name:>10}
{name!r}
```

This intentionally small syntax keeps templates portable across Python and
TypeScript.

## API Cheat Sheet

```ts
definePrompt(config);
loadPrompt("path/to/prompt.yaml");
loadPromptUrl("https://...");

prompt.variables;
prompt.render(vars);
prompt.generate(vars, options);
prompt.stream(vars, options);
prompt.withTemplate(messageId, newTemplate);
prompt.withToolDescription(toolName, newDescription);
prompt.optimizableMessages();
prompt.optimizableTools();
prompt.contentHash();
prompt.toDict();

extractVariables(template);
renderTemplate(template, vars);
dumpMessages(messages);
loadMessages(messagesOrJson);
compileOutputShorthand(fields);
```

## Common Errors

### Missing Variables

```txt
Prompt 'support-triage' is missing variables: company.
```

Pass every placeholder used by every template message. Extra variables are
ignored at runtime.

### Disallowed Template Mutation

```txt
Message 'ticket' is not marked optimize: true; it must not be rewritten.
```

Only messages explicitly marked `optimize: true` can be changed with
`withTemplate`.

### Variable Set Changed

```txt
Template mutation for 'instructions' must preserve the variable set ...
```

Optimizer-produced templates must keep the same placeholders as the original
message.

### Undeclared Tool Handler

```txt
Handlers for undeclared tools: get_wether. Declared tools: get_weather.
```

Handlers must match tool names declared in the prompt config.

## Design Boundaries

This package intentionally stays small:

- no GEPA runner
- no eval runner
- no provider abstraction beyond AI SDK
- no pricing table
- no embeddings wrapper
- no prompt registry

It is the shared prompt/data/trace layer that those systems can build on.
