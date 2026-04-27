const { logInfo } = require('../utils/logger');

class TranslationService {
  constructor() {
    this.running = false;
    this.activeConfig = null;
  }

  start(config) {
    this.running = true;
    this.activeConfig = { ...config };
    logInfo(
      `Pipeline(start): source=${config.sourceLanguage || 'n/a'} target=${config.targetLanguage || 'n/a'}`
    );
  }

  stop() {
    this.running = false;
    logInfo('Pipeline(stop)');
  }

  status() {
    return {
      running: this.running,
      activeConfig: this.activeConfig,
    };
  }
}

module.exports = {
  TranslationService,
};
