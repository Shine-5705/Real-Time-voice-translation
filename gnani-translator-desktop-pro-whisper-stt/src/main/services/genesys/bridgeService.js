const WebSocket = require('ws');

function createGenesysBridgeService({
  env,
  logInfo,
  logError,
  normalizeTranscriptMessage,
  onStatus,
  onTranscript,
}) {
  const state = {
    running: false,
    connected: false,
    mode: 'assist',
    endpoint: '',
    socket: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    sessionId: '',
  };

  function emitStatus(message = '') {
    if (typeof onStatus === 'function') {
      onStatus({
        running: state.running,
        connected: state.connected,
        mode: state.mode,
        endpoint: state.endpoint,
        message,
      });
    }
  }

  function clearReconnect() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function closeSocket() {
    if (!state.socket) return;
    try {
      state.socket.removeAllListeners();
      state.socket.close();
    } catch (_err) {
      // no-op
    }
    state.socket = null;
  }

  function scheduleReconnect() {
    if (!state.running || state.mode === 'assist' || !state.endpoint) return;
    clearReconnect();
    state.reconnectAttempt += 1;
    const maxMs = Number(env('GENESYS_BRIDGE_RECONNECT_MAX_MS', '30000'));
    const backoff = Math.min(maxMs, 1000 * (2 ** Math.min(8, state.reconnectAttempt)));
    state.reconnectTimer = setTimeout(() => {
      connectSocket().catch((err) => {
        logError(`Genesys bridge reconnect failed: ${err.message}`);
        scheduleReconnect();
      });
    }, backoff);
    emitStatus(`Reconnect scheduled in ${backoff}ms`);
  }

  function handleMessage(rawData, isBinary) {
    if (isBinary) {
      return;
    }
    let msg = null;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (err) {
      logError(`Genesys bridge JSON parse error: ${err.message}`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'heartbeat') {
      emitStatus('Heartbeat received');
      return;
    }
    if (msg.type === 'status') {
      emitStatus(String(msg.message || 'Status update'));
      return;
    }
    if (msg.type === 'transcript') {
      const normalized = normalizeTranscriptMessage(msg);
      if (!normalized) return;
      if (typeof onTranscript === 'function') onTranscript(normalized);
      return;
    }
  }

  function connectSocket() {
    return new Promise((resolve, reject) => {
      if (!state.endpoint) {
        reject(new Error('GENESYS_STREAM_ENDPOINT missing'));
        return;
      }

      const apiKey = env('GENESYS_BRIDGE_API_KEY', '').trim();
      const socket = new WebSocket(state.endpoint, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      state.socket = socket;

      socket.on('open', () => {
        state.connected = true;
        state.reconnectAttempt = 0;
        emitStatus('Connected');
        logInfo(`Genesys bridge connected: ${state.endpoint}`);
        resolve();
      });

      socket.on('message', (data, isBinary) => handleMessage(data, isBinary));
      socket.on('error', (err) => {
        state.connected = false;
        emitStatus(`Socket error: ${err.message}`);
        reject(err);
      });
      socket.on('close', () => {
        state.connected = false;
        emitStatus('Disconnected');
        if (state.running) scheduleReconnect();
      });
    });
  }

  async function start(config = {}) {
    const requestedMode = String(config.deliveryMode || env('GENESYS_INTEGRATION_MODE', 'assist')).toLowerCase();
    state.mode = requestedMode;
    state.endpoint = String(config.streamEndpoint || env('GENESYS_STREAM_ENDPOINT', '')).trim();
    state.sessionId = String(config.sessionId || '').trim();
    state.running = true;
    emitStatus('Starting');

    if (requestedMode === 'assist') {
      emitStatus('Assist mode active (bridge socket not required)');
      return status();
    }

    await connectSocket();
    return status();
  }

  function stop(reason = 'Stopped') {
    state.running = false;
    state.connected = false;
    clearReconnect();
    closeSocket();
    emitStatus(reason);
    return status();
  }

  function canPublishAudio() {
    return state.running && state.connected && state.socket && (state.mode === 'inject' || state.mode === 'both');
  }

  function publishTtsChunk(chunkPayload) {
    if (!canPublishAudio() || !chunkPayload) return false;
    try {
      state.socket.send(JSON.stringify({
        type: 'translated-audio-chunk',
        sessionId: state.sessionId || undefined,
        ...chunkPayload,
      }));
      return true;
    } catch (err) {
      logError(`Genesys bridge publish chunk failed: ${err.message}`);
      return false;
    }
  }

  function publishTtsAudio(audioPayload) {
    if (!canPublishAudio() || !audioPayload) return false;
    try {
      state.socket.send(JSON.stringify({
        type: 'translated-audio',
        sessionId: state.sessionId || undefined,
        ...audioPayload,
      }));
      return true;
    } catch (err) {
      logError(`Genesys bridge publish audio failed: ${err.message}`);
      return false;
    }
  }

  function publishTtsDone(donePayload = {}) {
    if (!canPublishAudio()) return false;
    try {
      state.socket.send(JSON.stringify({
        type: 'translated-audio-done',
        sessionId: state.sessionId || undefined,
        ...donePayload,
      }));
      return true;
    } catch (err) {
      logError(`Genesys bridge publish done failed: ${err.message}`);
      return false;
    }
  }

  function status() {
    return {
      running: state.running,
      connected: state.connected,
      mode: state.mode,
      endpoint: state.endpoint,
      reconnectAttempt: state.reconnectAttempt,
      sessionId: state.sessionId,
    };
  }

  return {
    start,
    stop,
    status,
    publishTtsChunk,
    publishTtsAudio,
    publishTtsDone,
  };
}

module.exports = {
  createGenesysBridgeService,
};
