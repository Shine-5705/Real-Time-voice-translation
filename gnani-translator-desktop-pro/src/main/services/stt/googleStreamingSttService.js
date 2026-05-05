/**
 * Google Cloud Speech streaming STT service with:
 *  - Interim results for live display
 *  - Speculative early translation on stable interims
 *  - Automatic stream recycling (hard limit ~305s / ~10 MB per stream)
 */

function createGoogleStreamingSttService({
  env,
  logInfo,
  logError,
  sendStatus,
  enqueueTranscript,
  enqueueTranscriptIncoming,
  sendInterimTranscript,
  sendInterimTranscriptIncoming,
  speculateTranslation,
  speculateTranslationIncoming,
  getGoogleSpeechClient,
  toBcp47,
  getState,
  setStreams,
}) {
  let recycleTimerOutgoing = null;
  let recycleTimerIncoming = null;

  // Interim stability tracking — when the same interim persists for
  // SPECULATE_STABLE_MS we fire speculative translation.
  let lastInterimOutgoing = '';
  let lastInterimOutgoingTs = 0;
  let speculatedOutgoing = '';
  let lastInterimIncoming = '';
  let lastInterimIncomingTs = 0;
  let speculatedIncoming = '';
  let stabilityTimerOutgoing = null;
  let stabilityTimerIncoming = null;
  let committedOutgoing = '';
  let committedIncoming = '';
  let lastCommitOutgoingTs = 0;
  let lastCommitIncomingTs = 0;

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

  function extractInterimTranscript(response) {
    const parts = [];
    const results = Array.isArray(response && response.results) ? response.results : [];
    for (const result of results) {
      if (!result || result.isFinal) continue;
      const alt = Array.isArray(result.alternatives) ? result.alternatives[0] : null;
      const text = String((alt && alt.transcript) || '').trim();
      if (text) parts.push(text);
    }
    return parts.join(' ').trim();
  }

  function extractFinalTranscript(response) {
    const parts = [];
    const results = Array.isArray(response && response.results) ? response.results : [];
    for (const result of results) {
      if (!result || !result.isFinal) continue;
      const alt = Array.isArray(result.alternatives) ? result.alternatives[0] : null;
      const text = String((alt && alt.transcript) || '').trim();
      if (text) parts.push(text);
    }
    return parts.join(' ').trim();
  }

  function createStreamRequest(languageCode) {
    const sampleRate = Number(env('VACHANA_STT_SAMPLE_RATE', '16000'));
    // latest_long required for continuous multi-utterance streaming;
    // latest_short silently stops after first utterance.
    const model = env('GOOGLE_STT_STREAM_MODEL', 'latest_long');
    return {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: sampleRate,
        languageCode,
        enableAutomaticPunctuation: true,
        model,
        useEnhanced: true,
      },
      interimResults: true,
      singleUtterance: false,
    };
  }

  function attachAudioWriteDebug(stream, label) {
    const originalWrite = stream.write.bind(stream);
    let sentFrames = 0;
    let sentBytes = 0;
    let lastLogTs = Date.now();
    stream.write = (chunk, ...args) => {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk || '');
      sentFrames += 1;
      sentBytes += size;
      const now = Date.now();
      if (now - lastLogTs >= 5000) {
        logInfo(`Google STT ${label} audio write frames=${sentFrames} bytes=${sentBytes}`);
        lastLogTs = now;
      }
      return originalWrite(chunk, ...args);
    };
  }

  /* ─── Interim stability → speculative translation ────────────────────── */

  function checkStability(direction, text, language) {
    const stableMs = Number(env('GOOGLE_STT_SPECULATE_STABLE_MS', '400'));
    if (stableMs <= 0) return;

    if (direction === 'outgoing') {
      if (text === lastInterimOutgoing) return; // already tracking
      lastInterimOutgoing = text;
      lastInterimOutgoingTs = Date.now();
      if (stabilityTimerOutgoing) clearTimeout(stabilityTimerOutgoing);
      stabilityTimerOutgoing = setTimeout(() => {
        if (text === lastInterimOutgoing && text !== speculatedOutgoing && text.length > 0) {
          speculatedOutgoing = text;
          logInfo(`[Google STT outgoing] Stable interim → speculative translate len=${text.length}`);
          if (typeof speculateTranslation === 'function') {
            speculateTranslation(text, language);
          }
        }
      }, stableMs);
    } else {
      if (text === lastInterimIncoming) return;
      lastInterimIncoming = text;
      lastInterimIncomingTs = Date.now();
      if (stabilityTimerIncoming) clearTimeout(stabilityTimerIncoming);
      stabilityTimerIncoming = setTimeout(() => {
        if (text === lastInterimIncoming && text !== speculatedIncoming && text.length > 0) {
          speculatedIncoming = text;
          logInfo(`[Google STT incoming] Stable interim → speculative translate len=${text.length}`);
          if (typeof speculateTranslationIncoming === 'function') {
            speculateTranslationIncoming(text, language);
          }
        }
      }, stableMs);
    }
  }

  function resetInterimState(direction) {
    if (direction === 'outgoing') {
      lastInterimOutgoing = '';
      speculatedOutgoing = '';
      committedOutgoing = '';
      lastCommitOutgoingTs = 0;
      if (stabilityTimerOutgoing) { clearTimeout(stabilityTimerOutgoing); stabilityTimerOutgoing = null; }
    } else {
      lastInterimIncoming = '';
      speculatedIncoming = '';
      committedIncoming = '';
      lastCommitIncomingTs = 0;
      if (stabilityTimerIncoming) { clearTimeout(stabilityTimerIncoming); stabilityTimerIncoming = null; }
    }
  }

  /* ─── Stream creation ────────────────────────────────────────────────── */

  function createOutgoingStream(event, sourceLanguage) {
    const client = getGoogleSpeechClient();
    const languageCode = toBcp47(sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN'));
    const request = createStreamRequest(languageCode);

    const stream = client.streamingRecognize(request);
    attachAudioWriteDebug(stream, 'outgoing');
    setStreams({ sttGoogleStream: stream });

    const interimThrottleMs = Number(env('GOOGLE_STT_INTERIM_THROTTLE_MS', '150'));
    let lastInterimSentTs = 0;

    stream.on('data', (response) => {
      // Final transcript → enqueue for translate + TTS pipeline
      const text = extractFinalTranscript(response);
      if (text) {
        logInfo(`Google STT final transcript len=${text.length}`);
        const deltaFinal = deltaAfterCommonPrefix(committedOutgoing, text);
        resetInterimState('outgoing');
        if (!deltaFinal) {
          if (typeof sendInterimTranscript === 'function') {
            sendInterimTranscript(event, { text: '', final: true });
          }
          return;
        }
        enqueueTranscript(event, {
          type: 'transcript',
          text: deltaFinal,
          detected_language: sourceLanguage,
          latency: 'google-stream',
        });
        if (typeof sendInterimTranscript === 'function') {
          sendInterimTranscript(event, { text: '', final: true });
        }
        return;
      }

      // Interim transcript → live display + stability check for speculation
      const interim = extractInterimTranscript(response);
      if (!interim) return;

      checkStability('outgoing', interim, sourceLanguage);

      const now = Date.now();
      const deltaInterim = deltaAfterCommonPrefix(committedOutgoing, interim);
      if (shouldCommitInterim(now, deltaInterim, lastCommitOutgoingTs)) {
        committedOutgoing = interim;
        lastCommitOutgoingTs = now;
        enqueueTranscript(event, {
          type: 'transcript',
          text: deltaInterim,
          detected_language: sourceLanguage,
          latency: 'google-stream-interim',
        });
      }
      if (now - lastInterimSentTs >= interimThrottleMs) {
        lastInterimSentTs = now;
        if (typeof sendInterimTranscript === 'function') {
          sendInterimTranscript(event, {
            text: interim,
            final: false,
            direction: 'outgoing',
          });
        }
      }
    });

    stream.on('error', (error) => {
      logError(`GOOGLE STREAM STT ERROR: ${error.message}`);
      if (getState().translationRunning) {
        sendStatus(event, true, `STT error: ${error.message}`);
      }
    });

    stream.on('close', () => {
      if (getState().translationRunning && !recycleTimerOutgoing) {
        sendStatus(event, false, 'STT disconnected. Click Start again.');
      }
    });

    return stream;
  }

  function createIncomingStream(event, targetLanguage) {
    const client = getGoogleSpeechClient();
    const languageCode = toBcp47(targetLanguage || env('VACHANA_DEFAULT_TARGET_LANGUAGE', 'hi-IN'));
    const request = createStreamRequest(languageCode);

    const stream = client.streamingRecognize(request);
    attachAudioWriteDebug(stream, 'incoming');
    setStreams({ sttGoogleStreamReturn: stream });

    const interimThrottleMs = Number(env('GOOGLE_STT_INTERIM_THROTTLE_MS', '150'));
    let lastInterimSentTs = 0;

    stream.on('data', (response) => {
      const text = extractFinalTranscript(response);
      if (text) {
        logInfo(`Google STT return final transcript len=${text.length}`);
        const deltaFinal = deltaAfterCommonPrefix(committedIncoming, text);
        resetInterimState('incoming');
        if (!deltaFinal) {
          if (typeof sendInterimTranscriptIncoming === 'function') {
            sendInterimTranscriptIncoming(event, { text: '', final: true });
          }
          return;
        }
        enqueueTranscriptIncoming(event, {
          type: 'transcript',
          text: deltaFinal,
          detected_language: targetLanguage,
          latency: 'google-stream-return',
        });
        if (typeof sendInterimTranscriptIncoming === 'function') {
          sendInterimTranscriptIncoming(event, { text: '', final: true });
        }
        return;
      }

      const interim = extractInterimTranscript(response);
      if (!interim) return;

      checkStability('incoming', interim, targetLanguage);

      const now = Date.now();
      const deltaInterim = deltaAfterCommonPrefix(committedIncoming, interim);
      if (shouldCommitInterim(now, deltaInterim, lastCommitIncomingTs)) {
        committedIncoming = interim;
        lastCommitIncomingTs = now;
        enqueueTranscriptIncoming(event, {
          type: 'transcript',
          text: deltaInterim,
          detected_language: targetLanguage,
          latency: 'google-stream-return-interim',
        });
      }
      if (now - lastInterimSentTs >= interimThrottleMs) {
        lastInterimSentTs = now;
        if (typeof sendInterimTranscriptIncoming === 'function') {
          sendInterimTranscriptIncoming(event, {
            text: interim,
            final: false,
            direction: 'incoming',
          });
        }
      }
    });

    stream.on('error', (error) => {
      logError(`GOOGLE STREAM RETURN STT ERROR: ${error.message}`);
    });

    stream.on('close', () => {
      const state = getState();
      if (state.translationRunning && state.activeConfig?.bidirectional && !recycleTimerIncoming) {
        logError('Google return STT stream disconnected (team-audio path).');
      }
    });

    return stream;
  }

  /* ─── Stream recycling ───────────────────────────────────────────────── */

  function startRecycleTimer(direction, event, language) {
    const recycleMs = Number(env('GOOGLE_STT_STREAM_RECYCLE_MS', '60000'));
    if (recycleMs <= 0) return;

    const label = direction === 'outgoing' ? 'outgoing' : 'incoming';
    const timer = setInterval(() => {
      if (!getState().translationRunning) return;

      logInfo(`[Google STT ${label}] Recycling stream (every ${recycleMs}ms)`);
      if (direction === 'outgoing') {
        const old = getState().sttGoogleStream;
        if (old && !old.destroyed) {
          try { old.destroy(); } catch (_e) {}
        }
        createOutgoingStream(event, language);
      } else {
        const old = getState().sttGoogleStreamReturn;
        if (old && !old.destroyed) {
          try { old.destroy(); } catch (_e) {}
        }
        createIncomingStream(event, language);
      }
    }, recycleMs);

    if (direction === 'outgoing') {
      recycleTimerOutgoing = timer;
    } else {
      recycleTimerIncoming = timer;
    }
  }

  /* ─── Public API ─────────────────────────────────────────────────────── */

  function connectSTT(event, sourceLanguage) {
    return new Promise((resolve, reject) => {
      try {
        const languageCode = toBcp47(sourceLanguage || env('VACHANA_DEFAULT_SOURCE_LANGUAGE', 'en-IN'));
        logInfo(`Connecting Google streaming STT (outgoing, ${languageCode}) interimResults=true`);
        createOutgoingStream(event, sourceLanguage);
        startRecycleTimer('outgoing', event, sourceLanguage);
        sendStatus(event, true, 'Connected to STT. Speak now.');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  function connectSTTReturn(event, targetLanguage) {
    return new Promise((resolve, reject) => {
      try {
        const languageCode = toBcp47(targetLanguage || env('VACHANA_DEFAULT_TARGET_LANGUAGE', 'hi-IN'));
        logInfo(`Connecting Google streaming STT (incoming, ${languageCode}) interimResults=true`);
        createIncomingStream(event, targetLanguage);
        startRecycleTimer('incoming', event, targetLanguage);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  function stopRecycleTimers() {
    if (recycleTimerOutgoing) { clearInterval(recycleTimerOutgoing); recycleTimerOutgoing = null; }
    if (recycleTimerIncoming) { clearInterval(recycleTimerIncoming); recycleTimerIncoming = null; }
    resetInterimState('outgoing');
    resetInterimState('incoming');
  }

  return {
    connectSTT,
    connectSTTReturn,
    stopRecycleTimers,
  };
}

module.exports = {
  createGoogleStreamingSttService,
};
