import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";

import {
  Output,
  generateText,
  isStepCount,
  jsonSchema,
  streamText,
  tool,
} from "ai";
import type { GenerateTextResult, ModelMessage, StreamTextResult } from "ai";
import Ajv from "ajv";
import { parse as parseYaml } from "yaml";

import { PromptError } from "./errors";
import {
  TypedAssistantMessage,
  TypedSystemMessage,
  TypedUserMessage,
  type TypedModelMessage,
} from "./messages";
import { PROMPT_CONFIG_SCHEMA, compileOutputShorthand } from "./schema";
import { escapeTemplateLiterals, extractVariables } from "./template";
import type {
  PromptConfig,
  PromptHandlers,
  PromptMessageConfig,
  PromptOutput,
  PromptRole,
  PromptSkillConfig,
  PromptToolConfig,
  PromptVariables,
  RuntimePromptVariables,
  SimplePromptMessageConfig,
  ToolChoiceConfig,
} from "./types";

export const PROMPT_SPEC_VERSION = "pai.prompt.v1";

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

type NormalizedSchema = {
  schema: Record<string, unknown>;
  name?: string;
  description?: string;
};

type NormalizedPromptConfig = {
  specVersion: typeof PROMPT_SPEC_VERSION;
  name: string;
  version?: string | number;
  description?: string;
  model?: unknown;
  params: Record<string, unknown>;
  input?: NormalizedSchema;
  output?: NormalizedSchema;
  messages: PromptMessageConfig[];
  tools: Record<string, PromptToolConfig>;
  toolChoice?: ToolChoiceConfig;
  maxSteps?: number;
  skills: Record<string, PromptSkillConfig>;
};

/** The serialized prompt document (`toDict()`): plain JSON, spec-shaped. */
export type PromptDocument = {
  specVersion: typeof PROMPT_SPEC_VERSION;
  name: string;
  version?: string | number;
  description?: string;
  model?: string;
  params?: Record<string, unknown>;
  input?: NormalizedSchema;
  output?: NormalizedSchema;
  messages: PromptMessageConfig[];
  tools?: Record<string, PromptToolConfig>;
  toolChoice?: ToolChoiceConfig;
  maxSteps?: number;
  skills?: Record<string, PromptSkillConfig>;
};

type PromptCallOptions<C> = Record<string, unknown> & {
  model?: unknown;
  handlers?: PromptHandlers<C>;
};

type PromptGenerateResult<C> = GenerateTextResult<
  any,
  any,
  any
> & { readonly output: PromptOutput<C> };

type PromptStreamResult<C> = StreamTextResult<
  any,
  any,
  any
>;

const ajv = new Ajv({ allErrors: true, strict: false });
const validatePromptConfig = ajv.compile(PROMPT_CONFIG_SCHEMA);

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

export type PromptRuntimeOptions = {
  /** Default tool handlers, merged under call-time `handlers` (call-time
   * wins). Set by PromptSpec.bind(); never part of the document. NOTE:
   * mutation helpers (withTemplate, withToolDescription, ...) return plain
   * prompts without these — re-`bind()` the result to restore them. */
  handlers?: Record<string, (...args: any[]) => unknown>;
};

export class Prompt<C = PromptConfig> {
  readonly config: NormalizedPromptConfig;
  private readonly defaultHandlers: Record<string, (...args: any[]) => unknown>;

  constructor(config: C, runtime: PromptRuntimeOptions = {}) {
    this.config = normalizePromptConfig(config as unknown as PromptConfig);
    this.defaultHandlers = { ...(runtime.handlers ?? {}) };
  }

  get name(): string {
    return this.config.name;
  }

  get specVersion(): string {
    return this.config.specVersion;
  }

  /** All template variables across messages and skills, in render order. */
  get variables(): string[] {
    const names: string[] = [];
    for (const message of this.effectiveMessages()) {
      for (const name of messageVariables(message)) {
        if (!names.includes(name)) {
          names.push(name);
        }
      }
    }
    return names;
  }

  /**
   * Stable candidate identity: sha256 of the canonical document JSON,
   * truncated to 16 hex chars. The algorithm is spec'd (spec/README.md) so
   * Python and TypeScript agree on every hash.
   */
  contentHash(): string {
    return createHash("sha256")
      .update(canonicalJson(this.toDict()), "utf8")
      .digest("hex")
      .slice(0, 16);
  }

