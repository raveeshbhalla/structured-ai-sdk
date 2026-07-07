# structured-ai-sdk

Structured prompt configs and typed templates for the Vercel AI SDK.

This package is a minimal wrapper around `ai`: it runs **pai prompt
documents** (`specVersion: pai.prompt.v1`) — the same JSON/YAML files
`pai-sdk` (Python) runs — renders typed trace messages, enforces
optimizer-safe mutations, and delegates generation to AI SDK core
(`generateText` / `streamText` / `Output.object` / `tool`).

Cross-language parity is enforced, not aspirational: the JSON Schema is
vendored byte-for-byte from pai-sdk, `contentHash()` implements the spec'd
canonical serialization so hashes match Python's exactly, and the shared
conformance fixtures in `spec/conformance/` (copied verbatim from pai-sdk)
run in this repo's test suite. See `spec/README.md`.

## Why this shape: two ideas

This package exists so that prompt improvement can happen **offline**, on
data, instead of by hand-editing strings in code. Two ideas make that work.

### Idea 1 — prompts are documents, so they can be optimized offline

A prompt written as a template literal fuses two very different things:

```ts
const system = `You triage support tickets for ${company}. Be decisive.`;
```

`"Be decisive"` is prose you might want to improve; `${company}` is data flow
you must never break. Fused, neither a human nor an optimizer can safely
rewrite one without risking the other — and every candidate wording is a
code deploy with no identity, no A/B, no rollback.

The prompt document unfuses them:

```ts
const prompt = definePrompt({
  name: "support-triage",
  input: { company: "string", ticket: "string" },
  output: { urgency: ["low", "medium", "high"], summary: "string" },
  system: "You triage support tickets for {{company}}. Be decisive.",
  user: "Ticket: {{ticket}}",
} as const);
```

What that buys, each point backed by a mechanism:

- **Bindings become structural.** `{{company}}` is plumbing, not text:
  `withTemplate()` rejects any rewrite that changes a template's placeholder
  set, so machine rewriting of the prose is safe *by construction*.
- **Every piece of model-facing prose is addressable** — `message:system`,
  `tool:<name>`, `skill:<name>.instructions` — and documents never mark what
  to optimize; each optimizer run picks its targets
  (`readCandidate`/`applyCandidate` speak GEPA `optimize_anything`'s
  `{address: text}` candidate shape).
- **Prompts get identity.** `contentHash()` names a candidate — pin, A/B,
  roll back — and hashes are byte-identical with pai-sdk (Python), because
  it is the *same JSON document* on both sides.
- **Improvement ships as data.** The optimizer's winner is
  `applyCandidate(prompt, best).toDict()` — plain JSON with the same
  variables, ids, and schemas as the seed (the adoption guarantee), so your
  app picks it up with `loadPrompt`/`spec.load()` and no code change:

```ts
const prompt = triage.load("prompts/support-triage.optimized.json");
result.output.urgency;   // still "low" | "medium" | "high" — typed via definePromptSpec
```

### Idea 2 — history is ModelMessage[], so production logs become optimization data

Offline optimization needs rollouts: what the model actually saw and did,
including tool calls and results — not just an `input -> output` row. Here,
`render()` returns real AI SDK `ModelMessage`s that *also* carry their
`template`, bound `variables`, and message `id`, and `dumpMessages()`
serializes them losslessly:

```ts
await db.traces.insert({
  promptHash: prompt.contentHash(),          // which candidate produced this
  messages: dumpMessages([...prompt.render(vars), ...(await result.response).messages]),
});
```

Because the message wire format and the document hash are shared with
pai-sdk, those logs are directly consumable by the Python-side optimization
tooling: recreate replayable history from stored messages (or straight from
an OTEL backend via `trace_from_otel_spans`), replay spans under candidate
prompts, feed `span_feedback` to a reflective optimizer — then ship the
optimized JSON back to this app. **Serve in TypeScript, log everywhere,
optimize offline, adopt by data update.** The document is the bridge; no
runtime ever needs to know an optimizer exists.

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
  system: "You triage support tickets for {{company}}. Be decisive.",
  user: "Ticket: {{ticket}}",
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
  prompt documents.
- Portable Mustache-style `{{variable}}` templates (with `\{{` escaping and
  unicode variable names) for system, user, and assistant messages. Single
  braces are literal text, so JSON examples can appear naturally in templates.
- Structured `input`/`output` shorthand that compiles to JSON Schema, with
  render-time input validation.
- Tool interface configs — description + input/output schemas — that bind to
  executable handlers at call time.
- Skills: named, addressable prose blocks (`description` = when,
  `instructions` = templated how) rendered as `skill:<name>` system messages.
- `definePromptSpec`: the typed code socket optimizer-produced documents
  plug into — load-time contract validation, spec-typed `result.output`,
  pre-bound tool handlers, `document()`/`export()` for authoring seeds.
- Immutable prompt mutations for optimizers: `withTemplate`,
  `withToolDescription`, `withSkillDescription`, `withSkillInstructions` —
  plus `readCandidate` / `applyCandidate` over `{address: text}` dicts (the
  GEPA `optimize_anything` candidate shape) and `renderMessage` for typed
  mid-conversation turns. Documents never carry optimization intent; optimizer
  scripts choose target addresses per run.
- Typed rendered messages for traces: template, variables, id, and rendered
  content.
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

Samples:

```bash
direnv allow
direnv exec . npm run sample:template
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
