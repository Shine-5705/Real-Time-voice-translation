function createTtsQueueService({
  env,
  logInfo,
  logError,
  elapsedMs,
  synthesizeRestTtsSequentialToRenderer,
  streamTTSRealtime,
  writeEvent,
  writePipelineRow,
  sendStatus,
  getState,
  onTtsChunk,
  onTtsAudio,
  onTtsDone,
}) {
  const ttsJobQueue = [];
  let ttsWorkerActive = false;

  function enqueueTtsJob(job) {
    ttsJobQueue.push(job);
    processTtsJobQueue().catch((error) => {
      logError(`TTS QUEUE ERROR: ${error.message}`);
    });
  }

  async function processTtsJobQueue() {
    if (ttsWorkerActive) return;
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
        const googleStreamToRenderer = ttsProvider === 'google' && env('GOOGLE_TTS_STREAM_TO_RENDERER', 'true').toLowerCase() === 'true';
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
                const payload = {
                  audioBase64: chunk.toString('base64'),
                  sampleRate,
                  numChannels: Number(env('VACHANA_TTS_NUM_CHANNELS', '1')),
                  sampleWidth: Number(env('VACHANA_TTS_SAMPLE_WIDTH', '2')),
                  channel: playbackChannel,
                };
                event.sender.send('translated-audio-chunk', payload);
                if (typeof onTtsChunk === 'function') onTtsChunk(payload);
              },
            });
            const donePayload = {
              segmentId,
              chunkCount: stats.chunkCount,
              byteCount: stats.byteCount,
              channel: playbackChannel,
            };
            event.sender.send('translated-audio-done', donePayload);
            if (typeof onTtsDone === 'function') onTtsDone(donePayload);
            writeEvent('segment_tts', { segment_id: segmentId, audio_bytes: stats.byteCount, chunk_count: stats.chunkCount, mode: 'realtime-ws' });
          } catch (wsError) {
            const restFallbackEnabled = env('ENABLE_TTS_REST_FALLBACK_ON_WS_ERROR', 'true').toLowerCase() === 'true';
            if (!restFallbackEnabled) throw wsError;
            logError(`TTS realtime failed; using REST fallback: ${wsError.message}`);
            const audioBytes = await synthesizeRestTtsSequentialToRenderer(
              translatedText,
              event,
              playbackChannel,
              ttsLangCode,
              segmentId,
              {
                onChunk: onTtsChunk,
                onAudio: onTtsAudio,
                onDone: onTtsDone,
              }
            );
            if (!googleStreamToRenderer && typeof onTtsDone === 'function') {
              onTtsDone({ segmentId, byteCount: audioBytes, chunkCount: 0, channel: playbackChannel });
            }
            writeEvent('segment_tts', { segment_id: segmentId, audio_bytes: audioBytes, mode: 'rest-fallback', realtime_error: wsError.message });
          }
        } else {
          const ttsMode = ttsProvider === 'google' ? 'google-tts' : 'rest';
          const audioBytes = await synthesizeRestTtsSequentialToRenderer(
            translatedText,
            event,
            playbackChannel,
            ttsLangCode,
            segmentId,
            {
              onChunk: onTtsChunk,
              onAudio: onTtsAudio,
              onDone: onTtsDone,
            }
          );
          if (!googleStreamToRenderer && typeof onTtsDone === 'function') {
            onTtsDone({ segmentId, byteCount: audioBytes, chunkCount: 0, channel: playbackChannel });
          }
          writeEvent('segment_tts', { segment_id: segmentId, audio_bytes: audioBytes, mode: ttsMode });
        }

        logInfo(
          `LATENCY seg=${segmentId} total_ms=${elapsedMs(segmentStartMs)} `
          + `translate_ms=${Number(translateElapsedMs || 0)} tts_queue_wait_ms=${Math.max(0, ttsQueueWaitMs)} `
          + `tts_ms=${elapsedMs(ttsStartMs)} mode=rest`
        );
        writePipelineRow({
          segmentId, spokeAtMs: segmentStartMs, sttMs: sttElapsedMs, translateMs: translateElapsedMs,
          ttsMs: elapsedMs(ttsStartMs), totalMs: elapsedMs(segmentStartMs), sourceText, translatedText,
        });
      } catch (error) {
        logError(`PIPELINE ERROR (tts): ${error.message}`);
        sendStatus(event, getState().translationRunning, `Pipeline error: ${error.message}`);
      }
    }
    ttsWorkerActive = false;
  }

  return {
    enqueueTtsJob,
    processTtsJobQueue,
    getQueue: () => ttsJobQueue,
  };
}

module.exports = {
  createTtsQueueService,
};
