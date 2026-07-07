export { PromptError, StructuredAIError, TemplateError } from "./errors";
export {
  TypedAssistantMessage,
  TypedSystemMessage,
  TypedUserMessage,
  dumpMessages,
  dumpMessagesJson,
  loadMessages,
  type TypedAssistantMessage as TypedAssistantMessageType,
  type TypedMessageFields,
  type TypedMessageInput,
  type TypedModelMessage,
  type TypedSystemMessage as TypedSystemMessageType,
  type TypedUserMessage as TypedUserMessageType,
} from "./messages";
export {
  PROMPT_SPEC_VERSION,
  Prompt,
  canonicalJson,
  definePrompt,
  loadPrompt,
  loadPromptUrl,
  toolOutputSchema,
  type PromptDocument,
  type PromptRuntimeOptions,
} from "./prompt";
export {
  PromptSpec,
  definePromptSpec,
  type PromptSpecConfig,
  type SpecDocumentText,
  type SpecPromptShape,
  type SpecToolConfig,
} from "./spec";
export {
  applyCandidate,
  applyOptimizerTarget,
  listOptimizerTargets,
  parseTargetAddress,
  readCandidate,
  readOptimizerTarget,
  targetAddress,
  type OptimizerTarget,
  type OptimizerTargetKind,
} from "./optimization";
export { PROMPT_CONFIG_SCHEMA, compileOutputShorthand } from "./schema";
export { escapeTemplateLiterals, extractVariables, renderTemplate } from "./template";
export type {
  ExtractTemplateVariables,
  OutputFromConfig,
  OutputShorthand,
  OutputShorthandField,
  PromptConfig,
  PromptHandler,
  PromptHandlers,
  PromptInputConfig,
  PromptMessageConfig,
  PromptOutput,
  PromptOutputConfig,
  PromptRole,
  PromptSkillConfig,
  PromptToolConfig,
  PromptToolInputs,
  PromptToolOutputs,
  PromptVariableNames,
  PromptVariables,
  SimplePromptMessageConfig,
  ToolChoiceConfig,
} from "./types";
