import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { extractVariables } from "./template";
import type {
  PromptConfig,
  PromptHandlers,
  PromptMessageConfig,
  PromptOutput,
  PromptRole,
  PromptToolConfig,
  PromptVariables,
  RuntimePromptVariables,
  SimplePromptMessageConfig,
  ToolChoiceConfig,
} from "./types";

type NormalizedOutput = {
  schema: Record<string, unknown>;
  name?: string;
  description?: string;
};

type NormalizedPromptConfig = Omit<
  PromptConfig,
  "system" | "user" | "messages" | "output" | "tools"
> & {
  output?: NormalizedOutput;
  messages: PromptMessageConfig[];
  tools: Record<string, PromptToolConfig>;
};

type PromptCallOptions<C extends PromptConfig> = Record<string, unknown> & {
  model?: unknown;
  handlers?: PromptHandlers<C>;
};

type PromptGenerateResult<C extends PromptConfig> = GenerateTextResult<
  any,
  any,
  any
> & { readonly output: PromptOutput<C> };

type PromptStreamResult<C extends PromptConfig> = StreamTextResult<
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

export class Prompt<C extends PromptConfig = PromptConfig> {
  readonly config: NormalizedPromptConfig;

  constructor(config: C) {
    this.config = normalizePromptConfig(config);
  }

  get name(): string {
    return this.config.name;
  }

  get variables(): string[] {
    const names: string[] = [];
    for (const message of this.config.messages) {
      for (const name of messageVariables(message)) {
        if (!names.includes(name)) {
          names.push(name);
        }
      }
    }
    return names;
  }

  optimizableMessages(): PromptMessageConfig[] {
    return this.config.messages.filter((message) => message.optimize === true);
  }

  optimizableTools(): Record<string, PromptToolConfig> {
    return Object.fromEntries(
      Object.entries(this.config.tools).filter(([, config]) => config.optimize === true),
    );
  }

  contentHash(): string {
    return createHash("sha256")
      .update(canonicalJson(this.toDict()))
      .digest("hex")
      .slice(0, 16);
  }

  toDict(): NormalizedPromptConfig {
    return deepClone(this.config);
  }

  withTemplate(messageId: string, newTemplate: string): Prompt<C> {
    const index = this.config.messages.findIndex((message) => message.id === messageId);
    if (index === -1) {
      throw new PromptError(`No message with id '${messageId}'.`);
    }

    const message = this.config.messages[index]!;
    if (message.optimize !== true) {
      throw new PromptError(
        `Message '${messageId}' is not marked optimize: true; it must not be rewritten.`,
      );
    }
    if (message.template === undefined) {
      throw new PromptError(`Message '${messageId}' has literal content, not a template.`);
    }

    const oldVars = new Set(extractVariables(message.template));
    const newVars = new Set(extractVariables(newTemplate));
    if (!sameSet(oldVars, newVars)) {
      throw new PromptError(
        `Template mutation for '${messageId}' must preserve the variable set ${JSON.stringify([...oldVars].sort())}; got ${JSON.stringify([...newVars].sort())}.`,
      );
    }

    const next = this.toDict();
    next.messages[index] = { ...message, template: newTemplate };
    return new Prompt(next as unknown as C);
  }

  withToolDescription(toolName: string, newDescription: string): Prompt<C> {
    const toolConfig = this.config.tools[toolName];
    if (!toolConfig) {
      throw new PromptError(`No tool named '${toolName}'.`);
    }
    if (toolConfig.optimize !== true) {
      throw new PromptError(
        `Tool '${toolName}' is not marked optimize: true; its description must not be rewritten.`,
      );
    }

    const next = this.toDict();
    next.tools[toolName] = { ...toolConfig, description: newDescription };
    return new Prompt(next as unknown as C);
  }

