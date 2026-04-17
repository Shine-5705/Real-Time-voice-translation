const WebSocket = require('ws');

function createTtsService({
  env,
  logInfo,
  logError,
  elapsedMs,
  fetchWithTimeout,
  buildUrl,
  candidateEndpoints,
  getGoogleTtsClient,
  getGoogleTtsBetaClient,
}) {
  function toBcp47(langCode) {
    const s = String(langCode || '').toLowerCase().trim();
    if (s === 'en-hi-in-latn') return 'hi-IN';
    if (s.includes('-in') || s.includes('-us') || s.includes('-gb')) {
      const parts = s.split('-');
      return `${parts[0]}-${parts[1].toUpperCase()}`;
    }
    const map = {
      hi: 'hi-IN', en: 'en-IN', bn: 'bn-IN', gu: 'gu-IN', kn: 'kn-IN',
      ml: 'ml-IN', mr: 'mr-IN', pa: 'pa-IN', ta: 'ta-IN', te: 'te-IN',
    };
    return map[s] || s;
  }

  function googleTtsVoiceForLang(langCode) {
    const override = env(`GOOGLE_TTS_VOICE_${String(langCode).toUpperCase().replace(/-/g, '_')}`, '').trim();
    if (override) return override;
    const lc = String(langCode).toLowerCase().split('-')[0];
    const defaults = {
      hi: 'hi-IN-Chirp3-HD-Aoede',
      en: 'en-US-Chirp3-HD-Aoede',
      bn: 'bn-IN-Wavenet-A',
      gu: 'gu-IN-Wavenet-A',
      kn: 'kn-IN-Wavenet-A',
      ml: 'ml-IN-Wavenet-A',
      mr: 'mr-IN-Wavenet-A',
      pa: 'pa-IN-Wavenet-A',
      ta: 'ta-IN-Neural2-A',
      te: 'te-IN-Standard-A',
    };
    return defaults[lc] || env('GOOGLE_TTS_VOICE', 'en-US-Chirp3-HD-Aoede');
  }

  function inferLanguageCodeFromVoiceName(voiceName, fallbackLangCode) {
    const requested = toBcp47(fallbackLangCode);
    const m = String(voiceName || '').match(/^([a-z]{2,3}-[A-Z]{2,3})-/);
    if (m && m[1]) return m[1];
    return requested;
  }

  function buildWavHeader(pcmByteLength, sampleRate, numChannels = 1, bitsPerSample = 16) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmByteLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmByteLength, 40);
    return header;
  }

  async function synthesizeTTSViaGoogle(text, langCode, opts = {}) {
    const startMs = Date.now();
    const client = getGoogleTtsBetaClient();
    const bcp47 = toBcp47(langCode);
    const voiceName = googleTtsVoiceForLang(bcp47);
    const effectiveLanguageCode = inferLanguageCodeFromVoiceName(voiceName, bcp47);
    const sampleRate = Number(env('GOOGLE_TTS_SAMPLE_RATE', '24000'));
    const onPcmChunk = typeof opts.onPcmChunk === 'function' ? opts.onPcmChunk : null;
    const firstEmitBytes = Math.max(1, Number(env('GOOGLE_TTS_STREAM_FIRST_EMIT_BYTES', '8')));
    const stream = client.streamingSynthesize();
    const audioChunks = [];
    let pendingFirstChunk = Buffer.alloc(0);
    let firstChunkEmitted = false;

    const done = new Promise((resolve, reject) => {
      stream.on('data', (response) => {
        if (response.audioContent && response.audioContent.length > 0) {
          const chunk = Buffer.from(response.audioContent);
          audioChunks.push(chunk);
          if (!onPcmChunk) return;
          if (!firstChunkEmitted) {
            pendingFirstChunk = Buffer.concat([pendingFirstChunk, chunk]);
            if (pendingFirstChunk.length < firstEmitBytes) return;
            onPcmChunk(pendingFirstChunk);
            pendingFirstChunk = Buffer.alloc(0);
            firstChunkEmitted = true;
            return;
          }
          onPcmChunk(chunk);
        }
      });
      stream.on('end', () => {
        if (onPcmChunk && !firstChunkEmitted && pendingFirstChunk.length > 0) onPcmChunk(pendingFirstChunk);
        resolve();
      });
      stream.on('error', reject);
    });

    stream.write({
      streamingConfig: {
        voice: { languageCode: effectiveLanguageCode, name: voiceName },
        streamingAudioConfig: { audioEncoding: 'PCM', sampleRateHertz: sampleRate },
      },
    });
    stream.write({ input: { text } });
    stream.end();
    await done;

    const pcm = Buffer.concat(audioChunks);
    const wavHeader = buildWavHeader(pcm.length, sampleRate);
    const out = Buffer.concat([wavHeader, pcm]);
    logInfo(`Google TTS (streaming) elapsed_ms=${elapsedMs(startMs)} bytes=${out.length} voice=${voiceName} lang=${effectiveLanguageCode}`);
    return out;
  }

  async function synthesizeTTSViaGoogleSync(text, langCode) {
    const startMs = Date.now();
    const client = getGoogleTtsClient();
    const bcp47 = toBcp47(langCode);
    const voiceName = googleTtsVoiceForLang(bcp47);
    const effectiveLanguageCode = inferLanguageCodeFromVoiceName(voiceName, bcp47);
    const sampleRate = Number(env('GOOGLE_TTS_SAMPLE_RATE', '24000'));
    const [response] = await client.synthesizeSpeech({
      input: { text },
      voice: { languageCode: effectiveLanguageCode, name: voiceName },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: sampleRate },
    });
    const out = Buffer.from(response.audioContent);
    logInfo(`Google TTS (sync fallback) elapsed_ms=${elapsedMs(startMs)} bytes=${out.length} voice=${voiceName} lang=${effectiveLanguageCode}`);
    return out;
  }

  async function synthesizeTTS(text, langCode, opts = {}) {
    const provider = env('TTS_PROVIDER', 'google').toLowerCase();
    if (provider === 'google') {
      try {
        return await synthesizeTTSViaGoogle(text, langCode, opts);
      } catch (err) {
        const allowSyncFallback = env('GOOGLE_TTS_STREAM_FALLBACK_TO_SYNC', 'true').toLowerCase() === 'true';
        if (allowSyncFallback) {
          logError(`Google streaming TTS failed, fallback to sync: ${err.message}`);
          return synthesizeTTSViaGoogleSync(text, langCode);
        }
        throw err;
      }
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
    const timeoutMs = Number(env('VACHANA_TTS_REST_TIMEOUT_MS', '120000'));

    let lastError = 'unknown';
    for (const endpoint of endpoints) {
      const url = buildUrl(endpoint);
      try {
        const response = await fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': apiKey },
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
        }, timeoutMs);
        if (!response.ok) {
          const body = await response.text();
          lastError = `status=${response.status} endpoint=${url} body=${body.slice(0, 200)}`;
          continue;
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (err) {
        lastError = err.message;
      }
    }
    throw new Error(`TTS failed for all endpoints: ${lastError}`);
  }

  function splitTextForSequentialTts(text) {
    const maxChars = Math.max(48, Number(env('VACHANA_TTS_MAX_CHARS_PER_CHUNK', '120')));
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    if (t.length <= maxChars) return [t];
    const parts = t.split(/(?<=[.!?…।])\s+/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    let buf = '';
    for (const p of parts) {
      const candidate = buf ? `${buf} ${p}`.trim() : p;
      if (candidate.length <= maxChars) buf = candidate;
      else {
        if (buf) chunks.push(buf.trim());
        buf = p;
      }
    }
    if (buf) chunks.push(buf.trim());
    return chunks;
  }

  async function synthesizeRestTtsSequentialToRenderer(
    translatedText,
    event,
    playbackChannel = 'meeting',
    ttsLangCode = '',
    segmentId = null,
    hooks = {}
  ) {
    const parts = splitTextForSequentialTts(translatedText);
    const ttsProvider = env('TTS_PROVIDER', 'google').toLowerCase();
    const streamGooglePcm = ttsProvider === 'google' && env('GOOGLE_TTS_STREAM_TO_RENDERER', 'true').toLowerCase() === 'true';
    const sampleRate = Number(env('GOOGLE_TTS_SAMPLE_RATE', '24000'));

    let totalBytes = 0;
    let emittedChunkCount = 0;
    let totalPcmBytes = 0;
    for (let i = 0; i < parts.length; i += 1) {
      if (streamGooglePcm) {
        const before = emittedChunkCount;
        const audioBuffer = await synthesizeTTS(parts[i], ttsLangCode, {
          onPcmChunk: (pcmChunk) => {
            emittedChunkCount += 1;
            totalPcmBytes += pcmChunk.length;
            event.sender.send('translated-audio-chunk', {
              audioBase64: pcmChunk.toString('base64'),
              sampleRate,
              numChannels: 1,
              sampleWidth: 2,
              channel: playbackChannel,
            });
            if (typeof hooks.onChunk === 'function') {
              hooks.onChunk({
                audioBase64: pcmChunk.toString('base64'),
                sampleRate,
                numChannels: 1,
                sampleWidth: 2,
                channel: playbackChannel,
              });
            }
          },
        });
        totalBytes += audioBuffer.length;
        if (before === emittedChunkCount) {
          event.sender.send('translated-audio', {
            mimeType: 'audio/wav',
            audioBase64: audioBuffer.toString('base64'),
            channel: playbackChannel,
          });
          if (typeof hooks.onAudio === 'function') {
            hooks.onAudio({
              mimeType: 'audio/wav',
              audioBase64: audioBuffer.toString('base64'),
              channel: playbackChannel,
            });
          }
        }
      } else {
        const audioBuffer = await synthesizeTTS(parts[i], ttsLangCode, {});
        totalBytes += audioBuffer.length;
        event.sender.send('translated-audio', {
          mimeType: 'audio/wav',
          audioBase64: audioBuffer.toString('base64'),
          channel: playbackChannel,
        });
        if (typeof hooks.onAudio === 'function') {
          hooks.onAudio({
            mimeType: 'audio/wav',
            audioBase64: audioBuffer.toString('base64'),
            channel: playbackChannel,
          });
        }
      }
    }
    if (streamGooglePcm) {
      const donePayload = {
        segmentId: segmentId || undefined,
        chunkCount: emittedChunkCount,
        byteCount: totalPcmBytes,
        channel: playbackChannel,
      };
      event.sender.send('translated-audio-done', donePayload);
      if (typeof hooks.onDone === 'function') hooks.onDone(donePayload);
    }
    return totalBytes;
  }

  function streamTTSRealtime({ endpoint, apiKey, text, model, sampleRate, container, voice, onChunk }) {
    return new Promise((resolve, reject) => {
      const url = String(endpoint || '').trim();
      if (!url) return reject(new Error('Realtime TTS endpoint missing'));
      const ws = new WebSocket(url, {
        headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': apiKey },
      });
      let chunkCount = 0;
      let byteCount = 0;
      let closed = false;
      let opened = false;
      const timeoutMs = Number(env('VACHANA_TTS_REALTIME_TIMEOUT_MS', '20000'));
      const timer = setTimeout(() => {
        if (!closed) {
          try { ws.close(); } catch (_e) {}
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
          if (typeof onChunk === 'function') onChunk(chunk);
          return;
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        closed = true;
        reject(error);
      });

      ws.on('close', () => {
        clearTimeout(timer);
        if (closed) return;
        closed = true;
        if (!opened) return reject(new Error('Realtime TTS websocket closed before open'));
        resolve({ chunkCount, byteCount });
      });
    });
  }

  return {
    toBcp47,
    synthesizeTTS,
    synthesizeRestTtsSequentialToRenderer,
    streamTTSRealtime,
  };
}

module.exports = {
  createTtsService,
};
