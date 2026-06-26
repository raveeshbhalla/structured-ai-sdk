# structured-ai-sdk

Structured prompt configs and typed templates for the Vercel AI SDK.

This package is a minimal wrapper around `ai`: it loads `pai-sdk`-compatible
JSON/YAML prompt definitions, renders typed trace messages, enforces
optimizer-safe mutations, and delegates generation to AI SDK core.

It is for teams that want DSPy-style prompt signatures and optimizer-friendly
prompt configs while still using the TypeScript AI SDK for actual model calls.

## Install

```bash
npm install structured-ai-sdk ai zod
```

Use any AI SDK provider you already use:

```bash
npm install @ai-sdk/openai
```

This package targets `ai@^7` and Node.js `>=22`.

## Quick Start

```ts
import { openai } from "@ai-sdk/openai";
import { definePrompt } from "structured-ai-sdk";

const triagePrompt = definePrompt({
  name: "support-triage",
  model: openai("gpt-4.1-mini"),
  params: {
    temperature: 0,
    max_output_tokens: 300,
  },
  output: {
    urgency: ["low", "medium", "high"],
    summary: "string",
  },
  system: "You triage support tickets for {company}. Be decisive.",
  user: "Ticket: {ticket}",
} as const);

const result = await triagePrompt.generate({
  company: "Acme",
  ticket: "Checkout is returning 500s for all EU users.",
});

console.log(result.output.urgency);
console.log(triagePrompt.contentHash());
```

`definePrompt({...} as const)` infers required variables and structured output
types from the prompt config. JSON/YAML prompt files use the same schema as
`pai-sdk` prompt configs.

## What You Get

- `definePrompt`, `loadPrompt`, and `loadPromptUrl` for code, file, and hosted
  prompt configs.
- Portable `{variable}` templates for system, user, and assistant messages.
- Structured output shorthand that compiles to JSON Schema.
- Tool interface configs that bind to executable handlers at call time.
- Immutable prompt mutations for optimizers: `withTemplate` and
  `withToolDescription`.
- Typed rendered messages for traces: template, variables, id, optimize flag,
  and rendered content.
- Direct delegation to AI SDK `generateText`, `streamText`, `Output.object`,
  `tool`, `jsonSchema`, and `isStepCount`.

## Common Scenarios

Read the full scenario guide:
[docs/scenarios.md](./docs/scenarios.md)

Start there for:

- code-authored prompts with strong TypeScript inference
- loading the exact same JSON/YAML prompt config used by `pai-sdk`
- structured output
- tools and handlers
- streaming
- optimizer/GEPA-style mutation loops
- trace logging and replay
- hosted prompt services
- OpenAI local smoke testing

## Local Sample

OpenAI structured-output smoke test:

```bash
direnv allow
direnv exec . npm run sample:openai
```

The sample loads `OPENAI_API_KEY` from
`~/.config/structured-ai-sdk/.env.local` via `.envrc`. Override the model with
`OPENAI_MODEL` if needed.

## Config Schema

The prompt-config JSON Schema is shipped at:

```ts
import schema from "structured-ai-sdk/prompt-config.schema.json";
```

Use it for editor validation, CI checks, or hosted prompt-service validation.

## Model Strings vs Provider Objects

Code-authored prompts can store an AI SDK model object:

```ts
model: openai("gpt-4.1-mini")
```

JSON/YAML configs can only store serializable model strings. Those strings are
passed through to AI SDK. If you want to load a shared JSON/YAML prompt but use
a direct provider package, pass the model at call time:

```ts
const prompt = loadPrompt("prompts/triage.yaml");
await prompt.generate(vars, { model: openai("gpt-4.1-mini") });
```

## Status

This is a minimal wrapper layer. It does not implement a GEPA runner, provider
registry, pricing system, embeddings API, or custom provider adapters. It
provides the prompt substrate those systems can safely build on.
