/**
 * PromptSpec — the typed code socket a prompt document plugs into.
 *
 * The document (JSON) owns everything model-facing: templates, skill prose,
 * tool descriptions, model, params — what an external optimization plane
 * (e.g. Orizu) evolves. The spec owns what JSON cannot carry: TypeScript
 * types (via `as const` schemas) and executable tool handlers.
 *
 *     const triage = definePromptSpec({
 *       name: "support-triage",
 *       input: { company: "string", ticket: "string" },
 *       output: { urgency: ["low", "medium", "high"], summary: "string" },
 *       tools: {
 *         lookup_customer: {
 *           description: "Look up the customer's plan.",   // seed text
 *           input: { customer_email: "string" },
 *           execute: async ({ customer_email }) => lookup(customer_email),
 *         },
 *       },
 *     } as const);
 *
 *     // Day 0 — author the seed text through the spec:
 *     const seed = triage.document({
 *       model: "anthropic/claude-haiku-4-5",
 *       system: "You triage tickets for {{company}}. Be decisive.",
 *       user: "Ticket: {{ticket}}",
 *     });
 *     seed.export("prompts/support-triage.json");   // -> optimizer ingests
 *
 *     // Every day after — plug the optimized JSON back in:
 *     const prompt = triage.load("prompts/support-triage.optimized.json");
 *     const result = await prompt.generate({ company: "Acme", ticket: "..." });
 *     result.output.urgency;                        // typed from the spec
 *
 * `bind()`/`load()` enforce the adoption contract at load time (name,
 * required input fields + types, output/tool schema compatibility; prose is
 * ignored). Anything `applyCandidate` produces binds by construction. A spec
 * is optional — every document also runs untyped via plain `loadPrompt`.
 */

import { PromptError } from "./errors";
import { Prompt, loadPrompt, loadPromptUrl } from "./prompt";
import { compileOutputShorthand } from "./schema";
import type {
  OutputShorthand,
  PromptConfig,
  PromptHandler,
  PromptInputConfig,
  PromptMessageConfig,
  PromptOutputConfig,
  PromptSkillConfig,
  SimplePromptMessageConfig,
  ToolChoiceConfig,
} from "./types";

export type SpecToolConfig = {
  description?: string; // seed text; optimizer territory thereafter
  input?: OutputShorthand | { schema: Record<string, unknown> };
  output?: OutputShorthand | { schema: Record<string, unknown> };
  strict?: boolean;
  execute?: PromptHandler<any>;
};

export type PromptSpecConfig = {
  name: string;
  input?: PromptInputConfig;
  output?: PromptOutputConfig;
  tools?: Record<string, SpecToolConfig>;
};

/** Document text/config keys — everything the spec does NOT derive. */
export type SpecDocumentText = {
  model?: unknown;
  version?: string | number;
  description?: string;
  params?: Record<string, unknown>;
  system?: SimplePromptMessageConfig;
  user?: SimplePromptMessageConfig;
  messages?: readonly PromptMessageConfig[];
  skills?: Record<string, PromptSkillConfig>;
  toolChoice?: ToolChoiceConfig;
  maxSteps?: number;
};

/** The PromptConfig shape a spec projects onto its bound prompts, so
 * PromptOutput/PromptToolInputs/PromptHandlers infer from the spec. */
export type SpecPromptShape<S extends PromptSpecConfig> = Omit<
  PromptConfig,
  "input" | "output" | "tools"
> &
  (S extends { input: infer I } ? { input: I } : {}) &
  (S extends { output: infer O } ? { output: O } : {}) &
  (S extends { tools: infer T } ? { tools: T } : {});

const IGNORED_SCHEMA_KEYS = new Set(["title", "description"]);

function comparableSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(comparableSchema);
  }
  if (schema !== null && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema as Record<string, unknown>)
        .filter(([key]) => !IGNORED_SCHEMA_KEYS.has(key))
        .map(([key, value]) => [key, comparableSchema(value)]),
    );
  }
  return schema;
}

function schemasCompatible(expected: unknown, actual: unknown): boolean {
  return (
    JSON.stringify(comparableSchema(expected)) ===
    JSON.stringify(comparableSchema(actual))
  );
}

function toSchema(
  config: OutputShorthand | { schema: Record<string, unknown> } | undefined,
): Record<string, unknown> | undefined {
  if (config === undefined) {
    return undefined;
  }
  if ("schema" in config) {
    return (config as { schema: Record<string, unknown> }).schema;
  }
  return compileOutputShorthand(config as Record<string, unknown>);
}

export class PromptSpec<S extends PromptSpecConfig = PromptSpecConfig> {
  constructor(readonly spec: S) {
    if (!spec.name) {
      throw new PromptError("A PromptSpec needs a name.");
    }
  }

  get name(): string {
    return this.spec.name;
  }

  private handlers(): Record<string, (...args: any[]) => unknown> {
    const handlers: Record<string, (...args: any[]) => unknown> = {};
    for (const [name, toolConfig] of Object.entries(this.spec.tools ?? {})) {
      if (toolConfig.execute) {
        handlers[name] = toolConfig.execute as (...args: any[]) => unknown;
      }
    }
    return handlers;
  }

