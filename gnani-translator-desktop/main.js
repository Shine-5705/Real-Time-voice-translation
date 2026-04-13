const { app, BrowserWindow, ipcMain } = require('electron');
// Surface Chromium/electron diagnostics in the same terminal as the main process (when supported).
app.commandLine.appendSwitch('enable-logging');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ---------- Google Cloud SDK clients (lazy-init on first use) ----------
let _googleTranslateClient = null;
let _googleTtsClient = null;
let _googleSpeechClient = null;

function resolveGoogleKeyFile() {
  const raw = env('GOOGLE_APPLICATION_CREDENTIALS', 'ai-translation-app-493204-d9dc12f54709.json').trim();
  if (path.isAbsolute(raw)) {
    return raw;
  }
  // Resolve relative to repo root (one level above gnani-translator-desktop/).
  return path.join(__dirname, '..', raw);
}

function getGoogleTranslateClient() {
  if (!_googleTranslateClient) {
    const { Translate } = require('@google-cloud/translate').v2;
    _googleTranslateClient = new Translate({ keyFilename: resolveGoogleKeyFile() });
  }
  return _googleTranslateClient;
}

function getGoogleTtsClient() {
  if (!_googleTtsClient) {
    const textToSpeech = require('@google-cloud/text-to-speech');
    _googleTtsClient = new textToSpeech.TextToSpeechClient({ keyFilename: resolveGoogleKeyFile() });
  }
  return _googleTtsClient;
}

function getGoogleSpeechClient() {
  if (!_googleSpeechClient) {
    const speech = require('@google-cloud/speech');
    _googleSpeechClient = new speech.SpeechClient({ keyFilename: resolveGoogleKeyFile() });
  }
  return _googleSpeechClient;
}

let mainWindow;
let translationRunning = false;
let sttSocket = null;
let sttSocketReturn = null;
let activeConfig = null;
let sttMode = 'ws';
let restAudioBuffer = [];
let restFlushTimer = null;
let restInFlight = false;
let audioFramesForwarded = 0;
let audioFramesDropped = 0;
let metricsTimer = null;
let segmentCounter = 0;
let transcriptQueue = [];
let queueProcessing = false;
let sessionArtifacts = null;
let pipelineStats = { count: 0, sttSum: 0, translateSum: 0, ttsSum: 0, totalSum: 0 };
let lastMicActivityLogTs = 0;
let activeSender = null;
let lastSpeechDetectedAt = 0;
let lastTranscriptAt = 0;
let sttHealthTimer = null;
let wsHealthFailoverTriggered = false;
let restOverlapBuffer = Buffer.alloc(0);
let lastEnqueuedTranscriptNorm = '';
let lastEnqueuedTranscriptNormIncoming = '';
let ttsJobQueue = [];
let ttsWorkerActive = false;
let ttsWorkersInFlight = 0;
const TTS_MAX_CONCURRENT = 4; // Enable parallel TTS execution
let speechAggregationBuffer = [];
let speechAggregationTimer = null;
let speechAggregationStartedAt = 0;
let speechAggregationEvent = null;
let recentSourceContext = [];
let recentTargetContext = [];
let recentIncomingSourceContext = [];
let recentIncomingTargetContext = [];
let lockedPreferredSpeakerId = null;
let speechAggregationBufferIncoming = [];
let speechAggregationTimerIncoming = null;
let speechAggregationStartedAtIncoming = 0;
let speechAggregationEventIncoming = null;

function nowISO() {
  return new Date().toISOString();
}

function logInfo(message) {
  const line = `[${nowISO()}] ${message}\n`;
  try {
    process.stdout.write(line);
  } catch (_e) {
    console.log(line.trimEnd());
  }
}

function logError(message) {
  const line = `[${nowISO()}] ${message}\n`;
  try {
    process.stderr.write(line);
  } catch (_e) {
    console.error(line.trimEnd());
  }
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function elapsedMs(startMs) {
  return Math.max(0, Date.now() - Number(startMs || Date.now()));
}

function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function writePipelineRow({ segmentId, sttMs, translateMs, ttsMs, totalMs, sourceText, translatedText }) {
  if (!sessionArtifacts) return;
  const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const row =
    padRight(segmentId, 5)
    + padRight(timeStr, 14)
    + padRight(sttMs, 9)
    + padRight(translateMs, 14)
    + padRight(ttsMs, 9)
    + padRight(totalMs, 10)
    + `${sourceText}  →  ${translatedText}\n`;
  appendLine(sessionArtifacts.pipelineLogPath, row);

  pipelineStats.count += 1;
  pipelineStats.sttSum += Number(sttMs) || 0;
  pipelineStats.translateSum += Number(translateMs) || 0;
  pipelineStats.ttsSum += Number(ttsMs) || 0;
  pipelineStats.totalSum += Number(totalMs) || 0;
}

function writePipelineSummary() {
  if (!sessionArtifacts || pipelineStats.count === 0) return;
  const n = pipelineStats.count;
  const avg = (v) => Math.round(v / n);
  const summary =
    '\n' + '─'.repeat(120) + '\n'
    + `Session ended : ${nowISO()}\n`
    + `Total segments: ${n}\n`
    + `Avg STT       : ${avg(pipelineStats.sttSum)} ms\n`
    + `Avg Translate : ${avg(pipelineStats.translateSum)} ms\n`
    + `Avg TTS       : ${avg(pipelineStats.ttsSum)} ms\n`
    + `Avg Total     : ${avg(pipelineStats.totalSum)} ms\n`;
  appendLine(sessionArtifacts.pipelineLogPath, summary);
}

function getWorkspaceRoot() {
  return path.join(__dirname, '..');
}

function sessionDirNow() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(getWorkspaceRoot(), 'workdir', 'live', stamp);
}

function appendLine(filePath, line) {
  try {
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (err) {
    logError(`Failed writing ${filePath}: ${err.message}`);
  }
}

function initSessionArtifacts(sourceLanguage, targetLanguage) {
  const dir = sessionDirNow();
  fs.mkdirSync(dir, { recursive: true });

  sessionArtifacts = {
    dir,
    sourceLogPath: path.join(dir, 'source_transcript.log'),
    spokenTextPath: path.join(dir, 'spoken_text.txt'),
    translatedLogPath: path.join(dir, 'translated_transcript.log'),
    eventsPath: path.join(dir, 'events.jsonl'),
    pipelineLogPath: path.join(dir, 'pipeline_timings.txt'),
    sourceLanguage,
    targetLanguage,
  };

  fs.writeFileSync(sessionArtifacts.sourceLogPath, '', 'utf8');
  fs.writeFileSync(sessionArtifacts.spokenTextPath, '', 'utf8');
  fs.writeFileSync(sessionArtifacts.translatedLogPath, '', 'utf8');
  fs.writeFileSync(sessionArtifacts.eventsPath, '', 'utf8');

  const pipelineHeader =
    `=== Pipeline Timing Log ===\n`
    + `Session started : ${nowISO()}\n`
    + `Source language  : ${sourceLanguage}\n`
    + `Target language  : ${targetLanguage}\n`
    + `STT provider     : ${env('STT_PROVIDER', 'google')}\n`
    + `Translate provider: ${env('TRANSLATION_PROVIDER', 'google')}\n`
    + `TTS provider     : ${env('TTS_PROVIDER', 'google')}\n`
    + `\n`
    + padRight('#', 5)
    + padRight('Time', 14)
    + padRight('STT ms', 9)
    + padRight('Translate ms', 14)
    + padRight('TTS ms', 9)
    + padRight('Total ms', 10)
    + `Source Text  →  Translated Text\n`
    + '─'.repeat(120) + '\n';
  fs.writeFileSync(sessionArtifacts.pipelineLogPath, pipelineHeader, 'utf8');
  pipelineStats = { count: 0, sttSum: 0, translateSum: 0, ttsSum: 0, totalSum: 0 };

  logInfo(`Session log directory: ${dir}`);
}

function writeEvent(eventType, data) {
  if (!sessionArtifacts) {
    return;
  }
  appendLine(
    sessionArtifacts.eventsPath,
    JSON.stringify({ ts: nowISO(), event: eventType, ...data })
  );
}

function candidateEndpoints(csvValue, singleValue, defaults) {
  const out = [];

  const add = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
      return;
    }
    let normalized = trimmed;
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      if (!normalized.startsWith('/')) {
        normalized = `/${normalized}`;
      }
    }
    if (!out.includes(normalized)) {
      out.push(normalized);
    }
  };

  let explicit = false;
  for (const part of String(csvValue || '').split(',')) {
    if (part.trim()) {
      explicit = true;
      add(part);
    }
  }

  if (String(singleValue || '').trim()) {
    explicit = true;
    add(singleValue);
  }

  if (!explicit) {
    for (const fallback of defaults) {
      add(fallback);
    }
  }

  return out;
}

function buildUrl(endpoint) {
  const baseUrl = env('VACHANA_BASE_URL', 'https://api.vachana.ai');
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  return `${baseUrl}${endpoint}`;
}

function sendStatus(event, running, message) {
  logInfo(`STATUS running=${running} :: ${message}`);
  writeEvent('status', { running, message });
  event.sender.send('translation-status', { running, message });
}

function parseTranslationText(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  return (
    payload.translation ||
    payload.translated_text ||
    payload.translatedText ||
    payload.text ||
    payload.output ||
    (payload.data && (payload.data.translated_text || payload.data.text)) ||
    ''
  );
}

function appendContextText(buffer, text) {
  const value = String(text || '').trim();
  if (!value) {
    return;
  }

  const maxSegments = Number(env('CONTEXT_WINDOW_SEGMENTS', '4'));
  const maxChars = Number(env('CONTEXT_WINDOW_MAX_CHARS', '260'));

  buffer.push(value);
  while (buffer.length > maxSegments) {
    buffer.shift();
  }

  while (buffer.join(' ').length > maxChars && buffer.length > 1) {
    buffer.shift();
  }
}

