// @ts-expect-error - not merged yet
import { LanguageModel } from 'electron/utility';

import { AppleIntelligenceLanguageModel } from './apple-intelligence-language-model.js';

// Set prototype chain so instances extend LanguageModel for Prompt API compatibility.
Object.setPrototypeOf(
  AppleIntelligenceLanguageModel.prototype,
  LanguageModel.prototype,
);
Object.setPrototypeOf(AppleIntelligenceLanguageModel, LanguageModel);

export { AppleIntelligenceLanguageModel };
