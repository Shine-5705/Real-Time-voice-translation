function createRestLoopSttService({
  env,
  logInfo,
  logError,
  elapsedMs,
  sendStatus,
  transcribeViaGoogle,
  transcribeViaRest,
}) {
  function startRestSttFallback({ state, setState, event, sourceLanguage, enqueueTranscript }) {
    setState({
      sttMode: 'rest',
      restAudioBuffer: [],
      restInFlight: false,
      restOverlapBuffer: Buffer.alloc(0),
    });

    if (state.restFlushTimer) clearInterval(state.restFlushTimer);

    const sttProvider = env('STT_PROVIDER', 'vachana').toLowerCase();
    const defaultMinBytes = sttProvider === 'google' ? '48000' : '32000';
    const defaultFlushMs = sttProvider === 'google' ? '2500' : '1500';
    const minBytesPerFlush = Number(env('VACHANA_STT_REST_MIN_BYTES', defaultMinBytes));
    const flushEveryMs = Number(env('VACHANA_STT_REST_FLUSH_MS', defaultFlushMs));
    const overlapMs = Number(env('VACHANA_STT_REST_OVERLAP_MS', '400'));
    const sampleRate = Number(env('VACHANA_STT_SAMPLE_RATE', '16000'));
    const overlapBytes = Math.max(0, Math.floor((overlapMs / 1000) * sampleRate * 2));

    const timer = setInterval(async () => {
      if (!state.translationRunning || state.sttMode !== 'rest' || state.restInFlight) return;
      const totalBytes = state.restAudioBuffer.reduce((sum, b) => sum + b.length, 0);
      if (totalBytes < minBytesPerFlush) return;

      const freshChunk = Buffer.concat(state.restAudioBuffer);
      const chunk = state.restOverlapBuffer.length > 0 ? Buffer.concat([state.restOverlapBuffer, freshChunk]) : freshChunk;
      state.restAudioBuffer = [];
      state.restOverlapBuffer = overlapBytes > 0 && chunk.length > overlapBytes
        ? chunk.subarray(chunk.length - overlapBytes)
        : chunk;
      state.restInFlight = true;

      try {
        const provider = env('STT_PROVIDER', 'vachana').toLowerCase();
        sendStatus(event, true, `${provider === 'google' ? 'Google' : 'REST'} STT processing...`);
        const transcribeFn = provider === 'google' ? transcribeViaGoogle : transcribeViaRest;
        const sttStartMs = Date.now();
        const { transcript: text, speakerId } = await transcribeFn(chunk, sourceLanguage);
        const sttElapsedMs = elapsedMs(sttStartMs);
        if (text && text.trim()) {
          enqueueTranscript(event, {
            type: 'transcript',
            text,
            detected_language: sourceLanguage,
            latency: provider === 'google' ? 'google-stt' : 'rest',
            speaker_id: speakerId || undefined,
            sttElapsedMs,
          });
        }
      } catch (error) {
        logError(`STT REST ERROR: ${error.message}`);
        sendStatus(event, true, `STT error: ${error.message}`);
      } finally {
        state.restInFlight = false;
      }
    }, flushEveryMs);

    state.restFlushTimer = timer;
    logInfo('STT mode switched to REST fallback');
    sendStatus(event, true, 'Realtime STT unavailable. Using REST STT fallback.');
  }

  function startRestSttReturnPath({ state, event, targetLanguage, enqueueTranscriptIncoming }) {
    state.restAudioBufferReturn = [];
    state.restInFlightReturn = false;
    state.restOverlapBufferReturn = Buffer.alloc(0);
    if (state.restFlushTimerReturn) clearInterval(state.restFlushTimerReturn);

    const sttProvider = env('STT_PROVIDER', 'vachana').toLowerCase();
    const minBytesPerFlush = Number(env('STT_RETURN_MIN_BYTES', '32000'));
    const flushEveryMs = Number(env('STT_RETURN_FLUSH_MS', '2000'));
    const overlapMs = Number(env('VACHANA_STT_REST_OVERLAP_MS', '400'));
    const sampleRate = Number(env('VACHANA_STT_SAMPLE_RATE', '16000'));
    const overlapBytes = Math.max(0, Math.floor((overlapMs / 1000) * sampleRate * 2));

    const timer = setInterval(async () => {
      if (!state.translationRunning || !state.activeConfig?.bidirectional || state.restInFlightReturn) return;
      const totalBytes = state.restAudioBufferReturn.reduce((sum, b) => sum + b.length, 0);
      if (totalBytes < minBytesPerFlush) return;

      const freshChunk = Buffer.concat(state.restAudioBufferReturn);
      const chunk = state.restOverlapBufferReturn.length > 0
        ? Buffer.concat([state.restOverlapBufferReturn, freshChunk])
        : freshChunk;
      state.restAudioBufferReturn = [];
      state.restOverlapBufferReturn = overlapBytes > 0 && chunk.length > overlapBytes
        ? chunk.subarray(chunk.length - overlapBytes)
        : chunk;
      state.restInFlightReturn = true;

      try {
        logInfo(`RETURN STT flush bytes=${chunk.length} lang=${targetLanguage}`);
        const transcribeFn = sttProvider === 'google' ? transcribeViaGoogle : transcribeViaRest;
        const sttStartMs = Date.now();
        const { transcript: text, speakerId } = await transcribeFn(chunk, targetLanguage);
        const sttElapsedMs = elapsedMs(sttStartMs);
        if (text && text.trim()) {
          enqueueTranscriptIncoming(event, {
            type: 'transcript',
            text,
            detected_language: targetLanguage,
            latency: sttProvider === 'google' ? 'google-stt-return' : 'rest-return',
            speaker_id: speakerId || undefined,
            sttElapsedMs,
          });
        }
      } catch (error) {
        logError(`STT RETURN REST ERROR: ${error.message}`);
      } finally {
        state.restInFlightReturn = false;
      }
    }, flushEveryMs);

    state.restFlushTimerReturn = timer;
    logInfo(`Return STT REST path started (${targetLanguage}) provider=${sttProvider}`);
  }

  return {
    startRestSttFallback,
    startRestSttReturnPath,
  };
}

module.exports = {
  createRestLoopSttService,
};