  render(variables?: PromptVariables<C>): TypedModelMessage[] {
    const bindings = (variables ?? {}) as RuntimePromptVariables;
    const missing = this.variables.filter((name) => !(name in bindings));
    if (missing.length > 0) {
      throw new PromptError(
        `Prompt '${this.name}' is missing variables: ${missing.join(", ")}.`,
      );
    }

    return this.config.messages.map((message) => {
      const factory = typedFactory(message.role);
      if (message.template !== undefined) {
        const bound = Object.fromEntries(
          messageVariables(message).map((name) => [name, bindings[name]]),
        );
        return factory({
          template: message.template,
          variables: bound,
          optimize: message.optimize ?? false,
          ...(message.id !== undefined ? { id: message.id } : {}),
        });
      }

      const content = message.content ?? "";
      return factory({
        template: escapeLiteralTemplate(content),
        variables: {},
        optimize: message.optimize ?? false,
        ...(message.id !== undefined ? { id: message.id } : {}),
        content,
      });
    });
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

    const boundHandlers = (handlers ?? {}) as Record<string, (...args: any[]) => unknown>;
    const unknownHandlers = Object.keys(boundHandlers).filter(
      (name) => !(name in this.config.tools),
    );
    if (unknownHandlers.length > 0) {
      throw new PromptError(
        `Handlers for undeclared tools: ${unknownHandlers.sort().join(", ")}. Declared tools: ${Object.keys(this.config.tools).sort().join(", ") || "(none)"}.`,
      );
    }

    if (Object.keys(this.config.tools).length > 0 && callOptions.tools === undefined) {
      callOptions.tools = Object.fromEntries(
        Object.entries(this.config.tools).map(([name, config]) => {
          const execute = boundHandlers[name];
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

    if (this.config.tool_choice !== undefined && callOptions.toolChoice === undefined) {
      callOptions.toolChoice = mapToolChoice(this.config.tool_choice);
    }

    if (this.config.max_steps !== undefined && callOptions.stopWhen === undefined) {
      callOptions.stopWhen = isStepCount(this.config.max_steps);
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
        optimize: true,
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
  validateMessages(messages);

  const output = data.output
    ? "schema" in data.output
      ? (data.output as NormalizedOutput)
      : { schema: compileOutputShorthand(data.output as Record<string, unknown>) }
    : undefined;

  const tools = data.tools ?? {};
  for (const toolConfig of Object.values(tools)) {
    toolInputSchema(toolConfig);
  }

  const normalized = {
    ...data,
    messages,
    tools,
    ...(output ? { output } : {}),
  };
  delete (normalized as Partial<PromptConfig>).system;
  delete (normalized as Partial<PromptConfig>).user;
  return normalized as NormalizedPromptConfig;
}

function assertSchemaValid(config: PromptConfig): void {
  if (!validatePromptConfig(config)) {
    const message = ajv.errorsText(validatePromptConfig.errors, {
      separator: "; ",
      dataVar: "prompt",
    });
    throw new PromptError(message);
  }
}

function validateMessages(messages: PromptMessageConfig[]): void {
  const ids = messages
    .map((message) => message.id)
    .filter((id): id is string => id !== undefined);
  if (new Set(ids).size !== ids.length) {
    throw new PromptError("Prompt message ids must be unique.");
  }

  for (const message of messages) {
    const hasTemplate = message.template !== undefined;
    const hasContent = message.content !== undefined;
    if (hasTemplate === hasContent) {
      throw new PromptError("A prompt message needs exactly one of template/content.");
    }
    if (message.template !== undefined) {
      extractVariables(message.template);
    }
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

function escapeLiteralTemplate(content: string): string {
  return content.replaceAll("{{", "\\{{");
}

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    mapped[PARAM_ALIASES[key] ?? key] = value;
  }
  return mapped;
}

const PARAM_ALIASES: Record<string, string> = {
  max_output_tokens: "maxOutputTokens",
  top_p: "topP",
  top_k: "topK",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  stop_sequences: "stopSequences",
  max_retries: "maxRetries",
  provider_options: "providerOptions",
  active_tools: "activeTools",
  tool_choice: "toolChoice",
  stop_when: "stopWhen",
  prepare_step: "prepareStep",
  abort_signal: "abortSignal",
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

function mapToolChoice(choice: ToolChoiceConfig): unknown {
  if (typeof choice === "string") {
    return choice;
  }
  return { type: "tool", toolName: choice.tool_name };
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}: ${canonicalJson(entry)}`)
    .join(", ")}}`;
}
