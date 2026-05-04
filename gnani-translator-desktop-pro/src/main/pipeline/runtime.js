/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║              Real-Time Call Translation – Pipeline Runtime                  ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║                                                                            ║
 * ║  CUSTOMER PIPELINE  (Phone → Agent)                                        ║
 * ║  ──────────────────────────────────                                        ║
 * ║  Phone → Genesys → Blackhole 16ch → [STT] → [Translate] → [TTS] → Agent   ║
 * ║                                                                            ║
 * ║  AGENT PIPELINE  (Agent → Phone)                                           ║
 * ║  ──────────────────────────────────                                        ║
 * ║  Agent Mic → [STT] → [Translate] → [TTS] → Blackhole 2ch → Genesys → Phone║
 * ║                                                                            ║
 * ║  Pluggable components (via .env):                                          ║
 * ║    STT_PROVIDER          = auto | google | deepgram | vachana              ║
 * ║    VACHANA_STT_MODE      = ws     | rest                                   ║
 * ║    TRANSLATION_PROVIDER  = google | vachana                                ║
 * ║    TTS_PROVIDER          = google | vachana                                ║
 * ║    ENABLE_TTS_REALTIME_WS = true  | false  (vachana WS TTS)               ║
 * ║                                                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { env } = require('../config/env');
const { logInfo, logError, nowISO } = require('../utils/logger');

// ─── Google Cloud clients (lazy singletons) ──────────────────────────────────
const { createGoogleClients } = require('../services/google/clients');

// ─── Pluggable provider factories ────────────────────────────────────────────
const { createSttProviderFactory } = require('../services/stt/sttProviderFactory');
const { createTranslationProviderFactory } = require('../services/translation/translationProviderFactory');
const { createTtsProviderFactory } = require('../services/tts/ttsProviderFactory');

// ─── Underlying service implementations (used by factories) ──────────────────
const { createTtsService } = require('../services/tts/ttsService');
const { createTranslator } = require('../services/translation/translator');
const { createTranscribeService } = require('../services/stt/transcribeService');
const { createRealtimeWsSttService } = require('../services/stt/realtimeWsService');
const { createGoogleStreamingSttService } = require('../services/stt/googleStreamingSttService');
const { createDeepgramStreamingSttService } = require('../services/stt/deepgramStreamingSttService');
const { createRestLoopSttService } = require('../services/stt/restLoopService');

// ─── Shared services ─────────────────────────────────────────────────────────
const { createArtifactService } = require('../services/artifacts/artifactService');
const { createTranscriptQueueService } = require('./queue/transcriptQueueService');
const { createTtsQueueService } = require('./queue/ttsQueueService');

// ─── Genesys integration ─────────────────────────────────────────────────────
const { createGenesysBridgeService } = require('../services/genesys/bridgeService');
const { normalizeTranscriptMessage } = require('../services/genesys/mediaAdapter');

// ─── Utilities ───────────────────────────────────────────────────────────────
const {
  isIndicLanguage,
  sttProviderForLanguage,
  normalizeLangCode,
  toVachanaLanguageCode,
  sttRealtimeLangCode,
  candidateEndpoints,
  parseTranslationText,
} = require('../services/common/pipelineUtils');

/* ═══════════════════════════════════════════════════════════════════════════════
 *  Helpers
 * ═══════════════════════════════════════════════════════════════════════════ */

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

function tokenizeNormalized(text) {
  return String(text || '').split(' ').map((t) => t.trim()).filter(Boolean);
}

function isLikelyEchoText(candidateNorm, referenceNorm) {
  const a = String(candidateNorm || '').trim();
  const b = String(referenceNorm || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;

  // Common loopback pattern: STT hears a shortened/expanded version.
  const minContainChars = 14;
  if (Math.min(a.length, b.length) >= minContainChars) {
    if (a.includes(b) || b.includes(a)) return true;
  }

  const aTokens = tokenizeNormalized(a);
  const bTokens = tokenizeNormalized(b);
  if (aTokens.length < 4 || bTokens.length < 4) return false;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let intersect = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersect += 1;
  }
  const smaller = Math.max(1, Math.min(aSet.size, bSet.size));
  const overlap = intersect / smaller;
  return overlap >= 0.72;
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

function extractPcmFromWavBuffer(wavBuffer) {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44) return Buffer.alloc(0);
  const riff = wavBuffer.toString('ascii', 0, 4);
  const wave = wavBuffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') return Buffer.alloc(0);
  const dataId = wavBuffer.toString('ascii', 36, 40);
  if (dataId !== 'data') return Buffer.alloc(0);
  const dataSize = wavBuffer.readUInt32LE(40);
  const end = Math.min(wavBuffer.length, 44 + dataSize);
  if (end <= 44) return Buffer.alloc(0);
  return wavBuffer.subarray(44, end);
}

