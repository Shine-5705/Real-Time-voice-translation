const WebSocket = require('ws');

function createDeepgramStreamingSttService({
  env,
  logInfo,
  logError,
  sendStatus,
  enqueueTranscript,
  enqueueTranscriptIncoming,
  sendInterimTranscript,
  sendInterimTranscriptIncoming,
  getState,
  setSockets,
}) {
  function toDeepgramLanguage(langCode) {
    const raw = String(langCode || '').trim();
    if (!raw) return 'en';
    const lower = raw.toLowerCase();
    if (lower === 'en-hi-in-latn' || lower === 'hinglish' || lower === 'tanglish') return 'en';
    return lower.split('-')[0] || 'en';
  }

  function buildDeepgramUrl(langCode) {
    const base = env('DEEPGRAM_STT_REALTIME_ENDPOINT', 'wss://api.deepgram.com/v1/listen').trim();
    const model = env('DEEPGRAM_STT_MODEL', 'nova-2').trim();
    const sampleRate = Number(env('VACHANA_STT_SAMPLE_RATE', '16000'));
    const language = toDeepgramLanguage(langCode);
    const params = new URLSearchParams({
      model,
      language,
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: env('DEEPGRAM_STT_ENDPOINTING_MS', '120'),
    });
    return `${base}?${params.toString()}`;
  }

  function extractText(msg) {
    const alt = msg && msg.channel && Array.isArray(msg.channel.alternatives)
      ? msg.channel.alternatives[0]
      : null;
    return String((alt && alt.transcript) || '').trim();
  }

  function connectSTT(event, sourceLanguage) {
    return new Promise((resolve, reject) => {
      const apiKey = env('DEEPGRAM_API_KEY', '').trim();
      if (!apiKey) return reject(new Error('DEEPGRAM_API_KEY missing in .env'));

      const wsUrl = buildDeepgramUrl(sourceLanguage);
      logInfo(`Connecting Deepgram streaming STT (outgoing) to ${wsUrl}`);
      const socket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      });
      setSockets({ sttSocket: socket });

      socket.on('open', () => resolve());

      socket.on('message', (payload, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.type !== 'Results') return;
          const text = extractText(msg);
          if (!text) return;

          if (msg.is_final) {
            enqueueTranscript(event, {
              type: 'transcript',
              text,
              detected_language: sourceLanguage,
              latency: 'deepgram-stream',
            });
            if (typeof sendInterimTranscript === 'function') {
              sendInterimTranscript(event, { text: '', final: true, direction: 'outgoing' });
            }
            return;
          }

          if (typeof sendInterimTranscript === 'function') {
            sendInterimTranscript(event, { text, final: false, direction: 'outgoing' });
          }
        } catch (error) {
          logError(`Deepgram outgoing parse error: ${error.message}`);
        }
      });

      socket.on('error', (error) => {
        logError(`DEEPGRAM OUTGOING STT ERROR: ${error.message}`);
        reject(error);
      });

      socket.on('close', () => {
        if (getState().translationRunning) {
          sendStatus(event, false, 'Deepgram STT disconnected. Click Start again.');
        }
      });
    });
  }

  function connectSTTReturn(event, targetLanguage) {
    return new Promise((resolve, reject) => {
      const apiKey = env('DEEPGRAM_API_KEY', '').trim();
      if (!apiKey) return reject(new Error('DEEPGRAM_API_KEY missing in .env'));

      const wsUrl = buildDeepgramUrl(targetLanguage);
      logInfo(`Connecting Deepgram streaming STT (incoming) to ${wsUrl}`);
      const socket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Token ${apiKey}`,
        },
      });
      setSockets({ sttSocketReturn: socket });

      socket.on('open', () => resolve());

      socket.on('message', (payload, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.type !== 'Results') return;
          const text = extractText(msg);
          if (!text) return;

          if (msg.is_final) {
            enqueueTranscriptIncoming(event, {
              type: 'transcript',
              text,
              detected_language: targetLanguage,
              latency: 'deepgram-stream-return',
            });
            if (typeof sendInterimTranscriptIncoming === 'function') {
              sendInterimTranscriptIncoming(event, { text: '', final: true, direction: 'incoming' });
            }
            return;
          }

          if (typeof sendInterimTranscriptIncoming === 'function') {
            sendInterimTranscriptIncoming(event, { text, final: false, direction: 'incoming' });
          }
        } catch (error) {
          logError(`Deepgram incoming parse error: ${error.message}`);
        }
      });

      socket.on('error', (error) => {
        logError(`DEEPGRAM INCOMING STT ERROR: ${error.message}`);
        reject(error);
      });

      socket.on('close', () => {
        const state = getState();
        if (state.translationRunning && state.activeConfig?.bidirectional) {
          logError('Deepgram return STT disconnected (team-audio path).');
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
  createDeepgramStreamingSttService,
};
