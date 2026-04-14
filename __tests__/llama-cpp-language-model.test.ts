import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock electron/utility — must be before dynamic import of the module under test
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

// Mock node-llama-cpp
const mockPrompt = vi.fn();
const mockGetChatHistory = vi.fn().mockReturnValue([]);
const mockSetChatHistory = vi.fn();
const mockSequence = { nextTokenIndex: 0 };
const mockGetSequence = vi.fn().mockReturnValue(mockSequence);
const mockTokenize = vi.fn().mockReturnValue([1, 2, 3, 4, 5]);

const mockSession = {
  prompt: mockPrompt,
  getChatHistory: mockGetChatHistory,
  setChatHistory: mockSetChatHistory,
  sequence: mockSequence,
};

const mockContext = {
  getSequence: mockGetSequence,
  contextSize: 4096,
};

const mockCreateGrammarForJsonSchema = vi
  .fn()
  .mockResolvedValue('mock-grammar');

const mockModel = {
  createContext: vi.fn().mockResolvedValue(mockContext),
  tokenize: mockTokenize,
  llama: {
    createGrammarForJsonSchema: (...args: unknown[]) =>
      mockCreateGrammarForJsonSchema(...args),
  },
};

vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn().mockResolvedValue({
    loadModel: vi.fn().mockResolvedValue(mockModel),
  }),
  LlamaChatSession: vi.fn().mockImplementation(function () {
    return mockSession;
  }),
}));

// Import after mocks are set up
const { LlamaCppLanguageModel } = await import(
  '../src/llama-cpp-language-model.js'
);

function makeMessages(text: string) {
  return [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, value: text }],
    },
  ];
}

const fakeSignal = new AbortController().signal;

describe('LlamaCppLanguageModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModel.createContext.mockResolvedValue(mockContext);
    mockGetChatHistory.mockReturnValue([]);
    mockSequence.nextTokenIndex = 0;
  });

  describe('static modelPath', () => {
    it('defaults to null', () => {
      expect(LlamaCppLanguageModel.modelPath).toBeNull();
    });
  });

  describe('availability', () => {
    it('returns "unavailable" when modelPath is null', async () => {
      class TestModel extends LlamaCppLanguageModel {
        static modelPath = null;
      }
      expect(await TestModel.availability()).toBe('unavailable');
    });

    it('returns "available" when modelPath is set and llama works', async () => {
      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      expect(await TestModel.availability()).toBe('available');
    });
  });

  describe('create', () => {
    it('throws if modelPath is not set', async () => {
      class TestModel extends LlamaCppLanguageModel {
        static modelPath = null;
      }
      await expect(TestModel.create({ signal: fakeSignal })).rejects.toThrow(
        'modelPath must be set',
      );
    });

    it('creates an instance with the correct contextWindow', async () => {
      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });
      expect(instance.contextWindow).toBe(4096);
      expect(instance.contextUsage).toBe(0);
    });

    it('extracts system prompt from initialPrompts', async () => {
      const { LlamaChatSession } = await import('node-llama-cpp');

      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }

      await TestModel.create({
        signal: fakeSignal,
        initialPrompts: [
          {
            role: 'system',
            content: [{ type: 'text', value: 'You are helpful' }],
          },
          {
            role: 'user',
            content: [{ type: 'text', value: 'Hello' }],
          },
        ],
      });

      expect(LlamaChatSession).toHaveBeenCalledWith(
        expect.objectContaining({ systemPrompt: 'You are helpful' }),
      );
    });
  });

  describe('prompt', () => {
    it('returns a ReadableStream with model output', async () => {
      mockPrompt.mockImplementation(
        async (
          _text: string,
          opts: { onTextChunk: (chunk: string) => void },
        ) => {
          opts.onTextChunk('Hello ');
          opts.onTextChunk('World');
        },
      );

      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });
      const stream = await instance.prompt(makeMessages('Hi'), {
        signal: fakeSignal,
      });

      const reader = stream.getReader();
      const chunks: string[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      expect(chunks).toEqual(['Hello ', 'World']);
    });

    it('updates contextUsage after prompt completes', async () => {
      mockPrompt.mockImplementation(
        async (
          _text: string,
          opts: { onTextChunk: (chunk: string) => void },
        ) => {
          mockSequence.nextTokenIndex = 42;
          opts.onTextChunk('response');
        },
      );

      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });
      expect(instance.contextUsage).toBe(0);

      const stream = await instance.prompt(makeMessages('Hi'), {
        signal: fakeSignal,
      });
      const reader = stream.getReader();
      while (!(await reader.read()).done);

      expect(instance.contextUsage).toBe(42);
    });

    it('passes grammar from JSON schema responseConstraint', async () => {
      mockPrompt.mockImplementation(
        async (
          _text: string,
          opts: { onTextChunk: (chunk: string) => void },
        ) => {
          opts.onTextChunk('{"answer":42}');
        },
      );

      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });
      const schema = {
        type: 'object',
        properties: { answer: { type: 'number' } },
      };
      const stream = await instance.prompt(makeMessages('Hi'), {
        signal: fakeSignal,
        responseConstraint: schema,
      });

      const reader = stream.getReader();
      while (!(await reader.read()).done);

      expect(mockCreateGrammarForJsonSchema).toHaveBeenCalledWith(schema);
      expect(mockPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ grammar: 'mock-grammar' }),
      );
    });

    it('throws for RegExp responseConstraint', async () => {
      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });

      await expect(
        instance.prompt(makeMessages('Hi'), {
          signal: fakeSignal,
          responseConstraint: /\d+/,
        }),
      ).rejects.toThrow('RegExp responseConstraint is not supported');
    });
  });

  describe('append', () => {
    it('adds messages to chat history', async () => {
      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });

      await instance.append(makeMessages('Context message'), {
        signal: fakeSignal,
      });

      expect(mockSetChatHistory).toHaveBeenCalled();
      const history = mockSetChatHistory.mock.calls.at(-1)[0];
      expect(history).toContainEqual({ type: 'user', text: 'Context message' });
    });

    it('updates contextUsage after append', async () => {
      mockSequence.nextTokenIndex = 15;

      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });
      expect(instance.contextUsage).toBe(0);

      await instance.append(makeMessages('Context message'), {
        signal: fakeSignal,
      });

      expect(instance.contextUsage).toBe(15);
    });
  });

  describe('measureContextUsage', () => {
    it('returns token count for the input', async () => {
      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });
      const count = await instance.measureContextUsage(makeMessages('test'), {
        signal: fakeSignal,
      });

      expect(count).toBe(5);
      expect(mockTokenize).toHaveBeenCalledWith('test');
    });
  });

  describe('clone', () => {
    it('creates a new instance with copied chat history', async () => {
      mockGetChatHistory.mockReturnValue([{ type: 'user', text: 'existing' }]);

      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });
      const cloned = await instance.clone({ signal: fakeSignal });

      expect(cloned).toBeInstanceOf(TestModel);
      expect(cloned.contextWindow).toBe(instance.contextWindow);
      expect(mockSetChatHistory).toHaveBeenCalledWith([
        { type: 'user', text: 'existing' },
      ]);
    });
  });

  describe('destroy', () => {
    it('nullifies internal state', async () => {
      class TestModel extends LlamaCppLanguageModel {
        static modelPath = '/path/to/model.gguf';
      }
      const instance = await TestModel.create({ signal: fakeSignal });
      instance.destroy();

      await expect(
        instance.prompt(makeMessages('Hi'), { signal: fakeSignal }),
      ).rejects.toThrow('not initialized');
    });
  });
});