/* ═══════════════════════════════════════════════════════════════════════════════
 *  Boot Runtime
 * ═══════════════════════════════════════════════════════════════════════════ */

function bootRuntime({ app, createMainWindow }) {
  app.commandLine.appendSwitch('enable-logging');
  const appDir = path.join(__dirname, '..', '..', '..');

  /* ─── Shared pipeline state ─────────────────────────────────────────────── */

  const state = {
    mainWindow: null,
    translationRunning: false,
    activeConfig: null,
    activeSender: null,

    // STT state (populated by providers at start-translation)
    sttMode: 'ws',
    // Legacy global provider (kept for REST-loop compat); prefer per-pipeline below
    sttProvider: 'vachana',
    // Per-pipeline providers — Customer and Agent may differ when STT_PROVIDER=auto
    sttProviderCustomer: 'vachana',
    sttProviderAgent: 'vachana',
    sttSocket: null,           // Customer Pipeline: Vachana/Deepgram WS
    sttSocketReturn: null,     // Agent Pipeline:    Vachana/Deepgram WS
    sttGoogleStream: null,     // Customer Pipeline: Google streaming
    sttGoogleStreamReturn: null, // Agent Pipeline:  Google streaming

    // REST STT buffers
    restAudioBuffer: [],
    restInFlight: false,
    restOverlapBuffer: Buffer.alloc(0),
    restFlushTimer: null,
    restAudioBufferReturn: [],
    restInFlightReturn: false,
    restOverlapBufferReturn: Buffer.alloc(0),
    restFlushTimerReturn: null,

    // Metrics
    metricsTimer: null,
    audioFramesForwarded: 0,
    audioFramesDropped: 0,

    // Segment tracking
    segmentCounter: 0,
    lastEnqueuedTranscriptNorm: '',
    lastEnqueuedTranscriptAtMs: 0,
    lastEnqueuedTranscriptNormIncoming: '',
    lastEnqueuedTranscriptIncomingAtMs: 0,
    lastOutgoingTranslatedNorm: '',
    lastOutgoingTranslatedAtMs: 0,
    lastIncomingTranslatedNorm: '',
    lastIncomingTranslatedAtMs: 0,

    // Translation context windows
    recentSourceContext: [],
    recentTargetContext: [],
    recentIncomingSourceContext: [],
    recentIncomingTargetContext: [],

    // Voice clone
    voiceCloneEmbedding: null,

    // Platform integration
    platform: 'teams',
    deliveryMode: 'assist',
  };

  const getState = () => state;
  const setState = (patch) => Object.assign(state, patch);

  /* ═════════════════════════════════════════════════════════════════════════
   *  1. INITIALIZE UNDERLYING SERVICES
   * ═════════════════════════════════════════════════════════════════════ */

  const googleClients = createGoogleClients({ env, appDir });

  const ttsService = createTtsService({
    env, logInfo, logError, elapsedMs, fetchWithTimeout, buildUrl, candidateEndpoints,
    getGoogleTtsClient: googleClients.getGoogleTtsClient,
    getGoogleTtsBetaClient: googleClients.getGoogleTtsBetaClient,
  });

  const translator = createTranslator({
    env, logInfo, logError, elapsedMs, fetchWithTimeout, buildUrl, candidateEndpoints,
    parseTranslationText, normalizeLangCode,
    getGoogleTranslateClient: googleClients.getGoogleTranslateClient,
  });

  const transcribeService = createTranscribeService({
    env, logInfo, logError, elapsedMs, fetchWithTimeout, buildUrl, candidateEndpoints,
    getGoogleSpeechClient: googleClients.getGoogleSpeechClient,
    toBcp47: ttsService.toBcp47,
  });

  const artifacts = createArtifactService({ env, nowISO, logInfo, logError });

  /* ═════════════════════════════════════════════════════════════════════════
   *  2. TRANSCRIPT ENQUEUE  (STT output → Translate → TTS queue)
   *
   *  Both pipelines converge here:
   *    Customer Pipeline STT output → enqueueTranscript()
   *    Agent Pipeline STT output    → enqueueTranscriptIncoming()
   * ═════════════════════════════════════════════════════════════════════ */

  function sendStatus(event, running, message) {
    logInfo(`STATUS running=${running} :: ${message}`);
    artifacts.writeEvent('status', { running, message });
    event.sender.send('translation-status', { running, message });
  }

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
    const translatedNorm = normalizeTranscriptForDedupe(target);
    if (translatedNorm) {
      const nowMs = Date.now();
      if (direction === 'incoming') {
        state.lastIncomingTranslatedNorm = translatedNorm;
        state.lastIncomingTranslatedAtMs = nowMs;
      } else {
        state.lastOutgoingTranslatedNorm = translatedNorm;
        state.lastOutgoingTranslatedAtMs = nowMs;
      }
    }
  }

  function suppressCrossChannelEcho(direction, normalizedText) {
    const enabled = env('ENABLE_CROSS_CHANNEL_ECHO_SUPPRESSION', 'true').toLowerCase() === 'true';
    if (!enabled || !normalizedText) return false;
    const windowMs = Number(env('CROSS_CHANNEL_ECHO_WINDOW_MS', '8000'));
    const nowMs = Date.now();
    const withinWindow = (ts) => ts > 0 && (nowMs - ts) <= windowMs;
    const echoMatches = (refNorm, refTs) => withinWindow(refTs) && isLikelyEchoText(normalizedText, refNorm);

    if (direction === 'incoming') {
      if (echoMatches(state.lastEnqueuedTranscriptNorm, state.lastEnqueuedTranscriptAtMs)) {
        return 'matched_recent_outgoing_stt';
      }
      if (echoMatches(state.lastOutgoingTranslatedNorm, state.lastOutgoingTranslatedAtMs)) {
        return 'matched_recent_outgoing_tts';
      }
      return false;
    }

    if (echoMatches(state.lastEnqueuedTranscriptNormIncoming, state.lastEnqueuedTranscriptIncomingAtMs)) {
      return 'matched_recent_incoming_stt';
    }
    if (echoMatches(state.lastIncomingTranslatedNorm, state.lastIncomingTranslatedAtMs)) {
      return 'matched_recent_incoming_tts';
    }
    return false;
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

  /**
   * Customer Pipeline: enqueue transcript from customer's speech.
   * Flow: Blackhole 16ch → STT → [here] → Translate → TTS → Agent
   */
  function enqueueTranscript(event, msg) {
    if (!msg || msg.type !== 'transcript' || !msg.text || !msg.text.trim()) return;
    if (!isMeaningfulTranscript(msg.text)) {
      logInfo(`[CustomerPipeline] STT noise skipped: "${String(msg.text).trim()}"`);
      artifacts.writeEvent('segment_skipped_noise', { raw_text: String(msg.text).trim() });
      return;
    }
    const normalized = normalizeTranscriptForDedupe(msg.text);
    if (normalized && normalized === state.lastEnqueuedTranscriptNorm) return;
    const echoReason = suppressCrossChannelEcho('outgoing', normalized);
    if (echoReason) {
      logInfo(`[CustomerPipeline] Echo-loop transcript skipped (${echoReason}): "${String(msg.text).trim()}"`);
      artifacts.writeEvent('segment_skipped_echo_loop', { direction: 'outgoing', reason: echoReason, raw_text: String(msg.text).trim() });
      return;
    }
    state.lastEnqueuedTranscriptNorm = normalized;
    state.lastEnqueuedTranscriptAtMs = Date.now();
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

  /**
   * Agent Pipeline: enqueue transcript from agent's speech.
   * Flow: Agent Mic → STT → [here] → Translate → TTS → Blackhole 2ch → Genesys → Phone
   */
  function enqueueTranscriptIncoming(event, msg) {
    if (!msg || msg.type !== 'transcript' || !msg.text || !msg.text.trim()) return;
    if (!isMeaningfulTranscript(msg.text)) return;
    const normalized = normalizeTranscriptForDedupe(msg.text);
    if (normalized && normalized === state.lastEnqueuedTranscriptNormIncoming) return;
    const echoReason = suppressCrossChannelEcho('incoming', normalized);
    if (echoReason) {
      logInfo(`[AgentPipeline] Echo-loop transcript skipped (${echoReason}): "${String(msg.text).trim()}"`);
      artifacts.writeEvent('segment_skipped_echo_loop', { direction: 'incoming', reason: echoReason, raw_text: String(msg.text).trim() });
      return;
    }
    state.lastEnqueuedTranscriptNormIncoming = normalized;
    state.lastEnqueuedTranscriptIncomingAtMs = Date.now();
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

  /* ═════════════════════════════════════════════════════════════════════════
   *  2b. SPECULATIVE TRANSLATION CACHE + INTERIM FORWARDING
   *
   *  When Google STT interim results stabilize, we pre-translate them so
   *  the final transcript can skip the translate step (~150-250ms saved).
   * ═════════════════════════════════════════════════════════════════════ */

  const speculativeCache = new Map();
  const SPECULATIVE_CACHE_MAX = 20;

  function speculativeCacheKey(text, srcLang, tgtLang) {
    return `${String(text).trim().toLowerCase()}|${srcLang}|${tgtLang}`;
  }

  function speculateTranslation(text, detectedLanguage) {
    if (!state.activeConfig) return;
    const src = toVachanaLanguageCode(detectedLanguage || state.activeConfig.sourceLanguage);
    const tgt = state.activeConfig.targetLanguage;
    const key = speculativeCacheKey(text, src, tgt);
    if (speculativeCache.has(key)) return;
    const contextHint = getContextHint();
    translator.translateText(text, src, tgt, contextHint)
      .then((translated) => {
        if (translated && translated.trim()) {
          if (speculativeCache.size >= SPECULATIVE_CACHE_MAX) {
            const firstKey = speculativeCache.keys().next().value;
            speculativeCache.delete(firstKey);
          }
          speculativeCache.set(key, { translated, ts: Date.now() });
        }
      })
      .catch((_err) => { /* speculative miss — pipeline will translate normally */ });
  }

  function speculateTranslationIncoming(text, detectedLanguage) {
    if (!state.activeConfig) return;
    const src = toVachanaLanguageCode(detectedLanguage || state.activeConfig.targetLanguage);
    const tgt = toVachanaLanguageCode(state.activeConfig.sourceLanguage);
    const key = speculativeCacheKey(text, src, tgt);
    if (speculativeCache.has(key)) return;
    const contextHint = getContextHintReverse();
    translator.translateText(text, src, tgt, contextHint)
      .then((translated) => {
        if (translated && translated.trim()) {
          if (speculativeCache.size >= SPECULATIVE_CACHE_MAX) {
            const firstKey = speculativeCache.keys().next().value;
            speculativeCache.delete(firstKey);
          }
          speculativeCache.set(key, { translated, ts: Date.now() });
        }
      })
      .catch((_err) => {});
  }

  function getSpeculativeTranslation(text, srcLang, tgtLang) {
    const key = speculativeCacheKey(text, srcLang, tgtLang);
    const entry = speculativeCache.get(key);
    if (!entry) return null;
    speculativeCache.delete(key);
    return entry.translated;
  }

  function sendInterimTranscript(event, payload) {
    try { event.sender.send('transcript-interim', { ...payload, incoming: false }); } catch (_e) {}
  }

  function sendInterimTranscriptIncoming(event, payload) {
    try { event.sender.send('transcript-interim', { ...payload, incoming: true }); } catch (_e) {}
  }

  /* ═════════════════════════════════════════════════════════════════════════
   *  3. GENESYS BRIDGE  (Phone ↔ Genesys ↔ Audio Devices)
   *
   *  Handles:
   *    - Receiving transcripts from Genesys (bridge → enqueue)
   *    - Publishing translated TTS audio back to Genesys (inject/both mode)
   * ═════════════════════════════════════════════════════════════════════ */

  function broadcastGenesysBridgeStatus(payload) {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('genesys-bridge-status', payload);
    }
    if (state.activeSender && state.mainWindow && state.activeSender !== state.mainWindow.webContents) {
      try { state.activeSender.send('genesys-bridge-status', payload); } catch (_err) { /* no-op */ }
    }
  }

  const genesysBridgeService = createGenesysBridgeService({
    env, logInfo, logError, normalizeTranscriptMessage,
    onStatus: (payload) => {
      artifacts.writeEvent('genesys_bridge_status', payload);
      broadcastGenesysBridgeStatus(payload);
    },
    onTranscript: (transcriptPayload) => {
      const bridgeEvent = { sender: state.mainWindow?.webContents || state.activeSender };
      if (!bridgeEvent.sender) return;
      if (String(transcriptPayload.direction || '').toLowerCase() === 'in') {
        enqueueTranscriptIncoming(bridgeEvent, transcriptPayload);
        return;
      }
      enqueueTranscript(bridgeEvent, transcriptPayload);
    },
  });

  /* ═════════════════════════════════════════════════════════════════════════
   *  4. TTS QUEUE  (Translate output → TTS → Audio output)
   *
   *  Customer Pipeline: TTS in targetLanguage  → 'meeting' channel → Agent
   *  Agent Pipeline:    TTS in sourceLanguage  → 'local' channel   → Genesys → Phone
   * ═════════════════════════════════════════════════════════════════════ */

  const ttsQueue = createTtsQueueService({
    env, logInfo, logError, elapsedMs,
    synthesizeRestTtsSequentialToRenderer: ttsService.synthesizeRestTtsSequentialToRenderer,
    streamTTSRealtime: ttsService.streamTTSRealtime,
    writeEvent: artifacts.writeEvent,
    writePipelineRow: artifacts.writePipelineRow,
    sendStatus,
    getState,
    onTtsChunk: (chunkPayload) => {
      const chunkBytes = Buffer.from(String(chunkPayload.audioBase64 || ''), 'base64');
      const sr = Number(chunkPayload.sampleRate || 16000);
      const channel = String(chunkPayload.channel || 'meeting');
      // Customer Pipeline → outgoingTranslated; Agent Pipeline → incomingTranslated
      artifacts.appendAudioTrack(
        channel === 'local' ? 'incomingTranslated' : 'outgoingTranslated',
        chunkBytes, sr,
      );
      artifacts.appendAudioTrack('fullTranslatedConversation', chunkBytes, sr);
      // Agent Pipeline: inject translated audio back to Genesys → Phone
      if (state.platform === 'genesys' && (state.deliveryMode === 'inject' || state.deliveryMode === 'both')) {
        genesysBridgeService.publishTtsChunk(chunkPayload);
      }
    },
    onTtsAudio: (audioPayload) => {
      const wavBytes = Buffer.from(String(audioPayload.audioBase64 || ''), 'base64');
      const pcmBytes = extractPcmFromWavBuffer(wavBytes);
      const channel = String(audioPayload.channel || 'meeting');
      if (pcmBytes.length) {
        artifacts.appendAudioTrack(
          channel === 'local' ? 'incomingTranslated' : 'outgoingTranslated',
          pcmBytes, Number(env('GOOGLE_TTS_SAMPLE_RATE', '16000')),
        );
        artifacts.appendAudioTrack('fullTranslatedConversation', pcmBytes, Number(env('GOOGLE_TTS_SAMPLE_RATE', '16000')));
      }
      if (state.platform === 'genesys' && (state.deliveryMode === 'inject' || state.deliveryMode === 'both')) {
        genesysBridgeService.publishTtsAudio(audioPayload);
      }
    },
    onTtsDone: (donePayload) => {
      if (state.platform === 'genesys' && (state.deliveryMode === 'inject' || state.deliveryMode === 'both')) {
        genesysBridgeService.publishTtsDone(donePayload);
      }
    },
  });

  /* ═════════════════════════════════════════════════════════════════════════
   *  5. TRANSCRIPT QUEUE  (STT output → Translate → TTS queue)
   *
   *  Shared by both pipelines. Direction is determined per-segment:
   *    direction=undefined → Customer Pipeline (source→target, meeting channel)
   *    direction='in'      → Agent Pipeline    (target→source, local channel)
   * ═════════════════════════════════════════════════════════════════════ */

  const transcriptQueue = createTranscriptQueueService({
    env, logInfo, logError, elapsedMs,
    appendContextText,
    getContextHint,
    getContextHintReverse,
    toVachanaLanguageCode,
    translateText: translator.translateText,
    enqueueTtsJob: ttsQueue.enqueueTtsJob,
    writeEvent: artifacts.writeEvent,
    appendTranslatedLine,
    appendConversationPair: artifacts.appendConversationPair,
    getSpeculativeTranslation,
  });

  /* ═════════════════════════════════════════════════════════════════════════
   *  6. STT PROVIDERS  (Audio → Speech-to-Text)
   *
   *  Customer Pipeline STT: Blackhole 16ch audio → text
   *  Agent Pipeline STT:    Agent microphone audio → text
   *
   *  Provider selected by STT_PROVIDER + VACHANA_STT_MODE env variables.
   * ═════════════════════════════════════════════════════════════════════ */

  const realtimeWs = createRealtimeWsSttService({
    env, logInfo, logError, sendStatus,
    enqueueTranscript, enqueueTranscriptIncoming,
    sttRealtimeLangCode, getState,
    setSockets: setState,
  });

  const googleStreamingStt = createGoogleStreamingSttService({
    env, logInfo, logError, sendStatus,
    enqueueTranscript, enqueueTranscriptIncoming,
    sendInterimTranscript,
    sendInterimTranscriptIncoming,
    speculateTranslation,
    speculateTranslationIncoming,
    getGoogleSpeechClient: googleClients.getGoogleSpeechClient,
    toBcp47: ttsService.toBcp47,
    getState,
    setStreams: setState,
  });

  const deepgramStreamingStt = createDeepgramStreamingSttService({
    env, logInfo, logError, sendStatus,
    enqueueTranscript, enqueueTranscriptIncoming,
    sendInterimTranscript,
    sendInterimTranscriptIncoming,
    getState,
    setSockets: setState,
  });

  const restLoops = createRestLoopSttService({
    env, logInfo, logError, elapsedMs, sendStatus,
    transcribeViaGoogle: transcribeService.transcribeViaGoogle,
    transcribeViaRest: transcribeService.transcribeViaRest,
  });

  // STT Provider Factory: unifies provider selection for both pipelines
  const sttFactory = createSttProviderFactory({
    env, logInfo, logError, sendStatus,
    realtimeWs, googleStreamingStt, deepgramStreamingStt, restLoops,
    getState, setState,
  });

  // Translation Provider Factory
  const translationFactory = createTranslationProviderFactory({ env, translator });

  // TTS Provider Factory
  const ttsFactory = createTtsProviderFactory({ env, ttsService });

  /* ═════════════════════════════════════════════════════════════════════════
   *  7. PIPELINE TEARDOWN
   * ═════════════════════════════════════════════════════════════════════ */

  function teardownPipeline() {
    state.translationRunning = false;

    // Timers
    if (state.metricsTimer) clearInterval(state.metricsTimer);
    if (state.restFlushTimer) clearInterval(state.restFlushTimer);
    if (state.restFlushTimerReturn) clearInterval(state.restFlushTimerReturn);
    state.metricsTimer = null;
    state.restFlushTimer = null;
    state.restFlushTimerReturn = null;

    // Google STT stream recycle timers
    googleStreamingStt.stopRecycleTimers();

    // Customer Pipeline STT connections
    if (state.sttSocket) {
      try { state.sttSocket.close(); } catch (_e) {}
      state.sttSocket = null;
    }
    if (state.sttGoogleStream) {
      try { state.sttGoogleStream.destroy(); } catch (_e) {}
      state.sttGoogleStream = null;
    }

    // Agent Pipeline STT connections
    if (state.sttSocketReturn) {
      try { state.sttSocketReturn.close(); } catch (_e) {}
      state.sttSocketReturn = null;
    }
    if (state.sttGoogleStreamReturn) {
      try { state.sttGoogleStreamReturn.destroy(); } catch (_e) {}
      state.sttGoogleStreamReturn = null;
    }

    // Genesys bridge
    genesysBridgeService.stop('Pipeline teardown');
    artifacts.writePipelineSummary();
  }

  /* ═════════════════════════════════════════════════════════════════════════
   *  8. IPC HANDLERS  (Renderer ↔ Main Process)
   * ═════════════════════════════════════════════════════════════════════ */

  function registerIpc() {

    /* ─── START TRANSLATION ──────────────────────────────────────────────
     *
     *  Initializes both pipelines in order:
     *
     *  Step 1: Read configuration
     *  Step 2: Initialize artifacts & reset state
     *  Step 3: Start Genesys bridge (if inject/both mode)
     *  Step 4: Start Customer Pipeline STT
     *           Blackhole 16ch → STT (provider per env) → enqueueTranscript
     *  Step 5: Start Agent Pipeline STT (if bidirectional)
     *           Agent Mic → STT (provider per env) → enqueueTranscriptIncoming
     *
     *  Once STT connects, the transcript queue handles:
     *    STT text → Translate (provider per env) → TTS (provider per env) → Audio
     * ─────────────────────────────────────────────────────────────────── */

    ipcMain.on('start-translation', (event, config = {}) => {
      state.activeSender = event.sender;

      // Step 1: Read configuration
      const sourceLanguage = config.sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN');
      const targetLanguage = config.targetLanguage || env('VACHANA_DEFAULT_TARGET_LANGUAGE', 'hi-IN');
      const bidirectionalRequested = Boolean(config.bidirectional);
      const platform = String(config.platform || 'teams').toLowerCase();
      const deliveryMode = String(config.deliveryMode || 'assist').toLowerCase();
      const listenDeviceId = String(config.listenDeviceId || '').trim();
      const localOutputDeviceId = String(config.localOutputDeviceId || '').trim();

      // Keep a single, deterministic Google voice for each translation session.
      if (typeof ttsService.resetGoogleVoiceLock === 'function') {
        ttsService.resetGoogleVoiceLock(targetLanguage);
      }

      // Step 2: Initialize artifacts & reset state
      artifacts.initSessionArtifacts(appDir, sourceLanguage, targetLanguage);
      artifacts.writeEvent('session_start', {
        source_language: sourceLanguage,
        target_language: targetLanguage,
        bidirectional: bidirectionalRequested,
        platform,
        delivery_mode: deliveryMode,
        listen_device_id: listenDeviceId,
        local_output_device_id: localOutputDeviceId,
      });

      // Resolve per-language providers now that we know the languages
      const sttProviderCustomer = sttFactory.resolveProviderForLang(sourceLanguage);
      const sttProviderAgent = sttFactory.resolveProviderForLang(targetLanguage);
      const sttMode = sttFactory.resolveMode();
      const translationProvider = translationFactory.resolve();
      const { provider: ttsProvider, realtimeWs: ttsRealtimeWs } = ttsFactory.resolve();

      logInfo(
        `[Config] CustomerPipeline STT=${sttProviderCustomer}/${sttMode} (${sourceLanguage} — ${isIndicLanguage(sourceLanguage) ? 'Indic→vachana' : 'foreign→deepgram'})`
      );
      logInfo(
        `[Config] AgentPipeline    STT=${sttProviderAgent}/${sttMode} (${targetLanguage} — ${isIndicLanguage(targetLanguage) ? 'Indic→vachana' : 'foreign→deepgram'})`
      );
      logInfo(`[Config] Translation=${translationProvider} TTS=${ttsProvider}${ttsRealtimeWs ? '/ws' : ''}`);
      logInfo(`[Config] source=${sourceLanguage} target=${targetLanguage} bidir=${bidirectionalRequested} platform=${platform} delivery=${deliveryMode}`);

      state.activeConfig = {
        sourceLanguage, targetLanguage,
        bidirectional: bidirectionalRequested,
        platform, deliveryMode,
        listenDeviceId, localOutputDeviceId,
      };
      state.platform = platform;
      state.deliveryMode = deliveryMode;
      state.translationRunning = true;
      state.sttMode = sttMode;
      // Keep legacy sttProvider aligned with Customer Pipeline for REST-loop compat
      state.sttProvider = sttProviderCustomer;
      state.sttProviderCustomer = sttProviderCustomer;
      state.sttProviderAgent = sttProviderAgent;
      state.audioFramesForwarded = 0;
      state.audioFramesDropped = 0;
      state.segmentCounter = 0;
      state.lastEnqueuedTranscriptNorm = '';
      state.lastEnqueuedTranscriptAtMs = 0;
      state.lastEnqueuedTranscriptNormIncoming = '';
      state.lastEnqueuedTranscriptIncomingAtMs = 0;
      state.lastOutgoingTranslatedNorm = '';
      state.lastOutgoingTranslatedAtMs = 0;
      state.lastIncomingTranslatedNorm = '';
      state.lastIncomingTranslatedAtMs = 0;
      state.recentSourceContext = [];
      state.recentTargetContext = [];
      state.recentIncomingSourceContext = [];
      state.recentIncomingTargetContext = [];

      // Step 3: Genesys bridge (Phone ↔ Genesys)
      if (platform === 'genesys' && (deliveryMode === 'inject' || deliveryMode === 'both')) {
        genesysBridgeService.start({
          deliveryMode,
          sessionId: config.sessionId || '',
          streamEndpoint: config.streamEndpoint || '',
        }).catch((err) => {
          logError(`Genesys bridge start failed: ${err.message}`);
          broadcastGenesysBridgeStatus({
            ...genesysBridgeService.status(),
            message: `Start failed: ${err.message}`,
          });
        });
      } else {
        genesysBridgeService.stop('Bridge disabled for current mode');
      }

      // Metrics timer
      if (state.metricsTimer) clearInterval(state.metricsTimer);
      state.metricsTimer = setInterval(() => {
        if (state.translationRunning) {
          logInfo(
            `AUDIO frames forwarded=${state.audioFramesForwarded}, `
            + `dropped=${state.audioFramesDropped}, `
            + `transcriptQueue=${transcriptQueue.getQueue().length}`
          );
        }
      }, 5000);

      // Step 4 & 5: Connect both pipelines via STT factory

      if (sttMode === 'rest') {
        // REST mode: start polling loops (no async connect needed)
        state.sttMode = 'rest';

        // Customer Pipeline: Blackhole 16ch → REST STT → enqueueTranscript
        sttFactory.connectCustomerStt(event, sourceLanguage, { enqueueTranscript, state });

        if (bidirectionalRequested) {
          // Agent Pipeline: Agent Mic → REST STT → enqueueTranscriptIncoming
          sttFactory.connectAgentStt(event, targetLanguage, { enqueueTranscriptIncoming, state });
          return sendStatus(event, true,
            `Bidirectional REST mode [${platform}/${deliveryMode}]: customer (${sourceLanguage}) → agent; agent (${targetLanguage}) → phone.`
          );
        }
        return sendStatus(event, true,
          `Pipeline started in REST mode (${sourceLanguage} → ${targetLanguage}) [${platform}/${deliveryMode}].`
        );
      }

      // Streaming mode: connect WebSocket / Google streaming
      // Step 4: Customer Pipeline STT
      sttFactory.connectCustomerStt(event, sourceLanguage, { enqueueTranscript, state })
        .then(() => {
          state.sttMode = 'ws';

          if (!bidirectionalRequested) {
            sendStatus(event, true,
              `Customer Pipeline started (${sourceLanguage} → ${targetLanguage}) [${platform}/${deliveryMode}].`
            );
            return;
          }

          // Step 5: Agent Pipeline STT
          return sttFactory.connectAgentStt(event, targetLanguage, { enqueueTranscriptIncoming, state })
            .then(() => sendStatus(event, true,
              `Bidirectional [${platform}/${deliveryMode}]: customer (${sourceLanguage}) → agent; agent (${targetLanguage}) → phone.`
            ))
            .catch((err) => {
              state.activeConfig.bidirectional = false;
              logError(`[AgentPipeline] STT connect failed: ${err.message}`);
              sendStatus(event, true,
                `Customer Pipeline started (${sourceLanguage} → ${targetLanguage}) [${platform}/${deliveryMode}]. Agent pipeline disabled: ${err.message}`
              );
            });
        })
        .catch((error) => {
          // Customer Pipeline STT failed; try REST fallback
          const didFallback = sttFactory.fallbackCustomerToRest(event, sourceLanguage, {
            enqueueTranscript, state,
          });
          if (didFallback) {
            state.sttMode = 'rest';
            sendStatus(event, true, `STT streaming failed (${error.message}). REST fallback active.`);
            return;
          }
          state.translationRunning = false;
          sendStatus(event, false, `Failed to start pipeline: ${error.message}`);
          teardownPipeline();
        });
    });

    /* ─── STOP TRANSLATION ───────────────────────────────────────────── */

    ipcMain.on('stop-translation', (event) => {
      artifacts.writeEvent('session_stop', {});
      teardownPipeline();
      sendStatus(event, false, 'Translation stopped.');
    });

    /* ─── GENESYS BRIDGE IPC ─────────────────────────────────────────── */

    ipcMain.handle('genesys-bridge-start', async (_event, bridgeConfig = {}) => {
      const mergedConfig = {
        deliveryMode: bridgeConfig.deliveryMode || state.deliveryMode || 'assist',
        sessionId: bridgeConfig.sessionId || '',
        streamEndpoint: bridgeConfig.streamEndpoint || '',
      };
      const status = await genesysBridgeService.start(mergedConfig);
      broadcastGenesysBridgeStatus({ ...status, message: 'Bridge started via IPC' });
      return status;
    });

    ipcMain.handle('genesys-bridge-stop', async () => {
      const status = genesysBridgeService.stop('Bridge stopped via IPC');
      broadcastGenesysBridgeStatus({ ...status, message: 'Bridge stopped via IPC' });
      return status;
    });

    ipcMain.handle('genesys-bridge-status', async () => {
      return genesysBridgeService.status();
    });

    /* ─── CUSTOMER PIPELINE: AUDIO INPUT ─────────────────────────────
     *
     *  Blackhole 16ch → audio-chunk IPC → STT provider
     *
     *  This is the entry point for the Customer Pipeline.
     *  Audio from the phone call (via Genesys → Blackhole 16ch) arrives
     *  as 1024-byte PCM16 frames from the renderer's audio capture.
     * ─────────────────────────────────────────────────────────────── */

    ipcMain.on('audio-chunk', (_event, chunkBytes) => {
      if (!state.translationRunning) return;
      if (!chunkBytes) {
        state.audioFramesDropped += 1;
        return;
      }
      const buffer = Buffer.isBuffer(chunkBytes) ? chunkBytes : Buffer.from(chunkBytes);
      if (buffer.length !== 1024) {
        state.audioFramesDropped += 1;
        return;
      }

      // Record raw customer audio
      artifacts.appendAudioTrack('outgoingReal', buffer, 16000);
      artifacts.appendAudioTrack('fullRealConversation', buffer, 16000);

      // Route to Customer Pipeline STT (via factory)
      const forwarded = sttFactory.routeCustomerAudio(buffer);
      if (forwarded) {
        state.audioFramesForwarded += 1;
      } else {
        state.audioFramesDropped += 1;
      }
    });

    /* ─── AGENT PIPELINE: AUDIO INPUT ────────────────────────────────
     *
     *  Agent Mic → audio-chunk-return IPC → STT provider
     *
     *  This is the entry point for the Agent Pipeline.
     *  Audio from the agent's microphone arrives as 1024-byte PCM16
     *  frames. After STT → Translate → TTS, the output goes to
     *  Blackhole 2ch → Genesys → Phone.
     * ─────────────────────────────────────────────────────────────── */

    ipcMain.on('audio-chunk-return', (_event, chunkBytes) => {
      if (!state.translationRunning || !state.activeConfig?.bidirectional || !chunkBytes) return;
      const buffer = Buffer.isBuffer(chunkBytes) ? chunkBytes : Buffer.from(chunkBytes);
      if (buffer.length !== 1024) return;

      // Record raw agent audio
      artifacts.appendAudioTrack('incomingReal', buffer, 16000);
      artifacts.appendAudioTrack('fullRealConversation', buffer, 16000);

      // Route to Agent Pipeline STT (via factory)
      sttFactory.routeAgentAudio(buffer);
    });

    /* ─── MIC ACTIVITY ───────────────────────────────────────────────── */

    ipcMain.on('mic-activity', (_event, payload = {}) => {
      const rms = Number(payload.rms || 0).toFixed(4);
      const speaking = Boolean(payload.speaking);
      const queuedFrames = Number(payload.queuedFrames || 0);
      const sourceLang = payload.sourceLang || state.activeConfig?.sourceLanguage || 'n/a';
      const targetLang = payload.targetLang || state.activeConfig?.targetLanguage || 'n/a';
      logInfo(`MIC activity speaking=${speaking} rms=${rms} queuedFrames=${queuedFrames} lang=${sourceLang}->${targetLang}`);
    });

    /* ─── VOICE ENROLLMENT ───────────────────────────────────────────── */

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

  /* ═════════════════════════════════════════════════════════════════════════
   *  9. APP LIFECYCLE
   * ═════════════════════════════════════════════════════════════════════ */

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
    const sttPref = String(env('STT_PROVIDER', 'auto')).toLowerCase();
    logInfo(`Providers: STT=${sttPref}/${sttFactory.resolveMode()} (auto-selects vachana=Indic / deepgram=foreign) Translation=${translationFactory.resolve()} TTS=${ttsFactory.resolve().provider}`);
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