  // -- authoring: code -> document ----------------------------------------

  /** Author a seed document through the spec: the spec contributes name,
   * schemas, and tool interfaces; you contribute the text. */
  document(text: SpecDocumentText): Prompt<SpecPromptShape<S>> {
    const config: Record<string, unknown> = { name: this.spec.name, ...text };
    if (this.spec.input !== undefined) {
      config.input = this.spec.input;
    }
    if (this.spec.output !== undefined) {
      config.output = this.spec.output;
    }
    if (this.spec.tools !== undefined) {
      config.tools = Object.fromEntries(
        Object.entries(this.spec.tools).map(([name, { execute: _execute, ...rest }]) => [
          name,
          rest,
        ]),
      );
    }
    return new Prompt(config as SpecPromptShape<S>, { handlers: this.handlers() });
  }

  // -- binding: document -> code --------------------------------------------

  /** Validate a document against this spec and return a typed prompt with
   * the spec's handlers bound (call-time `handlers` win). */
  bind(promptOrConfig: Prompt | PromptConfig): Prompt<SpecPromptShape<S>> {
    const document =
      promptOrConfig instanceof Prompt ? promptOrConfig.toDict() : promptOrConfig;
    const prompt = new Prompt(document as SpecPromptShape<S>, {
      handlers: this.handlers(),
    });
    this.validate(prompt);
    return prompt;
  }

  load(source: string | URL | PromptConfig): Prompt<SpecPromptShape<S>> {
    return this.bind(loadPrompt(source as any));
  }

  async loadUrl(
    url: string | URL,
    options?: Parameters<typeof loadPromptUrl>[1],
  ): Promise<Prompt<SpecPromptShape<S>>> {
    return this.bind(await loadPromptUrl(url, options));
  }

  // -- the contract -----------------------------------------------------------

  private validate(prompt: Prompt<any>): void {
    if (prompt.name !== this.spec.name) {
      throw new PromptError(
        `Document is for task '${prompt.name}', not '${this.spec.name}' — ` +
          "refusing to bind the wrong task's prompt.",
      );
    }
    this.validateInput(prompt);
    this.validateOutput(prompt);
    this.validateTools(prompt);
  }

  private validateInput(prompt: Prompt<any>): void {
    if (this.spec.input === undefined) {
      return;
    }
    const docSchema = prompt.inputSchema();
    if (!docSchema) {
      throw new PromptError(
        `Spec '${this.spec.name}' declares a typed input; the document has no input schema.`,
      );
    }
    const specSchema = toSchema(this.spec.input)!;
    const specProps = (specSchema.properties ?? {}) as Record<string, unknown>;
    const docProps = (docSchema.properties ?? {}) as Record<string, unknown>;
    const missing = Object.keys(specProps)
      .filter((name) => !Object.hasOwn(docProps, name))
      .sort();
    if (missing.length > 0) {
      throw new PromptError(
        `Document input schema is missing spec fields: ${missing.join(", ")}.`,
      );
    }
    const specRequired = [...((specSchema.required as string[] | undefined) ?? [])].sort();
    const docRequired = [...((docSchema.required as string[] | undefined) ?? [])].sort();
    if (JSON.stringify(specRequired) !== JSON.stringify(docRequired)) {
      throw new PromptError(
        `Document input required fields [${docRequired.join(", ")}] do not match ` +
          `the spec's [${specRequired.join(", ")}]. (Documents may add extra ` +
          "OPTIONAL fields only.)",
      );
    }
    for (const name of Object.keys(specProps)) {
      if (!schemasCompatible(specProps[name], docProps[name])) {
        throw new PromptError(
          `Document input field '${name}' has a different type than the spec.`,
        );
      }
    }
  }

  private validateOutput(prompt: Prompt<any>): void {
    if (this.spec.output === undefined) {
      return;
    }
    const docSchema = prompt.config.output?.schema;
    if (!schemasCompatible(toSchema(this.spec.output), docSchema)) {
      throw new PromptError(
        `Document output schema does not match spec '${this.spec.name}'.`,
      );
    }
  }

  private validateTools(prompt: Prompt<any>): void {
    for (const [name, toolConfig] of Object.entries(this.spec.tools ?? {})) {
      const docTool = Object.hasOwn(prompt.config.tools, name)
        ? prompt.config.tools[name]
        : undefined;
      if (!docTool) {
        throw new PromptError(
          `Spec '${this.spec.name}' has a handler for tool '${name}' but the ` +
            "document does not declare it.",
        );
      }
      if (!schemasCompatible(toSchema(toolConfig.input), toSchema(docTool.input))) {
        throw new PromptError(
          `Document tool '${name}' input schema does not match the spec's.`,
        );
      }
    }
  }
}

export function definePromptSpec<const S extends PromptSpecConfig>(
  spec: S,
): PromptSpec<S> {
  return new PromptSpec(spec);
}
