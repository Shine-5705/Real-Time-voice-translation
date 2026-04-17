const { ipcMain } = require('electron');

function registerCoreIpc({ mainWindow, translationService, genesysBridgeService }) {
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

  ipcMain.handle('genesys-bridge-start', async (_event, config = {}) => {
    if (!genesysBridgeService) {
      return { running: false, connected: false, message: 'Genesys bridge service not wired' };
    }
    const status = await genesysBridgeService.start(config);
    mainWindow.webContents.send('genesys-bridge-status', { ...status, message: 'Bridge started' });
    return status;
  });

  ipcMain.handle('genesys-bridge-stop', async () => {
    if (!genesysBridgeService) {
      return { running: false, connected: false, message: 'Genesys bridge service not wired' };
    }
    const status = genesysBridgeService.stop('Stopped by IPC');
    mainWindow.webContents.send('genesys-bridge-status', { ...status, message: 'Bridge stopped' });
    return status;
  });

  ipcMain.handle('genesys-bridge-status', async () => {
    if (!genesysBridgeService) {
      return { running: false, connected: false, message: 'Genesys bridge service not wired' };
    }
    return genesysBridgeService.status();
  });
}

module.exports = {
  registerCoreIpc,
};