function getContextHint() {
  const enabled = env('ENABLE_CONTEXTUAL_TRANSLATION', 'true').toLowerCase() === 'true';
  if (!enabled) {
    return { source: '', target: '' };
  }

  return {
    source: recentSourceContext.join(' '),
    target: recentTargetContext.join(' '),
  };
}

function getContextHintReverse() {
  const enabled = env('ENABLE_CONTEXTUAL_TRANSLATION', 'true').toLowerCase() === 'true';
  if (!enabled) {
    return { source: '', target: '' };
  }

  return {
    source: recentIncomingSourceContext.join(' '),
    target: recentIncomingTargetContext.join(' '),
  };
}

function isMeaningfulTranscript(text) {
  const value = String(text || '').trim();
  if (!value) {
    return false;
  }

  // Accept only segments that contain at least one letter or number.
  // This avoids translating pure punctuation/noise like "." or "।".
  return /[\p{L}\p{N}]/u.test(value);
}

function isStrongTranscriptBoundary(text) {
  return /[.!?…।]$/.test(String(text || '').trim());
}

function isLikelyIncompleteFragment(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) {
    return true;
  }

  if (value.length <= 3) {
    return true;
  }

  if (/[-,:;]$/.test(value)) {
    return true;
  }

  const trailingTokens = new Set([
    'and', 'or', 'but', 'so', 'because', 'if', 'when', 'while', 'where', 'which',
    'that', 'than', 'to', 'of', 'for', 'in', 'on', 'at', 'with', 'from', 'by',
    'as', 'about', 'into', 'over', 'after', 'before', 'around', 'related',
  ]);

  const tokens = value.split(/\s+/).filter(Boolean);
  const lastToken = tokens[tokens.length - 1] || '';
  if (trailingTokens.has(lastToken)) {
    return true;
  }

  return /\b(?:am|is|are|was|were|have|has|had|do|does|did|will|would|can|could|should|may|might|must)\s*$/i.test(value);
}

function extractSpeakerIdFromStt(msg) {
  if (!msg || typeof msg !== 'object') {
    return '';
  }
  const direct = msg.speaker_id ?? msg.speakerId ?? msg.speaker ?? msg.spk_id ?? msg.participant_id;
  if (direct != null && String(direct).trim()) {
    return String(direct).trim();
  }
  const nested = msg.result || msg.data;
  if (nested && typeof nested === 'object') {
    const n = nested.speaker_id ?? nested.speakerId ?? nested.speaker;
    if (n != null && String(n).trim()) {
      return String(n).trim();
    }
  }
  return '';
}

function getSpeakerPreferenceMode() {
  const fromConfig = activeConfig?.speakerPreferenceMode;
  if (fromConfig && fromConfig !== 'inherit' && fromConfig !== '') {
    return String(fromConfig).toLowerCase();
  }
  return String(env('SPEAKER_PREFERENCE_MODE', 'off')).toLowerCase();
}

function getExplicitPreferredSpeakerId() {
  const v = activeConfig?.preferredSpeakerId ?? env('VACHANA_PREFERRED_SPEAKER_ID', '');
  return String(v || '').trim();
}

function resetSpeakerPreferenceState() {
  lockedPreferredSpeakerId = null;
}

function acceptSpeakerForPreference(speakerId) {
  const mode = getSpeakerPreferenceMode();
  if (!mode || mode === 'off' || mode === 'false' || mode === 'none') {
    return true;
  }

  const sid = String(speakerId || '').trim();

  if (mode === 'explicit') {
    const want = getExplicitPreferredSpeakerId();
    if (!want) {
      return true;
    }
    if (!sid) {
      return true;
    }
    return sid.toLowerCase() === want.toLowerCase();
  }

  if (mode === 'lock_first' || mode === 'guest') {
    if (!sid) {
      return true;
    }
    if (!lockedPreferredSpeakerId) {
      lockedPreferredSpeakerId = sid;
      logInfo(`SPEAKER preference (guest lock): primary="${lockedPreferredSpeakerId}"`);
      return true;
    }
    return sid.toLowerCase() === lockedPreferredSpeakerId.toLowerCase();
  }

  return true;
}

function getSpeechAggregationConfig() {
  // Rolling window (~1.5s): emit segments on silence, size cap, or max wait — similar in spirit to
  // vachana-translations continuous ASR + periodic finalization (see translation_session.py).
  return {
    idleMs: Number(env('SPEECH_AGGREGATION_IDLE_MS', '900')),
    maxWaitMs: Number(env('SPEECH_AGGREGATION_MAX_WAIT_MS', '1200')),
    minChars: Number(env('SPEECH_AGGREGATION_MIN_CHARS', '6')),
    maxChars: Number(env('SPEECH_AGGREGATION_MAX_CHARS', '110')),
  };
}

function clearSpeechAggregationTimer() {
  if (speechAggregationTimer) {
    clearTimeout(speechAggregationTimer);
    speechAggregationTimer = null;
  }
}

function rescheduleAggregationIfPending() {
  if (speechAggregationBuffer.length === 0 || !speechAggregationStartedAt) {
    return;
  }
  const { idleMs, maxWaitMs } = getSpeechAggregationConfig();
  const ageMs = Date.now() - speechAggregationStartedAt;
  const untilWindowEnd = maxWaitMs - ageMs;
  if (untilWindowEnd <= 0) {
    scheduleSpeechAggregationFlush(0);
    return;
  }
  const delay = Math.min(idleMs, untilWindowEnd);
  scheduleSpeechAggregationFlush(Math.max(80, delay));
}

function flushSpeechAggregationBuffer(force = false) {
  if (speechAggregationBuffer.length === 0) {
    clearSpeechAggregationTimer();
    speechAggregationStartedAt = 0;
    speechAggregationEvent = null;
    return;
  }

  const { minChars, maxWaitMs } = getSpeechAggregationConfig();
  const ageMs = speechAggregationStartedAt ? Date.now() - speechAggregationStartedAt : 0;
  const windowExceeded = ageMs >= maxWaitMs;
  const effectiveForce = force || windowExceeded;

  const combined = speechAggregationBuffer
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!effectiveForce) {
    if (combined.length < minChars && !isStrongTranscriptBoundary(combined)) {
      rescheduleAggregationIfPending();
      return;
    }

    if (!isStrongTranscriptBoundary(combined) && isLikelyIncompleteFragment(combined)) {
      rescheduleAggregationIfPending();
      return;
    }

    const tailFragment = speechAggregationBuffer[speechAggregationBuffer.length - 1]?.text || '';
    if (speechAggregationBuffer.length < 3 && isLikelyIncompleteFragment(tailFragment)) {
      rescheduleAggregationIfPending();
      return;
    }
  } else if (windowExceeded && combined && !isMeaningfulTranscript(combined)) {
    speechAggregationBuffer = [];
    clearSpeechAggregationTimer();
    speechAggregationStartedAt = 0;
    speechAggregationEvent = null;
    return;
  }

  const event = speechAggregationEvent || speechAggregationBuffer[0].event;
  const detectedLanguage = speechAggregationBuffer[0].detectedLanguage || activeConfig?.sourceLanguage || 'unknown';
  const receivedAt = speechAggregationBuffer[0].receivedAt || nowISO();
  const aggregatedCount = speechAggregationBuffer.length;
  const segmentSpeakerId = speechAggregationBuffer.map((x) => x.speakerId).find((s) => s && String(s).trim()) || '';
  const sttElapsedMs = Math.max(...speechAggregationBuffer.map((x) => x.sttElapsedMs || 0));

  speechAggregationBuffer = [];
  clearSpeechAggregationTimer();
  speechAggregationStartedAt = 0;
  speechAggregationEvent = null;

  if (!combined) {
    return;
  }

  segmentCounter += 1;
  transcriptQueue.push({
    id: segmentCounter,
    event,
    text: combined,
    detectedLanguage,
    speakerId: segmentSpeakerId,
    latency: 'aggregated',
    receivedAt,
    aggregatedCount,
    createdAtMs: Date.now(),
    sttElapsedMs,
  });

  logInfo(`QUEUE pushed aggregated segment=${segmentCounter} fragments=${aggregatedCount} pending=${transcriptQueue.length}`);
  processTranscriptQueue().catch((err) => {
    logError(`QUEUE ERROR: ${err.message}`);
  });
}

function scheduleSpeechAggregationFlush(delayMs) {
  clearSpeechAggregationTimer();
  speechAggregationTimer = setTimeout(() => {
    flushSpeechAggregationBuffer(false);
  }, delayMs);
}

function enqueueSpeechFragment(event, msg) {
  const fragment = String(msg.text || '').trim();
  if (!fragment) {
    return;
  }

  if (!speechAggregationStartedAt) {
    speechAggregationStartedAt = Date.now();
  }

  speechAggregationEvent = event;
  speechAggregationBuffer.push({
    text: fragment,
    detectedLanguage: msg.detected_language || activeConfig?.sourceLanguage || 'unknown',
    speakerId: extractSpeakerIdFromStt(msg),
    receivedAt: nowISO(),
    sttElapsedMs: msg.sttElapsedMs || 0,
    event,
  });

  const { idleMs, maxWaitMs, maxChars } = getSpeechAggregationConfig();
  const combined = speechAggregationBuffer
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ageMs = Date.now() - speechAggregationStartedAt;
  const shouldFlushSoon = isStrongTranscriptBoundary(fragment) || combined.length >= maxChars || ageMs >= maxWaitMs;
  const keepWaitingForContext = isLikelyIncompleteFragment(fragment) && ageMs < maxWaitMs;

  const commitDelayMs = Number(env('SPEECH_AGGREGATION_COMMIT_MS', '90'));
  if (shouldFlushSoon && !keepWaitingForContext) {
    scheduleSpeechAggregationFlush(commitDelayMs);
  } else if (ageMs >= maxWaitMs) {
    scheduleSpeechAggregationFlush(commitDelayMs);
  } else {
    scheduleSpeechAggregationFlush(idleMs);
  }
}

