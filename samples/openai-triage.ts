import { openai } from "@ai-sdk/openai";

import { definePrompt } from "../src";

const modelId = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";

const prompt = definePrompt({
  name: "openai-support-triage",
  model: openai(modelId),
  params: {
    temperature: 0,
    max_output_tokens: 220,
  },
  output: {
    urgency: ["low", "medium", "high"],
    summary: "string",
    next_action: "string",
  },
  system:
    "You triage support tickets for {company}. Be concise and choose the smallest useful next action.",
  user: "Ticket: {ticket}",
} as const);

const variables = {
  company: "Acme Cloud",
  ticket:
    "Production deploy is blocked because API requests started returning 500s after rotating a service token.",
};

const result = await prompt.generate(variables);

console.log(
  JSON.stringify(
    {
      model: modelId,
      promptHash: prompt.contentHash(),
      renderedMessages: prompt.render(variables).map((message) => ({
        id: message.id,
        role: message.role,
        optimize: message.optimize,
        content: message.content,
        variables: message.variables,
      })),
      output: result.output,
      usage: result.usage,
      finishReason: result.finishReason,
    },
    null,
    2,
  ),
);
