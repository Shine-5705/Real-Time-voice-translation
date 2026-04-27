const { execFile } = require('child_process');

function createTextInjectionService({ logInfo, logError }) {
  function injectToFocusedApp(text) {
    return new Promise((resolve) => {
      const value = String(text || '').trim();
      if (!value) return resolve({ ok: true, skipped: true });
      if (process.platform !== 'darwin') {
        return resolve({ ok: false, error: 'Typing injection currently supports macOS only.' });
      }
      const script = `tell application "System Events" to keystroke ${JSON.stringify(value)}`;
      execFile('osascript', ['-e', script], (error) => {
        if (error) {
          logError(`Typing injection failed: ${error.message}`);
          resolve({ ok: false, error: error.message });
          return;
        }
        logInfo(`Typing injection success len=${value.length}`);
        resolve({ ok: true });
      });
    });
  }

  return {
    injectToFocusedApp,
  };
}

module.exports = {
  createTextInjectionService,
};
