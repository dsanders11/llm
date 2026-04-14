import { app, BrowserWindow, utilityProcess, session } from 'electron';
import path from 'path';

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 800,
    webPreferences: {
      enableBlinkFeatures: 'AIPromptAPI',
    },
  });

  mainWindow.loadFile('../static/index.html');
}

app.on('ready', async () => {
  // Fork the utility process running the AI handler
  const aiHandler = utilityProcess.fork(path.join(__dirname, 'ai-handler.js'));
  aiHandler.postMessage({
    type: 'init',
    options: { userDataPath: app.getPath('userData') },
  });

  const win = await createWindow();

  // Register the AI handler for the default session
  session.defaultSession.registerLocalAIHandler(aiHandler);
});
