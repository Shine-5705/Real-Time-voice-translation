const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { env } = require('../config/env');
const { logInfo, logError, nowISO } = require('../utils/logger');
const { createGoogleClients } = require('../services/google/clients');
const { createTtsService } = require('../services/tts/ttsService');
const { createTranslator } = require('../services/translation/translator');
const { createTranscribeService } = require('../services/stt/transcribeService');
const { createRealtimeWsSttService } = require('../services/stt/realtimeWsService');
const { createRestLoopSttService } = require('../services/stt/restLoopService');
const { createArtifactService } = require('../services/artifacts/artifactService');
const { createTranscriptQueueService } = require('./queue/transcriptQueueService');
const { createTtsQueueService } = require('./queue/ttsQueueService');
const {
  normalizeLangCode,
  toVachanaLanguageCode,
  sttRealtimeLangCode,
  candidateEndpoints,
  parseTranslationText,
} = require('../services/common/pipelineUtils');

function elapsedMs(startMs) {
  return Math.max(0, Date.now() - Number(startMs || Date.now()));
}

function isMeaningfulTranscript(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

function normalizeTranscriptForDedupe(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSpeakerIdFromStt(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const direct = msg.speaker_id ?? msg.speakerId ?? msg.speaker ?? msg.spk_id ?? msg.participant_id;
  if (direct != null && String(direct).trim()) return String(direct).trim();
  const nested = msg.result || msg.data;
  if (nested && typeof nested === 'object') {
    const n = nested.speaker_id ?? nested.speakerId ?? nested.speaker;
    if (n != null && String(n).trim()) return String(n).trim();
  }
  return '';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 40000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    const name = err && err.name;
    const msg = String((err && err.message) || '');
    if (name === 'AbortError' || /aborted/i.test(msg)) {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms (url=${String(url).slice(0, 120)})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(endpoint) {
  const baseUrl = env('VACHANA_BASE_URL', 'https://api.vachana.ai');
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
  return `${baseUrl}${endpoint}`;
}

function bootRuntime({ app, createMainWindow }) {
  app.commandLine.appendSwitch('enable-logging');

  const appDir = path.join(__dirname, '..', '..', '..');
  const state = {
    mainWindow: null,
    translationRunning: false,
    activeConfig: null,
    activeSender: null,
    sttMode: 'ws',
    sttSocket: null,
    sttSocketReturn: null,
    restAudioBuffer: [],
    restInFlight: false,
    restOverlapBuffer: Buffer.alloc(0),
    restFlushTimer: null,
    restAudioBufferReturn: [],
    restInFlightReturn: false,
    restOverlapBufferReturn: Buffer.alloc(0),
    restFlushTimerReturn: null,
    metricsTimer: null,
    segmentCounter: 0,
    lastEnqueuedTranscriptNorm: '',
    lastEnqueuedTranscriptNormIncoming: '',
    recentSourceContext: [],
    recentTargetContext: [],
    recentIncomingSourceContext: [],
    recentIncomingTargetContext: [],
    voiceCloneEmbedding: null,
  };

  const googleClients = createGoogleClients({ env, appDir });
  const ttsService = createTtsService({
    env,
    logInfo,
    logError,
    elapsedMs,
    fetchWithTimeout,
    buildUrl,
    candidateEndpoints,
    getGoogleTtsClient: googleClients.getGoogleTtsClient,
    getGoogleTtsBetaClient: googleClients.getGoogleTtsBetaClient,
  });
  const translator = createTranslator({
    env,
    logInfo,
    logError,
    elapsedMs,
    fetchWithTimeout,
    buildUrl,
    candidateEndpoints,
    parseTranslationText,
    normalizeLangCode,
    getGoogleTranslateClient: googleClients.getGoogleTranslateClient,
  });
  const transcribeService = createTranscribeService({
    env,
    logInfo,
    logError,
    elapsedMs,
    fetchWithTimeout,
    buildUrl,
    candidateEndpoints,
    getGoogleSpeechClient: googleClients.getGoogleSpeechClient,
    toBcp47: ttsService.toBcp47,
  });
  const artifacts = createArtifactService({ env, nowISO, logInfo, logError });

  const getState = () => state;
  const setSockets = (patch) => Object.assign(state, patch);
  const setState = (patch) => Object.assign(state, patch);

  function appendContextText(direction, sourceText, translatedText) {
    const source = String(sourceText || '').trim();
    const target = String(translatedText || '').trim();
    if (!source || !target) return;
    const maxSegments = Number(env('CONTEXT_WINDOW_SEGMENTS', '4'));
    const maxChars = Number(env('CONTEXT_WINDOW_MAX_CHARS', '260'));
    const sourceBuf = direction === 'incoming' ? state.recentIncomingSourceContext : state.recentSourceContext;
    const targetBuf = direction === 'incoming' ? state.recentIncomingTargetContext : state.recentTargetContext;
    sourceBuf.push(source);
    targetBuf.push(target);
    while (sourceBuf.length > maxSegments) sourceBuf.shift();
    while (targetBuf.length > maxSegments) targetBuf.shift();
    while (sourceBuf.join(' ').length > maxChars && sourceBuf.length > 1) sourceBuf.shift();
    while (targetBuf.join(' ').length > maxChars && targetBuf.length > 1) targetBuf.shift();
  }

  function getContextHint() {
    const enabled = env('ENABLE_CONTEXTUAL_TRANSLATION', 'true').toLowerCase() === 'true';
    if (!enabled) return { source: '', target: '' };
    return { source: state.recentSourceContext.join(' '), target: state.recentTargetContext.join(' ') };
  }

  function getContextHintReverse() {
    const enabled = env('ENABLE_CONTEXTUAL_TRANSLATION', 'true').toLowerCase() === 'true';
    if (!enabled) return { source: '', target: '' };
    return {
      source: state.recentIncomingSourceContext.join(' '),
      target: state.recentIncomingTargetContext.join(' '),
    };
  }

  function appendTranslatedLine(segmentId, isIncoming, sourceLanguage, targetLanguage, translatedText) {
    if (!artifacts.getSessionArtifacts()) return;
    artifacts.appendLine(
      artifacts.getSessionArtifacts().translatedLogPath,
      `[${nowISO()}] seg=${segmentId} ${isIncoming ? '[in] ' : ''}${sourceLanguage}->${targetLanguage} :: ${translatedText}`
    );
  }

  function sendStatus(event, running, message) {
    logInfo(`STATUS running=${running} :: ${message}`);
    artifacts.writeEvent('status', { running, message });
    event.sender.send('translation-status', { running, message });
  }

  const ttsQueue = createTtsQueueService({
    env,
    logInfo,
    logError,
    elapsedMs,
    synthesizeRestTtsSequentialToRenderer: ttsService.synthesizeRestTtsSequentialToRenderer,
    streamTTSRealtime: ttsService.streamTTSRealtime,
    writeEvent: artifacts.writeEvent,
    writePipelineRow: artifacts.writePipelineRow,
    sendStatus,
    getState,
  });

  const transcriptQueue = createTranscriptQueueService({
    env,
    logInfo,
    logError,
    elapsedMs,
    appendContextText,
    getContextHint,
    getContextHintReverse,
    toVachanaLanguageCode,
    translateText: translator.translateText,
    enqueueTtsJob: ttsQueue.enqueueTtsJob,
    writeEvent: artifacts.writeEvent,
    appendTranslatedLine,
  });

  function enqueueTranscript(event, msg) {
    if (!msg || msg.type !== 'transcript' || !msg.text || !msg.text.trim()) return;
    if (!isMeaningfulTranscript(msg.text)) {
      logInfo(`STT noise skipped: "${String(msg.text).trim()}"`);
      artifacts.writeEvent('segment_skipped_noise', { raw_text: String(msg.text).trim() });
      return;
    }
    const normalized = normalizeTranscriptForDedupe(msg.text);
    if (normalized && normalized === state.lastEnqueuedTranscriptNorm) return;
    state.lastEnqueuedTranscriptNorm = normalized;
    state.segmentCounter += 1;
    transcriptQueue.push({
      id: state.segmentCounter,
      event,
      text: String(msg.text).trim(),
      detectedLanguage: msg.detected_language || state.activeConfig?.sourceLanguage || 'unknown',
      speakerId: extractSpeakerIdFromStt(msg),
      latency: msg.latency || 'realtime',
      receivedAt: nowISO(),
      createdAtMs: Date.now(),
      sttElapsedMs: msg.sttElapsedMs || 0,
      activeConfig: state.activeConfig,
    });
  }

  function enqueueTranscriptIncoming(event, msg) {
    if (!msg || msg.type !== 'transcript' || !msg.text || !msg.text.trim()) return;
    if (!isMeaningfulTranscript(msg.text)) return;
    const normalized = normalizeTranscriptForDedupe(msg.text);
    if (normalized && normalized === state.lastEnqueuedTranscriptNormIncoming) return;
    state.lastEnqueuedTranscriptNormIncoming = normalized;
    state.segmentCounter += 1;
    transcriptQueue.push({
      id: state.segmentCounter,
      event,
      text: String(msg.text).trim(),
      detectedLanguage: msg.detected_language || state.activeConfig?.targetLanguage || 'unknown',
      speakerId: extractSpeakerIdFromStt(msg),
      latency: msg.latency || 'realtime-incoming',
      receivedAt: nowISO(),
      createdAtMs: Date.now(),
      direction: 'in',
      sttElapsedMs: msg.sttElapsedMs || 0,
      activeConfig: state.activeConfig,
    });
  }

  const realtimeWs = createRealtimeWsSttService({
    env,
    logInfo,
    logError,
    sendStatus,
    enqueueTranscript,
    enqueueTranscriptIncoming,
    sttRealtimeLangCode,
    getState,
    setSockets,
  });

  const restLoops = createRestLoopSttService({
    env,
    logInfo,
    logError,
    elapsedMs,
    sendStatus,
    transcribeViaGoogle: transcribeService.transcribeViaGoogle,
    transcribeViaRest: transcribeService.transcribeViaRest,
  });

  function teardownPipeline() {
    state.translationRunning = false;
    if (state.metricsTimer) clearInterval(state.metricsTimer);
    if (state.restFlushTimer) clearInterval(state.restFlushTimer);
    if (state.restFlushTimerReturn) clearInterval(state.restFlushTimerReturn);
    state.metricsTimer = null;
    state.restFlushTimer = null;
    state.restFlushTimerReturn = null;
    if (state.sttSocket) {
      try { state.sttSocket.close(); } catch (_e) {}
      state.sttSocket = null;
    }
    if (state.sttSocketReturn) {
      try { state.sttSocketReturn.close(); } catch (_e) {}
      state.sttSocketReturn = null;
    }
    artifacts.writePipelineSummary();
  }

  function registerIpc() {
    ipcMain.on('start-translation', (event, config = {}) => {
      state.activeSender = event.sender;
      const sourceLanguage = config.sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN');
      const targetLanguage = config.targetLanguage || env('VACHANA_DEFAULT_TARGET_LANGUAGE', 'hi-IN');
      const bidirectionalRequested = Boolean(config.bidirectional);
      const listenDeviceId = String(config.listenDeviceId || '').trim();
      const localOutputDeviceId = String(config.localOutputDeviceId || '').trim();
      artifacts.initSessionArtifacts(appDir, sourceLanguage, targetLanguage);
      artifacts.writeEvent('session_start', {
        source_language: sourceLanguage,
        target_language: targetLanguage,
        bidirectional: bidirectionalRequested,
        listen_device_id: listenDeviceId,
        local_output_device_id: localOutputDeviceId,
      });
      state.activeConfig = {
        sourceLanguage,
        targetLanguage,
        bidirectional: bidirectionalRequested,
        listenDeviceId,
        localOutputDeviceId,
      };
      state.translationRunning = true;
      state.sttMode = 'ws';
      state.segmentCounter = 0;
      state.lastEnqueuedTranscriptNorm = '';
      state.lastEnqueuedTranscriptNormIncoming = '';
      state.recentSourceContext = [];
      state.recentTargetContext = [];
      state.recentIncomingSourceContext = [];
      state.recentIncomingTargetContext = [];

      if (state.metricsTimer) clearInterval(state.metricsTimer);
      state.metricsTimer = setInterval(() => {
        if (state.translationRunning) {
          logInfo(`AUDIO queue=${transcriptQueue.getQueue().length}`);
        }
      }, 5000);

      const sttModePref = env('VACHANA_STT_MODE', 'ws').toLowerCase();
      if (sttModePref === 'rest') {
        state.sttMode = 'rest';
        restLoops.startRestSttFallback({ state, setState, event, sourceLanguage, enqueueTranscript });
        if (bidirectionalRequested) {
          restLoops.startRestSttReturnPath({ state, event, targetLanguage, enqueueTranscriptIncoming });
          return sendStatus(event, true, `Bidirectional REST mode: you (${sourceLanguage}) → meeting; team (${targetLanguage}) → headphones.`);
        }
        return sendStatus(event, true, `Pipeline started in REST mode (${sourceLanguage} -> ${targetLanguage}).`);
      }

      realtimeWs.connectSTT(event, sourceLanguage)
        .then(() => {
          state.sttMode = 'ws';
          if (!state.activeConfig.bidirectional) {
            sendStatus(event, true, `Pipeline started (${sourceLanguage} -> ${targetLanguage}).`);
            return;
          }
          return realtimeWs.connectSTTReturn(event, targetLanguage)
            .then(() => sendStatus(event, true, `Bidirectional: you → ${targetLanguage} (meeting); team → ${sourceLanguage} (headphones).`))
            .catch((err) => {
              state.activeConfig.bidirectional = false;
              logError(`Return STT connect failed: ${err.message}`);
              sendStatus(event, true, `Pipeline started (${sourceLanguage} -> ${targetLanguage}). Team listen disabled: ${err.message}`);
            });
        })
        .catch((error) => {
          const restFallback = env('ENABLE_STT_REST_FALLBACK', 'true').toLowerCase() === 'true';
          if (restFallback) {
            state.sttMode = 'rest';
            restLoops.startRestSttFallback({ state, setState, event, sourceLanguage, enqueueTranscript });
            sendStatus(event, true, `WS STT failed (${error.message}). REST fallback active.`);
            return;
          }
          state.translationRunning = false;
          sendStatus(event, false, `Failed to start pipeline: ${error.message}`);
          teardownPipeline();
        });
    });

    ipcMain.on('stop-translation', (event) => {
      artifacts.writeEvent('session_stop', {});
      teardownPipeline();
      sendStatus(event, false, 'Translation stopped.');
    });

    ipcMain.on('audio-chunk', (_event, chunkBytes) => {
      if (!state.translationRunning || !chunkBytes) return;
      const buffer = Buffer.isBuffer(chunkBytes) ? chunkBytes : Buffer.from(chunkBytes);
      if (buffer.length !== 1024) return;
      if (state.sttMode === 'rest') {
        state.restAudioBuffer.push(buffer);
        return;
      }
      if (!state.sttSocket || state.sttSocket.readyState !== 1) return;
      state.sttSocket.send(buffer);
    });

    ipcMain.on('audio-chunk-return', (_event, chunkBytes) => {
      if (!state.translationRunning || !state.activeConfig?.bidirectional || !chunkBytes) return;
      const buffer = Buffer.isBuffer(chunkBytes) ? chunkBytes : Buffer.from(chunkBytes);
      if (buffer.length !== 1024) return;
      if (state.sttMode === 'rest') {
        state.restAudioBufferReturn.push(buffer);
        return;
      }
      if (!state.sttSocketReturn || state.sttSocketReturn.readyState !== 1) return;
      state.sttSocketReturn.send(buffer);
    });

    ipcMain.on('mic-activity', (_event, payload = {}) => {
      const rms = Number(payload.rms || 0).toFixed(4);
      const speaking = Boolean(payload.speaking);
      const queuedFrames = Number(payload.queuedFrames || 0);
      const sourceLang = payload.sourceLang || state.activeConfig?.sourceLanguage || 'n/a';
      const targetLang = payload.targetLang || state.activeConfig?.targetLanguage || 'n/a';
      logInfo(`MIC activity speaking=${speaking} rms=${rms} queuedFrames=${queuedFrames} lang=${sourceLang}->${targetLang}`);
    });

    ipcMain.handle('enroll-voice', async (_event, wavBase64) => {
      const startMs = Date.now();
      const apiKey = env('VACHANA_API_KEY_ID');
      if (!apiKey) {
        return { success: false, error: 'VACHANA_API_KEY_ID not set in .env' };
      }
      try {
        const wavBuf = Buffer.from(wavBase64, 'base64');
        const endpoint = env('VACHANA_VOICE_CLONE_EMBEDDING_ENDPOINT', '/api/v1/tts/voice-clone/embeddings');
        const url = buildUrl(endpoint);
        const boundary = `----VCFormBoundary${Date.now()}`;
        const header = Buffer.from(
          `--${boundary}\r\n`
          + 'Content-Disposition: form-data; name="audio_file"; filename="enroll.wav"\r\n'
          + 'Content-Type: audio/wav\r\n\r\n'
        );
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([header, wavBuf, footer]);
        const resp = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'X-API-Key-ID': apiKey,
          },
          body,
        }, 30000);
        if (!resp.ok) {
          const errText = await resp.text();
          logError(`Voice enrollment failed: status=${resp.status} body=${errText.slice(0, 300)}`);
          return { success: false, error: `Server returned ${resp.status}` };
        }
        const json = await resp.json();
        if (!json.success || !json.data?.voice_clone_embedding) {
          return { success: false, error: json.message || 'No embedding in response' };
        }
        state.voiceCloneEmbedding = json.data.voice_clone_embedding;
        const embeddingPath = path.join(appDir, '..', 'workdir', 'voice_embedding.json');
        fs.mkdirSync(path.dirname(embeddingPath), { recursive: true });
        fs.writeFileSync(embeddingPath, JSON.stringify(state.voiceCloneEmbedding, null, 2), 'utf8');
        logInfo(`Voice enrollment SUCCESS elapsed_ms=${elapsedMs(startMs)} path=${embeddingPath}`);
        if (state.mainWindow && !state.mainWindow.isDestroyed()) {
          state.mainWindow.webContents.send('enroll-status', { enrolled: true });
        }
        return { success: true };
      } catch (err) {
        logError(`Voice enrollment error: ${err.message}`);
        return { success: false, error: err.message };
      }
    });
  }

  app.whenReady().then(() => {
    state.mainWindow = createMainWindow();
    state.mainWindow.webContents.on('did-finish-load', () => {
      const embeddingPath = path.join(appDir, '..', 'workdir', 'voice_embedding.json');
      if (fs.existsSync(embeddingPath)) {
        try {
          state.voiceCloneEmbedding = JSON.parse(fs.readFileSync(embeddingPath, 'utf8'));
          state.mainWindow.webContents.send('enroll-status', { enrolled: true });
          logInfo(`Loaded saved voice embedding from ${embeddingPath}`);
        } catch (err) {
          logError(`Failed loading saved voice embedding: ${err.message}`);
        }
      }
    });
    registerIpc();
    sendStatus({ sender: state.mainWindow.webContents }, false, 'Ready.');
  });

  app.on('activate', () => {
    if (!state.mainWindow) {
      state.mainWindow = createMainWindow();
    }
  });

  app.on('window-all-closed', () => {
    teardownPipeline();
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = {
  bootRuntime,
};
