import { TemplateError } from "./errors";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function extractVariables(template: string): string[] {
  const names: string[] = [];

  for (let index = 0; index < template.length; index += 1) {
    if (!template.startsWith("{{", index)) {
      continue;
    }

    if (countBackslashesBefore(template, index) % 2 === 1) {
      index += 1;
      continue;
    }

    const end = template.indexOf("}}", index + 2);
    if (end === -1) {
      throw new TemplateError(
        "Invalid template: expected '}}' before end of string.",
      );
    }

    const rawName = template.slice(index + 2, end);
    const name = rawName.trim();
    if (!IDENTIFIER.test(name)) {
      throw new TemplateError(
        `Only plain {{name}} placeholders are supported; got '{{${rawName}}}'.`,
      );
    }

    if (!names.includes(name)) {
      names.push(name);
    }
    index = end + 1;
  }

  return names;
}

export function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  const names = extractVariables(template);
  const missing = names.filter((name) => !(name in variables));
  if (missing.length > 0) {
    throw new TemplateError(`Missing template variables: ${missing.join(", ")}.`);
  }

  let rendered = "";
  for (let index = 0; index < template.length; index += 1) {
    if (!template.startsWith("{{", index)) {
      rendered += template[index];
      continue;
    }

    const backslashes = countBackslashesBefore(template, index);
    if (backslashes > 0) {
      rendered =
        rendered.slice(0, -backslashes) + "\\".repeat(Math.floor(backslashes / 2));
    }

    if (backslashes % 2 === 1) {
      rendered += "{{";
      index += 1;
      continue;
    }

    const end = template.indexOf("}}", index + 2);
    if (end === -1) {
      throw new TemplateError(
        "Invalid template: expected '}}' before end of string.",
      );
    }

    const rawName = template.slice(index + 2, end);
    const name = rawName.trim();
    if (!IDENTIFIER.test(name)) {
      throw new TemplateError(
        `Only plain {{name}} placeholders are supported; got '{{${rawName}}}'.`,
      );
    }
    rendered += String(variables[name]);
    index = end + 1;
  }

  return rendered;
}

function countBackslashesBefore(value: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count;
}
