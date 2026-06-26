import { definePrompt } from "../src";

const prompt = definePrompt({
  name: "brace-safe-template",
  system:
    'Return JSON shaped like {"status": "ok"} when useful. You are helping {{company}}.',
  user: "Ticket: {{ticket}}",
} as const);

const messages = prompt.render({ company: "Acme", ticket: "Login fails" });

console.log(`variables: ${prompt.variables.join(", ")}`);
for (const message of messages) {
  console.log(`${message.role}: ${message.content}`);
}
