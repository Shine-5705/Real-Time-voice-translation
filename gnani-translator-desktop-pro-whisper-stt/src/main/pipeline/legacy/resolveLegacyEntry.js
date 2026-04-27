const path = require('path');

function resolveLegacyEntry() {
  return path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'gnani-translator-desktop',
    'main.js'
  );
}

module.exports = {
  resolveLegacyEntry,
};