  /** Serialize back to the portable document form (plain JSON). */
  toDict(): PromptDocument {
    const config = this.config;
    const document: PromptDocument = {
      specVersion: config.specVersion,
      name: config.name,
      messages: config.messages.map((message) => ({ ...message })),
    };
    if (config.version !== undefined) {
      document.version = config.version;
    }
    if (config.description !== undefined) {
      document.description = config.description;
    }
    // Runtime model objects are call-time concerns; only strings are data.
    if (typeof config.model === "string") {
      document.model = config.model;
    }
    if (Object.keys(config.params).length > 0) {
      document.params = deepClone(config.params);
    }
    if (config.input !== undefined) {
      document.input = deepClone(config.input);
    }
    if (config.output !== undefined) {
      document.output = deepClone(config.output);
    }
    if (Object.keys(config.tools).length > 0) {
      document.tools = deepClone(config.tools);
    }
    if (config.toolChoice !== undefined) {
      document.toolChoice = deepClone(config.toolChoice);
    }
    if (config.maxSteps !== undefined) {
      document.maxSteps = config.maxSteps;
    }
    if (Object.keys(config.skills).length > 0) {
      document.skills = deepClone(config.skills);
    }
    return document;
  }

  /** Write the serialized document to a .json file (pretty-printed) — what
   * an external optimizer (or the Python runtime) ingests. */
  export(path: string): string {
    writeFileSync(path, `${JSON.stringify(this.toDict(), null, 2)}\n`);
    return path;
  }

  inputSchema(): Record<string, unknown> | undefined {
    return this.config.input?.schema;
  }

  /**
   * Lightweight top-level validation for prompt input variables: required
   * fields and `additionalProperties: false`, per the spec. Full JSON Schema
   * validation is the caller's choice.
   */
  validateInputs(variables?: RuntimePromptVariables): RuntimePromptVariables {
    const data = { ...(variables ?? {}) };
    const schema = this.config.input?.schema;
    if (!schema) {
      return data;
    }
    const properties = schema.properties as Record<string, unknown> | undefined;
    const required = (schema.required as string[] | undefined) ?? [];
    const missing = required.filter((name) => !Object.hasOwn(data, name));
    if (missing.length > 0) {
      throw new PromptError(
        `Prompt '${this.name}' is missing required input fields: ${missing.join(", ")}.`,
      );
    }
    if (schema.additionalProperties === false && properties !== undefined) {
      const extra = Object.keys(data)
        .filter((name) => !Object.hasOwn(properties, name))
        .sort();
      if (extra.length > 0) {
        throw new PromptError(
          `Prompt '${this.name}' received unknown input fields: ${extra.join(", ")}.`,
        );
      }
    }
    return data;
  }

  // -- the optimization contract -------------------------------------------

  withTemplate(messageId: string, newTemplate: string): Prompt<C> {
    const index = this.config.messages.findIndex((message) => message.id === messageId);
    if (index === -1) {
      throw new PromptError(`No message with id '${messageId}'.`);
    }

    const message = this.config.messages[index]!;
    if (message.template === undefined) {
      throw new PromptError(`Message '${messageId}' has literal content, not a template.`);
    }

    assertSameVariables(
      `Template mutation for '${messageId}'`,
      message.template,
      newTemplate,
    );

    const next = cloneConfig(this.config);
    next.messages[index] = { ...message, template: newTemplate };
    return promptFromNormalized<C>(next);
  }

  withToolDescription(toolName: string, newDescription: string): Prompt<C> {
    const toolConfig = Object.hasOwn(this.config.tools, toolName)
      ? this.config.tools[toolName]
      : undefined;
    if (!toolConfig) {
      throw new PromptError(`No tool named '${toolName}'.`);
    }

    const next = cloneConfig(this.config);
    next.tools[toolName] = { ...toolConfig, description: newDescription };
    return promptFromNormalized<C>(next);
  }

  withSkillDescription(skillName: string, newDescription: string): Prompt<C> {
    const skill = Object.hasOwn(this.config.skills, skillName)
      ? this.config.skills[skillName]
      : undefined;
    if (!skill) {
      throw new PromptError(`No skill named '${skillName}'.`);
    }
    const next = cloneConfig(this.config);
    next.skills[skillName] = { ...skill, description: newDescription };
    return promptFromNormalized<C>(next);
  }

