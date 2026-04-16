function createTranslator({
  env,
  logInfo,
  logError,
  elapsedMs,
  fetchWithTimeout,
  buildUrl,
  candidateEndpoints,
  parseTranslationText,
  normalizeLangCode,
  getGoogleTranslateClient,
}) {
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

  return {
    translateViaPublicFallback,
    translateViaGoogle,
    translateText,
  };
}

module.exports = {
  createTranslator,
};
