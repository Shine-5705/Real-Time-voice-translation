function createTranscriptQueueService({
  env,
  logInfo,
  logError,
  elapsedMs,
  appendContextText,
  getContextHint,
  getContextHintReverse,
  toVachanaLanguageCode,
  translateText,
  enqueueTtsJob,
  writeEvent,
  appendTranslatedLine,
}) {
  let queueProcessing = false;
  const transcriptQueue = [];

  async function processTranscriptQueue() {
    if (queueProcessing || transcriptQueue.length === 0) return;
    queueProcessing = true;
    try {
      while (transcriptQueue.length > 0) {
        const item = transcriptQueue.shift();
        const event = item.event;
        const segmentStartMs = Number(item.createdAtMs || Date.now());
        try {
          const isIncoming = item.direction === 'in';
          logInfo(isIncoming ? `STT-IN(${item.detectedLanguage}, ${item.latency}): ${item.text}` : `STT(${item.detectedLanguage}, ${item.latency}): ${item.text}`);
          event.sender.send('transcript', {
            text: item.text,
            detectedLanguage: item.detectedLanguage,
            latency: item.latency,
            speakerId: item.speakerId || '',
            incoming: isIncoming,
          });

          const configuredSourceLanguage = item.activeConfig?.sourceLanguage;
          const configuredTargetLanguage = item.activeConfig?.targetLanguage;
          if (!configuredSourceLanguage || !configuredTargetLanguage) continue;

          const useDetected = env('USE_DETECTED_SOURCE_LANGUAGE', 'true').toLowerCase() === 'true';
          const sourceLanguage = isIncoming
            ? (useDetected ? toVachanaLanguageCode(item.detectedLanguage) : toVachanaLanguageCode(configuredTargetLanguage))
            : (useDetected ? toVachanaLanguageCode(item.detectedLanguage) : configuredSourceLanguage);
          const targetLanguage = isIncoming ? toVachanaLanguageCode(configuredSourceLanguage) : configuredTargetLanguage;
          const contextHint = isIncoming ? getContextHintReverse() : getContextHint();

          let translatedText = '';
          const translateStartMs = Date.now();
          try {
            translatedText = await translateText(item.text, sourceLanguage, targetLanguage, contextHint);
          } catch (error) {
            const fallbackToSource = env('FALLBACK_TO_SOURCE_TEXT_ON_TRANSLATE_ERROR', 'true').toLowerCase() === 'true';
            if (!fallbackToSource) throw error;
            logError(`TRANSLATE ERROR -> using source text fallback: ${error.message}`);
            translatedText = item.text;
          }

          const translateElapsedMs = elapsedMs(translateStartMs);
          if (!translatedText || !translatedText.trim()) continue;
          logInfo(isIncoming ? `TRANSLATED-IN(${sourceLanguage} -> ${targetLanguage}): ${translatedText}` : `TRANSLATED(${sourceLanguage} -> ${targetLanguage}): ${translatedText}`);
          appendTranslatedLine(item.id, isIncoming, sourceLanguage, targetLanguage, translatedText);
          writeEvent('segment_translated', {
            segment_id: item.id,
            source_language: sourceLanguage,
            target_language: targetLanguage,
            source_text: item.text,
            translated_text: translatedText,
            direction: isIncoming ? 'incoming' : 'outgoing',
          });

          event.sender.send('transcript', {
            text: translatedText,
            translated: true,
            sourceText: item.text,
            speakerId: item.speakerId || '',
            incoming: isIncoming,
          });
          appendContextText(isIncoming ? 'incoming' : 'outgoing', item.text, translatedText);
          enqueueTtsJob({
            segmentId: item.id,
            translatedText,
            sourceText: item.text,
            event,
            segmentStartMs,
            sttElapsedMs: item.sttElapsedMs || 0,
            translateElapsedMs,
            playbackChannel: isIncoming ? 'local' : 'meeting',
            ttsLangCode: targetLanguage,
          });
        } catch (error) {
          logError(`SEGMENT ERROR seg=${item.id}: ${error.message}`);
          writeEvent('segment_error', { segment_id: item.id, error: error.message, source_text: item.text });
        }
      }
    } finally {
      queueProcessing = false;
      if (transcriptQueue.length > 0) processTranscriptQueue().catch((err) => logError(`QUEUE ERROR: ${err.message}`));
    }
  }

  function push(item) {
    transcriptQueue.push(item);
    processTranscriptQueue().catch((err) => logError(`QUEUE ERROR: ${err.message}`));
  }

  return {
    push,
    processTranscriptQueue,
    getQueue: () => transcriptQueue,
  };
}

module.exports = {
  createTranscriptQueueService,
};
