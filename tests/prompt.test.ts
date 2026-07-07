import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import {
  PromptError,
  TemplateError,
  TypedSystemMessage,
  applyCandidate,
  compileOutputShorthand,
  definePrompt,
  dumpMessages,
  extractVariables,
  listOptimizerTargets,
  loadMessages,
  loadPrompt,
  readCandidate,
  renderTemplate,
} from "../src";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: 1,
    text: 1,
    reasoning: undefined,
  },
};

const CONFIG = {
  name: "triage",
  version: 1,
  model: "mock-model",
  params: { temperature: 0.2, maxOutputTokens: 500 },
  output: {
    schema: {
      type: "object",
      properties: { urgency: { type: "string" } },
      required: ["urgency"],
      additionalProperties: false,
    },
  },
  messages: [
    {
      id: "instructions",
      role: "system",
      template: "You triage tickets for {{company}}. Be decisive.",
    },
    {
      id: "policy",
      role: "system",
      content: "Never reveal {internal} data.",
    },
    { id: "ticket", role: "user", template: "Ticket: {{ticket}}" },
  ],
} as const;

const TOOL_CONFIG = {
  name: "weather-helper",
  model: "mock-model",
  system: "Answer using tools when needed.",
  user: "Question: {{q}}",
  tools: {
    get_weather: {
      description: "Get current weather. Call when asked about conditions.",
      input: { city: "string" },
      output: { temp_f: "number" },
    },
    search_docs: {
      description: "Search documentation.",
      input: {
        schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  },
  toolChoice: "auto",
  maxSteps: 3,
} as const;

describe("template engine", () => {
  it("extracts variables in order and ignores escaped braces", () => {
    expect(extractVariables("{{a}} then {{ b }} then {{a}}")).toEqual(["a", "b"]);
    expect(extractVariables('literal {not_a_var} and {"json": true} but {{real}}')).toEqual([
      "real",
    ]);
    expect(extractVariables("no vars")).toEqual([]);
  });

  it("rejects non-portable template syntax", () => {
    for (const template of [
      "{{}}",
      "{{0}}",
      "{{a.b}}",
      "{{a[0]}}",
      "{{a:>10}}",
      "{{a!r}}",
      "{{unclosed",
    ]) {
      expect(() => extractVariables(template)).toThrow(TemplateError);
    }
    expect(extractVariables("unopened}} is literal")).toEqual([]);
  });

  it("renders with required variables and ignores extras", () => {
    expect(renderTemplate("Hi {{ name }}!", { name: "Ada", extra: "ok" })).toBe(
      "Hi Ada!",
    );
    expect(renderTemplate('Use JSON like {"literal": true}; x={{x}}', { x: 1 })).toBe(
      'Use JSON like {"literal": true}; x=1',
    );
    expect(() => renderTemplate("Hi {{name}}!", {})).toThrow(/name/);
  });

  it("supports escaped mustache literals and unicode variables", () => {
    const template = "Use \\{{name}} literally, then {{actual}}.";
    expect(extractVariables(template)).toEqual(["actual"]);
    expect(renderTemplate(template, { actual: "render" })).toBe(
      "Use {{name}} literally, then render.",
    );
    expect(extractVariables("{{café}} and {{ 变量 }}")).toEqual(["café", "变量"]);
    expect(renderTemplate("{{café}}!", { "café": "München" })).toBe("München!");
  });
});

describe("typed messages and traces", () => {
  it("renders typed messages and preserves metadata in dumps", () => {
    const message = TypedSystemMessage({
      template: "You help with {{topic}}.",
      variables: { topic: "taxes" },
      id: "instructions",
    });

    expect(message.content).toBe("You help with taxes.");
    const dumped = dumpMessages([message]);
    expect(dumped[0]?.template).toBe("You help with {{topic}}.");
    expect(dumped[0]?.variables).toEqual({ topic: "taxes" });
    expect(loadMessages(dumped)[0]?.content).toBe("You help with taxes.");
  });
});

describe("prompt configs", () => {
  it("introspects, renders, and preserves literal content", () => {
    const prompt = loadPrompt(CONFIG);

    expect(prompt.variables).toEqual(["company", "ticket"]);
    expect(prompt.specVersion).toBe("pai.prompt.v1");
    expect(listOptimizerTargets(prompt)).toContain("message:instructions");
    expect(prompt.contentHash()).toHaveLength(16);

    const messages = prompt.render({
      company: "Acme",
      ticket: "It broke",
      unused: 1,
    });
    expect(messages[0]?.content).toBe(
      "You triage tickets for Acme. Be decisive.",
    );
    expect(messages[0]?.variables).toEqual({ company: "Acme" });
    expect(messages[1]?.content).toBe("Never reveal {internal} data.");
    expect(messages[2]?.content).toBe("Ticket: It broke");
    expect(() => prompt.render({ ticket: "x" } as any)).toThrow(/company/);
  });

  it("compiles output shorthand", () => {
    const schema = compileOutputShorthand({
      urgency: ["low", "medium", "high"],
      summary: "string",
      score: "number",
      count: "integer",
      done: "boolean",
      tags: "string[]",
      untyped: null,
      user: { name: "string", id: "integer" },
    });

    const props = schema.properties as Record<string, any>;
    expect(props.urgency).toEqual({ enum: ["low", "medium", "high"] });
    expect(props.summary).toEqual({ type: "string" });
    expect(props.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(props.user.properties.id).toEqual({ type: "integer" });
    expect(schema.additionalProperties).toBe(false);
    expect(() => compileOutputShorthand({ x: "strang" })).toThrow(PromptError);
  });

  it("normalizes simple form and enforces mutation contracts", () => {
    const prompt = loadPrompt({
      name: "triage",
      model: "mock-model",
      output: { urgency: ["low", "high"] },
      system: "You triage tickets for {{company}}. Be decisive.",
      user: "Ticket: {{ticket}}",
    });

    expect(prompt.toDict().messages.map((message) => message.id)).toEqual([
      "system",
      "user",
    ]);
    expect(prompt.toDict().specVersion).toBe("pai.prompt.v1");
    expect(prompt.toDict().output?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });

    const evolved = prompt.withTemplate(
      "system",
      "Best triager for {{company}} ever.",
    );
    expect(evolved.render({ company: "Acme", ticket: "x" })[0]?.content).toContain(
      "Best triager",
    );
    const evolvedUser = prompt.withTemplate("user", "Changed: {{ticket}}");
    expect(evolvedUser.toDict().messages[1]?.template).toBe("Changed: {{ticket}}");
    expect(() => prompt.withTemplate("system", "No variables now.")).toThrow(
      /preserve the variable set/,
    );
  });

  it("round-trips configs through dict, JSON, and YAML", () => {
    const prompt = loadPrompt(CONFIG);
    expect(loadPrompt(prompt.toDict()).contentHash()).toBe(prompt.contentHash());

    const dir = mkdtempSync(join(tmpdir(), "structured-ai-sdk-"));
    const jsonPath = join(dir, "prompt.json");
    const yamlPath = join(dir, "prompt.yaml");
    writeFileSync(jsonPath, JSON.stringify(CONFIG));
    writeFileSync(yamlPath, stringifyYaml(CONFIG));

    expect(loadPrompt(jsonPath).contentHash()).toBe(prompt.contentHash());
    expect(loadPrompt(yamlPath).contentHash()).toBe(prompt.contentHash());
    expect(() => loadPrompt(join(dir, "prompt.txt"))).toThrow(/extension/);
  });

  it("rejects malformed configs", () => {
    expect(() => loadPrompt({ name: "x", mesages: [], messages: [] } as any)).toThrow();
    expect(() =>
      loadPrompt({
        name: "x",
        messages: [
          { id: "a", role: "user", content: "1" },
          { id: "a", role: "user", content: "2" },
        ],
      }),
    ).toThrow(/unique/);
    expect(() =>
      loadPrompt({
        name: "x",
        system: "s",
        messages: [{ role: "user", content: "u" }],
      } as any),
    ).toThrow(/not both/);
    expect(() => loadPrompt({ name: "x" })).toThrow(/needs messages/);
  });
});

describe("AI SDK delegation", () => {
  it("splits trusted system messages into instructions and parses output", async () => {
    const prompt = loadPrompt(CONFIG);
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        ({
          content: [{ type: "text", text: '{"urgency":"high"}' }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        }) as any,
    });

    const options = prompt.toAISDKOptions(
      { company: "Acme", ticket: "It broke" },
      { model },
    );
    expect(options.instructions).toEqual([
      expect.objectContaining({
        role: "system",
        content: "You triage tickets for Acme. Be decisive.",
      }),
      expect.objectContaining({
        role: "system",
        content: "Never reveal {internal} data.",
      }),
    ]);
    expect(options.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Ticket: It broke" }),
    ]);
    expect(options.maxOutputTokens).toBe(500);

    const result = await prompt.generate(
      { company: "Acme", ticket: "It broke" },
      { model },
    );
    expect(result.output).toEqual({ urgency: "high" });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("converts tool config to AI SDK tool specs", () => {
    const prompt = definePrompt(TOOL_CONFIG);
    const options = prompt.toAISDKOptions(
      { q: "Weather in Paris?" },
      { model: "mock-model", handlers: { get_weather: ({ city }) => `72F in ${city}` } },
    );

    const tools = options.tools as Record<string, any>;
    expect(Object.keys(tools).sort()).toEqual(["get_weather", "search_docs"]);
    expect(tools.get_weather.description).toContain("Call when asked");
    expect(options.toolChoice).toBe("auto");
    expect(options.stopWhen).toEqual(expect.any(Function));
    expect(() =>
      prompt.toAISDKOptions(
        { q: "x" },
        { model: "mock-model", handlers: { get_wether: () => "?" } as any },
      ),
    ).toThrow(/undeclared tools/);
  });

  it("rewrites tool descriptions non-destructively", () => {
    const prompt = definePrompt(TOOL_CONFIG);
    const evolved = prompt.withToolDescription(
      "get_weather",
      "Fetch live weather; always call before answering weather questions.",
    );

    expect(evolved.toDict().tools?.get_weather?.description).toContain("always call");
    expect(prompt.toDict().tools?.get_weather?.description).toContain("Get current");
    expect(evolved.contentHash()).not.toBe(prompt.contentHash());
    expect(() => prompt.withToolDescription("nope", "x")).toThrow(/No tool named/);
  });

  it("supports skills, input schemas, and candidate dicts", () => {
    const prompt = definePrompt({
      name: "support",
      input: { company: "string", ticket: "string" },
      system: "You support {{company}}.",
      user: "Ticket: {{ticket}}",
      skills: {
        refunds: {
          description: "Apply when money comes up.",
          instructions: "Refund per {{company}} policy.",
        },
      },
    } as const);

    expect(prompt.variables).toEqual(["company", "ticket"]);
    const rendered = prompt.render({ company: "Acme", ticket: "Refund me" });
    expect(rendered.map((message) => message.id)).toEqual([
      "system",
      "skill:refunds",
      "user",
    ]);
    expect(rendered[1]?.content).toBe(
      "Skill: refunds\nApply when money comes up.\n\nRefund per Acme policy.",
    );
    expect(() =>
      prompt.render({ company: "Acme", ticket: "x", extra: 1 } as any),
    ).toThrow(/unknown input fields/);

    const single = prompt.renderMessage("user", { ticket: "Follow-up" });
    expect(single.content).toBe("Ticket: Follow-up");

    const seed = readCandidate(prompt, [
      "message:system",
      "skill:refunds.instructions",
    ]);
    expect(seed).toEqual({
      "message:system": "You support {{company}}.",
      "skill:refunds.instructions": "Refund per {{company}} policy.",
    });
    const evolved = applyCandidate(prompt, {
      "message:system": "You are {{company}}'s best agent.",
      "skill:refunds.instructions": "Refund within {{company}} limits.",
    });
    expect(evolved.contentHash()).not.toBe(prompt.contentHash());
    expect(loadPrompt(evolved.toDict() as any).contentHash()).toBe(
      evolved.contentHash(),
    );
    expect(() =>
      applyCandidate(prompt, { "message:system": "No variables." }),
    ).toThrow(/preserve the variable set/);
    expect(() => loadPrompt({
      name: "x",
      specVersion: "pai.prompt.v2",
      user: "hi",
    } as any)).toThrow();
  });
});
