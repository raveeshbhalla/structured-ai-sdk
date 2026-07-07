import { TemplateError } from "./errors";

// Unicode identifiers per the spec: XID_Start/_ then XID_Continue — exactly
// Python's str.isidentifier(), so the same document loads in both runtimes.
const IDENTIFIER = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;

// Python's str.strip() whitespace set (str.isspace), which differs from both
// String.prototype.trim (strips \uFEFF) and \s: portable tag parsing must
// agree on {{ name }} handling.
const PY_SPACE =
  "\t\n\x0b\f\r\x1c\x1d\x1e\x1f \x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const PY_TRIM = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

function pyTrim(text: string): string {
  return text.replace(PY_TRIM, "");
}

function countPrecedingBackslashes(text: string, openIndex: number): number {
  let count = 0;
  let index = openIndex - 1;
  while (index >= 0 && text[index] === "\\") {
    count += 1;
    index -= 1;
  }
  return count;
}

function isEscapedTagOpen(template: string, openIndex: number): boolean {
  return countPrecedingBackslashes(template, openIndex) % 2 === 1;
}

type Tag = { start: number; end: number; rawName: string };

function* iterTags(template: string): Generator<Tag> {
  let index = 0;
  while (true) {
    const open = template.indexOf("{{", index);
    if (open === -1) {
      break;
    }
    if (isEscapedTagOpen(template, open)) {
      index = open + 2;
      continue;
    }

    const close = template.indexOf("}}", open + 2);
    if (close === -1) {
      throw new TemplateError("Invalid template: unclosed '{{'.");
    }

    yield { start: open, end: close + 2, rawName: template.slice(open + 2, close) };
    index = close + 2;
  }
}

/** Escape literal Mustache opens so renderTemplate returns the same text. */
export function escapeTemplateLiterals(text: string): string {
  const escaped: string[] = [];
  let index = 0;
  while (true) {
    const open = text.indexOf("{{", index);
    if (open === -1) {
      escaped.push(text.slice(index));
      break;
    }

    const backslashCount = countPrecedingBackslashes(text, open);
    const backslashesStart = open - backslashCount;
    escaped.push(text.slice(index, backslashesStart));
    escaped.push("\\".repeat(backslashCount * 2 + 1));
    escaped.push("{{");
    index = open + 2;
  }
  return escaped.join("");
}

function unescapeTemplateLiterals(text: string): string {
  const rendered: string[] = [];
  let index = 0;
  while (true) {
    const open = text.indexOf("{{", index);
    if (open === -1) {
      rendered.push(text.slice(index));
      break;
    }

    const backslashCount = countPrecedingBackslashes(text, open);
    if (backslashCount % 2 === 1) {
      const backslashesStart = open - backslashCount;
      rendered.push(text.slice(index, backslashesStart));
      rendered.push("\\".repeat(Math.floor(backslashCount / 2)));
      rendered.push("{{");
      index = open + 2;
    } else {
      rendered.push(text.slice(index, open + 2));
      index = open + 2;
    }
  }
  return rendered.join("");
}

function unescapeLiteralBeforeTag(text: string): string {
  let backslashCount = 0;
  let index = text.length - 1;
  while (index >= 0 && text[index] === "\\") {
    backslashCount += 1;
    index -= 1;
  }
  if (backslashCount === 0) {
    return unescapeTemplateLiterals(text);
  }

  const prefix = text.slice(0, text.length - backslashCount);
  return (
    unescapeTemplateLiterals(prefix) + "\\".repeat(Math.floor(backslashCount / 2))
  );
}

/**
 * Placeholder names in a template, in order of first appearance.
 *
 * Only plain `{{name}}` placeholders are allowed; format specs, positional,
 * and dotted/indexed access raise TemplateError — keeping templates portable
 * across runtimes.
 */
export function extractVariables(template: string): string[] {
  const names: string[] = [];
  for (const { rawName } of iterTags(template)) {
    const name = pyTrim(rawName);
    if (!IDENTIFIER.test(name)) {
      throw new TemplateError(
        `Only plain {{name}} placeholders are supported; got '{{${rawName}}}'.`,
      );
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** Render a template, requiring every placeholder to be bound. */
export function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  const names = extractVariables(template);
  const missing = names.filter((name) => !Object.hasOwn(variables, name));
  if (missing.length > 0) {
    throw new TemplateError(`Missing template variables: ${missing.join(", ")}.`);
  }

  const rendered: string[] = [];
  let lastIndex = 0;
  for (const { start, end, rawName } of iterTags(template)) {
    rendered.push(unescapeLiteralBeforeTag(template.slice(lastIndex, start)));
    rendered.push(String(variables[pyTrim(rawName)]));
    lastIndex = end;
  }
  rendered.push(unescapeTemplateLiterals(template.slice(lastIndex)));
  return rendered.join("");
}
