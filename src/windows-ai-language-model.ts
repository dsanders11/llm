import { ReadableStream } from 'node:stream/web';

// @ts-expect-error - not merged yet
import { LanguageModel } from 'electron/utility';

import { LanguageModel as WindowsLanguageModel } from '../gen/windows-ai/LanguageModel.js';
import { LanguageModelOptions as WindowsLanguageModelOptions } from '../gen/windows-ai/LanguageModelOptions.js';
import { LanguageModelContext } from '../gen/windows-ai/LanguageModelContext.js';
import { LanguageModelResponseStatus } from '../gen/windows-ai/LanguageModelResponseStatus.js';
import { AIFeatureReadyState } from '../gen/windows-ai/AIFeatureReadyState.js';

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
  private _windowsModel: WindowsLanguageModel | null = null;
  private _context: LanguageModelContext | null = null;
  private _systemPrompt: string | undefined;
  private _history: LanguageModelMessage[] = [];
  private _contextMessageCount = 0;
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

    const windowsModel = await WindowsLanguageModel.createAsync(signal);

    const initialPrompts = options.initialPrompts ?? [];

    // Extract system prompt from initial prompts
    const systemMessages = initialPrompts.filter((m) => m.role === 'system');
    const systemPrompt =
      systemMessages.length > 0
        ? systemMessages.map((m) => extractTextContent(m)).join('\n')
        : undefined;

    // Create a context window with the system prompt so the model
    // can track conversation history across generateResponseAsync calls.
    const context = systemPrompt
      ? windowsModel.createContext(systemPrompt)
      : windowsModel.createContext();

    // Estimate context window size by checking how much of a large string
    // the model can accept in a fresh context.
    const emptyContext = windowsModel.createContext();
    const probeLength = Number(
      windowsModel.getUsablePromptLength(emptyContext, 'a'.repeat(1_000_000)),
    );
    emptyContext.close();

    const instance = new this({
      contextUsage: 0,
      contextWindow: Math.ceil(probeLength / 4),
    });

    instance._windowsModel = windowsModel;
    instance._context = context;
    instance._systemPrompt = systemPrompt;
    instance._initialPrompts = initialPrompts;

    // Non-system initial prompts are queued as history; _contextMessageCount
    // starts at 0 so they'll be included in the first prompt call.
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
    if (!this._windowsModel || !this._context) {
      throw new Error('Model is not initialized');
    }

    options.signal.throwIfAborted();

    // Build prompt from messages the context hasn't seen yet + new input.
    const pendingMessages = this._history.slice(this._contextMessageCount);
    const allMessages = [...pendingMessages, ...input];
    const promptText = allMessages.map((m) => extractTextContent(m)).join('\n');
    const windowsModel = this._windowsModel;
    const context = this._context;

    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          const modelOptions = WindowsLanguageModelOptions.create();

          const op = windowsModel.generateResponseAsync(
            context,
            promptText,
            modelOptions,
            options.signal,
          );

          // Register progress handler for streaming tokens
          op.progress((progressText: string) => {
            controller.enqueue(progressText);
          });

          const result = await op;

          if (result.status !== LanguageModelResponseStatus.Complete) {
            throw new Error(
              `Language model response failed (status ${result.status})`,
            );
          }

          // Track the exchange in conversation history
          this._history.push(...input);
          this._history.push({
            role: 'assistant',
            content: [{ type: 'text', value: result.text }],
          });

          // All history (including new input) has been consumed by the context
          this._contextMessageCount = this._history.length;

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

    // Queue messages to be included in the next prompt call.
    // _contextMessageCount stays the same, so these will be pending.
    this._history.push(...input);

    return undefined;
  }

  async measureContextUsage(
    input: LanguageModelMessage[],
    options: LanguageModelPromptOptions,
  ): Promise<number> {
    if (!this._windowsModel || !this._context) {
      throw new Error('Model is not initialized');
    }

    options.signal.throwIfAborted();

    const text = input.map((m) => extractTextContent(m)).join('\n');

    // Measure against an empty context so we get the token cost of
    // just the input, independent of current conversation state.
    const emptyContext = this._windowsModel.createContext();
    const usableLength = Number(
      this._windowsModel.getUsablePromptLength(emptyContext, text),
    );
    emptyContext.close();

    const effectiveLength = Math.min(text.length, usableLength);
    return Math.ceil(effectiveLength / 4);
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

    // Create a fresh context for the clone — _contextMessageCount starts
    // at 0 so the full history is replayed on the next prompt call.
    cloned._context = cloned._systemPrompt
      ? this._windowsModel.createContext(cloned._systemPrompt)
      : this._windowsModel.createContext();

    return cloned;
  }

  destroy(): void {
    try {
      this._context?.close();
    } catch {
      // Ignore close errors
    } finally {
      this._context = null;
    }

    if (this._ownsModel && this._windowsModel) {
      try {
        this._windowsModel.close();
      } catch {
        // Ignore close errors
      }
    }
    this._windowsModel = null;
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
