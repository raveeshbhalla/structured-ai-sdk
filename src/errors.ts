export class StructuredAIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PromptError extends StructuredAIError {}

export class TemplateError extends StructuredAIError {}
