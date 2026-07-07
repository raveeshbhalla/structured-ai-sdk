/**
 * Skills + optimizer candidates, end to end:
 *
 * 1. Define a prompt document with a skill and a tool (typed via `as const`).
 * 2. Run it — the skill renders as a `skill:<name>` system message and the
 *    tool handler binds by name.
 * 3. Read a `{address: text}` seed candidate, apply an evolved candidate, and
 *    persist the optimized document as plain JSON (what a GEPA
 *    optimize_anything runner would do; GEPA itself stays external).
 *
 * Run: direnv exec . npm run sample:skills
 */

import { writeFileSync } from "node:fs";

import { openai } from "@ai-sdk/openai";
import {
  applyCandidate,
  definePrompt,
  dumpMessagesJson,
  loadPrompt,
  readCandidate,
} from "../src";

const modelId = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

const prompt = definePrompt({
  name: "support-agent",
  input: { company: "string", ticket: "string" },
  output: { reply: "string", escalate: "boolean" },
  system:
    "You are the support agent for {{company}}. Look up the customer's plan before answering account questions.",
  user: "{{ticket}}",
  skills: {
    refunds: {
      description: "Apply when the customer asks for money back.",
      instructions:
        "Refunds at {{company}}: plan 'pro' allows refunds up to $500 without escalation; anything above must set escalate=true.",
    },
  },
  tools: {
    lookup_customer: {
      description: "Look up the customer's plan and monthly spend.",
      input: { customer_email: "string" },
      output: { plan: "string", monthly_spend: "number" },
    },
  },
  toolChoice: "auto",
  maxSteps: 4,
} as const);

const variables = {
  company: "Acme",
  ticket: "jane@corp.example was double charged $700 last month. Refund it.",
};

const result = await prompt.generate(variables, {
  model: openai(modelId),
  handlers: {
    lookup_customer: async ({ customer_email }) => ({
      plan: "pro",
      monthly_spend: 900,
      customer_email,
    }),
  },
});

// The optimizer side: read the seed, apply an "evolved" candidate, persist.
const targets = ["message:system", "skill:refunds.instructions"];
const seedCandidate = readCandidate(prompt, targets);
const evolved = applyCandidate(prompt, {
  ...seedCandidate,
  "message:system":
    "You are {{company}}'s senior support lead. Verify the account with lookup_customer before any billing answer.",
});
const optimizedDocument = evolved.toDict();
writeFileSync(
  "support-agent.optimized.json",
  JSON.stringify(optimizedDocument, null, 2),
);

console.log(
  JSON.stringify(
    {
      model: modelId,
      promptHash: prompt.contentHash(),
      renderedIds: prompt.render(variables).map((message) => message.id),
      escalate: result.output.escalate,
      steps: result.steps.length,
      renderedMessages: JSON.parse(dumpMessagesJson(prompt.render(variables))),
      seedCandidate,
      evolvedHash: evolved.contentHash(),
      optimizedDocumentReloads:
        loadPrompt(optimizedDocument as any).contentHash() === evolved.contentHash(),
    },
    null,
    2,
  ),
);
