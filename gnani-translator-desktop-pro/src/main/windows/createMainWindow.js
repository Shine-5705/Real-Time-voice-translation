const path = require('path');
const { BrowserWindow } = require('electron');

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  return win;
}

module.exports = {
  createMainWindow,
};
