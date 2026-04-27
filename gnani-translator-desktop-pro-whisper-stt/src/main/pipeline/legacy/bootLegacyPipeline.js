const { resolveLegacyEntry } = require('./resolveLegacyEntry');
const { logInfo } = require('../../utils/logger');

function bootLegacyPipeline() {
  const legacyMainPath = resolveLegacyEntry();
  logInfo(`Phase1 boot: loading legacy pipeline at ${legacyMainPath}`);
  // Phase 1 compatibility mode: execute the existing proven pipeline unchanged.
  // Next phases will extract module-by-module into src/main/services/*.
  require(legacyMainPath);
}

module.exports = {
  bootLegacyPipeline,
};
