import type {
  AssistantModelMessage,
  ModelMessage,
  SystemModelMessage,
  UserModelMessage,
} from "ai";

import { renderTemplate } from "./template";
import type { PromptRole } from "./types";

export type TypedMessageFields = {
  template: string;
  variables: Record<string, unknown>;
  id?: string;
};

export type TypedSystemMessage = SystemModelMessage &
  TypedMessageFields & {
    role: "system";
    content: string;
  };

export type TypedUserMessage = UserModelMessage &
  TypedMessageFields & {
    role: "user";
    content: string;
  };

export type TypedAssistantMessage = AssistantModelMessage &
  TypedMessageFields & {
    role: "assistant";
    content: string;
  };

export type TypedModelMessage =
  | TypedSystemMessage
  | TypedUserMessage
  | TypedAssistantMessage;

export type TypedMessageInput = {
  template: string;
  variables?: Record<string, unknown>;
  id?: string;
  content?: string;
};

function createTypedMessage(
  role: PromptRole,
  input: TypedMessageInput,
): TypedModelMessage {
  const variables = input.variables ?? {};
  const content = input.content ?? renderTemplate(input.template, variables);
  return omitUndefined({
    role,
    content,
    template: input.template,
    variables,
    id: input.id,
  }) as TypedModelMessage;
}

export const TypedSystemMessage = (input: TypedMessageInput): TypedSystemMessage =>
  createTypedMessage("system", input) as TypedSystemMessage;

export const TypedUserMessage = (input: TypedMessageInput): TypedUserMessage =>
  createTypedMessage("user", input) as TypedUserMessage;

export const TypedAssistantMessage = (
  input: TypedMessageInput,
): TypedAssistantMessage =>
  createTypedMessage("assistant", input) as TypedAssistantMessage;

export function dumpMessages(messages: readonly unknown[]): Array<Record<string, unknown>> {
  return messages.map((message) => toJsonSafe(message) as Record<string, unknown>);
}

export function dumpMessagesJson(
  messages: readonly unknown[],
  options: { indent?: number } = {},
): string {
  return JSON.stringify(dumpMessages(messages), null, options.indent);
}

export function loadMessages(data: string | readonly unknown[]): ModelMessage[] {
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return toJsonSafe(parsed) as ModelMessage[];
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [key, toJsonSafe(entry)] as const)
    .filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries);
}
