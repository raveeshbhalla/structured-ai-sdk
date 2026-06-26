import { TemplateError } from "./errors";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function extractVariables(template: string): string[] {
  const names: string[] = [];

  for (let index = 0; index < template.length; index += 1) {
    const char = template[index];
    const next = template[index + 1];

    if (char === "{" && next === "{") {
      index += 1;
      continue;
    }

    if (char === "}" && next === "}") {
      index += 1;
      continue;
    }

    if (char === "}") {
      throw new TemplateError("Invalid template: single '}' encountered.");
    }

    if (char !== "{") {
      continue;
    }

    const end = template.indexOf("}", index + 1);
    if (end === -1) {
      throw new TemplateError("Invalid template: expected '}' before end of string.");
    }

    const name = template.slice(index + 1, end);
    if (!IDENTIFIER.test(name)) {
      throw new TemplateError(
        `Only plain {name} placeholders are supported; got '{${name}}'.`,
      );
    }

    if (!names.includes(name)) {
      names.push(name);
    }
    index = end;
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
    const char = template[index];
    const next = template[index + 1];

    if (char === "{" && next === "{") {
      rendered += "{";
      index += 1;
      continue;
    }

    if (char === "}" && next === "}") {
      rendered += "}";
      index += 1;
      continue;
    }

    if (char === "{") {
      const end = template.indexOf("}", index + 1);
      const name = template.slice(index + 1, end);
      rendered += String(variables[name]);
      index = end;
      continue;
    }

    if (char === "}") {
      throw new TemplateError("Invalid template: single '}' encountered.");
    }

    rendered += char;
  }

  return rendered;
}
