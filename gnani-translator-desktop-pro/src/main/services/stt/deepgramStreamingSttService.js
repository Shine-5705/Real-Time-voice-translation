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

  function splitWords(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean);
  }

  function deltaAfterCommonPrefix(previousText, currentText) {
    const prev = splitWords(previousText);
    const curr = splitWords(currentText);
    let i = 0;
    while (i < prev.length && i < curr.length && prev[i].toLowerCase() === curr[i].toLowerCase()) i += 1;
    return curr.slice(i).join(' ').trim();
  }

  function shouldCommitInterim(nowMs, deltaText, lastCommitTs) {
    const enabled = String(env('STT_INTERIM_COMMIT_ENABLED', 'true')).toLowerCase() === 'true';
    if (!enabled) return false;
    const minChars = Math.max(3, Number(env('STT_INTERIM_COMMIT_MIN_CHARS', '10')));
    const minNewChars = Math.max(2, Number(env('STT_INTERIM_COMMIT_MIN_NEW_CHARS', '6')));
    const throttleMs = Math.max(0, Number(env('STT_INTERIM_COMMIT_THROTTLE_MS', '220')));
    return deltaText.length >= minChars
      && deltaText.length >= minNewChars
      && (nowMs - lastCommitTs) >= throttleMs;
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
      let committedOutgoing = '';
      let lastCommitOutgoingTs = 0;

      socket.on('open', () => resolve());

      socket.on('message', (payload, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.type !== 'Results') return;
          const text = extractText(msg);
          if (!text) return;

          if (msg.is_final) {
            const deltaFinal = deltaAfterCommonPrefix(committedOutgoing, text);
            committedOutgoing = '';
            lastCommitOutgoingTs = 0;
            if (!deltaFinal) {
              if (typeof sendInterimTranscript === 'function') {
                sendInterimTranscript(event, { text: '', final: true, direction: 'outgoing' });
              }
              return;
            }
            enqueueTranscript(event, {
              type: 'transcript',
              text: deltaFinal,
              detected_language: sourceLanguage,
              latency: 'deepgram-stream',
            });
            if (typeof sendInterimTranscript === 'function') {
              sendInterimTranscript(event, { text: '', final: true, direction: 'outgoing' });
            }
            return;
          }

          const now = Date.now();
          const deltaInterim = deltaAfterCommonPrefix(committedOutgoing, text);
          if (shouldCommitInterim(now, deltaInterim, lastCommitOutgoingTs)) {
            committedOutgoing = text;
            lastCommitOutgoingTs = now;
            enqueueTranscript(event, {
              type: 'transcript',
              text: deltaInterim,
              detected_language: sourceLanguage,
              latency: 'deepgram-stream-interim',
            });
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
      let committedIncoming = '';
      let lastCommitIncomingTs = 0;

      socket.on('open', () => resolve());

      socket.on('message', (payload, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.type !== 'Results') return;
          const text = extractText(msg);
          if (!text) return;

          if (msg.is_final) {
            const deltaFinal = deltaAfterCommonPrefix(committedIncoming, text);
            committedIncoming = '';
            lastCommitIncomingTs = 0;
            if (!deltaFinal) {
              if (typeof sendInterimTranscriptIncoming === 'function') {
                sendInterimTranscriptIncoming(event, { text: '', final: true, direction: 'incoming' });
              }
              return;
            }
            enqueueTranscriptIncoming(event, {
              type: 'transcript',
              text: deltaFinal,
              detected_language: targetLanguage,
              latency: 'deepgram-stream-return',
            });
            if (typeof sendInterimTranscriptIncoming === 'function') {
              sendInterimTranscriptIncoming(event, { text: '', final: true, direction: 'incoming' });
            }
            return;
          }

          const now = Date.now();
          const deltaInterim = deltaAfterCommonPrefix(committedIncoming, text);
          if (shouldCommitInterim(now, deltaInterim, lastCommitIncomingTs)) {
            committedIncoming = text;
            lastCommitIncomingTs = now;
            enqueueTranscriptIncoming(event, {
              type: 'transcript',
              text: deltaInterim,
              detected_language: targetLanguage,
              latency: 'deepgram-stream-return-interim',
            });
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