function clearSpeechAggregationTimerIncoming() {
  if (speechAggregationTimerIncoming) {
    clearTimeout(speechAggregationTimerIncoming);
    speechAggregationTimerIncoming = null;
  }
}

function rescheduleIncomingAggregationIfPending() {
  if (speechAggregationBufferIncoming.length === 0 || !speechAggregationStartedAtIncoming) {
    return;
  }
  const { idleMs, maxWaitMs } = getSpeechAggregationConfig();
  const ageMs = Date.now() - speechAggregationStartedAtIncoming;
  const untilWindowEnd = maxWaitMs - ageMs;
  if (untilWindowEnd <= 0) {
    scheduleIncomingSpeechAggregationFlush(0);
    return;
  }
  const delay = Math.min(idleMs, untilWindowEnd);
  scheduleIncomingSpeechAggregationFlush(Math.max(80, delay));
}

function flushIncomingSpeechAggregationBuffer(force = false) {
  if (speechAggregationBufferIncoming.length === 0) {
    clearSpeechAggregationTimerIncoming();
    speechAggregationStartedAtIncoming = 0;
    speechAggregationEventIncoming = null;
    return;
  }

  const { minChars, maxWaitMs } = getSpeechAggregationConfig();
  const ageMs = speechAggregationStartedAtIncoming ? Date.now() - speechAggregationStartedAtIncoming : 0;
  const windowExceeded = ageMs >= maxWaitMs;
  const effectiveForce = force || windowExceeded;

  const combined = speechAggregationBufferIncoming
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!effectiveForce) {
    if (combined.length < minChars && !isStrongTranscriptBoundary(combined)) {
      rescheduleIncomingAggregationIfPending();
      return;
    }

    if (!isStrongTranscriptBoundary(combined) && isLikelyIncompleteFragment(combined)) {
      rescheduleIncomingAggregationIfPending();
      return;
    }

    const tailFragment = speechAggregationBufferIncoming[speechAggregationBufferIncoming.length - 1]?.text || '';
    if (speechAggregationBufferIncoming.length < 3 && isLikelyIncompleteFragment(tailFragment)) {
      rescheduleIncomingAggregationIfPending();
      return;
    }
  } else if (windowExceeded && combined && !isMeaningfulTranscript(combined)) {
    speechAggregationBufferIncoming = [];
    clearSpeechAggregationTimerIncoming();
    speechAggregationStartedAtIncoming = 0;
    speechAggregationEventIncoming = null;
    return;
  }

  const event = speechAggregationEventIncoming || speechAggregationBufferIncoming[0].event;
  const detectedLanguage = speechAggregationBufferIncoming[0].detectedLanguage || activeConfig?.targetLanguage || 'unknown';
  const receivedAt = speechAggregationBufferIncoming[0].receivedAt || nowISO();
  const aggregatedCount = speechAggregationBufferIncoming.length;
  const segmentSpeakerId = speechAggregationBufferIncoming.map((x) => x.speakerId).find((s) => s && String(s).trim()) || '';
  const sttElapsedMs = Math.max(...speechAggregationBufferIncoming.map((x) => x.sttElapsedMs || 0));

  speechAggregationBufferIncoming = [];
  clearSpeechAggregationTimerIncoming();
  speechAggregationStartedAtIncoming = 0;
  speechAggregationEventIncoming = null;

  if (!combined) {
    return;
  }

  segmentCounter += 1;
  transcriptQueue.push({
    id: segmentCounter,
    event,
    text: combined,
    detectedLanguage,
    speakerId: segmentSpeakerId,
    latency: 'aggregated-incoming',
    receivedAt,
    aggregatedCount,
    createdAtMs: Date.now(),
    direction: 'in',
    sttElapsedMs,
  });

  logInfo(`QUEUE pushed incoming segment=${segmentCounter} fragments=${aggregatedCount} pending=${transcriptQueue.length}`);
  processTranscriptQueue().catch((err) => {
    logError(`QUEUE ERROR: ${err.message}`);
  });
}

function scheduleIncomingSpeechAggregationFlush(delayMs) {
  clearSpeechAggregationTimerIncoming();
  speechAggregationTimerIncoming = setTimeout(() => {
    flushIncomingSpeechAggregationBuffer(false);
  }, delayMs);
}

