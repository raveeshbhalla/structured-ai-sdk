import { TemplateError } from "./errors";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function extractVariables(template: string): string[] {
  const names: string[] = [];

  for (let index = 0; index < template.length; index += 1) {
    if (template.startsWith("\\{{", index)) {
      index += 2;
      continue;
    }

    if (!template.startsWith("{{", index)) {
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
    if (template.startsWith("\\{{", index)) {
      rendered += "{{";
      index += 2;
      continue;
    }

    if (!template.startsWith("{{", index)) {
      rendered += template[index];
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
