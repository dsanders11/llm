// Type definitions matching the Prompt API's LanguageModel types
// from the Electron Prompt API (electron/electron#50659)

export interface LanguageModelMessageContent {
  type: 'text' | 'image' | 'audio';
  value: string | ArrayBuffer;
}

export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: LanguageModelMessageContent[];
  prefix?: boolean;
}

export interface LanguageModelCreateOptions {
  signal: AbortSignal;
  initialPrompts?: LanguageModelMessage[];
}

export interface LanguageModelPromptOptions {
  responseConstraint?: object;
  signal: AbortSignal;
}

export interface LanguageModelAppendOptions {
  signal: AbortSignal;
}

export interface LanguageModelCloneOptions {
  signal: AbortSignal;
}