function enqueueIncomingSpeechFragment(event, msg) {
  const fragment = String(msg.text || '').trim();
  if (!fragment) {
    return;
  }

  if (!speechAggregationStartedAtIncoming) {
    speechAggregationStartedAtIncoming = Date.now();
  }

  speechAggregationEventIncoming = event;
  speechAggregationBufferIncoming.push({
    text: fragment,
    detectedLanguage: msg.detected_language || activeConfig?.targetLanguage || 'unknown',
    speakerId: extractSpeakerIdFromStt(msg),
    receivedAt: nowISO(),
    sttElapsedMs: msg.sttElapsedMs || 0,
    event,
  });

  const { idleMs, maxWaitMs, maxChars } = getSpeechAggregationConfig();
  const combined = speechAggregationBufferIncoming
    .map((item) => item.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ageMs = Date.now() - speechAggregationStartedAtIncoming;
  const shouldFlushSoon = isStrongTranscriptBoundary(fragment) || combined.length >= maxChars || ageMs >= maxWaitMs;
  const keepWaitingForContext = isLikelyIncompleteFragment(fragment) && ageMs < maxWaitMs;

  const commitDelayMs = Number(env('SPEECH_AGGREGATION_COMMIT_MS', '90'));
  if (shouldFlushSoon && !keepWaitingForContext) {
    scheduleIncomingSpeechAggregationFlush(commitDelayMs);
  } else if (ageMs >= maxWaitMs) {
    scheduleIncomingSpeechAggregationFlush(commitDelayMs);
  } else {
    scheduleIncomingSpeechAggregationFlush(idleMs);
  }
}

function normalizeTranscriptForDedupe(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLangCode(langCode) {
  if (!langCode) {
    return 'en';
  }

  const lower = String(langCode).toLowerCase();
  if (lower === 'en-hi-in-latn') {
    return 'hi';
  }

  const parts = lower.split('-');
  return parts[0] || 'en';
}

function toVachanaLanguageCode(langCode) {
  const normalized = String(langCode || '').trim();
  if (!normalized) {
    return 'en-IN';
  }

  const lower = normalized.toLowerCase();
  if (lower.includes('-in') || lower === 'en-hi-in-latn') {
    return normalized;
  }

  const map = {
    en: 'en-IN',
    hi: 'hi-IN',
    bn: 'bn-IN',
    gu: 'gu-IN',
    kn: 'kn-IN',
    ml: 'ml-IN',
    mr: 'mr-IN',
    pa: 'pa-IN',
    ta: 'ta-IN',
    te: 'te-IN',
  };

  return map[lower] || normalized;
}

/** Vachana Realtime STT `lang_code` header — Hinglish Latin maps to en-IN. */
function sttRealtimeLangCode(sourceLanguage) {
  const lower = String(sourceLanguage || '').trim().toLowerCase();
  if (lower.includes('latn') || lower === 'en-hi-in-latn') {
    return 'en-IN';
  }
  return toVachanaLanguageCode(sourceLanguage);
}

function buildWavFromPcm16(pcmBytes, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBytes.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBytes.copy(buffer, 44);

  return buffer;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 40000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
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

async function transcribeViaGoogle(pcmBytes, sourceLanguage) {
  const startMs = Date.now();
  const client = getGoogleSpeechClient();
  const sampleRate = Number(env('VACHANA_STT_SAMPLE_RATE', '16000'));
  const bcp47 = toBcp47(sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN'));
  logInfo(`Google STT request languageCode=${bcp47} pcmBytes=${pcmBytes.length}`);

  const [response] = await client.recognize({
    audio: { content: pcmBytes.toString('base64') },
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: sampleRate,
      languageCode: bcp47,
      enableAutomaticPunctuation: true,
      model: 'latest_long',
      useEnhanced: true,
    },
  });

  const transcript = (response.results || [])
    .map((r) => (r.alternatives && r.alternatives[0] ? r.alternatives[0].transcript : ''))
    .join(' ')
    .trim();

  logInfo(`Google STT elapsed_ms=${elapsedMs(startMs)} transcript_len=${transcript.length}`);
  return { transcript, speakerId: '' };
}

async function transcribeViaRest(pcmBytes, sourceLanguage) {
  const apiKey = env('VACHANA_API_KEY_ID');
  const endpoints = candidateEndpoints(
    env('VACHANA_STT_ENDPOINTS', ''),
    env('VACHANA_STT_ENDPOINT', '/stt/v3'),
    ['/stt/v3', '/stt/rest', '/stt', '/stt/transcribe']
  );

  const wav = buildWavFromPcm16(pcmBytes, Number(env('VACHANA_STT_SAMPLE_RATE', '16000')));
  const language = sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN');
  const sttTimeoutMs = Number(env('VACHANA_STT_REST_TIMEOUT_MS', '12000'));

  let lastError = 'unknown error';
  for (const endpoint of endpoints) {
    const url = buildUrl(endpoint);
    const form = new FormData();
    form.append('audio_file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
    form.append('language_code', language);
    form.append('preferred_language', language);

    try {
      const sttReqStartMs = Date.now();
      logInfo(`STT REST request endpoint=${url}`);
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'X-API-Key-ID': apiKey,
        },
        body: form,
      }, sttTimeoutMs);

      if (response.status === 404) {
        logError(`STT REST endpoint not found: ${url} elapsed_ms=${elapsedMs(sttReqStartMs)}`);
        lastError = `404 at ${url}`;
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        lastError = `status=${response.status} endpoint=${url} body=${body.slice(0, 300)}`;
        logError(`STT REST error ${lastError} elapsed_ms=${elapsedMs(sttReqStartMs)}`);
        continue;
      }

      const payload = await response.json();
      const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
      const transcript = String(
        payload.transcript || payload.text ||
        (data && (data.transcript || data.text)) ||
        ''
      ).trim();
      const speakerId = String(
        payload.speaker_id ?? payload.speaker ?? (data && (data.speaker_id || data.speaker)) ?? ''
      ).trim();
      logInfo(`STT REST parsed endpoint=${url} transcript_len=${transcript.length} elapsed_ms=${elapsedMs(sttReqStartMs)}`);
      return { transcript, speakerId };
    } catch (err) {
      lastError = err.message;
      logError(`STT REST exception endpoint=${url} error=${err.message}`);
    }
  }

  throw new Error(`STT REST failed for all endpoints: ${lastError}`);
}

async function translateViaPublicFallback(text, sourceLanguage, targetLanguage) {
  const sl = normalizeLangCode(sourceLanguage);
  const tl = normalizeLangCode(targetLanguage);

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, { method: 'GET' });

  if (!response.ok) {
    throw new Error(`Fallback translate failed (${response.status})`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    return '';
  }

  return payload[0]
    .map((chunk) => (Array.isArray(chunk) ? chunk[0] : ''))
    .join('')
    .trim();
}

async function translateViaGoogle(text, sourceLanguage, targetLanguage) {
  const startMs = Date.now();
  const client = getGoogleTranslateClient();
  const sl = normalizeLangCode(sourceLanguage);
  const tl = normalizeLangCode(targetLanguage);
  const [translation] = await client.translate(text, { from: sl, to: tl });
  const result = Array.isArray(translation) ? translation[0] : translation;
  logInfo(`Google Translate elapsed_ms=${elapsedMs(startMs)} len=${(result || '').length}`);
  return String(result || '').trim();
}

async function translateText(text, sourceLanguage, targetLanguage, contextHint = { source: '', target: '' }) {
  if (!text || !text.trim()) {
    return '';
  }

  const provider = env('TRANSLATION_PROVIDER', 'google').toLowerCase();

  if (provider === 'google') {
    try {
      return await translateViaGoogle(text, sourceLanguage, targetLanguage);
    } catch (err) {
      logError(`Google Translate error: ${err.message}`);
      logInfo('Google Translate failed. Trying public fallback.');
      return translateViaPublicFallback(text, sourceLanguage, targetLanguage);
    }
  }

  // ---------- Vachana (legacy) ----------
  const apiKey = env('VACHANA_API_KEY_ID');
  const endpoints = candidateEndpoints(
    env('VACHANA_TRANSLATE_ENDPOINTS', ''),
    env('VACHANA_TRANSLATE_ENDPOINT', '/api/v1/tts/translate'),
    ['/api/v1/translate', '/translate', '/api/v1/translation', '/api/v1/tts/translate']
  );
  const translateTimeoutMs = Number(env('VACHANA_TRANSLATE_TIMEOUT_MS', '10000'));

  let lastError = 'unknown';
  for (const endpoint of endpoints) {
    const url = buildUrl(endpoint);
    try {
      const translateReqStartMs = Date.now();
      logInfo(`Translate request endpoint=${url}`);
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key-ID': apiKey,
        },
        body: JSON.stringify({
          text,
          source_language: sourceLanguage,
          target_language: targetLanguage,
          source: sourceLanguage,
          target: targetLanguage,
          context_before_source: contextHint.source || '',
          context_before_target: contextHint.target || '',
          context_window_segments: Number(env('CONTEXT_WINDOW_SEGMENTS', '4')),
        }),
      }, translateTimeoutMs);

      if (response.status === 404) {
        lastError = `404 at ${url}`;
        logError(`Translate endpoint not found: ${url} elapsed_ms=${elapsedMs(translateReqStartMs)}`);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        lastError = `status=${response.status} endpoint=${url} body=${body.slice(0, 300)}`;
        logError(`Translate API error ${lastError} elapsed_ms=${elapsedMs(translateReqStartMs)}`);
        continue;
      }

      const payload = await response.json();
      const translated = parseTranslationText(payload);
      if (translated) {
        logInfo(`Translate parsed endpoint=${url} translated_len=${translated.length} elapsed_ms=${elapsedMs(translateReqStartMs)}`);
        return translated;
      }

      lastError = `No translated text field at ${url}`;
      logError(lastError);
    } catch (error) {
      lastError = `${error.message}`;
      logError(`Translate exception endpoint=${url} error=${error.message}`);
    }
  }

  const fallbackEnabled = env('ENABLE_PUBLIC_TRANSLATE_FALLBACK', 'true').toLowerCase() === 'true';
  if (!fallbackEnabled) {
    throw new Error(`Translate failed for all endpoints: ${lastError}`);
  }

  logInfo(`Primary translate failed (${lastError}). Trying fallback translator.`);
  return translateViaPublicFallback(text, sourceLanguage, targetLanguage);
}

/**
 * Optional: Python REST TTS (legacy Vachana fallback). Set VACHANA_TTS_USE_PYTHON=true.
 * Only used when TTS_PROVIDER=vachana.
 */
function synthesizeTTSViaPythonSubprocess(text) {
  const repoRoot = path.join(__dirname, '..');
  const scriptPath = env('VACHANA_TTS_PYTHON_SCRIPT', '').trim()
    || path.join(__dirname, 'scripts', 'tts_once.py');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`VACHANA_TTS_USE_PYTHON set but script missing: ${scriptPath}`);
  }
  const pythonBin = env('VACHANA_PYTHON', 'python3');
  const payload = JSON.stringify({ text: String(text || '') });
  logInfo(`TTS Python subprocess: ${pythonBin} ${scriptPath}`);
  const timeoutMs = Number(env('VACHANA_TTS_REST_TIMEOUT_MS', '120000'));
  const result = spawnSync(pythonBin, [scriptPath], {
    input: Buffer.from(payload, 'utf8'),
    maxBuffer: 256 * 1024 * 1024,
    cwd: repoRoot,
    env: { ...process.env },
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`Python TTS killed (${result.signal})`);
  }
  if (result.status !== 0) {
    const errText = result.stderr ? result.stderr.toString('utf8') : '';
    throw new Error(`Python TTS failed (exit ${result.status}): ${errText.slice(0, 800)}`);
  }
  if (!result.stdout || result.stdout.length === 0) {
    throw new Error('Python TTS returned empty audio');
  }
  logInfo(`TTS Python subprocess ok bytes=${result.stdout.length}`);
  return Buffer.from(result.stdout);
}

/**
 * Map a language code to a Google TTS voice name.
 * Uses neural2 voices when available, falls back to standard.
 * GOOGLE_TTS_VOICE_<LANG_TAG> env overrides per language (e.g. GOOGLE_TTS_VOICE_HI_IN=hi-IN-Wavenet-C).
 */
function googleTtsVoiceForLang(langCode) {
  const override = env(`GOOGLE_TTS_VOICE_${String(langCode).toUpperCase().replace(/-/g, '_')}`, '').trim();
  if (override) {
    return override;
  }
  const lc = String(langCode).toLowerCase().split('-')[0];
  const defaults = {
    hi: 'hi-IN-Neural2-A',
    en: 'en-IN-Neural2-A',
    bn: 'bn-IN-Wavenet-A',
    gu: 'gu-IN-Wavenet-A',
    kn: 'kn-IN-Wavenet-A',
    ml: 'ml-IN-Wavenet-A',
    mr: 'mr-IN-Wavenet-A',
    pa: 'pa-IN-Wavenet-A',
    ta: 'ta-IN-Neural2-A',
    te: 'te-IN-Standard-A',
  };
  return defaults[lc] || env('GOOGLE_TTS_VOICE', 'en-IN-Neural2-A');
}

/** Build a proper BCP-47 language code Google APIs accept (e.g. hi-IN, en-IN). */
function toBcp47(langCode) {
  const s = String(langCode || '').toLowerCase().trim();
  if (s === 'en-hi-in-latn') {
    return 'hi-IN';
  }
  if (s.includes('-in') || s.includes('-us') || s.includes('-gb')) {
    const parts = s.split('-');
    return `${parts[0]}-${parts[1].toUpperCase()}`;
  }
  const map = {
    hi: 'hi-IN', en: 'en-IN', bn: 'bn-IN', gu: 'gu-IN',
    kn: 'kn-IN', ml: 'ml-IN', mr: 'mr-IN', pa: 'pa-IN',
    ta: 'ta-IN', te: 'te-IN',
  };
  return map[s] || s;
}

async function synthesizeTTSViaGoogle(text, langCode) {
  const startMs = Date.now();
  const client = getGoogleTtsClient();
  const bcp47 = toBcp47(langCode);
  const voiceName = googleTtsVoiceForLang(bcp47);
  const sampleRate = Number(env('GOOGLE_TTS_SAMPLE_RATE', '24000'));

  const [response] = await client.synthesizeSpeech({
    input: { text },
    voice: { languageCode: bcp47, name: voiceName },
    audioConfig: {
      audioEncoding: 'LINEAR16',
      sampleRateHertz: sampleRate,
    },
  });

  const buf = Buffer.from(response.audioContent);
  logInfo(`Google TTS elapsed_ms=${elapsedMs(startMs)} bytes=${buf.length} voice=${voiceName}`);
  return buf;
}

