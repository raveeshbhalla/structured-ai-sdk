/**
 * Helpers for external optimizer scripts (e.g. GEPA `optimize_anything`) that
 * mutate prompt documents. Neither GEPA nor any optimizer is a dependency —
 * the runner owns datasets and search; this module gives it the two ends of
 * the loop, and `applyCandidate(...).toDict()` is the optimized JSON document
 * to persist and load wherever it is needed.
 *
 * Target addresses (the keys of a `{address: text}` candidate):
 *
 * - `message:<id>`                a message template, by message id
 * - `tool:<name>`                 a tool description, by tool name
 * - `skill:<name>.description`    a skill's when-to-apply prose
 * - `skill:<name>.instructions`   a skill's how-to template
 */

import { PromptError } from "./errors";
import type { Prompt } from "./prompt";
import type { PromptConfig } from "./types";

export type OptimizerTargetKind =
  | "message_template"
  | "tool_description"
  | "skill_description"
  | "skill_instructions";

export type OptimizerTarget = {
  kind: OptimizerTargetKind;
  id: string;
};

export function targetAddress(target: OptimizerTarget): string {
  switch (target.kind) {
    case "message_template":
      return `message:${target.id}`;
    case "tool_description":
      return `tool:${target.id}`;
    case "skill_description":
      return `skill:${target.id}.description`;
    case "skill_instructions":
      return `skill:${target.id}.instructions`;
  }
}

export function parseTargetAddress(address: string): OptimizerTarget {
  const separator = address.indexOf(":");
  const prefix = separator === -1 ? "" : address.slice(0, separator);
  const rest = separator === -1 ? "" : address.slice(separator + 1);
  if (!rest) {
    throw new PromptError(`Invalid optimizer target address: '${address}'.`);
  }
  if (prefix === "message") {
    return { kind: "message_template", id: rest };
  }
  if (prefix === "tool") {
    return { kind: "tool_description", id: rest };
  }
  if (prefix === "skill") {
    const dot = rest.lastIndexOf(".");
    const name = dot === -1 ? "" : rest.slice(0, dot);
    const part = dot === -1 ? "" : rest.slice(dot + 1);
    if (name && part === "description") {
      return { kind: "skill_description", id: name };
    }
    if (name && part === "instructions") {
      return { kind: "skill_instructions", id: name };
    }
    throw new PromptError(
      `Invalid skill target address '${address}' (expected 'skill:<name>.description' or 'skill:<name>.instructions').`,
    );
  }
  throw new PromptError(
    `Invalid optimizer target address '${address}' (expected a 'message:', 'tool:', or 'skill:' prefix).`,
  );
}

/** Selectable text-target addresses; nothing is ever marked optimizable. */
export function listOptimizerTargets<C extends PromptConfig>(
  prompt: Prompt<C>,
): string[] {
  const addresses: string[] = [];
  for (const message of prompt.config.messages) {
    if (message.id !== undefined && message.template !== undefined) {
      addresses.push(`message:${message.id}`);
    }
  }
  for (const [name, toolConfig] of Object.entries(prompt.config.tools)) {
    if (toolConfig.description !== undefined) {
      addresses.push(`tool:${name}`);
    }
  }
  for (const name of Object.keys(prompt.config.skills)) {
    addresses.push(`skill:${name}.description`);
    addresses.push(`skill:${name}.instructions`);
  }
  return addresses;
}

export function readOptimizerTarget<C extends PromptConfig>(
  prompt: Prompt<C>,
  address: string,
): string {
  const target = parseTargetAddress(address);
  if (target.kind === "message_template") {
    const message = prompt.config.messages.find((entry) => entry.id === target.id);
    if (!message) {
      throw new PromptError(`No message with id '${target.id}'.`);
    }
    if (message.template === undefined) {
      throw new PromptError(
        `Message '${target.id}' has literal content, not a template.`,
      );
    }
    return message.template;
  }
  if (target.kind === "tool_description") {
    const toolConfig = Object.hasOwn(prompt.config.tools, target.id)
      ? prompt.config.tools[target.id]
      : undefined;
    if (!toolConfig) {
      throw new PromptError(`No tool named '${target.id}'.`);
    }
    if (toolConfig.description === undefined) {
      throw new PromptError(`Tool '${target.id}' has no description.`);
    }
    return toolConfig.description;
  }
  const skill = Object.hasOwn(prompt.config.skills, target.id)
    ? prompt.config.skills[target.id]
    : undefined;
  if (!skill) {
    throw new PromptError(`No skill named '${target.id}'.`);
  }
  return target.kind === "skill_description" ? skill.description : skill.instructions;
}

export function applyOptimizerTarget<C extends PromptConfig>(
  prompt: Prompt<C>,
  address: string,
  candidateText: string,
): Prompt<C> {
  const target = parseTargetAddress(address);
  if (target.kind === "message_template") {
    return prompt.withTemplate(target.id, candidateText);
  }
  if (target.kind === "tool_description") {
    return prompt.withToolDescription(target.id, candidateText);
  }
  if (target.kind === "skill_description") {
    return prompt.withSkillDescription(target.id, candidateText);
  }
  return prompt.withSkillInstructions(target.id, candidateText);
}

/**
 * Extract the selected targets as an optimize_anything seed candidate:
 * `{address: current text}`.
 */
export function readCandidate<C extends PromptConfig>(
  prompt: Prompt<C>,
  targets: readonly string[],
): Record<string, string> {
  const candidate: Record<string, string> = {};
  for (const address of targets) {
    const canonical = targetAddress(parseTargetAddress(address));
    if (canonical in candidate) {
      throw new PromptError(`Duplicate optimizer target: '${canonical}'.`);
    }
    candidate[canonical] = readOptimizerTarget(prompt, address);
  }
  return candidate;
}

/**
 * Rebuild a Prompt from an evolved `{address: text}` candidate. Every
 * mutation goes through the structural contract (variable sets, names, and
 * schemas preserved by construction).
 */
export function applyCandidate<C extends PromptConfig>(
  prompt: Prompt<C>,
  candidate: Record<string, string>,
): Prompt<C> {
  let evolved = prompt;
  for (const [address, text] of Object.entries(candidate)) {
    if (typeof text !== "string") {
      throw new PromptError(
        `Candidate value for '${address}' must be a string; got ${typeof text}.`,
      );
    }
    evolved = applyOptimizerTarget(evolved, address, text);
  }
  return evolved;
}
