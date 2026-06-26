import { TemplateError } from "./errors";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function extractVariables(template: string): string[] {
  const names: string[] = [];
  let index = 0;

  while (true) {
    const open = template.indexOf("{{", index);
    const close = template.indexOf("}}", index);
    if (close !== -1 && (open === -1 || close < open)) {
      throw new TemplateError("Invalid template: unexpected '}}'.");
    }
    if (open === -1) {
      break;
    }

    const end = template.indexOf("}}", open + 2);
    if (end === -1) {
      throw new TemplateError("Invalid template: unclosed '{{'.");
    }

    const rawName = template.slice(open + 2, end);
    const name = rawName.trim();
    if (!IDENTIFIER.test(name)) {
      throw new TemplateError(
        `Only plain {{name}} placeholders are supported; got '{{${rawName}}}'.`,
      );
    }

    if (!names.includes(name)) {
      names.push(name);
    }
    index = end + 2;
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

  return template.replace(/\{\{(.*?)\}\}/gs, (_match, rawName: string) =>
    String(variables[rawName.trim()]),
  );
}