async function synthesizeTTS(text, langCode) {
  const provider = env('TTS_PROVIDER', 'google').toLowerCase();

  if (provider === 'google') {
    const lang = langCode || activeConfig?.targetLanguage || env('VACHANA_DEFAULT_TARGET_LANGUAGE', 'hi-IN');
    try {
      return await synthesizeTTSViaGoogle(text, lang);
    } catch (err) {
      logError(`Google TTS error: ${err.message}. No fallback available.`);
      throw err;
    }
  }

  // ---------- Vachana (legacy) ----------
  if (env('VACHANA_TTS_USE_PYTHON', 'false').toLowerCase() === 'true') {
    return synthesizeTTSViaPythonSubprocess(text);
  }

  const apiKey = env('VACHANA_API_KEY_ID');
  const sampleRate = Number(env('VACHANA_TTS_SAMPLE_RATE', '16000'));
  const voice = env('VACHANA_TTS_VOICE', 'sia');
  const model = env('VACHANA_TTS_MODEL', 'vachana-voice-v2');
  const container = env('VACHANA_TTS_CONTAINER', 'wav');

  const endpoints = candidateEndpoints(
    env('VACHANA_TTS_ENDPOINTS', ''),
    env('VACHANA_TTS_ENDPOINT', '/api/v1/tts/inference'),
    ['/api/v1/tts/inference', '/api/v1/tts/rest', '/tts/rest', '/tts']
  );
  const ttsTimeoutMs = Number(env('VACHANA_TTS_REST_TIMEOUT_MS', '120000'));

  let lastError = 'unknown';
  for (const endpoint of endpoints) {
    const url = buildUrl(endpoint);
    try {
      const ttsReqStartMs = Date.now();
      logInfo(`TTS request endpoint=${url}`);
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key-ID': apiKey,
        },
        body: JSON.stringify({
          text,
          model,
          voice,
          audio_config: {
            sample_rate: sampleRate,
            encoding: 'linear_pcm',
            container,
            num_channels: 1,
            sample_width: 2,
          },
        }),
      }, ttsTimeoutMs);

      if (response.status === 404) {
        lastError = `404 at ${url}`;
        logError(`TTS endpoint not found: ${url} elapsed_ms=${elapsedMs(ttsReqStartMs)}`);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        lastError = `status=${response.status} endpoint=${url} body=${body.slice(0, 300)}`;
        logError(`TTS API error ${lastError} elapsed_ms=${elapsedMs(ttsReqStartMs)}`);
        continue;
      }

      const arr = await response.arrayBuffer();
      const out = Buffer.from(arr);
      logInfo(`TTS parsed endpoint=${url} bytes=${out.length} elapsed_ms=${elapsedMs(ttsReqStartMs)}`);
      return out;
    } catch (error) {
      lastError = `${error.message}`;
      logError(`TTS exception endpoint=${url} error=${error.message}`);
    }
  }

  throw new Error(`TTS failed for all endpoints: ${lastError}`);
}

function hardSplitLongTts(segment, maxChars) {
  segment = String(segment || '').trim();
  if (!segment) {
    return [];
  }
  if (segment.length <= maxChars) {
    return [segment];
  }
  const out = [];
  let start = 0;
  while (start < segment.length) {
    let end = Math.min(start + maxChars, segment.length);
    if (end < segment.length) {
      const slice = segment.slice(start, end);
      const sp = slice.lastIndexOf(' ');
      if (sp > maxChars / 4) {
        end = start + sp;
      }
    }
    if (end <= start) {
      end = Math.min(start + maxChars, segment.length);
    }
    const piece = segment.slice(start, end).trim();
    if (piece) {
      out.push(piece);
    }
    start = end;
  }
  return out;
}

function splitTextForSequentialTts(text) {
  const maxChars = Math.max(48, Number(env('VACHANA_TTS_MAX_CHARS_PER_CHUNK', '120')));
  const enabled = env('VACHANA_TTS_SEQUENTIAL_CHUNKING', 'true').toLowerCase() === 'true';
  if (!enabled) {
    return [String(text || '').trim()].filter(Boolean);
  }
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) {
    return [];
  }
  if (t.length <= maxChars) {
    return [t];
  }
  const rawParts = t.split(/(?<=[.!?…।])\s+/);
  const parts = rawParts.map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    if (p.length > maxChars) {
      if (buf) {
        chunks.push(buf.trim());
        buf = '';
      }
      chunks.push(...hardSplitLongTts(p, maxChars));
      continue;
    }
    const candidate = buf ? `${buf} ${p}`.trim() : p;
    if (candidate.length <= maxChars) {
      buf = candidate;
    } else {
      if (buf) {
        chunks.push(buf.trim());
      }
      buf = p;
    }
  }
  if (buf) {
    chunks.push(buf.trim());
  }
  return chunks.filter(Boolean);
}

async function synthesizeRestTtsSequentialToRenderer(translatedText, event, playbackChannel = 'meeting', ttsLangCode = '') {
  const parts = splitTextForSequentialTts(translatedText);
  if (parts.length > 1) {
    logInfo(
      `TTS sequential: ${parts.length} chunk(s), max_chars=${env('VACHANA_TTS_MAX_CHARS_PER_CHUNK', '120')} `
      + '(chunks queued in order)',
    );
  }
  let totalBytes = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const audioBuffer = await synthesizeTTS(parts[i], ttsLangCode);
    totalBytes += audioBuffer.length;
    event.sender.send('translated-audio', {
      mimeType: 'audio/wav',
      audioBase64: audioBuffer.toString('base64'),
      channel: playbackChannel,
    });
  }
  return totalBytes;
}

