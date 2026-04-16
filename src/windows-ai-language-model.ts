import { ReadableStream } from 'node:stream/web';

// @ts-expect-error - not merged yet
import { LanguageModel } from 'electron/utility';

import {
  LanguageModel as WindowsLanguageModel,
  LanguageModelOptions as WindowsLanguageModelOptions,
  AIFeatureReadyState,
} from '../gen/windows-ai/index.js';

import type {
  LanguageModelCreateOptions,
  LanguageModelPromptOptions,
  LanguageModelAppendOptions,
  LanguageModelCloneOptions,
  LanguageModelMessage,
} from './types.js';

/**
 * A `LanguageModel` subclass backed by the Windows AI
 * `Microsoft.Windows.AI.Text.LanguageModel` API (Phi Silica / NPU).
 *
 * This class wraps the local on-device language model available on
 * Windows Copilot+ PCs and exposes it through the Electron Prompt API.
 *
 * @example
 * ```js
 * import { WindowsAILanguageModel } from '@electron/llm';
 * import { localAIHandler } from 'electron/utility';
 *
 * localAIHandler.setPromptAPIHandler(() => WindowsAILanguageModel);
 * ```
 */
export class WindowsAILanguageModel extends LanguageModel {
  private _windowsModel: any = null;
  private _systemPrompt: string | undefined;
  private _history: LanguageModelMessage[] = [];
  private _initialPrompts: LanguageModelMessage[] | undefined;
  private _ownsModel = true;

  constructor(options: { contextUsage: number; contextWindow: number }) {
    super(options);
  }

  static async create(
    options: LanguageModelCreateOptions,
  ): Promise<LanguageModel> {
    const { signal } = options;
    signal.throwIfAborted();

    const windowsModel = await WindowsLanguageModel.createAsync();
    signal.throwIfAborted();

    if (!windowsModel) {
      throw new Error(
        'Failed to create Windows AI Language Model. ' +
          'Ensure your device supports Windows AI (Copilot+ PC required).',
      );
    }

    const initialPrompts = options.initialPrompts ?? [];

    // Extract system prompt from initial prompts
    const systemMessages = initialPrompts.filter((m) => m.role === 'system');
    const systemPrompt =
      systemMessages.length > 0
        ? systemMessages.map((m) => extractTextContent(m)).join('\n')
        : undefined;

    const instance = new this({
      contextUsage: 0,
      contextWindow: 8192, // TODO - How to get context window size?
    });

    instance._windowsModel = windowsModel;
    instance._systemPrompt = systemPrompt;
    instance._initialPrompts = initialPrompts;

    // Add non-system initial prompts as conversation history
    instance._history = initialPrompts
      .filter((m) => m.role !== 'system')
      .slice();

    return instance;
  }

  static async availability(): Promise<string> {
    try {
      const state = WindowsLanguageModel.getReadyState();
      if (state === AIFeatureReadyState.Ready) {
        return 'available';
      }
      return 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async prompt(
    input: LanguageModelMessage[],
    options: LanguageModelPromptOptions,
  ): Promise<ReadableStream<string>> {
    if (!this._windowsModel) {
      throw new Error('Model is not initialized');
    }

    options.signal.throwIfAborted();

    // Build full prompt including system prompt, history, and new input
    const promptText = this._buildPrompt(input);
    const windowsModel = this._windowsModel;

    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          const modelOptions = WindowsLanguageModelOptions.create();

          // generateResponseAsync2 is the (String, LanguageModelOptions)
          // overload of the WinRT GenerateResponseAsync API
          const op = windowsModel.generateResponseAsync2(
            promptText,
            modelOptions,
          );

          // Register progress handler for streaming tokens
          op.progress((progressText: unknown) => {
            const chunk =
              typeof progressText === 'string'
                ? progressText
                : String(progressText);
            if (chunk) {
              controller.enqueue(chunk);
            }
          });

          // Handle abort signal
          const onAbort = () => {
            try {
              op.cancel();
            } catch {
              // Ignore cancel errors
            }
          };
          options.signal.addEventListener('abort', onAbort, { once: true });

          const result = await op;
          options.signal.removeEventListener('abort', onAbort);

          // Track the exchange in conversation history
          this._history.push(...input);
          this._history.push({
            role: 'assistant',
            content: [{ type: 'text', value: result.text }],
          });

          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  async append(
    input: LanguageModelMessage[],
    options: LanguageModelAppendOptions,
  ): Promise<undefined> {
    if (!this._windowsModel) {
      throw new Error('Model is not initialized');
    }

    options.signal.throwIfAborted();

    // Queue messages to be included in the next prompt call
    this._history.push(...input);

    return undefined;
  }

  async measureContextUsage(
    input: LanguageModelMessage[],
    options: LanguageModelPromptOptions,
  ): Promise<number> {
    if (!this._windowsModel) {
      throw new Error('Model is not initialized');
    }

    options.signal.throwIfAborted();

    const text = this._buildPrompt(input);

    // Rough estimate: ~4 characters per token for English text
    // TODO - Don't estimate, find a way to get actual token count from the Windows model if possible
    return Math.ceil(text.length / 4);
  }

  async clone(options: LanguageModelCloneOptions): Promise<LanguageModel> {
    if (!this._windowsModel) {
      throw new Error('Model is not initialized');
    }

    options.signal.throwIfAborted();

    const cloned = new (this.constructor as typeof WindowsAILanguageModel)({
      // @ts-expect-error - not merged yet
      contextUsage: this.contextUsage,
      // @ts-expect-error - not merged yet
      contextWindow: this.contextWindow,
    });

    // Share the underlying Windows model instance (creating is expensive)
    cloned._windowsModel = this._windowsModel;
    cloned._ownsModel = false;
    cloned._systemPrompt = this._systemPrompt;
    cloned._initialPrompts = this._initialPrompts;
    cloned._history = [...this._history];

    return cloned;
  }

  destroy(): void {
    if (this._ownsModel && this._windowsModel) {
      try {
        this._windowsModel.close();
      } catch {
        // Ignore close errors
      }
    }
    this._windowsModel = null;
  }

  private _buildPrompt(input: LanguageModelMessage[]): string {
    const parts: string[] = [];

    if (this._systemPrompt) {
      parts.push(this._systemPrompt);
    }

    // Include conversation history and new input
    for (const msg of [...this._history, ...input]) {
      parts.push(extractTextContent(msg));
    }

    return parts.join('\n');
  }
}

function extractTextContent(msg: LanguageModelMessage): string {
  return msg.content
    .filter((c) => c.type === 'text')
    .map((c) =>
      typeof c.value === 'string'
        ? c.value
        : Buffer.from(c.value).toString('utf-8'),
    )
    .join('');
}