  withSkillInstructions(skillName: string, newInstructions: string): Prompt<C> {
    const skill = Object.hasOwn(this.config.skills, skillName)
      ? this.config.skills[skillName]
      : undefined;
    if (!skill) {
      throw new PromptError(`No skill named '${skillName}'.`);
    }
    assertSameVariables(
      `Instructions mutation for skill '${skillName}'`,
      skill.instructions,
      newInstructions,
    );
    const next = cloneConfig(this.config);
    next.skills[skillName] = { ...skill, instructions: newInstructions };
    return promptFromNormalized<C>(next);
  }

  // -- rendering & execution -----------------------------------------------

  /**
   * Declared messages with skills rendered in as system messages. Skills
   * follow the last declared system message (or lead when there is none), in
   * declaration order — the sequence render() produces, per the spec.
   */
  effectiveMessages(): PromptMessageConfig[] {
    return effectiveMessagesOf(this.config.messages, this.config.skills);
  }

  render(variables?: PromptVariables<C>): TypedModelMessage[] {
    let bindings = (variables ?? {}) as RuntimePromptVariables;
    const missing = this.variables.filter((name) => !Object.hasOwn(bindings, name));
    if (missing.length > 0) {
      throw new PromptError(
        `Prompt '${this.name}' is missing variables: ${missing.join(", ")}.`,
      );
    }
    bindings = this.validateInputs(bindings);

    return this.effectiveMessages().map((message) =>
      renderPromptMessage(message, bindings),
    );
  }

  /**
   * Render ONE message (or skill, via `skill:<name>`) from the document —
   * for appending typed turns to an ongoing conversation. Only the message's
   * own variables are required.
   */
  renderMessage(
    messageId: string,
    variables?: RuntimePromptVariables,
  ): TypedModelMessage {
    const message = this.effectiveMessages().find((entry) => entry.id === messageId);
    if (!message) {
      throw new PromptError(`No message with id '${messageId}'.`);
    }
    const bindings = variables ?? {};
    const missing = messageVariables(message).filter(
      (name) => !Object.hasOwn(bindings, name),
    );
    if (missing.length > 0) {
      throw new PromptError(
        `Message '${messageId}' is missing variables: ${missing.join(", ")}.`,
      );
    }
    return renderPromptMessage(message, bindings);
  }

  async generate(
    variables?: PromptVariables<C>,
    options: PromptCallOptions<C> = {},
  ): Promise<PromptGenerateResult<C>> {
    return (await generateText(
      this.callOptions(variables, options) as any,
    )) as PromptGenerateResult<C>;
  }

  stream(
    variables?: PromptVariables<C>,
    options: PromptCallOptions<C> = {},
  ): PromptStreamResult<C> {
    return streamText(this.callOptions(variables, options) as any) as PromptStreamResult<C>;
  }

  toAISDKOptions(
    variables?: PromptVariables<C>,
    options: PromptCallOptions<C> = {},
  ): Record<string, unknown> {
    return this.callOptions(variables, options);
  }

  private callOptions(
    variables: PromptVariables<C> | undefined,
    options: PromptCallOptions<C>,
  ): Record<string, unknown> {
    const { model, handlers, ...overrides } = options;
    const resolvedModel = model ?? this.config.model;
    if (resolvedModel === undefined || resolvedModel === null) {
      throw new PromptError(
        `Prompt '${this.name}' has no model; set model in the config or pass model at call time.`,
      );
    }

    const rendered = this.render(variables);
    const systemMessages = rendered.filter((message) => message.role === "system");
    const nonSystemMessages = rendered.filter((message) => message.role !== "system");

    const callOptions: Record<string, unknown> = {
      ...normalizeParams(this.config.params ?? {}),
      ...normalizeParams(overrides),
      model: resolvedModel,
    };

    if (systemMessages.length === 1) {
      callOptions.instructions = systemMessages[0];
    } else if (systemMessages.length > 1) {
      callOptions.instructions = systemMessages;
    }

    if (nonSystemMessages.length > 0) {
      callOptions.messages = nonSystemMessages as ModelMessage[];
    } else {
      callOptions.prompt = "";
    }

    if (this.config.output && callOptions.output === undefined) {
      callOptions.output = Output.object({
        schema: jsonSchema(this.config.output.schema as any),
        ...(this.config.output.name !== undefined ? { name: this.config.output.name } : {}),
        ...(this.config.output.description !== undefined
          ? { description: this.config.output.description }
          : {}),
      });
    }

    const boundHandlers = {
      ...this.defaultHandlers,
      ...((handlers ?? {}) as Record<string, (...args: any[]) => unknown>),
    };
    const unknownHandlers = Object.keys(boundHandlers).filter(
      (name) => !Object.hasOwn(this.config.tools, name),
    );
    if (unknownHandlers.length > 0) {
      throw new PromptError(
        `Handlers for undeclared tools: ${unknownHandlers.sort().join(", ")}. Declared tools: ${Object.keys(this.config.tools).sort().join(", ") || "(none)"}.`,
      );
    }

    if (Object.keys(this.config.tools).length > 0 && callOptions.tools === undefined) {
      callOptions.tools = Object.fromEntries(
        Object.entries(this.config.tools).map(([name, config]) => {
          const execute = Object.hasOwn(boundHandlers, name)
            ? boundHandlers[name]
            : undefined;
          return [
            name,
            tool(
              omitUndefined({
                description: config.description,
                inputSchema: jsonSchema(toolInputSchema(config) as any),
                strict: config.strict,
                ...(execute ? { execute } : {}),
              }) as any,
            ),
          ];
        }),
      );
    }

    if (this.config.toolChoice !== undefined && callOptions.toolChoice === undefined) {
      callOptions.toolChoice = this.config.toolChoice;
    }

    if (this.config.maxSteps !== undefined && callOptions.stopWhen === undefined) {
      callOptions.stopWhen = isStepCount(this.config.maxSteps);
    }

    return callOptions;
  }
}

