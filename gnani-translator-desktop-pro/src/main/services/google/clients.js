const fs = require('fs');
const path = require('path');

function createGoogleClients({ env, appDir }) {
  let googleTranslateClient = null;
  let googleTtsClient = null;
  let googleTtsBetaClient = null;
  let googleSpeechClient = null;

  function resolveGoogleKeyFile() {
    const raw = env('GOOGLE_APPLICATION_CREDENTIALS', 'ai-translation-app-493204-0353b0f7de43.json').trim();
    if (path.isAbsolute(raw)) {
      return raw;
    }
    const candidates = [
      // Relative to structured app root.
      path.join(appDir, raw),
      // Relative to repo root (parent of structured app).
      path.join(appDir, '..', raw),
      // Relative to legacy app folder.
      path.join(appDir, '..', 'gnani-translator-desktop', raw),
      // Relative to current cwd.
      path.join(process.cwd(), raw),
    ];
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) {
      return hit;
    }
    // Preserve old behavior as final fallback path (for clearer diagnostics).
    return path.join(appDir, '..', raw);
  }

  function getGoogleTranslateClient() {
    if (!googleTranslateClient) {
      const { Translate } = require('@google-cloud/translate').v2;
      googleTranslateClient = new Translate({ keyFilename: resolveGoogleKeyFile() });
    }
    return googleTranslateClient;
  }

  function getGoogleTtsClient() {
    if (!googleTtsClient) {
      const textToSpeech = require('@google-cloud/text-to-speech');
      googleTtsClient = new textToSpeech.TextToSpeechClient({ keyFilename: resolveGoogleKeyFile() });
    }
    return googleTtsClient;
  }

  function getGoogleTtsBetaClient() {
    if (!googleTtsBetaClient) {
      const textToSpeech = require('@google-cloud/text-to-speech');
      googleTtsBetaClient = new textToSpeech.v1beta1.TextToSpeechClient({ keyFilename: resolveGoogleKeyFile() });
    }
    return googleTtsBetaClient;
  }

  function getGoogleSpeechClient() {
    if (!googleSpeechClient) {
      const speech = require('@google-cloud/speech');
      googleSpeechClient = new speech.SpeechClient({ keyFilename: resolveGoogleKeyFile() });
    }
    return googleSpeechClient;
  }

  return {
    resolveGoogleKeyFile,
    getGoogleTranslateClient,
    getGoogleTtsClient,
    getGoogleTtsBetaClient,
    getGoogleSpeechClient,
  };
}

module.exports = {
  createGoogleClients,
};
