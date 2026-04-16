import { ReadableStream } from 'node:stream/web';

// @ts-expect-error - not merged yet
import { LanguageModel } from 'electron/utility';

import {
  type ChatHistoryItem,
  LlamaChatSession,
  type LlamaContext,
  type LlamaModel,
  getLlama,
} from 'node-llama-cpp';

import type {
  LanguageModelAppendOptions,
  LanguageModelCloneOptions,
  LanguageModelCreateOptions,
  LanguageModelMessage,
  LanguageModelMessageContent,
  LanguageModelPromptOptions,
} from './types.js';

/**
 * A `LanguageModel` subclass powered by `node-llama-cpp` for use with the
 * Electron Prompt API.
 *
 * Subclass this and set `modelPath` to the path to your GGUF model file,
 * then register it with `localAIHandler.setPromptAPIHandler`.
 *
 * @example
 * ```js
 * import { LlamaCppLanguageModel } from '@electron/llm';
 * import { localAIHandler } from 'electron/utility';
 *
 * class MyModel extends LlamaCppLanguageModel {
 *   static modelPath = '/path/to/model.gguf';
 * }
 *
 * localAIHandler.setPromptAPIHandler(() => MyModel);
 * ```
 */
export class LlamaCppLanguageModel extends LanguageModel {
  static modelPath: string | null = null;

  private _session: LlamaChatSession | null = null;
  private _context: LlamaContext | null = null;
  private _model: LlamaModel | null = null;
  private _initialPrompts: LanguageModelMessage[] | undefined;

  constructor(options: { contextUsage: number; contextWindow: number }) {
    super(options);
  }

  static async create(
    options: LanguageModelCreateOptions,
  ): Promise<LanguageModel> {
    const modelPath = this.modelPath;
    if (!modelPath) {
      throw new Error('modelPath must be set before creating a model instance');
    }

    const { signal } = options;
    signal.throwIfAborted();

    const llama = await getLlama();
    signal.throwIfAborted();

    const model = await llama.loadModel({ loadSignal: signal, modelPath });
    const context = await model.createContext({ createSignal: signal });

    const initialPrompts = options.initialPrompts ?? [];

    // Extract system prompt from initial prompts
    const systemMessages = initialPrompts.filter((m) => m.role === 'system');
    const systemPrompt =
      systemMessages.length > 0
        ? systemMessages.map((m) => extractTextContent(m)).join('\n')
        : undefined;

    signal.throwIfAborted();
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt,
    });

    // Set non-system initial prompts as chat history
    const nonSystemPrompts = initialPrompts.filter((m) => m.role !== 'system');
    if (nonSystemPrompts.length > 0) {
      const history: ChatHistoryItem[] = [];

      if (systemPrompt) {
        history.push({ type: 'system', text: systemPrompt });
      }

      for (const msg of nonSystemPrompts) {
        const text = extractTextContent(msg);
        if (msg.role === 'user') {
          history.push({ type: 'user', text });
        } else if (msg.role === 'assistant') {
          history.push({ type: 'model', response: [text] });
        }
      }

      session.setChatHistory(history);
    }

    const contextWindow = context.contextSize;

    const instance = new this({
      contextUsage: 0,
      contextWindow,
    });

    instance._session = session;
    instance._context = context;
    instance._model = model;
    instance._initialPrompts = initialPrompts;

    return instance;
  }

  static async availability(): Promise<string> {
    if (!this.modelPath) {
      return 'unavailable';
    }

    try {
      const llama = await getLlama();
      if (!llama) return 'unavailable';
      return 'available';
    } catch {
      return 'unavailable';
    }
  }

  async prompt(
    input: LanguageModelMessage[],
    options: LanguageModelPromptOptions,
  ): Promise<ReadableStream<string>> {
    if (!this._session) {
      throw new Error('Model session is not initialized');
    }

    const text = messagesToText(input);

    let grammar:
      | Awaited<ReturnType<LlamaModel['llama']['createGrammarForJsonSchema']>>
      | undefined;
    if (options.responseConstraint != null) {
      if (options.responseConstraint instanceof RegExp) {
        throw new Error(
          'RegExp responseConstraint is not supported by node-llama-cpp',
        );
      }
      grammar = await this._model!.llama.createGrammarForJsonSchema(
        options.responseConstraint as Parameters<
          LlamaModel['llama']['createGrammarForJsonSchema']
        >[0],
      );
    }

    // Return a ReadableStream so that both prompt() and promptStreaming()
    // in the renderer work correctly through the Prompt API.
    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          await this._session!.prompt(text, {
            signal: options.signal,
            stopOnAbortSignal: true,
            grammar,
            onTextChunk: (chunk: string) => {
              controller.enqueue(chunk);
            },
          });
          this._updateContextUsage();
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
    if (!this._session) {
      throw new Error('Model session is not initialized');
    }

    options.signal.throwIfAborted();

    // Append messages to chat history without generating a response
    const history = this._session.getChatHistory();
    for (const msg of input) {
      const text = extractTextContent(msg);
      if (msg.role === 'user') {
        history.push({ type: 'user', text });
      } else if (msg.role === 'assistant') {
        history.push({ type: 'model', response: [text] });
      } else if (msg.role === 'system') {
        history.push({ type: 'system', text });
      }
    }
    this._session.setChatHistory(history);
    this._updateContextUsage();
    return undefined;
  }

  async measureContextUsage(
    input: LanguageModelMessage[],
    options: LanguageModelPromptOptions,
  ): Promise<number> {
    if (!this._model) {
      throw new Error('Model is not initialized');
    }

    options.signal.throwIfAborted();

    const text = messagesToText(input);
    const tokens = this._model.tokenize(text);
    return tokens.length;
  }

  async clone(options: LanguageModelCloneOptions): Promise<LanguageModel> {
    if (!this._session || !this._context || !this._model) {
      throw new Error('Model session is not initialized');
    }

    options.signal.throwIfAborted();

    const newContext = await this._model.createContext();
    options.signal.throwIfAborted();
    const newSession = new LlamaChatSession({
      contextSequence: newContext.getSequence(),
    });

    // Copy chat history from the original session
    const history = this._session.getChatHistory();
    newSession.setChatHistory(history);

    const cloned = new (this.constructor as LanguageModel)({
      // @ts-expect-error - not merged yet
      contextUsage: this.contextUsage,
      // @ts-expect-error - not merged yet
      contextWindow: this.contextWindow,
    });

    cloned._session = newSession;
    cloned._context = newContext;
    cloned._model = this._model;
    cloned._initialPrompts = this._initialPrompts;

    return cloned;
  }

  destroy(): void {
    this._session = null;
    this._context = null;
    this._model = null;
  }

  private _updateContextUsage(): void {
    if (this._session) {
      // @ts-expect-error - not merged yet
      this.contextUsage = this._session.sequence.nextTokenIndex;
    }
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

function messagesToText(messages: LanguageModelMessage[]): string {
  return messages.map((msg) => extractTextContent(msg)).join('\n');
}
