# @electron/llm

[![Test](https://github.com/electron/llm/actions/workflows/test.yml/badge.svg)](https://github.com/electron/llm/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@electron/llm.svg)](https://npmjs.org/package/@electron/llm)

A [`LanguageModel`](https://github.com/electron/electron/pull/50659) subclass for Electron's Prompt API, powered by [node-llama-cpp](https://github.com/withcatai/node-llama-cpp). Load any GGUF model and serve it to renderers via the standard `LanguageModel` web API.

> **This module requires Electron with Prompt API support** (see [electron/electron#50659](https://github.com/electron/electron/pull/50659)).

## How It Works

Electron's Prompt API lets web content call `LanguageModel.create()` and `model.prompt()` just like in Chrome. Your Electron app decides what model handles the request by running a `UtilityProcess` that registers a `LanguageModel` subclass via `localAIHandler.setPromptAPIHandler()`.

`@electron/llm` provides `LlamaCppLanguageModel` — a ready-made `LanguageModel` subclass that wires up `node-llama-cpp` so you don't have to write the boilerplate yourself. Subclass it, set `modelPath`, and you're done.

Import model classes and helpers from `@electron/llm/utility` (for use inside a `UtilityProcess`).

## Install

```sh
npm install @electron/llm
```

## Quick Start

### 1. Create the utility process script

```js
// ai-handler.js (runs in a UtilityProcess)
import { LlamaCppDownloadingLanguageModel, waitForMessage } from '@electron/llm/utility';
import { localAIHandler } from 'electron/utility';
import path from 'node:path';

const { options } = await waitForMessage((msg) => msg.type === 'init');

class MyModel extends LlamaCppDownloadingLanguageModel {
  static modelUrl = 'https://huggingface.co/user/repo/resolve/main/model.gguf';
  static modelPath = path.join(options.userDataPath, 'model.gguf');
}

localAIHandler.setPromptAPIHandler(() => MyModel);
```

### 2. Register it in the main process

```js
// main.js
import { app, BrowserWindow, utilityProcess, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, 'ai-handler.js'));
  child.postMessage({ type: 'init', options: { userDataPath: app.getPath('userData') } });

  const win = new BrowserWindow({
    webPreferences: {
      enableBlinkFeatures: 'AIPromptAPI',
    },
  });

  session.defaultSession.registerLocalAIHandler(child);
  win.loadFile('index.html');
});
```

### 3. Use the Prompt API in your renderer

```html
<script>
  async function askAI() {
    const model = await LanguageModel.create();
    const response = await model.prompt('What is Electron?');
    document.getElementById('response').textContent = response;
  }
</script>
<button onclick="askAI()">Ask AI</button>
<p id="response"></p>
```

## API

### `@electron/llm/utility`

#### `waitForMessage(predicate): Promise<T>`

Waits for a message on `process.parentPort` that satisfies the predicate. Returns the `data` of the first matching message; non-matching messages are ignored and the listener is removed after a match.

```js
import { waitForMessage } from '@electron/llm/utility';
const message = await waitForMessage((msg) => msg.type === 'init');
```

#### `LlamaCppLanguageModel`

A `LanguageModel` subclass that uses `node-llama-cpp` to run GGUF models locally.

##### `static modelPath: string | null`

Path to the GGUF model file. Must be set before the model can be created. Set this in your subclass:

```js
class MyModel extends LlamaCppLanguageModel {
  static modelPath = '/absolute/path/to/model.gguf';
}
```

#### `LlamaCppDownloadingLanguageModel`

A subclass of `LlamaCppLanguageModel` that automatically downloads a GGUF model from a URL before creating a session. If the model file already exists on disk, the download is skipped.

##### `static modelUrl: string | null`

The URL to download the GGUF model from. Must be set before the model can be created.

##### `static modelPath: string | null`

Where to save the downloaded model. Must be set explicitly — use `waitForMessage` to receive the app's `userData` path from the main process and build a path:

```js
import { LlamaCppDownloadingLanguageModel, waitForMessage } from '@electron/llm/utility';
import path from 'node:path';

const { options } = await waitForMessage((msg) => msg.type === 'init');

class MyModel extends LlamaCppDownloadingLanguageModel {
  static modelUrl = 'https://huggingface.co/user/repo/resolve/main/phi-3.gguf';
  static modelPath = path.join(options.userDataPath, 'phi-3.gguf');
}
```

## Testing

```sh
npm test              # run tests once
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```
