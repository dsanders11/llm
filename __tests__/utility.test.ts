import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock electron/utility (needed by LlamaCppLanguageModel base)
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

// Mock node-llama-cpp (needed by LlamaCppLanguageModel base)
vi.mock('node-llama-cpp', () => ({
  getLlama: vi.fn(),
  LlamaChatSession: vi.fn(),
}));

// Simulate process.parentPort
type MessageHandler = (event: { data: unknown }) => void;
let listeners: MessageHandler[] = [];
const mockParentPort = {
  on: vi.fn((event: string, listener: MessageHandler) => {
    if (event === 'message') listeners.push(listener);
  }),
  off: vi.fn((event: string, listener: MessageHandler) => {
    if (event === 'message') {
      listeners = listeners.filter((l) => l !== listener);
    }
  }),
};
vi.stubGlobal('process', { ...process, parentPort: mockParentPort });

const { waitForMessage } = await import('../src/utility.js');

describe('waitForMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners = [];
  });

  it('resolves with the first matching message', async () => {
    const promise = waitForMessage(
      (msg: { type: string }) => msg.type === 'init',
    );

    // Send a non-matching then matching message
    listeners[0]!({ data: { type: 'other' } });
    listeners[0]!({
      data: { type: 'init', options: { userDataPath: '/test' } },
    });

    const result = await promise;
    expect(result).toEqual({
      type: 'init',
      options: { userDataPath: '/test' },
    });
  });

  it('removes the listener after matching', async () => {
    const promise = waitForMessage(
      (msg: { type: string }) => msg.type === 'init',
    );

    expect(listeners).toHaveLength(1);
    listeners[0]!({ data: { type: 'init' } });
    await promise;

    expect(mockParentPort.off).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
    expect(listeners).toHaveLength(0);
  });

  it('keeps listening when predicate returns false', async () => {
    const promise = waitForMessage((msg: { count: number }) => msg.count === 3);

    listeners[0]!({ data: { count: 1 } });
    listeners[0]!({ data: { count: 2 } });
    expect(listeners).toHaveLength(1);

    listeners[0]!({ data: { count: 3 } });
    const result = await promise;
    expect(result).toEqual({ count: 3 });
  });
});