function streamTTSRealtime({ endpoint, apiKey, text, model, sampleRate, container, voice, onChunk }) {
  return new Promise((resolve, reject) => {
    const url = String(endpoint || '').trim();
    if (!url) {
      reject(new Error('Realtime TTS endpoint missing'));
      return;
    }

    logInfo(`TTS realtime connect endpoint=${url}`);
    const ws = new WebSocket(url, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key-ID': apiKey,
      },
    });

    let chunkCount = 0;
    let byteCount = 0;
    let closed = false;
    let opened = false;

    const timeoutMs = Number(env('VACHANA_TTS_REALTIME_TIMEOUT_MS', '20000'));
    const timer = setTimeout(() => {
      if (!closed) {
        try { ws.close(); } catch (_e) { }
        reject(new Error(`Realtime TTS timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({
        text,
        model,
        voice,
        audio_config: {
          sample_rate: sampleRate,
          encoding: 'linear_pcm',
          num_channels: Number(env('VACHANA_TTS_NUM_CHANNELS', '1')),
          sample_width: Number(env('VACHANA_TTS_SAMPLE_WIDTH', '2')),
          container,
        },
      }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary || Buffer.isBuffer(data)) {
        const chunk = Buffer.from(data);
        chunkCount += 1;
        byteCount += chunk.length;
        if (typeof onChunk === 'function') {
          onChunk(chunk);
        }
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error' || msg.error) {
          throw new Error(msg.message || msg.error || 'Realtime TTS server error');
        }
      } catch (err) {
        if (String(err.message).includes('Realtime TTS server error')) {
          clearTimeout(timer);
          closed = true;
          try { ws.close(); } catch (_e) { }
          reject(err);
        }
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      closed = true;
      reject(error);
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (closed) {
        return;
      }
      closed = true;

      if (!opened) {
        reject(new Error('Realtime TTS websocket closed before open'));
        return;
      }

      logInfo(`TTS realtime stream done chunks=${chunkCount} bytes=${byteCount}`);
      resolve({ chunkCount, byteCount });
    });
  });
}

async function processTranscriptQueue() {
  if (queueProcessing || transcriptQueue.length === 0) {
    return;
  }
  queueProcessing = true;

  try {
    while (transcriptQueue.length > 0) {
      const item = transcriptQueue.shift();
      const event = item.event;
      const segmentStartMs = Number(item.createdAtMs || Date.now());

      try {
        const isIncoming = item.direction === 'in';
        logInfo(
          isIncoming
            ? `STT-IN(${item.detectedLanguage}, ${item.latency}): ${item.text}`
            : `STT(${item.detectedLanguage}, ${item.latency}): ${item.text}`
        );

        if (sessionArtifacts) {
          const tag = isIncoming ? '[incoming] ' : '';
          appendLine(
            sessionArtifacts.sourceLogPath,
            `[${item.receivedAt}] ${tag}seg=${item.id} ${item.detectedLanguage} :: ${item.text}`
          );
          if (!isIncoming) {
            appendLine(sessionArtifacts.spokenTextPath, item.text);
          }
        }

        writeEvent('segment_received', {
          segment_id: item.id,
          source_text: item.text,
          detected_language: item.detectedLanguage,
          latency: item.latency,
          direction: isIncoming ? 'incoming' : 'outgoing',
        });

        event.sender.send('transcript', {
          text: item.text,
          detectedLanguage: item.detectedLanguage,
          latency: item.latency,
          speakerId: item.speakerId || '',
          incoming: isIncoming,
        });

        const configuredSourceLanguage = activeConfig?.sourceLanguage;
        const configuredTargetLanguage = activeConfig?.targetLanguage;
        if (!configuredSourceLanguage || !configuredTargetLanguage) {
          continue;
        }

        const useDetected = env('USE_DETECTED_SOURCE_LANGUAGE', 'true').toLowerCase() === 'true';

        let sourceLanguage;
        let targetLanguage;
        let contextHint;

        if (isIncoming) {
          sourceLanguage = useDetected
            ? toVachanaLanguageCode(item.detectedLanguage)
            : toVachanaLanguageCode(configuredTargetLanguage);
          targetLanguage = toVachanaLanguageCode(configuredSourceLanguage);
          contextHint = getContextHintReverse();
        } else {
          sourceLanguage = useDetected
            ? toVachanaLanguageCode(item.detectedLanguage)
            : configuredSourceLanguage;
          targetLanguage = configuredTargetLanguage;
          contextHint = getContextHint();
        }

        let translatedText = '';
        const translateStartMs = Date.now();
        let translateElapsedMs = 0;
        try {
          translatedText = await translateText(item.text, sourceLanguage, targetLanguage, contextHint);
          translateElapsedMs = elapsedMs(translateStartMs);
        } catch (error) {
          const fallbackToSource = env('FALLBACK_TO_SOURCE_TEXT_ON_TRANSLATE_ERROR', 'true').toLowerCase() === 'true';
          if (!fallbackToSource) {
            throw error;
          }
          logError(`TRANSLATE ERROR -> using source text fallback: ${error.message}`);
          translatedText = item.text;
          translateElapsedMs = elapsedMs(translateStartMs);
        }

        if (!translatedText || !translatedText.trim()) {
          writeEvent('segment_skipped_empty_translation', { segment_id: item.id });
          continue;
        }

        const normalize = (s) => String(s || '').trim().toLowerCase();
        const strictTargetOnly = env('STRICT_TARGET_ONLY_OUTPUT', 'true').toLowerCase() === 'true';
        if (normalize(translatedText) === normalize(item.text)
            && normalize(sourceLanguage) !== normalize(targetLanguage)) {
          logError(
            `Translation output equals source (possible failure). `
            + `source=${sourceLanguage}, target=${targetLanguage}, text="${item.text}"`
          );

          if (strictTargetOnly) {
            writeEvent('segment_skipped_source_like_output', {
              segment_id: item.id,
              source_language: sourceLanguage,
              target_language: targetLanguage,
              text: item.text,
            });
            continue;
          }
        }

        logInfo(
          isIncoming
            ? `TRANSLATED-IN(${sourceLanguage} -> ${targetLanguage}): ${translatedText}`
            : `TRANSLATED(${sourceLanguage} -> ${targetLanguage}): ${translatedText}`
        );

        if (sessionArtifacts) {
          appendLine(
            sessionArtifacts.translatedLogPath,
            `[${nowISO()}] seg=${item.id} ${isIncoming ? '[in] ' : ''}${sourceLanguage}->${targetLanguage} :: ${translatedText}`
          );
        }

        writeEvent('segment_translated', {
          segment_id: item.id,
          source_language: sourceLanguage,
          target_language: targetLanguage,
          source_text: item.text,
          translated_text: translatedText,
          direction: isIncoming ? 'incoming' : 'outgoing',
        });

        event.sender.send('transcript', {
          text: translatedText,
          translated: true,
          sourceText: item.text,
          speakerId: item.speakerId || '',
          incoming: isIncoming,
        });

        if (isIncoming) {
          appendContextText(recentIncomingSourceContext, item.text);
          appendContextText(recentIncomingTargetContext, translatedText);
        } else {
          appendContextText(recentSourceContext, item.text);
          appendContextText(recentTargetContext, translatedText);
        }

        enqueueTtsJob({
          segmentId: item.id,
          translatedText,
          sourceText: item.text,
          event,
          segmentStartMs,
          sttElapsedMs: item.sttElapsedMs || 0,
          translateElapsedMs,
          playbackChannel: isIncoming ? 'local' : 'meeting',
          ttsLangCode: targetLanguage,
        });
      } catch (error) {
        logError(`SEGMENT ERROR seg=${item.id}: ${error.message}`);
        writeEvent('segment_error', {
          segment_id: item.id,
          error: error.message,
          source_text: item.text,
        });
      }
    }
  } finally {
    queueProcessing = false;

    // If new segments arrived while finalizing, restart processing.
    if (transcriptQueue.length > 0) {
      processTranscriptQueue().catch((err) => {
        logError(`QUEUE ERROR: ${err.message}`);
      });
    }
  }
}

function enqueueTtsJob(job) {
  ttsJobQueue.push(job);
  processTtsJobQueue().catch((error) => {
    logError(`TTS QUEUE ERROR: ${error.message}`);
  });
}

async function processTtsJobQueue() {
  if (ttsWorkerActive) {
    return;
  }

  ttsWorkerActive = true;
  while (ttsJobQueue.length > 0) {
    const job = ttsJobQueue.shift();
    const {
      segmentId,
      translatedText,
      sourceText = '',
      event,
      segmentStartMs,
      sttElapsedMs = 0,
      translateElapsedMs,
      playbackChannel = 'meeting',
      ttsLangCode = '',
    } = job;
    const ttsQueueWaitMs = elapsedMs(segmentStartMs) - Number(translateElapsedMs || 0);

    try {
      const ttsProvider = env('TTS_PROVIDER', 'google').toLowerCase();
      // WS streaming TTS only applies to Vachana; Google TTS is REST-only (still fast).
      const ttsRealtimeEnabled = ttsProvider !== 'google' && env('ENABLE_TTS_REALTIME_WS', 'false').toLowerCase() === 'true';
      const ttsStartMs = Date.now();
      if (ttsRealtimeEnabled) {
        const ttsRealtimeEndpoint = env('VACHANA_TTS_REALTIME_ENDPOINT', 'wss://api.vachana.ai/api/v1/tts');
        const sampleRate = Number(env('VACHANA_TTS_SAMPLE_RATE', '16000'));
        const voice = env('VACHANA_TTS_VOICE', 'sia');
        const model = env('VACHANA_TTS_MODEL', 'vachana-voice-v2');
        const container = env('VACHANA_TTS_CONTAINER', 'wav');
        const apiKey = env('VACHANA_API_KEY_ID');

        try {
          const stats = await streamTTSRealtime({
            endpoint: ttsRealtimeEndpoint,
            apiKey,
            text: translatedText,
            model,
            sampleRate,
            container,
            voice,
            onChunk: (chunk) => {
              event.sender.send('translated-audio-chunk', {
                audioBase64: chunk.toString('base64'),
                sampleRate,
                numChannels: Number(env('VACHANA_TTS_NUM_CHANNELS', '1')),
                sampleWidth: Number(env('VACHANA_TTS_SAMPLE_WIDTH', '2')),
                channel: playbackChannel,
              });
            },
          });

          event.sender.send('translated-audio-done', {
            segmentId,
            chunkCount: stats.chunkCount,
            byteCount: stats.byteCount,
            channel: playbackChannel,
          });

          writeEvent('segment_tts', {
            segment_id: segmentId,
            audio_bytes: stats.byteCount,
            chunk_count: stats.chunkCount,
            mode: 'realtime-ws',
          });
          logInfo(
            `LATENCY seg=${segmentId} total_ms=${elapsedMs(segmentStartMs)} `
            + `translate_ms=${Number(translateElapsedMs || 0)} tts_queue_wait_ms=${Math.max(0, ttsQueueWaitMs)} `
            + `tts_ms=${elapsedMs(ttsStartMs)} mode=realtime-ws`
          );
          writePipelineRow({
            segmentId, sttMs: sttElapsedMs, translateMs: translateElapsedMs,
            ttsMs: elapsedMs(ttsStartMs), totalMs: elapsedMs(segmentStartMs),
            sourceText, translatedText,
          });
        } catch (wsError) {
          const restFallbackEnabled = env('ENABLE_TTS_REST_FALLBACK_ON_WS_ERROR', 'true').toLowerCase() === 'true';
          if (!restFallbackEnabled) {
            throw wsError;
          }

          logError(`TTS realtime failed; using REST fallback: ${wsError.message}`);
          const audioBytes = await synthesizeRestTtsSequentialToRenderer(translatedText, event, playbackChannel, ttsLangCode);
          writeEvent('segment_tts', {
            segment_id: segmentId,
            audio_bytes: audioBytes,
            mode: 'rest-fallback',
            realtime_error: wsError.message,
          });
          logInfo(
            `LATENCY seg=${segmentId} total_ms=${elapsedMs(segmentStartMs)} `
            + `translate_ms=${Number(translateElapsedMs || 0)} tts_queue_wait_ms=${Math.max(0, ttsQueueWaitMs)} `
            + `tts_ms=${elapsedMs(ttsStartMs)} mode=rest-fallback`
          );
          writePipelineRow({
            segmentId, sttMs: sttElapsedMs, translateMs: translateElapsedMs,
            ttsMs: elapsedMs(ttsStartMs), totalMs: elapsedMs(segmentStartMs),
            sourceText, translatedText,
          });
        }
      } else {
        const ttsMode = env('TTS_PROVIDER', 'google').toLowerCase() === 'google' ? 'google-tts' : 'rest';
        const audioBytes = await synthesizeRestTtsSequentialToRenderer(translatedText, event, playbackChannel, ttsLangCode);
        writeEvent('segment_tts', {
          segment_id: segmentId,
          audio_bytes: audioBytes,
          mode: ttsMode,
        });
        logInfo(
          `LATENCY seg=${segmentId} total_ms=${elapsedMs(segmentStartMs)} `
          + `translate_ms=${Number(translateElapsedMs || 0)} tts_queue_wait_ms=${Math.max(0, ttsQueueWaitMs)} `
          + `tts_ms=${elapsedMs(ttsStartMs)} mode=rest`
        );
        writePipelineRow({
          segmentId, sttMs: sttElapsedMs, translateMs: translateElapsedMs,
          ttsMs: elapsedMs(ttsStartMs), totalMs: elapsedMs(segmentStartMs),
          sourceText, translatedText,
        });
      }
    } catch (error) {
      logError(`PIPELINE ERROR (tts): ${error.message}`);
      sendStatus(event, translationRunning, `Pipeline error: ${error.message}`);
    }
  }

  ttsWorkerActive = false;
}

function enqueueTranscript(event, msg) {
  if (!msg || msg.type !== 'transcript' || !msg.text || !msg.text.trim()) {
    return;
  }

  if (!isMeaningfulTranscript(msg.text)) {
    logInfo(`STT noise skipped: "${String(msg.text).trim()}"`);
    writeEvent('segment_skipped_noise', {
      raw_text: String(msg.text).trim(),
    });
    return;
  }

  const sttSpeakerId = extractSpeakerIdFromStt(msg);
  if (!acceptSpeakerForPreference(sttSpeakerId)) {
    logInfo(`STT skipped (speaker filter): speaker="${sttSpeakerId || 'unknown'}" text="${String(msg.text).trim().slice(0, 80)}"`);
    writeEvent('segment_skipped_speaker', {
      speaker_id: sttSpeakerId || '',
      raw_text: String(msg.text).trim(),
    });
    return;
  }

  const normalized = normalizeTranscriptForDedupe(msg.text);
  if (normalized && normalized === lastEnqueuedTranscriptNorm) {
    logInfo(`STT duplicate skipped: "${String(msg.text).trim()}"`);
    writeEvent('segment_skipped_duplicate', {
      raw_text: String(msg.text).trim(),
    });
    return;
  }
  lastEnqueuedTranscriptNorm = normalized;

  lastTranscriptAt = Date.now();

  enqueueSpeechFragment(event, msg);
}

function enqueueTranscriptIncoming(event, msg) {
  if (!msg || msg.type !== 'transcript' || !msg.text || !msg.text.trim()) {
    return;
  }

  if (!isMeaningfulTranscript(msg.text)) {
    return;
  }

  const normalized = normalizeTranscriptForDedupe(msg.text);
  if (normalized && normalized === lastEnqueuedTranscriptNormIncoming) {
    logInfo(`STT incoming duplicate skipped: "${String(msg.text).trim()}"`);
    return;
  }
  lastEnqueuedTranscriptNormIncoming = normalized;

  lastTranscriptAt = Date.now();

  enqueueIncomingSpeechFragment(event, msg);
}

function connectSTT(event, sourceLanguage) {
  return new Promise((resolve, reject) => {
    const endpoint = env('VACHANA_STT_REALTIME_ENDPOINT', 'wss://api.vachana.ai/stt/v3/stream').trim();
    const apiKey = env('VACHANA_API_KEY_ID').trim();
    if (!apiKey) {
      reject(new Error('VACHANA_API_KEY_ID missing in .env'));
      return;
    }

    const langOverride = env('VACHANA_STT_LANG_CODE', '').trim();
    const langCode = langOverride || sttRealtimeLangCode(sourceLanguage);
    const includeLanguageHeader = env('VACHANA_STT_INCLUDE_LANGUAGE_HEADER', 'false').toLowerCase() === 'true';
    const headers = {
      'x-api-key-id': apiKey,
      lang_code: langCode,
    };

    if (includeLanguageHeader) {
      headers['x-language-code'] = langCode;
    }

    logInfo(`Connecting STT websocket to ${endpoint}`);
    sttSocket = new WebSocket(endpoint, { headers });

    sttSocket.on('open', () => resolve());

    sttSocket.on('message', (payload, isBinary) => {
      if (isBinary) {
        return;
      }

      try {
        const msg = JSON.parse(payload.toString());
        if (msg.type === 'connected') {
          sendStatus(event, true, 'Connected to STT. Speak now.');
          return;
        }
        if (msg.type === 'processing') {
          sendStatus(event, true, 'Processing speech segment...');
          return;
        }
        if (msg.type === 'error') {
          sendStatus(event, true, `STT error: ${msg.message}`);
          return;
        }

        enqueueTranscript(event, msg);
      } catch (error) {
        sendStatus(event, translationRunning, `Bad STT message: ${error.message}`);
      }
    });

    sttSocket.on('error', (error) => {
      logError(`STT SOCKET ERROR: ${error.message}`);
      if (String(error.message).includes('403')) {
        logError('STT auth rejected (403). Verify key scope and realtime entitlement.');
      }
      reject(error);
    });

    sttSocket.on('close', () => {
      if (translationRunning) {
        sendStatus(event, false, 'STT disconnected. Click Start again.');
      }
    });
  });
}

function connectSTTReturn(event, targetLanguage) {
  return new Promise((resolve, reject) => {
    const endpoint = env('VACHANA_STT_REALTIME_ENDPOINT', 'wss://api.vachana.ai/stt/v3/stream').trim();
    const apiKey = env('VACHANA_API_KEY_ID').trim();
    if (!apiKey) {
      reject(new Error('VACHANA_API_KEY_ID missing in .env'));
      return;
    }

    const langOverride = env('VACHANA_STT_RETURN_LANG_CODE', '').trim();
    const langCode = langOverride || sttRealtimeLangCode(targetLanguage);
    const includeLanguageHeader = env('VACHANA_STT_INCLUDE_LANGUAGE_HEADER', 'false').toLowerCase() === 'true';
    const headers = {
      'x-api-key-id': apiKey,
      lang_code: langCode,
    };

    if (includeLanguageHeader) {
      headers['x-language-code'] = langCode;
    }

    logInfo(`Connecting return STT websocket (team audio, ${langCode}) to ${endpoint}`);
    sttSocketReturn = new WebSocket(endpoint, { headers });

    sttSocketReturn.on('open', () => resolve());

    sttSocketReturn.on('message', (payload, isBinary) => {
      if (isBinary) {
        return;
      }

      try {
        const msg = JSON.parse(payload.toString());
        if (msg.type === 'connected' || msg.type === 'processing') {
          return;
        }
        if (msg.type === 'error') {
          logError(`Return STT error: ${msg.message}`);
          return;
        }

        enqueueTranscriptIncoming(event, msg);
      } catch (error) {
        logError(`Bad return STT message: ${error.message}`);
      }
    });

    sttSocketReturn.on('error', (error) => {
      logError(`RETURN STT SOCKET ERROR: ${error.message}`);
      reject(error);
    });

    sttSocketReturn.on('close', () => {
      if (translationRunning && activeConfig?.bidirectional) {
        logError('Return STT disconnected (team-audio path).');
      }
    });
  });
}

function startRestSttFallback(event, sourceLanguage) {
  sttMode = 'rest';
  restAudioBuffer = [];
  restInFlight = false;
  restOverlapBuffer = Buffer.alloc(0);

  if (restFlushTimer) {
    clearInterval(restFlushTimer);
  }

  const sttProvider = env('STT_PROVIDER', 'google').toLowerCase();
  const defaultMinBytes = sttProvider === 'google' ? '48000' : '32000';
  const defaultFlushMs = sttProvider === 'google' ? '2500' : '1500';
  const minBytesPerFlush = Number(env('VACHANA_STT_REST_MIN_BYTES', defaultMinBytes));
  const flushEveryMs = Number(env('VACHANA_STT_REST_FLUSH_MS', defaultFlushMs));
  const overlapMs = Number(env('VACHANA_STT_REST_OVERLAP_MS', '400'));
  const sampleRate = Number(env('VACHANA_STT_SAMPLE_RATE', '16000'));
  const overlapBytes = Math.max(0, Math.floor((overlapMs / 1000) * sampleRate * 2));

  restFlushTimer = setInterval(async () => {
    if (!translationRunning || sttMode !== 'rest' || restInFlight) {
      return;
    }

    const totalBytes = restAudioBuffer.reduce((sum, b) => sum + b.length, 0);
    if (totalBytes < minBytesPerFlush) {
      return;
    }

    const freshChunk = Buffer.concat(restAudioBuffer);
    const chunk = restOverlapBuffer.length > 0
      ? Buffer.concat([restOverlapBuffer, freshChunk])
      : freshChunk;
    restAudioBuffer = [];
    if (overlapBytes > 0 && chunk.length > overlapBytes) {
      restOverlapBuffer = chunk.subarray(chunk.length - overlapBytes);
    } else {
      restOverlapBuffer = chunk;
    }
    restInFlight = true;

    try {
      const sttProvider = env('STT_PROVIDER', 'google').toLowerCase();
      sendStatus(event, true, `${sttProvider === 'google' ? 'Google' : 'REST'} STT processing...`);
      const transcribeFn = sttProvider === 'google' ? transcribeViaGoogle : transcribeViaRest;
      const sttStartMs = Date.now();
      const { transcript: text, speakerId } = await transcribeFn(chunk, sourceLanguage);
      const sttElapsedMs = elapsedMs(sttStartMs);
      if (text && text.trim()) {
        enqueueTranscript(event, {
          type: 'transcript',
          text,
          detected_language: sourceLanguage,
          latency: sttProvider === 'google' ? 'google-stt' : 'rest',
          speaker_id: speakerId || undefined,
          sttElapsedMs,
        });
      }
    } catch (error) {
      logError(`STT REST ERROR: ${error.message}`);
      sendStatus(event, true, `STT error: ${error.message}`);
    } finally {
      restInFlight = false;
    }
  }, flushEveryMs);

  logInfo('STT mode switched to REST fallback');
  sendStatus(event, true, 'Realtime STT unavailable. Using REST STT fallback.');
}

function ensureSttHealthWatch() {
  if (sttHealthTimer) {
    clearInterval(sttHealthTimer);
  }

  sttHealthTimer = setInterval(() => {
    if (!translationRunning || sttMode !== 'ws' || wsHealthFailoverTriggered) {
      return;
    }

    const now = Date.now();
    const recentSpeech = now - lastSpeechDetectedAt < 4000;
    const transcriptStalled = now - lastTranscriptAt > 12000;
    if (!recentSpeech || !transcriptStalled) {
      return;
    }

    wsHealthFailoverTriggered = true;
    logError('STT WS health check: speech detected but no transcripts for >12s. Switching to REST fallback.');

    const sourceLanguage = activeConfig?.sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN');
    if (activeSender) {
      const evt = { sender: activeSender };
      startRestSttFallback(evt, sourceLanguage);
      sendStatus(evt, true, 'Auto-failover: switched STT from WebSocket to REST due to no transcript events.');
    }
  }, 3000);
}

function teardownPipeline() {
  translationRunning = false;
  activeConfig = null;
  sttMode = 'ws';
  restAudioBuffer = [];
  restOverlapBuffer = Buffer.alloc(0);
  restInFlight = false;
  transcriptQueue = [];
  queueProcessing = false;
  ttsJobQueue = [];
  ttsWorkerActive = false;
  ttsWorkersInFlight = 0;
  speechAggregationBuffer = [];
  speechAggregationEvent = null;
  speechAggregationStartedAt = 0;
  clearSpeechAggregationTimer();
  recentSourceContext = [];
  recentTargetContext = [];
  resetSpeakerPreferenceState();
  writePipelineSummary();
  sessionArtifacts = null;
  pipelineStats = { count: 0, sttSum: 0, translateSum: 0, ttsSum: 0, totalSum: 0 };
  activeSender = null;
  lastSpeechDetectedAt = 0;
  lastTranscriptAt = 0;
  wsHealthFailoverTriggered = false;
  lastEnqueuedTranscriptNorm = '';
  lastEnqueuedTranscriptNormIncoming = '';
  speechAggregationBufferIncoming = [];
  speechAggregationEventIncoming = null;
  speechAggregationStartedAtIncoming = 0;
  clearSpeechAggregationTimerIncoming();
  recentIncomingSourceContext = [];
  recentIncomingTargetContext = [];

  if (restFlushTimer) {
    clearInterval(restFlushTimer);
    restFlushTimer = null;
  }
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  if (sttHealthTimer) {
    clearInterval(sttHealthTimer);
    sttHealthTimer = null;
  }
  if (sttSocket) {
    try {
      sttSocket.close();
    } catch (_e) {
      // no-op
    }
    sttSocket = null;
  }
  if (sttSocketReturn) {
    try {
      sttSocketReturn.close();
    } catch (_e) {
      // no-op
    }
    sttSocketReturn = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: false,
    title: 'Gnani Translator',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.on('start-translation', (event, config = {}) => {
  activeSender = event.sender;
  const sourceLanguage = config.sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN');
  const targetLanguage = config.targetLanguage || env('VACHANA_DEFAULT_TARGET_LANGUAGE', 'hi-IN');
  const speakerPreferenceMode = config.speakerPreferenceMode != null && config.speakerPreferenceMode !== ''
    ? String(config.speakerPreferenceMode).toLowerCase()
    : String(env('SPEAKER_PREFERENCE_MODE', 'off')).toLowerCase();
  const preferredSpeakerId = config.preferredSpeakerId != null
    ? String(config.preferredSpeakerId).trim()
    : String(env('VACHANA_PREFERRED_SPEAKER_ID', '')).trim();
  const bidirectionalRequested = Boolean(config.bidirectional);

  initSessionArtifacts(sourceLanguage, targetLanguage);
  writeEvent('session_start', {
    source_language: sourceLanguage,
    target_language: targetLanguage,
    speaker_preference_mode: speakerPreferenceMode,
    bidirectional: bidirectionalRequested,
  });

  resetSpeakerPreferenceState();
  activeConfig = {
    sourceLanguage,
    targetLanguage,
    speakerPreferenceMode,
    preferredSpeakerId,
    bidirectional: bidirectionalRequested,
  };
  audioFramesForwarded = 0;
  audioFramesDropped = 0;
  segmentCounter = 0;
  lastEnqueuedTranscriptNorm = '';
  lastEnqueuedTranscriptNormIncoming = '';
  lastTranscriptAt = Date.now();
  lastSpeechDetectedAt = 0;
  wsHealthFailoverTriggered = false;
  recentSourceContext = [];
  recentTargetContext = [];
  recentIncomingSourceContext = [];
  recentIncomingTargetContext = [];
  speechAggregationBufferIncoming = [];
  speechAggregationEventIncoming = null;
  speechAggregationStartedAtIncoming = 0;
  clearSpeechAggregationTimerIncoming();

  if (metricsTimer) {
    clearInterval(metricsTimer);
  }
  metricsTimer = setInterval(() => {
    if (translationRunning) {
      logInfo(`AUDIO frames forwarded=${audioFramesForwarded}, dropped=${audioFramesDropped}, queue=${transcriptQueue.length}`);
    }
  }, 5000);

  const sttModePref = env('VACHANA_STT_MODE', 'ws').toLowerCase();
  if (sttModePref === 'rest') {
    if (bidirectionalRequested) {
      activeConfig.bidirectional = false;
      logError('Bidirectional mode requires WebSocket STT; running outgoing path only (REST mode).');
    }
    translationRunning = true;
    sttMode = 'rest';
    startRestSttFallback(event, sourceLanguage);
    sendStatus(
      event,
      true,
      bidirectionalRequested
        ? `Pipeline started in REST mode (${sourceLanguage} -> ${targetLanguage}). Team listen path disabled — set VACHANA_STT_MODE=ws for bidirectional.`
        : `Pipeline started in REST continuous mode (${sourceLanguage} -> ${targetLanguage}).`,
    );
    return;
  }

  connectSTT(event, sourceLanguage)
    .then(() => {
      sttMode = 'ws';
      translationRunning = true;
      ensureSttHealthWatch();
      if (!activeConfig.bidirectional) {
        sendStatus(event, true, `Pipeline started (${sourceLanguage} -> ${targetLanguage}).`);
        return Promise.resolve();
      }
      return connectSTTReturn(event, targetLanguage)
        .then(() => {
          sendStatus(
            event,
            true,
            `Bidirectional: you → ${targetLanguage} (meeting); team → ${sourceLanguage} (headphones).`,
          );
        })
        .catch((err) => {
          activeConfig.bidirectional = false;
          logError(`Return STT connect failed: ${err.message}`);
          sendStatus(
            event,
            true,
            `Pipeline started (${sourceLanguage} -> ${targetLanguage}). Team listen disabled: ${err.message}`,
          );
        });
    })
    .catch((error) => {
      const restFallback = env('ENABLE_STT_REST_FALLBACK', 'true').toLowerCase() === 'true';
      if (restFallback) {
        translationRunning = true;
        if (activeConfig) {
          activeConfig.bidirectional = false;
        }
        startRestSttFallback(event, sourceLanguage);
        ensureSttHealthWatch();
        sendStatus(event, true, `WS STT failed (${error.message}). REST fallback active (bidirectional disabled).`);
        return;
      }

      translationRunning = false;
      sendStatus(event, false, `Failed to start pipeline: ${error.message}`);
      teardownPipeline();
    });
});

ipcMain.on('stop-translation', (event) => {
  writeEvent('session_stop', {});
  teardownPipeline();
  sendStatus(event, false, 'Translation stopped.');
});

ipcMain.on('audio-chunk', (_event, chunkBytes) => {
  if (!translationRunning) {
    audioFramesDropped += 1;
    return;
  }

  if (!chunkBytes) {
    audioFramesDropped += 1;
    return;
  }

  const buffer = Buffer.isBuffer(chunkBytes) ? chunkBytes : Buffer.from(chunkBytes);
  if (buffer.length !== 1024) {
    audioFramesDropped += 1;
    return;
  }

  if (sttMode === 'rest') {
    restAudioBuffer.push(buffer);
    audioFramesForwarded += 1;
    return;
  }

  if (!sttSocket || sttSocket.readyState !== WebSocket.OPEN) {
    audioFramesDropped += 1;
    return;
  }

  sttSocket.send(buffer);
  audioFramesForwarded += 1;
});

ipcMain.on('audio-chunk-return', (_event, chunkBytes) => {
  if (!translationRunning || !activeConfig?.bidirectional) {
    return;
  }

  if (!chunkBytes) {
    return;
  }

  const buffer = Buffer.isBuffer(chunkBytes) ? chunkBytes : Buffer.from(chunkBytes);
  if (buffer.length !== 1024) {
    return;
  }

  if (sttMode !== 'ws' || !sttSocketReturn || sttSocketReturn.readyState !== WebSocket.OPEN) {
    return;
  }

  sttSocketReturn.send(buffer);
});

ipcMain.on('mic-activity', (_event, payload = {}) => {
  const now = Date.now();
  if (now - lastMicActivityLogTs < 1000) {
    return;
  }
  lastMicActivityLogTs = now;

  const rms = Number(payload.rms || 0).toFixed(4);
  const speaking = Boolean(payload.speaking);
  if (speaking) {
    lastSpeechDetectedAt = now;
  }
  const queuedFrames = Number(payload.queuedFrames || 0);
  const sourceLang = payload.sourceLang || activeConfig?.sourceLanguage || 'n/a';
  const targetLang = payload.targetLang || activeConfig?.targetLanguage || 'n/a';
  logInfo(
    `MIC activity speaking=${speaking} rms=${rms} queuedFrames=${queuedFrames} lang=${sourceLang}->${targetLang}`
  );
});

app.on('window-all-closed', () => {
  teardownPipeline();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
