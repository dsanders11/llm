import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  LlamaCppLanguageModel,
  type LanguageModelCreateOptions,
} from './llama-cpp-language-model.js';

/**
 * A downloading variant of {@link LlamaCppLanguageModel} that automatically
 * downloads a GGUF model from a URL before creating a session.
 *
 * Set `modelUrl` to the URL of the GGUF model file, and `modelPath` to the
 * local path where it should be saved.
 *
 * @example
 * ```js
 * import { LlamaCppDownloadingLanguageModel, waitForMessage } from '@electron/llm/utility';
 * import { localAIHandler } from 'electron/utility';
 * import path from 'node:path';
 *
 * const { options } = await waitForMessage((msg) => msg.type === 'init');
 *
 * class MyModel extends LlamaCppDownloadingLanguageModel {
 *   static modelUrl = 'https://huggingface.co/user/repo/resolve/main/model.gguf';
 *   static modelPath = path.join(options.userDataPath, 'model.gguf');
 * }
 *
 * localAIHandler.setPromptAPIHandler(() => MyModel);
 * ```
 */
export class LlamaCppDownloadingLanguageModel extends LlamaCppLanguageModel {
  static modelUrl: string | null = null;

  private static _downloadPromise: Promise<void> | null = null;

  /**
   * Resolves `modelPath` — throws if not set.
   */
  private static _resolveModelPath(): string {
    if (!this.modelPath) {
      throw new Error(
        'modelPath must be set before using LlamaCppDownloadingLanguageModel.',
      );
    }
    return this.modelPath;
  }

  /**
   * Returns `'available'` when the model file exists on disk,
   * `'downloading'` when a download is in progress, `'downloadable'`
   * when a `modelUrl` is set but the file is not yet present, or
   * `'unavailable'` when no `modelUrl` has been configured.
   */
  static override async availability(): Promise<string> {
    if (!this.modelUrl) return 'unavailable';

    const modelPath = this._resolveModelPath();

    try {
      await access(modelPath);
      return 'available';
    } catch {
      // File doesn't exist yet
    }

    if (this._downloadPromise) return 'downloading';
    return 'downloadable';
  }

  static override async create(options: LanguageModelCreateOptions) {
    if (!this.modelUrl) {
      throw new Error('modelUrl must be set before creating a model instance');
    }

    await this._ensureModelDownloaded(options.signal);
    return super.create(options);
  }

  private static async _ensureModelDownloaded(
    signal: AbortSignal,
  ): Promise<void> {
    const modelPath = this._resolveModelPath();

    try {
      await access(modelPath);
      return;
    } catch {
      // File doesn't exist, need to download
    }

    if (this._downloadPromise) {
      return this._downloadPromise;
    }

    this._downloadPromise = this._downloadModel(modelPath, signal);
    try {
      await this._downloadPromise;
    } finally {
      this._downloadPromise = null;
    }
  }

  private static async _downloadModel(
    modelPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const tmpPath = modelPath + '.download';

    await mkdir(path.dirname(modelPath), { recursive: true });
    signal.throwIfAborted();

    const response = await fetch(this.modelUrl!, { signal });
    if (!response.ok) {
      throw new Error(
        `Failed to download model: ${response.status} ${response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error('Response body is empty');
    }

    try {
      const nodeStream = Readable.fromWeb(response.body as never);
      const fileStream = createWriteStream(tmpPath);
      await pipeline(nodeStream, fileStream, { signal });
      await rename(tmpPath, modelPath);
    } catch (error) {
      try {
        await unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }
}