export function definePrompt<C extends PromptConfig>(config: C): Prompt<C> {
  return new Prompt(config);
}

export function loadPrompt<C extends PromptConfig>(source: C): Prompt<C>;
export function loadPrompt(source: string | URL): Prompt;
export function loadPrompt(source: PromptConfig | string | URL): Prompt {
  if (typeof source === "string" || source instanceof URL) {
    const path = source instanceof URL ? fileURLToPath(source) : source.toString();
    const suffix = extname(path).toLowerCase();
    if (![".json", ".yaml", ".yml"].includes(suffix)) {
      throw new PromptError(
        `Unsupported prompt file extension '${suffix}' (expected .json, .yaml, or .yml).`,
      );
    }
    const text = readFileSync(path, "utf8");
    return new Prompt(parsePromptText(text, suffix));
  }
  return new Prompt(source);
}

export async function loadPromptUrl(
  url: string | URL,
  options: {
    headers?: Record<string, string>;
    format?: "json" | "yaml";
    fetch?: typeof fetch;
  } = {},
): Promise<Prompt> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(
    url,
    options.headers ? { headers: options.headers } : undefined,
  );
  if (!response.ok) {
    throw new PromptError(`Failed to load prompt from ${url}: ${response.status}.`);
  }

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const inferredFormat =
    options.format ??
    (url.toString().endsWith(".yaml") ||
    url.toString().endsWith(".yml") ||
    contentType.includes("yaml")
      ? "yaml"
      : "json");

  return new Prompt(parsePromptText(text, inferredFormat === "yaml" ? ".yaml" : ".json"));
}

function promptFromNormalized<C>(
  config: NormalizedPromptConfig,
): Prompt<C> {
  return new Prompt(config as unknown as C);
}

function cloneConfig(config: NormalizedPromptConfig): NormalizedPromptConfig {
  const { model, ...rest } = config;
  const cloned = deepClone(rest) as NormalizedPromptConfig;
  if (model !== undefined) {
    cloned.model = model;
  }
  return cloned;
}

function assertSameVariables(label: string, before: string, after: string): void {
  const oldVars = new Set(extractVariables(before));
  const newVars = new Set(extractVariables(after));
  if (!sameSet(oldVars, newVars)) {
    throw new PromptError(
      `${label} must preserve the variable set ${JSON.stringify([...oldVars].sort())}; got ${JSON.stringify([...newVars].sort())}.`,
    );
  }
}

function effectiveMessagesOf(
  messages: readonly PromptMessageConfig[],
  skills: Record<string, PromptSkillConfig>,
): PromptMessageConfig[] {
  const skillNames = Object.keys(skills);
  if (skillNames.length === 0) {
    return [...messages];
  }
  // Sorted-name order (never declaration order): key order is not semantic
  // and the canonical hash sorts keys, so rendering must agree.
  skillNames.sort(codePointCompare);
  const skillMessages = skillNames.map((name) => skillMessage(name, skills[name]!));
  let lastSystem = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "system") {
      lastSystem = index;
      break;
    }
  }
  if (lastSystem === -1) {
    return [...skillMessages, ...messages];
  }
  return [
    ...messages.slice(0, lastSystem + 1),
    ...skillMessages,
    ...messages.slice(lastSystem + 1),
  ];
}

