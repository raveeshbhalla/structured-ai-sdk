/**
 * Run the shared spec/conformance fixtures — the cross-language contract with
 * pai-sdk. The fixture files are copied verbatim from pai-sdk's
 * spec/conformance/; a change that breaks one is a spec change, not a casual
 * edit. See spec/README.md.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PROMPT_CONFIG_SCHEMA, loadPrompt } from "../src";

const FIXTURES_DIR = join(__dirname, "..", "spec", "conformance");
const FIXTURE_FILES = readdirSync(FIXTURES_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

type Fixture = {
  description?: string;
  document?: Record<string, unknown>;
  expect?: {
    variables?: string[];
    messageIds?: (string | null)[];
    contentHash?: string;
    roundTrip?: boolean;
  };
  cases?: Array<{
    variables?: Record<string, unknown>;
    messages?: Array<{ role: string; id?: string | null; content: string }>;
    error?: boolean;
  }>;
  invalid?: Array<Record<string, unknown>>;
};

describe("spec conformance", () => {
  it("has fixtures to run", () => {
    expect(FIXTURE_FILES.length).toBeGreaterThan(0);
  });

  it("embeds the vendored schema byte-for-byte", () => {
    const vendored = JSON.parse(
      readFileSync(join(__dirname, "..", "prompt-config.schema.json"), "utf8"),
    );
    expect(JSON.parse(JSON.stringify(PROMPT_CONFIG_SCHEMA))).toEqual(vendored);
  });

  for (const file of FIXTURE_FILES) {
    it(file.replace(/\.json$/, ""), () => {
      const fixture = JSON.parse(
        readFileSync(join(FIXTURES_DIR, file), "utf8"),
      ) as Fixture;

      for (const invalid of fixture.invalid ?? []) {
        expect(() => loadPrompt(invalid as any), JSON.stringify(invalid)).toThrow();
      }

      if (!fixture.document) {
        return;
      }
      const prompt = loadPrompt(fixture.document as any);

      const expected = fixture.expect ?? {};
      if (expected.variables) {
        expect(prompt.variables).toEqual(expected.variables);
      }
      if (expected.messageIds) {
        expect(prompt.effectiveMessages().map((message) => message.id ?? null)).toEqual(
          expected.messageIds,
        );
      }
      if (expected.contentHash) {
        expect(prompt.contentHash()).toBe(expected.contentHash);
      }
      if (expected.roundTrip) {
        expect(loadPrompt(prompt.toDict() as any).contentHash()).toBe(
          prompt.contentHash(),
        );
      }

      for (const testCase of fixture.cases ?? []) {
        if (testCase.error) {
          expect(() => prompt.render((testCase.variables ?? {}) as any)).toThrow();
          continue;
        }
        const rendered = prompt.render((testCase.variables ?? {}) as any).map(
          (message) => ({
            role: message.role,
            id: message.id ?? null,
            content: message.content,
          }),
        );
        const expectedMessages = (testCase.messages ?? []).map((message) => ({
          role: message.role,
          id: message.id ?? null,
          content: message.content,
        }));
        expect(rendered).toEqual(expectedMessages);
      }
    });
  }
});
