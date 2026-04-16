const { ipcMain } = require('electron');

function registerCoreIpc({ mainWindow, translationService }) {
  ipcMain.on('start-translation', (_event, config) => {
    translationService.start(config || {});
    mainWindow.webContents.send('translation-status', {
      running: true,
      message: 'Structured pipeline started',
    });
  });

  ipcMain.on('stop-translation', () => {
    translationService.stop();
    mainWindow.webContents.send('translation-status', {
      running: false,
      message: 'Structured pipeline stopped',
    });
  });

  ipcMain.on('mic-activity', (_event, payload) => {
    // Keep this hook to support renderer telemetry.
    if (!translationService.status().running) {
      return;
    }
    mainWindow.webContents.send('translation-status', {
      running: true,
      message: `Mic ${payload?.speaking ? 'speaking' : 'idle'}`,
    });
  });

  ipcMain.handle('enroll-voice', async () => {
    return { ok: true, message: 'Voice enrollment scaffold ready' };
  });
}

module.exports = {
  registerCoreIpc,
};