function skillMessage(name: string, skill: PromptSkillConfig): PromptMessageConfig {
  // Composition is part of the spec (spec/README.md): the description is
  // literal prose (escaped), the instructions keep their placeholders.
  const template = `Skill: ${name}\n${escapeTemplateLiterals(skill.description)}\n\n${skill.instructions}`;
  return { role: "system", template, id: `skill:${name}` };
}

function renderPromptMessage(
  message: PromptMessageConfig,
  bindings: RuntimePromptVariables,
): TypedModelMessage {
  const factory = typedFactory(message.role);
  if (message.template !== undefined) {
    const bound = Object.fromEntries(
      messageVariables(message).map((name) => [name, bindings[name]]),
    );
    return factory({
      template: message.template,
      variables: bound,
      ...(message.id !== undefined ? { id: message.id } : {}),
    });
  }

  const content = message.content ?? "";
  return factory({
    template: escapeTemplateLiterals(content),
    variables: {},
    ...(message.id !== undefined ? { id: message.id } : {}),
    content,
  });
}

function normalizePromptConfig(config: PromptConfig): NormalizedPromptConfig {
  assertSchemaValid(config);
  const { model, ...serializableConfig } = config;
  const data = deepClone(serializableConfig) as PromptConfig;
  if (model !== undefined) {
    data.model = model;
  }

  const system = data.system;
  const user = data.user;
  delete data.system;
  delete data.user;

  if (system !== undefined || user !== undefined) {
    if (data.messages && data.messages.length > 0) {
      throw new PromptError("Use either top-level system/user or messages, not both.");
    }
    const messages: PromptMessageConfig[] = [];
    if (system !== undefined) {
      messages.push({
        role: "system",
        id: "system",
        ...simpleMessageEntry(system),
      });
    }
    if (user !== undefined) {
      messages.push({
        role: "user",
        id: "user",
        ...simpleMessageEntry(user),
      });
    }
    data.messages = messages;
  }

  const messages = [...(data.messages ?? [])];
  if (messages.length === 0) {
    throw new PromptError("A prompt needs messages: top-level system/user or messages.");
  }

  const skills = data.skills ?? {};
  for (const [name, skill] of Object.entries(skills)) {
    if (!SKILL_NAME.test(name)) {
      throw new PromptError(
        `Invalid skill name '${name}' (letters, digits, '-', '_' only).`,
      );
    }
    extractVariables(skill.instructions); // validate syntax eagerly
  }

  for (const key of Object.keys(data.params ?? {})) {
    if (Object.hasOwn(PARAM_SNAKE_HINTS, key)) {
      throw new PromptError(
        `Unknown params key '${key}' — did you mean '${PARAM_SNAKE_HINTS[key]}'? ` +
          "Document params use AI SDK option names.",
      );
    }
  }

  const input = data.input
    ? "schema" in data.input
      ? (data.input as NormalizedSchema)
      : { schema: compileOutputShorthand(data.input as Record<string, unknown>) }
    : undefined;

  const output = data.output
    ? "schema" in data.output
      ? (data.output as NormalizedSchema)
      : { schema: compileOutputShorthand(data.output as Record<string, unknown>) }
    : undefined;

  const tools = data.tools ?? {};
  for (const toolConfig of Object.values(tools)) {
    toolInputSchema(toolConfig); // compile eagerly so config errors surface
    toolOutputSchema(toolConfig);
  }

  const normalized: NormalizedPromptConfig = {
    ...(data as Record<string, unknown>),
    specVersion: PROMPT_SPEC_VERSION,
    name: data.name,
    params: data.params ?? {},
    messages,
    tools,
    skills,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  } as NormalizedPromptConfig;
  delete (normalized as Partial<PromptConfig>).system;
  delete (normalized as Partial<PromptConfig>).user;

  validateMessages(normalized);
  validateInputSchemaCoverage(normalized);
  return normalized;
}

function assertSchemaValid(config: PromptConfig): void {
  // Runtime model objects are call-time values, not document data; validate
  // the serializable view (the document spec requires model to be a string).
  const view: Record<string, unknown> = { ...config };
  if (view.model !== undefined && typeof view.model !== "string") {
    delete view.model;
  }
  if (!validatePromptConfig(view)) {
    const message = ajv.errorsText(validatePromptConfig.errors, {
      separator: "; ",
      dataVar: "prompt",
    });
    throw new PromptError(message);
  }
}

