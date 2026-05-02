import { ReadableStream } from 'node:stream/web';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type {
  LanguageModel,
  LanguageModelCreateOptions,
  LanguageModelPromptOptions,
  LanguageModelAppendOptions,
  LanguageModelCloneOptions,
  LanguageModelMessage,
} from './types.js';

interface AppleIntelligenceSession {
  readonly sessionId: string;
  respond(
    prompt: string,
    jsonSchema: string | null,
    onToken: (chunk: string) => void,
    onComplete: (error: string | null, fullResponse: string | null) => void,
    signal?: AbortSignal,
  ): void;
  clone(): AppleIntelligenceSession;
  countTokens(
    text: string,
    callback: (error: string | null, count: number) => void,
    signal?: AbortSignal,
  ): void;
  destroy(): void;
}

interface NativeAddon {
  checkAvailability(): string;
  getContextSize(): number;
  createSession(systemPrompt?: string): AppleIntelligenceSession;
  countTokens(
    text: string,
    callback: (error: string | null, count: number) => void,
    signal?: AbortSignal,
  ): void;
}

// Lazy-load the native addon so the module can be imported on any platform
// without throwing at parse time.
let _native: NativeAddon | undefined;
function getNative(): NativeAddon {
  if (!_native) {
    const require = createRequire(import.meta.url);
    // Walk up from this file to the package root (works whether running from
    // src/ during development or dist/src/ in the published package).
    let dir = import.meta.dirname;
    while (!existsSync(join(dir, 'package.json'))) {
      const parent = dirname(dir);
      if (parent === dir) throw new Error('Could not find package root');
      dir = parent;
    }
    _native = require(join(dir, 'build', 'Release', 'apple_intelligence.node'));
  }
  return _native!;
}

/**
 * A `LanguageModel` implementation backed by Apple Intelligence on macOS 26+.
 *
 * Uses Apple's FoundationModels framework (`LanguageModelSession` /
 * `SystemLanguageModel`) via a native Swift addon.  Streaming, abort-signal
 * support, session cloning, and token counting are all wired through to the
 * on-device model.
 *
 * Import from `@electron/llm/prompt-api/macos` for a Prompt API-compatible
 * version that extends the Electron `LanguageModel` class.
 *
 * @example
 * ```js
 * import { AppleIntelligenceLanguageModel } from '@electron/llm';
 * import { localAIHandler } from 'electron/utility';
 *
 * localAIHandler.setPromptAPIHandler(() => AppleIntelligenceLanguageModel);
 * ```
 */
export class AppleIntelligenceLanguageModel implements LanguageModel {
  contextUsage: number;
  contextWindow: number;
  private _session: AppleIntelligenceSession | null = null;
  private _systemPrompt: string | undefined;
  private _history: LanguageModelMessage[] = [];
  private _initialPrompts: LanguageModelMessage[] | undefined;
  private _ownsSession = true;

  constructor(options: { contextUsage: number; contextWindow: number }) {
    this.contextUsage = options.contextUsage;
    this.contextWindow = options.contextWindow;
  }

  static async create(
    options: LanguageModelCreateOptions,
  ): Promise<LanguageModel> {
    const { signal } = options;
    signal.throwIfAborted();

    const native = getNative();
    const initialPrompts = options.initialPrompts ?? [];

    // Extract system prompt from initial prompts
    const systemMessages = initialPrompts.filter((m) => m.role === 'system');
    const systemPrompt =
      systemMessages.length > 0
        ? systemMessages.map((m) => extractTextContent(m)).join('\n')
        : undefined;

    signal.throwIfAborted();
    const session = native.createSession(systemPrompt);
    signal.throwIfAborted();

    const contextWindow = native.getContextSize();

    const instance = new this({
      contextUsage: 0,
      contextWindow,
    });

    instance._session = session;
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
      return getNative().checkAvailability();
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

    options.signal.throwIfAborted();

    const promptText = this._buildPrompt(input);
    const session = this._session;

    // If a responseConstraint is provided (JSON Schema object), serialize it
    // for guided generation via Apple's DynamicGenerationSchema.
    const jsonSchema =
      options.responseConstraint != null &&
      !(options.responseConstraint instanceof RegExp)
        ? JSON.stringify(options.responseConstraint)
        : undefined;

    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          session.respond(
            promptText,
            jsonSchema ?? null,
            // onToken
            (chunk: string) => {
              controller.enqueue(chunk);
            },
            // onComplete
            (error: string | null, fullResponse: string | null) => {
              if (error) {
                controller.error(new Error(error));
              } else {
                // Track exchange in conversation history
                this._history.push(...input);
                if (fullResponse) {
                  this._history.push({
                    role: 'assistant',
                    content: [{ type: 'text', value: fullResponse }],
                  });
                }
                this._updateContextUsage();
                controller.close();
              }
            },
            options.signal,
          );
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

    // Queue messages to be included in the next prompt call.
    // Apple's LanguageModelSession manages its own transcript, but we track
    // appended messages locally and prepend them in _buildPrompt, matching
    // the WindowsAILanguageModel approach.
    this._history.push(...input);
    this._updateContextUsage();

    return undefined;
  }

  async measureContextUsage(
    input: LanguageModelMessage[],
    options: LanguageModelPromptOptions,
  ): Promise<number> {
    if (!this._session) {
      throw new Error('Model session is not initialized');
    }

    options.signal.throwIfAborted();

    const text = input.map((m) => extractTextContent(m)).join('\n');
    return new Promise<number>((resolve, reject) => {
      this._session!.countTokens(
        text,
        (error, count) => {
          if (error) reject(new Error(error));
          else resolve(count);
        },
        options.signal,
      );
    });
  }

  async clone(options: LanguageModelCloneOptions): Promise<LanguageModel> {
    if (!this._session) {
      throw new Error('Model session is not initialized');
    }

    options.signal.throwIfAborted();

    // Clone via LanguageModelSession(transcript:) in the native layer
    const clonedSession = this._session.clone();
    options.signal.throwIfAborted();

    const cloned = new (this
      .constructor as typeof AppleIntelligenceLanguageModel)({
      contextUsage: this.contextUsage,
      contextWindow: this.contextWindow,
    });

    cloned._session = clonedSession;
    cloned._ownsSession = true;
    cloned._systemPrompt = this._systemPrompt;
    cloned._initialPrompts = this._initialPrompts;
    cloned._history = [...this._history];

    return cloned;
  }

  destroy(): void {
    if (this._ownsSession && this._session) {
      this._session.destroy();
    }
    this._session = null;
  }

  private _updateContextUsage(): void {
    if (this._session) {
      const text = this._buildPrompt([]);
      this._session.countTokens(text, (error, count) => {
        if (!error) {
          this.contextUsage = count;
        }
      });
    }
  }

  private _buildPrompt(input: LanguageModelMessage[]): string {
    const parts: string[] = [];

    // System prompt is already passed via session instructions; don't repeat.
    // Include conversation history and new input.
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
