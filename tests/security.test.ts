/** Regressions for the security review: prototype-chain safety on untrusted
 * documents, canonical number parity, and skill-order invariance. */

import { describe, expect, it } from "vitest";

import {
  applyCandidate,
  canonicalJson,
  definePrompt,
  loadPrompt,
  readOptimizerTarget,
  renderTemplate,
} from "../src";

describe("prototype-chain safety on untrusted documents", () => {
  it("treats Object.prototype names as ordinary missing variables", () => {
    const prompt = loadPrompt({ name: "x", user: "Hi {{constructor}}" } as any);
    expect(() => prompt.render({} as any)).toThrow(/missing variables: constructor/);
    expect(prompt.render({ constructor: "Ada" } as any)[0]?.content).toBe("Hi Ada");
    expect(() => renderTemplate("{{toString}}", {})).toThrow(/Missing template/);
  });

  it("does not resolve tools or skills through the prototype", () => {
    const noTools = loadPrompt({ name: "x", user: "hi" } as any);
    expect(() => noTools.withToolDescription("constructor", "evil")).toThrow(
      /No tool named 'constructor'/,
    );
    expect(() =>
      noTools.toAISDKOptions({} as any, {
        model: "m",
        handlers: { constructor: () => "?" } as any,
      }),
    ).toThrow(/undeclared tools: constructor/);
    expect(() => readOptimizerTarget(noTools, "tool:constructor")).toThrow(
      /No tool named/,
    );
    expect(() =>
      readOptimizerTarget(noTools, "skill:constructor.description"),
    ).toThrow(/No skill named/);
    expect(() =>
      applyCandidate(noTools, { "tool:constructor": "evil" }),
    ).toThrow(/No tool named/);
  });

  it("keeps a declared 'constructor' tool client-side without a handler", () => {
    const prompt = loadPrompt({
      name: "x",
      user: "hi",
      tools: { constructor: { description: "d", input: { q: "string" } } },
    } as any);
    const options = prompt.toAISDKOptions({} as any, { model: "m" });
    const tools = options.tools as Record<string, any>;
    // no handler bound -> no execute function inherited from Object
    expect(tools["constructor"]!.execute).toBeUndefined();
  });

  it("validates required/extra input fields named like prototype members", () => {
    const prompt = loadPrompt({
      name: "x",
      input: { schema: {
        type: "object",
        properties: { constructor: { type: "string" } },
        required: ["constructor"],
        additionalProperties: false,
      } },
      user: "Hi {{constructor}}",
    } as any);
    expect(() => prompt.validateInputs({})).toThrow(/missing required input fields/);
    expect(() =>
      prompt.validateInputs({ constructor: "x", hasOwnProperty: "y" }),
    ).toThrow(/unknown input fields: hasOwnProperty/);
  });
});

describe("canonical JSON parity", () => {
  it("formats numbers like Python's canonical_prompt_json", () => {
    expect(
      canonicalJson({
        a: 0.00001,
        b: 1e-7,
        c: 1e21,
        d: 1.0,
        e: 123.456,
        f: -0,
      }),
    ).toBe('{"a":0.00001,"b":1e-7,"c":1000000000000000000000,"d":1,"e":123.456,"f":0}');
  });

  it("emits null for undefined array items instead of invalid JSON", () => {
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
    expect(canonicalJson([undefined])).toBe("[null]");
  });
});

describe("skill order is not semantic", () => {
  it("renders and hashes identically regardless of declaration order", () => {
    const base = { name: "x", system: "Base.", user: "Q: {{q}}" };
    const ab = definePrompt({
      ...base,
      skills: {
        alpha: { description: "a", instructions: "A" },
        beta: { description: "b", instructions: "B" },
      },
    } as any);
    const ba = definePrompt({
      ...base,
      skills: {
        beta: { description: "b", instructions: "B" },
        alpha: { description: "a", instructions: "A" },
      },
    } as any);
    expect(ab.contentHash()).toBe(ba.contentHash());
    const ids = (p: typeof ab) => p.render({ q: "hi" } as any).map((m) => m.id);
    expect(ids(ba)).toEqual(ids(ab));
    expect(ids(ab)).toEqual(["system", "skill:alpha", "skill:beta", "user"]);
  });
});

describe("template identifier parity", () => {
  it("rejects skill names with trailing newlines at load", () => {
    expect(() =>
      loadPrompt({
        name: "x",
        user: "hi",
        skills: { "esc\n": { description: "d", instructions: "i" } },
      } as any),
    ).toThrow();
  });
});
