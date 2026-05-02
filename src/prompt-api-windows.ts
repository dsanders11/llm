// @ts-expect-error - not merged yet
import { LanguageModel } from 'electron/utility';

import { WindowsAILanguageModel } from './windows-ai-language-model.js';

// Set prototype chain so instances extend LanguageModel for Prompt API compatibility.
Object.setPrototypeOf(
  WindowsAILanguageModel.prototype,
  LanguageModel.prototype,
);
Object.setPrototypeOf(WindowsAILanguageModel, LanguageModel);

export { WindowsAILanguageModel };
