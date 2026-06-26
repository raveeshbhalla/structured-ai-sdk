import type { ToolExecutionOptions } from "ai";
import type { FromSchema } from "json-schema-to-ts";

export type PromptRole = "system" | "user" | "assistant";

export type PromptMessageConfig = {
  role: PromptRole;
  template?: string;
  content?: string;
  optimize?: boolean;
  id?: string;
};

export type SimplePromptMessageConfig =
  | string
  | {
      template?: string;
      content?: string;
      optimize?: boolean;
      id?: string;
    };

export type OutputShorthandField =
  | null
  | string
  | readonly unknown[]
  | OutputShorthand;

export type OutputShorthand = {
  readonly [field: string]: OutputShorthandField;
};

export type PromptOutputConfig =
  | OutputShorthand
  | {
      schema: Record<string, unknown>;
      name?: string;
      description?: string;
    };

export type PromptToolConfig = {
  description?: string;
  optimize?: boolean;
  input?: OutputShorthand | { schema: Record<string, unknown> };
  strict?: boolean;
};

export type ToolChoiceConfig =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      tool_name: string;
    };

export type PromptConfig = {
  name: string;
  version?: string | number;
  description?: string;
  model?: unknown;
  params?: Record<string, unknown>;
  output?: PromptOutputConfig;
  system?: SimplePromptMessageConfig;
  user?: SimplePromptMessageConfig;
  messages?: readonly PromptMessageConfig[];
  tools?: Record<string, PromptToolConfig>;
  tool_choice?: ToolChoiceConfig;
  max_steps?: number;
};

type TemplateWhitespace = " " | "\n" | "\r" | "\t";
type TrimLeft<S extends string> = S extends `${TemplateWhitespace}${infer Rest}`
  ? TrimLeft<Rest>
  : S;
type TrimRight<S extends string> = S extends `${infer Rest}${TemplateWhitespace}`
  ? TrimRight<Rest>
  : S;
type Trim<S extends string> = TrimLeft<TrimRight<S>>;

type LowerAlpha =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type UpperAlpha = Uppercase<LowerAlpha>;
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type IdentifierStart = LowerAlpha | UpperAlpha | "_";
type IdentifierPart = IdentifierStart | Digit;
type IsIdentifierTail<S extends string> = S extends ""
  ? true
  : S extends `${infer First}${infer Rest}`
    ? First extends IdentifierPart
      ? IsIdentifierTail<Rest>
      : false
    : false;
type IsIdentifier<S extends string> = S extends `${infer First}${infer Rest}`
  ? First extends IdentifierStart
    ? IsIdentifierTail<Rest>
    : false
  : false;
type TemplateVariableName<S extends string> =
  IsIdentifier<Trim<S>> extends true ? Trim<S> : never;
type Toggle<T extends boolean> = T extends true ? false : true;
type ExtractTemplateVariablesFrom<
  S extends string,
  Escaped extends boolean = false,
> = S extends `${infer First}${infer Rest}`
  ? First extends "\\"
    ? ExtractTemplateVariablesFrom<Rest, Toggle<Escaped>>
    : First extends "{"
      ? Rest extends `{${infer AfterOpen}`
        ? Escaped extends true
          ? ExtractTemplateVariablesFrom<AfterOpen, false>
          : AfterOpen extends `${infer Name}}}${infer Tail}`
            ? TemplateVariableName<Name> | ExtractTemplateVariablesFrom<Tail, false>
            : never
        : ExtractTemplateVariablesFrom<Rest, false>
      : ExtractTemplateVariablesFrom<Rest, false>
  : never;

export type ExtractTemplateVariables<S extends string> =
  string extends S ? string : ExtractTemplateVariablesFrom<S>;

type TemplateFromSimple<T> = T extends string
  ? T
  : T extends { template: infer Template extends string }
    ? Template
    : never;

type TemplateFromMessage<T> = T extends { template: infer Template extends string }
  ? Template
  : never;

type MessageTemplateUnion<Messages> = Messages extends readonly unknown[]
  ? TemplateFromMessage<Messages[number]>
  : never;

export type PromptVariableNames<C> = C extends { messages: infer Messages }
  ? ExtractTemplateVariables<MessageTemplateUnion<Messages>>
  : ExtractTemplateVariables<TemplateFromSimple<C extends { system: infer S } ? S : never>> |
      ExtractTemplateVariables<TemplateFromSimple<C extends { user: infer U } ? U : never>>;

export type PromptVariables<C> = [PromptVariableNames<C>] extends [never]
  ? Record<string, unknown>
  : { [K in PromptVariableNames<C>]: unknown } & Record<string, unknown>;

type PrimitiveFromName<T extends string> = T extends `${infer Inner}[]`
  ? ShorthandFieldType<Inner>[]
  : T extends "string"
    ? string
    : T extends "number"
      ? number
      : T extends "integer" | "int"
        ? number
        : T extends "boolean" | "bool"
          ? boolean
          : unknown;

type ShorthandFieldType<T> = T extends null
  ? string
  : T extends string
    ? PrimitiveFromName<T>
    : T extends readonly (infer Item)[]
      ? Item
      : T extends Record<string, unknown>
        ? ShorthandObjectType<T>
        : unknown;

type ShorthandObjectType<T> = {
  [K in keyof T]: ShorthandFieldType<T[K]>;
};

type FromJsonSchema<S> = S extends Record<string, unknown> ? FromSchema<S> : unknown;

export type OutputFromConfig<O> = O extends { schema: infer S }
  ? FromJsonSchema<S>
  : O extends Record<string, unknown>
    ? ShorthandObjectType<O>
    : unknown;

export type PromptOutput<C> = C extends { output: infer O }
  ? OutputFromConfig<O>
  : string;

type ToolInputFromConfig<T> = T extends { input: infer I }
  ? OutputFromConfig<I>
  : Record<string, never>;

export type PromptToolInputs<C> = C extends { tools: infer Tools }
  ? {
      [K in keyof Tools]: ToolInputFromConfig<Tools[K]>;
    }
  : Record<string, never>;

export type PromptHandler<Input> = (
  input: Input,
  options: ToolExecutionOptions<any>,
) => unknown | Promise<unknown> | AsyncIterable<unknown>;

export type PromptHandlers<C> = Partial<{
  [K in keyof PromptToolInputs<C> & string]: PromptHandler<PromptToolInputs<C>[K]>;
}>;

export type RuntimePromptVariables = Record<string, unknown>;