function validateMessages(config: NormalizedPromptConfig): void {
  for (const message of config.messages) {
    const hasTemplate = message.template !== undefined;
    const hasContent = message.content !== undefined;
    if (hasTemplate === hasContent) {
      throw new PromptError("A prompt message needs exactly one of template/content.");
    }
    if (message.template !== undefined) {
      extractVariables(message.template);
    }
  }

  const skillIds = Object.keys(config.skills).map((name) => `skill:${name}`);
  const ids = [
    ...config.messages
      .map((message) => message.id)
      .filter((id): id is string => id !== undefined),
    ...skillIds,
  ];
  if (new Set(ids).size !== ids.length) {
    throw new PromptError(
      "Prompt message ids must be unique (skills reserve 'skill:<name>').",
    );
  }
}

function validateInputSchemaCoverage(config: NormalizedPromptConfig): void {
  const schema = config.input?.schema;
  if (!schema) {
    return;
  }
  if (schema.type !== undefined && schema.type !== "object") {
    throw new PromptError("Prompt input schema must be an object schema.");
  }
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (properties === undefined) {
    return;
  }
  const names: string[] = [];
  for (const message of effectiveMessagesOf(config.messages, config.skills)) {
    for (const name of messageVariables(message)) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  const missing = names.filter((name) => !Object.hasOwn(properties, name));
  if (missing.length > 0) {
    throw new PromptError(
      `Prompt input schema must declare template variables: ${missing.join(", ")}.`,
    );
  }
}

function simpleMessageEntry(
  message: SimplePromptMessageConfig,
): Omit<PromptMessageConfig, "role"> {
  return typeof message === "string" ? { template: message } : { ...message };
}

function messageVariables(message: PromptMessageConfig): string[] {
  return message.template === undefined ? [] : extractVariables(message.template);
}

function typedFactory(role: PromptRole) {
  if (role === "system") {
    return TypedSystemMessage;
  }
  if (role === "assistant") {
    return TypedAssistantMessage;
  }
  return TypedUserMessage;
}

// Document params ARE the AI SDK option vocabulary — pass through verbatim.
function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
}

// Reject snake_case params with a did-you-mean hint (parity with pai-sdk;
// never silently converted).
const PARAM_SNAKE_HINTS: Record<string, string> = {
  max_output_tokens: "maxOutputTokens",
  top_p: "topP",
  top_k: "topK",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  stop_sequences: "stopSequences",
  max_retries: "maxRetries",
  provider_options: "providerOptions",
  active_tools: "activeTools",
};

function toolInputSchema(config: PromptToolConfig): Record<string, unknown> {
  if (!config.input) {
    return EMPTY_OBJECT_SCHEMA;
  }
  const input = config.input as Record<string, unknown>;
  if ("schema" in input) {
    return input.schema as Record<string, unknown>;
  }
  return compileOutputShorthand(input);
}

export function toolOutputSchema(
  config: PromptToolConfig,
): Record<string, unknown> | undefined {
  if (!config.output) {
    return undefined;
  }
  const output = config.output as Record<string, unknown>;
  if ("schema" in output) {
    return output.schema as Record<string, unknown>;
  }
  return compileOutputShorthand(output);
}

function parsePromptText(text: string, suffix: string): PromptConfig {
  if (suffix === ".yaml" || suffix === ".yml") {
    return parseYaml(text) as PromptConfig;
  }
  if (suffix === ".json") {
    return JSON.parse(text) as PromptConfig;
  }
  throw new PromptError(
    `Unsupported prompt file extension '${suffix}' (expected .json, .yaml, or .yml).`,
  );
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  return [...left].every((item) => right.has(item));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const diff = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (diff !== 0) {
      return diff;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalNumber(value: number): string {
  // Integral doubles print as plain digits (1e21 -> "1000000000000000000000",
  // matching Python's int conversion); String() already matches the
  // spec's ECMAScript formatting for everything else.
  if (Number.isInteger(value)) {
    return Object.is(value, -0) ? "0" : BigInt(value).toString();
  }
  return String(value);
}

/**
 * The canonical JSON serialization used for contentHash(): sorted keys (by
 * code point), compact separators, raw unicode, ECMAScript number formatting
 * — byte-identical with pai-sdk's canonical_prompt_json (see spec/README.md).
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    // Mirror JSON.stringify's array behavior; bare undefined has no JSON form.
    return "null";
  }
  if (typeof value === "number") {
    return canonicalNumber(value);
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => codePointCompare(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
