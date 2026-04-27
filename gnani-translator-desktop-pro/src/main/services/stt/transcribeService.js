const { buildWavFromPcm16 } = require('../common/pipelineUtils');

function createTranscribeService({
  env,
  logInfo,
  logError,
  elapsedMs,
  fetchWithTimeout,
  buildUrl,
  candidateEndpoints,
  getGoogleSpeechClient,
  toBcp47,
}) {
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
          headers: { 'X-API-Key-ID': apiKey },
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
          payload.transcript || payload.text || (data && (data.transcript || data.text)) || ''
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

  return {
    transcribeViaGoogle,
    transcribeViaRest,
  };
}

module.exports = {
  createTranscribeService,
};
