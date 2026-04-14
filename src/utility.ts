export { LlamaCppLanguageModel } from './llama-cpp-language-model.js';
export { LlamaCppDownloadingLanguageModel } from './llama-cpp-downloading-language-model.js';

/**
 * Wait for a message on the utility process's `parentPort` that matches
 * the given predicate. Returns the full `MessageEvent` data of the first
 * matching message; non-matching messages are ignored.
 *
 * @example
 * ```js
 * import { waitForMessage } from '@electron/llm/utility';
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
