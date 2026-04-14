import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock electron/utility (base class dependency)
vi.mock('electron/utility', () => {
  class MockLanguageModel {
    contextUsage: number;
    contextWindow: number;
    constructor(values: { contextUsage: number; contextWindow: number }) {
      this.contextUsage = values.contextUsage;
      this.contextWindow = values.contextWindow;
    }
  }
  return { LanguageModel: MockLanguageModel };
});

// Mock node:fs
const mockCreateWriteStream = vi.fn().mockReturnValue({});
vi.mock('node:fs', () => ({
  createWriteStream: (...args: unknown[]) => mockCreateWriteStream(...args),
}));

// Mock node:fs/promises
const mockAccess = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockRename = vi.fn().mockResolvedValue(undefined);
const mockUnlink = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  rename: (...args: unknown[]) => mockRename(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

// Mock node:stream
const mockFromWeb = vi.fn().mockReturnValue({});
vi.mock('node:stream', () => ({
  Readable: { fromWeb: (...args: unknown[]) => mockFromWeb(...args) },
}));

// Mock node:stream/promises
const mockPipeline = vi.fn().mockResolvedValue(undefined);
vi.mock('node:stream/promises', () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
}));

// Mock node-llama-cpp
const mockGetSequence = vi.fn().mockReturnValue({});
const mockSession = {
  prompt: vi.fn(),
  getChatHistory: vi.fn().mockReturnValue([]),
  setChatHistory: vi.fn(),
};
const mockContext = {
  getSequence: mockGetSequence,
  contextSize: 4096,
};
const mockModel = {
  createContext: vi.fn().mockResolvedValue(mockContext),
  tokenize: vi.fn().mockReturnValue([1, 2, 3]),
};
vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn().mockResolvedValue({
    loadModel: vi.fn().mockResolvedValue(mockModel),
  }),
  LlamaChatSession: vi.fn().mockImplementation(function () {
    return mockSession;
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocks are set up
const { LlamaCppDownloadingLanguageModel } = await import(
  '../src/llama-cpp-downloading-language-model.js'
);

const fakeSignal = new AbortController().signal;

describe('LlamaCppDownloadingLanguageModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    mockMkdir.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockPipeline.mockResolvedValue(undefined);
    mockModel.createContext.mockResolvedValue(mockContext);
    mockFetch.mockResolvedValue({
      ok: true,
      body: 'mock-body',
    });
  });

  describe('static modelUrl', () => {
    it('defaults to null', () => {
      expect(LlamaCppDownloadingLanguageModel.modelUrl).toBeNull();
    });
  });

  describe('availability', () => {
    it('returns "unavailable" when modelUrl is null', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = null;
        static modelPath = '/tmp/test.gguf';
      }
      expect(await TestModel.availability()).toBe('unavailable');
    });

    it('returns "available" when model file exists', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = 'https://example.com/model.gguf';
        static modelPath = '/tmp/test.gguf';
      }
      mockAccess.mockResolvedValue(undefined);
      expect(await TestModel.availability()).toBe('available');
    });

    it('returns "downloadable" when file does not exist', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = 'https://example.com/model.gguf';
        static modelPath = '/tmp/test.gguf';
      }
      expect(await TestModel.availability()).toBe('downloadable');
    });

    it('returns "downloading" during active download', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = 'https://example.com/model.gguf';
        static modelPath = '/tmp/test.gguf';
      }
      // Simulate an in-progress download
      (TestModel as any)._downloadPromise = Promise.resolve();
      expect(await TestModel.availability()).toBe('downloading');
    });
  });

  describe('create', () => {
    it('throws when modelUrl is not set', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = null;
        static modelPath = '/tmp/test.gguf';
      }
      await expect(TestModel.create({ signal: fakeSignal })).rejects.toThrow(
        'modelUrl must be set',
      );
    });

    it('downloads model then creates instance', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = 'https://example.com/model.gguf';
        static modelPath = '/tmp/test.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });

      expect(instance).toBeInstanceOf(TestModel);
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/model.gguf', {
        signal: fakeSignal,
      });
      expect(mockPipeline).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalledWith(
        '/tmp/test.gguf.download',
        '/tmp/test.gguf',
      );
    });

    it('skips download when model file already exists', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = 'https://example.com/model.gguf';
        static modelPath = '/tmp/test.gguf';
      }
      mockAccess.mockResolvedValue(undefined);

      const instance = await TestModel.create({ signal: fakeSignal });

      expect(instance).toBeInstanceOf(TestModel);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('cleans up temp file on download failure', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = 'https://example.com/model.gguf';
        static modelPath = '/tmp/test.gguf';
      }
      mockPipeline.mockRejectedValue(new Error('network error'));

      await expect(TestModel.create({ signal: fakeSignal })).rejects.toThrow(
        'network error',
      );
      expect(mockUnlink).toHaveBeenCalledWith('/tmp/test.gguf.download');
    });

    it('throws on failed HTTP response', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = 'https://example.com/model.gguf';
        static modelPath = '/tmp/test.gguf';
      }
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(TestModel.create({ signal: fakeSignal })).rejects.toThrow(
        'Failed to download model: 404 Not Found',
      );
    });
  });

  describe('modelPath', () => {
    it('throws if modelPath is not set', async () => {
      class TestModel extends LlamaCppDownloadingLanguageModel {
        static modelUrl = 'https://example.com/model.gguf';
      }

      await expect(TestModel.availability()).rejects.toThrow(
        'modelPath must be set',
      );
    });
  });
});
