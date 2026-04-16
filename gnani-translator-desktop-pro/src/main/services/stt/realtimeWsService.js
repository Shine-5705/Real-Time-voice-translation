const WebSocket = require('ws');

function createRealtimeWsSttService({
  env,
  logInfo,
  logError,
  sendStatus,
  enqueueTranscript,
  enqueueTranscriptIncoming,
  sttRealtimeLangCode,
  getState,
  setSockets,
}) {
  function connectSTT(event, sourceLanguage) {
    return new Promise((resolve, reject) => {
      const endpoint = env('VACHANA_STT_REALTIME_ENDPOINT', 'wss://api.vachana.ai/stt/v3/stream').trim();
      const apiKey = env('VACHANA_API_KEY_ID').trim();
      if (!apiKey) return reject(new Error('VACHANA_API_KEY_ID missing in .env'));

      const langOverride = env('VACHANA_STT_LANG_CODE', '').trim();
      const langCode = langOverride || sttRealtimeLangCode(sourceLanguage);
      const includeLanguageHeader = env('VACHANA_STT_INCLUDE_LANGUAGE_HEADER', 'false').toLowerCase() === 'true';
      const headers = { 'x-api-key-id': apiKey, lang_code: langCode };
      if (includeLanguageHeader) headers['x-language-code'] = langCode;

      logInfo(`Connecting STT websocket to ${endpoint}`);
      const socket = new WebSocket(endpoint, { headers });
      setSockets({ sttSocket: socket });

      socket.on('open', () => resolve());
      socket.on('message', (payload, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.type === 'connected') return sendStatus(event, true, 'Connected to STT. Speak now.');
          if (msg.type === 'processing') return sendStatus(event, true, 'Processing speech segment...');
          if (msg.type === 'error') return sendStatus(event, true, `STT error: ${msg.message}`);
          enqueueTranscript(event, msg);
        } catch (error) {
          sendStatus(event, getState().translationRunning, `Bad STT message: ${error.message}`);
        }
      });
      socket.on('error', (error) => {
        logError(`STT SOCKET ERROR: ${error.message}`);
        if (String(error.message).includes('403')) {
          logError('STT auth rejected (403). Verify key scope and realtime entitlement.');
        }
        reject(error);
      });
      socket.on('close', () => {
        if (getState().translationRunning) sendStatus(event, false, 'STT disconnected. Click Start again.');
      });
    });
  }

  function connectSTTReturn(event, targetLanguage) {
    return new Promise((resolve, reject) => {
      const endpoint = env('VACHANA_STT_REALTIME_ENDPOINT', 'wss://api.vachana.ai/stt/v3/stream').trim();
      const apiKey = env('VACHANA_API_KEY_ID').trim();
      if (!apiKey) return reject(new Error('VACHANA_API_KEY_ID missing in .env'));

      const langOverride = env('VACHANA_STT_RETURN_LANG_CODE', '').trim();
      const langCode = langOverride || sttRealtimeLangCode(targetLanguage);
      const includeLanguageHeader = env('VACHANA_STT_INCLUDE_LANGUAGE_HEADER', 'false').toLowerCase() === 'true';
      const headers = { 'x-api-key-id': apiKey, lang_code: langCode };
      if (includeLanguageHeader) headers['x-language-code'] = langCode;

      logInfo(`Connecting return STT websocket (team audio, ${langCode}) to ${endpoint}`);
      const socket = new WebSocket(endpoint, { headers });
      setSockets({ sttSocketReturn: socket });

      socket.on('open', () => resolve());
      socket.on('message', (payload, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.type === 'connected' || msg.type === 'processing') return;
          if (msg.type === 'error') return logError(`Return STT error: ${msg.message}`);
          enqueueTranscriptIncoming(event, msg);
        } catch (error) {
          logError(`Bad return STT message: ${error.message}`);
        }
      });
      socket.on('error', (error) => {
        logError(`RETURN STT SOCKET ERROR: ${error.message}`);
        reject(error);
      });
      socket.on('close', () => {
        const state = getState();
        if (state.translationRunning && state.activeConfig?.bidirectional) {
          logError('Return STT disconnected (team-audio path).');
        }
      });
    });
  }

  return {
    connectSTT,
    connectSTTReturn,
  };
}

module.exports = {
  createRealtimeWsSttService,
};
