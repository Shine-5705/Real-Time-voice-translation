const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

let mainWindow;
let translationRunning = false;
let sttSocket = null;
let activeConfig = null;
let sttMode = 'ws';
let restAudioBuffer = [];
let restFlushTimer = null;
let restInFlight = false;
let audioFramesForwarded = 0;
let audioFramesDropped = 0;
let metricsTimer = null;

function nowISO() {
  return new Date().toISOString();
}

function logInfo(message) {
  console.log(`[${nowISO()}] ${message}`);
}

function logError(message) {
  console.error(`[${nowISO()}] ${message}`);
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function sendStatus(event, running, message) {
  logInfo(`STATUS running=${running} :: ${message}`);
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
    ''
  );
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

async function transcribeViaRest(pcmBytes, sourceLanguage) {
  const baseUrl = env('VACHANA_BASE_URL', 'https://api.vachana.ai');
  const sttEndpoint = env('VACHANA_STT_ENDPOINT', '/stt/v3');
  const apiKey = env('VACHANA_API_KEY_ID');

  const wav = buildWavFromPcm16(pcmBytes, Number(env('VACHANA_STT_SAMPLE_RATE', '16000')));
  const form = new FormData();
  form.append('audio_file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
  form.append('language_code', sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN'));

  const response = await fetch(`${baseUrl}${sttEndpoint}`, {
    method: 'POST',
    headers: {
      'X-API-Key-ID': apiKey,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`STT REST failed (${response.status})`);
  }

  const payload = await response.json();
  return payload.transcript || '';
}

function startRestSttFallback(event, sourceLanguage) {
  sttMode = 'rest';
  restAudioBuffer = [];
  restInFlight = false;

  if (restFlushTimer) {
    clearInterval(restFlushTimer);
  }

  const minBytesPerFlush = Number(env('VACHANA_STT_REST_MIN_BYTES', '48000')); // ~1.5s @16kHz/16-bit mono
  const flushEveryMs = Number(env('VACHANA_STT_REST_FLUSH_MS', '2000'));

  restFlushTimer = setInterval(async () => {
    if (!translationRunning || sttMode !== 'rest' || restInFlight) {
      return;
    }

    const totalBytes = restAudioBuffer.reduce((sum, b) => sum + b.length, 0);
    if (totalBytes < minBytesPerFlush) {
      return;
    }

    const chunk = Buffer.concat(restAudioBuffer);
    restAudioBuffer = [];
    restInFlight = true;

    try {
      sendStatus(event, true, 'REST STT processing segment...');
      const text = await transcribeViaRest(chunk, sourceLanguage);
      if (text && text.trim()) {
        handleTranscript(event, {
          type: 'transcript',
          text,
          detected_language: sourceLanguage,
          latency: 'rest',
        });
      }
    } catch (error) {
      logError(`STT REST ERROR: ${error.message}`);
      sendStatus(event, true, `STT REST error: ${error.message}`);
    } finally {
      restInFlight = false;
    }
  }, flushEveryMs);

  logInfo('STT mode switched to REST fallback');
  sendStatus(event, true, 'Realtime STT unavailable. Using REST STT fallback.');
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

async function translateText(text, sourceLanguage, targetLanguage) {
  if (!text || !text.trim()) {
    return '';
  }

  const baseUrl = env('VACHANA_BASE_URL', 'https://api.vachana.ai');
  const translateEndpoint = env('VACHANA_TRANSLATE_ENDPOINT', '/api/v1/tts/translate');
  const apiKey = env('VACHANA_API_KEY_ID');

  try {
    const response = await fetch(`${baseUrl}${translateEndpoint}`, {
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
      }),
    });

    if (!response.ok) {
      throw new Error(`Translate failed (${response.status})`);
    }

    const payload = await response.json();
    const translated = parseTranslationText(payload);
    if (translated) {
      logInfo('Primary translation endpoint returned a result.');
      return translated;
    }
    throw new Error('Translate response did not include translated text');
  } catch (error) {
    const fallbackEnabled = env('ENABLE_PUBLIC_TRANSLATE_FALLBACK', 'true').toLowerCase() === 'true';
    if (!fallbackEnabled) {
      throw error;
    }

    logInfo(`Primary translate failed (${error.message}). Trying fallback translator.`);
    try {
      const fallbackTranslated = await translateViaPublicFallback(text, sourceLanguage, targetLanguage);
      if (fallbackTranslated) {
        logInfo('Fallback translator returned a result.');
      }
      return fallbackTranslated;
    } catch (fallbackError) {
      logError(`Fallback translate failed: ${fallbackError.message}`);
      throw fallbackError;
    }
  }
}

async function synthesizeTTS(text) {
  const baseUrl = env('VACHANA_BASE_URL', 'https://api.vachana.ai');
  const ttsEndpoint = env('VACHANA_TTS_ENDPOINT', '/api/v1/tts/inference');
  const apiKey = env('VACHANA_API_KEY_ID');
  const sampleRate = Number(env('VACHANA_TTS_SAMPLE_RATE', '16000'));
  const voice = env('VACHANA_TTS_VOICE', 'sia');
  const model = env('VACHANA_TTS_MODEL', 'vachana-voice-v2');
  const container = env('VACHANA_TTS_CONTAINER', 'wav');

  const response = await fetch(`${baseUrl}${ttsEndpoint}`, {
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
  });

  if (!response.ok) {
    throw new Error(`TTS failed (${response.status})`);
  }

  const arr = await response.arrayBuffer();
  return Buffer.from(arr);
}

function handleTranscript(event, msg) {
  if (!msg || msg.type !== 'transcript' || !msg.text) {
    return;
  }

  const detectedLang = msg.detected_language || activeConfig?.sourceLanguage || 'unknown';
  const sttLatency = msg.latency ?? 'n/a';
  logInfo(`STT(${detectedLang}, latency=${sttLatency}ms): ${msg.text}`);

  event.sender.send('transcript', {
    text: msg.text,
    detectedLanguage: detectedLang,
    latency: msg.latency,
  });

  const sourceLanguage = activeConfig?.sourceLanguage;
  const targetLanguage = activeConfig?.targetLanguage;
  if (!sourceLanguage || !targetLanguage) {
    return;
  }

  const fallbackToSource = env('FALLBACK_TO_SOURCE_TEXT_ON_TRANSLATE_ERROR', 'true').toLowerCase() === 'true';

  translateText(msg.text, sourceLanguage, targetLanguage)
    .catch((error) => {
      if (fallbackToSource) {
        logError(`TRANSLATE ERROR -> using source text as fallback: ${error.message}`);
        return msg.text;
      }
      throw error;
    })
    .then((translatedText) => {
      if (!translatedText || !translatedText.trim()) {
        return null;
      }

      const normalize = (s) => String(s || '').trim().toLowerCase();
      if (normalize(translatedText) === normalize(msg.text)
          && normalize(sourceLanguage) !== normalize(targetLanguage)) {
        logError(
          `Translation output equals source (possible translation failure). `
          + `source=${sourceLanguage}, target=${targetLanguage}, text="${msg.text}"`
        );
      }

      logInfo(`TRANSLATED(${sourceLanguage} -> ${targetLanguage}): ${translatedText}`);

      event.sender.send('transcript', {
        text: translatedText,
        translated: true,
        sourceText: msg.text,
      });

      return synthesizeTTS(translatedText);
    })
    .then((audioBuffer) => {
      if (!audioBuffer) {
        return;
      }
      event.sender.send('translated-audio', {
        mimeType: 'audio/wav',
        audioBase64: audioBuffer.toString('base64'),
      });
    })
    .catch((error) => {
      logError(`PIPELINE ERROR: ${error.message}`);
      sendStatus(event, translationRunning, `Pipeline error: ${error.message}`);
    });
}

function connectSTT(event, sourceLanguage) {
  return new Promise((resolve, reject) => {
    const endpoint = env('VACHANA_STT_REALTIME_ENDPOINT', 'wss://api.vachana.ai/stt/v3').trim();
    const apiKey = env('VACHANA_API_KEY_ID').trim();
    if (!apiKey) {
      reject(new Error('VACHANA_API_KEY_ID missing in .env'));
      return;
    }

    const includeLanguageHeader = env('VACHANA_STT_INCLUDE_LANGUAGE_HEADER', 'false').toLowerCase() === 'true';
    const headers = {
      'X-API-Key-ID': apiKey,
      'x-api-key-id': apiKey,
    };

    if (includeLanguageHeader && sourceLanguage) {
      headers['x-language-code'] = sourceLanguage;
    }

    logInfo(`Connecting STT websocket to ${endpoint}`);

    sttSocket = new WebSocket(endpoint, {
      headers,
    });

    sttSocket.on('open', () => {
      resolve();
    });

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

        handleTranscript(event, msg);
      } catch (error) {
        sendStatus(event, translationRunning, `Bad STT message: ${error.message}`);
      }
    });

    sttSocket.on('error', (error) => {
      logError(`STT SOCKET ERROR: ${error.message}`);
      if (String(error.message).includes('403')) {
        logError('STT auth rejected (403). Verify VACHANA_API_KEY_ID, endpoint path, and account access for realtime STT.');
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

function teardownPipeline() {
  translationRunning = false;
  activeConfig = null;
  sttMode = 'ws';
  restAudioBuffer = [];
  restInFlight = false;
  if (restFlushTimer) {
    clearInterval(restFlushTimer);
    restFlushTimer = null;
  }
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  if (sttSocket) {
    try {
      sttSocket.close();
    } catch (_e) {
      // no-op
    }
    sttSocket = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    title: "Gnani Translator",
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools(); // Uncomment to see console
}

app.whenReady().then(createWindow);

ipcMain.on('start-translation', (event, config = {}) => {
  const sourceLanguage = config.sourceLanguage || 'en-IN';
  const targetLanguage = config.targetLanguage || 'hi-IN';
  activeConfig = {
    sourceLanguage,
    targetLanguage,
  };

  connectSTT(event, sourceLanguage)
    .then(() => {
      sttMode = 'ws';
      translationRunning = true;
      audioFramesForwarded = 0;
      audioFramesDropped = 0;
      if (metricsTimer) {
        clearInterval(metricsTimer);
      }
      metricsTimer = setInterval(() => {
        if (translationRunning) {
          logInfo(`AUDIO frames forwarded=${audioFramesForwarded}, dropped=${audioFramesDropped}`);
        }
      }, 5000);
      sendStatus(
        event,
        true,
        `Pipeline started (${sourceLanguage} -> ${targetLanguage}).`
      );
    })
    .catch((error) => {
      const restFallback = env('ENABLE_STT_REST_FALLBACK', 'true').toLowerCase() === 'true';
      if (restFallback) {
        translationRunning = true;
        audioFramesForwarded = 0;
        audioFramesDropped = 0;
        if (metricsTimer) {
          clearInterval(metricsTimer);
        }
        metricsTimer = setInterval(() => {
          if (translationRunning) {
            logInfo(`AUDIO frames forwarded=${audioFramesForwarded}, dropped=${audioFramesDropped}`);
          }
        }, 5000);
        startRestSttFallback(event, sourceLanguage);
        sendStatus(event, true, `WS STT failed (${error.message}). REST fallback active.`);
        return;
      }

      translationRunning = false;
      sendStatus(event, false, `Failed to start pipeline: ${error.message}`);
      teardownPipeline();
    });
});

ipcMain.on('stop-translation', (event) => {
  teardownPipeline();
  sendStatus(event, false, 'Translation stopped.');
});

ipcMain.on('audio-chunk', (event, chunkBytes) => {
  if (!translationRunning) {
    audioFramesDropped += 1;
    return;
  }

  if (!chunkBytes) {
    audioFramesDropped += 1;
    return;
  }

  const buffer = Buffer.isBuffer(chunkBytes)
    ? chunkBytes
    : Buffer.from(chunkBytes);

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

app.on('window-all-closed', () => {
  teardownPipeline();
  if (process.platform !== 'darwin') app.quit();
});