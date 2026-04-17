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
  const translationCache = new Map();

  function cacheKey(text, sourceLanguage, targetLanguage) {
    return `${normalizeLangCode(sourceLanguage)}::${normalizeLangCode(targetLanguage)}::${String(text || '').trim().toLowerCase()}`;
  }

  function getCachedTranslation(text, sourceLanguage, targetLanguage) {
    const ttlMs = Number(env('TRANSLATE_CACHE_TTL_MS', '60000'));
    if (ttlMs <= 0) return '';
    const key = cacheKey(text, sourceLanguage, targetLanguage);
    const hit = translationCache.get(key);
    if (!hit) return '';
    if (Date.now() - Number(hit.ts || 0) > ttlMs) {
      translationCache.delete(key);
      return '';
    }
    return String(hit.value || '');
  }

  function setCachedTranslation(text, sourceLanguage, targetLanguage, translated) {
    const ttlMs = Number(env('TRANSLATE_CACHE_TTL_MS', '60000'));
    if (ttlMs <= 0) return;
    const key = cacheKey(text, sourceLanguage, targetLanguage);
    translationCache.set(key, { ts: Date.now(), value: translated });
    const maxEntries = Number(env('TRANSLATE_CACHE_MAX_ENTRIES', '500'));
    if (translationCache.size > maxEntries) {
      const first = translationCache.keys().next();
      if (!first.done) translationCache.delete(first.value);
    }
  }

  async function withTimeout(promise, timeoutMs, label) {
    const timeout = Number(timeoutMs || 0);
    if (!timeout || timeout <= 0) return promise;
    let timer = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeout}ms`)), timeout);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async function hedgedGoogleTranslate(text, sourceLanguage, targetLanguage) {
    const fallbackEnabled = env('ENABLE_PUBLIC_TRANSLATE_FALLBACK', 'true').toLowerCase() === 'true';
    const hedgeEnabled = env('ENABLE_TRANSLATE_HEDGED_FALLBACK', 'true').toLowerCase() === 'true';
    const googleTimeoutMs = Number(env('GOOGLE_TRANSLATE_TIMEOUT_MS', '1800'));
    if (!fallbackEnabled || !hedgeEnabled) {
      return withTimeout(
        translateViaGoogle(text, sourceLanguage, targetLanguage),
        googleTimeoutMs,
        'Google Translate'
      );
    }

    const hedgeDelayMs = Number(env('TRANSLATE_HEDGE_DELAY_MS', '350'));
    const googlePromise = withTimeout(
      translateViaGoogle(text, sourceLanguage, targetLanguage),
      googleTimeoutMs,
      'Google Translate'
    );
    const fallbackPromise = new Promise((resolve, reject) => {
      setTimeout(() => {
        translateViaPublicFallback(text, sourceLanguage, targetLanguage).then(resolve).catch(reject);
      }, Math.max(0, hedgeDelayMs));
    });

    const winner = await Promise.any([googlePromise, fallbackPromise]);
    return String(winner || '').trim();
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
    const cached = getCachedTranslation(text, sourceLanguage, targetLanguage);
    if (cached) {
      logInfo(`Translate cache hit len=${cached.length}`);
      return cached;
    }

    if (provider === 'google') {
      try {
        const translated = await hedgedGoogleTranslate(text, sourceLanguage, targetLanguage);
        if (translated) setCachedTranslation(text, sourceLanguage, targetLanguage, translated);
        return translated;
      } catch (err) {
        logError(`Google Translate error: ${err.message}`);
        logInfo('Google Translate failed. Trying public fallback.');
        const translated = await translateViaPublicFallback(text, sourceLanguage, targetLanguage);
        if (translated) setCachedTranslation(text, sourceLanguage, targetLanguage, translated);
        return translated;
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
          setCachedTranslation(text, sourceLanguage, targetLanguage, translated);
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
    const translated = await translateViaPublicFallback(text, sourceLanguage, targetLanguage);
    if (translated) setCachedTranslation(text, sourceLanguage, targetLanguage, translated);
    return translated;
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
