import {
  LlamaCppLanguageModel,
  waitForMessage,
} from '@dsanders11/electron-llm/utility';
import { localAIHandler } from 'electron/utility';
import path from 'node:path';

const { options } = await waitForMessage((msg) => msg.type === 'init');

class MyModel extends LlamaCppLanguageModel {
  static modelPath =
    options.modelPath || path.join(options.userDataPath, 'model.gguf');
}

localAIHandler.setPromptAPIHandler(() => MyModel);
