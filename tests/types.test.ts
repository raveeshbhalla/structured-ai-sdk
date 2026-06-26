import { describe, expectTypeOf, it } from "vitest";

import { definePrompt } from "../src";
import type {
  PromptHandlers,
  PromptOutput,
  PromptToolInputs,
  PromptVariables,
} from "../src";

const config = {
  name: "triage",
  model: "mock-model",
  output: {
    urgency: ["low", "high"],
    tags: "string[]",
    user: { id: "integer", active: "boolean" },
  },
  system: "You triage tickets for {{ company }}.",
  user: "Ticket: {{ticket}}",
  tools: {
    get_weather: {
      description: "Get current weather.",
      input: { city: "string", count: "integer" },
    },
  },
} as const;

describe("type helpers", () => {
  it("infers variables from literal prompt configs", () => {
    expectTypeOf<PromptVariables<typeof config>>().toMatchTypeOf<{
      company: unknown;
      ticket: unknown;
    }>();

    const prompt = definePrompt(config);
    prompt.render({ company: "Acme", ticket: "It broke" });
    if (false) {
      // @ts-expect-error ticket is required
      prompt.render({ company: "Acme" });
    }
  });

  it("infers output shorthand", () => {
    expectTypeOf<PromptOutput<typeof config>>().toEqualTypeOf<{
      readonly urgency: "low" | "high";
      readonly tags: string[];
      readonly user: {
        readonly id: number;
        readonly active: boolean;
      };
    }>();
  });

  it("infers tool input shorthand and handler inputs", () => {
    expectTypeOf<PromptToolInputs<typeof config>>().toEqualTypeOf<{
      readonly get_weather: {
        readonly city: string;
        readonly count: number;
      };
    }>();

    const handlers: PromptHandlers<typeof config> = {
      get_weather(input) {
        expectTypeOf(input.city).toEqualTypeOf<string>();
        expectTypeOf(input.count).toEqualTypeOf<number>();
        return `Weather in ${input.city}`;
      },
    };

    expectTypeOf(handlers).toMatchTypeOf<PromptHandlers<typeof config>>();
  });
});
