// @ts-expect-error - not merged yet
import { LanguageModel } from 'electron/utility';

import { LlamaCppLanguageModel } from './llama-cpp-language-model.js';
import { LlamaCppDownloadingLanguageModel } from './llama-cpp-downloading-language-model.js';

// Set prototype chains so these classes extend LanguageModel for Prompt API
// compatibility. LlamaCppDownloadingLanguageModel inherits through
// LlamaCppLanguageModel automatically.
Object.setPrototypeOf(LlamaCppLanguageModel.prototype, LanguageModel.prototype);
Object.setPrototypeOf(LlamaCppLanguageModel, LanguageModel);

export { LlamaCppLanguageModel, LlamaCppDownloadingLanguageModel };

/**
 * Wait for a message on the utility process's `parentPort` that matches
 * the given predicate. Returns the full `MessageEvent` data of the first
 * matching message; non-matching messages are ignored.
 *
 * @example
 * ```js
 * import { waitForMessage } from '@electron/llm/prompt-api';
 *
 * const message = await waitForMessage((msg) => msg.type === 'init');
 * console.log(message.options.userDataPath);
 * ```
 */
export async function waitForMessage<T = unknown>(
  predicate: (message: T) => boolean,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const handler = (event: { data: T }) => {
      if (predicate(event.data)) {
        process.parentPort.off('message', handler);
        resolve(event.data);
      }
    };
    process.parentPort.on('message', handler);
  });
}
