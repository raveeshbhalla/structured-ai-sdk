/** PromptSpec: the typed code socket a prompt document plugs into. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PromptError,
  applyCandidate,
  definePromptSpec,
  loadPrompt,
} from "../src";

const triage = definePromptSpec({
  name: "support-triage",
  input: { company: "string", ticket: "string" },
  output: { urgency: ["low", "medium", "high"], summary: "string" },
  tools: {
    lookup_customer: {
      description: "Look up the customer's plan.",
      input: { customer_email: "string" },
      execute: async ({ customer_email }: { customer_email: string }) => ({
        plan: "pro",
        customer_email,
      }),
    },
  },
} as const);

function makeSeed() {
  return triage.document({
    model: "mock-model",
    params: { maxOutputTokens: 500 },
    system: "You triage tickets for {{company}}. Be decisive.",
    user: "Ticket: {{ticket}}",
    maxSteps: 3,
  });
}

describe("PromptSpec", () => {
  it("authors seeds with spec-derived contract sections and exports them", () => {
    const seed = makeSeed();
    const doc = seed.toDict();
    expect(doc.name).toBe("support-triage");
    expect(doc.input?.schema.required).toEqual(["company", "ticket"]);
    expect(doc.output?.schema.required).toEqual(["urgency", "summary"]);
    expect(doc.tools?.lookup_customer?.description).toBe("Look up the customer's plan.");
    expect(JSON.stringify(doc)).not.toContain("execute");

    const dir = mkdtempSync(join(tmpdir(), "prompt-spec-"));
    const path = seed.export(join(dir, "triage.json"));
    expect(loadPrompt(path).contentHash()).toBe(seed.contentHash());
  });

  it("binds optimizer output and rejects the wrong task", () => {
    const seed = makeSeed();
    const optimized = applyCandidate(loadPrompt(seed.toDict() as any), {
      "message:system": "You are {{company}}'s decisive triage lead.",
    });
    const bound = triage.bind(optimized);
    expect(bound.contentHash()).toBe(optimized.contentHash());
    expectTypeOf(bound.render({ company: "x", ticket: "y" })).toBeArray();

    expect(() =>
      triage.bind(loadPrompt({ name: "other-task", user: "Q: {{ticket}}" } as any)),
    ).toThrow(/wrong task/);
  });

  it("binds spec handlers as call defaults (call-time wins)", () => {
    const bound = makeSeed();
    const options = bound.toAISDKOptions(
      { company: "Acme", ticket: "hi" },
      { model: "mock-model" },
    );
    const tools = options.tools as Record<string, any>;
    expect(tools.lookup_customer.execute).toBeDefined(); // auto-bound from spec

    const overridden = bound.toAISDKOptions(
      { company: "Acme", ticket: "hi" },
      { model: "mock-model", handlers: { lookup_customer: () => "override" } },
    );
    expect((overridden.tools as any).lookup_customer.execute).toBeDefined();
  });

  it("enforces the contract but allows extra optional input fields and prose edits", () => {
    const doc = JSON.parse(JSON.stringify(makeSeed().toDict()));

    const withOptional = JSON.parse(JSON.stringify(doc));
    withOptional.input.schema.properties.trace_tag = { type: "string" };
    triage.bind(withOptional); // extra OPTIONAL field allowed

    const prose = JSON.parse(JSON.stringify(doc));
    prose.tools.lookup_customer.description = "Rewritten by the optimizer.";
    triage.bind(prose); // descriptions are optimizer territory

    const missing = JSON.parse(JSON.stringify(doc));
    delete missing.input.schema.properties.company;
    missing.input.schema.required = ["ticket"];
    missing.messages[0].template = "You triage tickets. Be decisive.";
    expect(() => triage.bind(missing)).toThrow(/missing spec fields: company/);

    const stricter = JSON.parse(JSON.stringify(doc));
    stricter.input.schema.properties.tenant = { type: "string" };
    stricter.input.schema.required = ["company", "ticket", "tenant"];
    expect(() => triage.bind(stricter)).toThrow(/required fields/);

    const drifted = JSON.parse(JSON.stringify(doc));
    drifted.output.schema.properties.urgency = { type: "integer" };
    expect(() => triage.bind(drifted)).toThrow(/output schema/);

    const toolless = JSON.parse(JSON.stringify(doc));
    delete toolless.tools;
    expect(() => triage.bind(toolless)).toThrow(/does not declare it/);
  });

  it("types output from the spec", () => {
    const bound = makeSeed();
    type Result = Awaited<ReturnType<typeof bound.generate>>;
    expectTypeOf<Result["output"]["urgency"]>().toEqualTypeOf<
      "low" | "medium" | "high"
    >();
  });
});

describe("camelCase document vocabulary", () => {
  it("rejects snake_case params with a hint", () => {
    expect(() =>
      loadPrompt({ name: "x", user: "hi", params: { max_output_tokens: 1 } } as any),
    ).toThrow(/did you mean 'maxOutputTokens'/);
  });

  it("passes params to the AI SDK verbatim and maps toolChoice", () => {
    const prompt = loadPrompt({
      name: "x",
      user: "Q: {{q}}",
      params: { maxOutputTokens: 500, providerOptions: { anthropic: { thinking: { type: "adaptive" } } } },
      tools: { lookup: { input: { id: "string" } } },
      toolChoice: { type: "tool", toolName: "lookup" },
      maxSteps: 2,
    } as any);
    const options = prompt.toAISDKOptions({ q: "hi" }, { model: "m" });
    expect(options.maxOutputTokens).toBe(500);
    expect(options.providerOptions).toEqual({ anthropic: { thinking: { type: "adaptive" } } });
    expect(options.toolChoice).toEqual({ type: "tool", toolName: "lookup" });
    expect(prompt.toDict().toolChoice).toEqual({ type: "tool", toolName: "lookup" });
    expect(() =>
      loadPrompt({ name: "x", user: "hi", tool_choice: "auto" } as any),
    ).toThrow(); // old key rejected by the schema
  });
});
