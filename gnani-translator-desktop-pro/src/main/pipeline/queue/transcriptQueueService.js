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
  appendConversationPair,
}) {
  let outgoingQueueProcessing = false;
  let incomingQueueProcessing = false;
  const outgoingQueue = [];
  const incomingQueue = [];

  async function processQueueItem(item) {
    const event = item.event;
    const segmentStartMs = Number(item.createdAtMs || Date.now());
    try {
      const isIncoming = item.direction === 'in';
      logInfo(isIncoming ? `STT-IN(${item.detectedLanguage}, ${item.latency}): ${item.text}` : `STT(${item.detectedLanguage}, ${item.latency}): ${item.text}`);
      event.sender.send('transcript', {
        segmentId: item.id,
        text: item.text,
        detectedLanguage: item.detectedLanguage,
        latency: item.latency,
        speakerId: item.speakerId || '',
        incoming: isIncoming,
      });

      const configuredSourceLanguage = item.activeConfig?.sourceLanguage;
      const configuredTargetLanguage = item.activeConfig?.targetLanguage;
      if (!configuredSourceLanguage || !configuredTargetLanguage) return;

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
      if (!translatedText || !translatedText.trim()) return;
      logInfo(isIncoming ? `TRANSLATED-IN(${sourceLanguage} -> ${targetLanguage}): ${translatedText}` : `TRANSLATED(${sourceLanguage} -> ${targetLanguage}): ${translatedText}`);
      appendTranslatedLine(item.id, isIncoming, sourceLanguage, targetLanguage, translatedText);
      if (typeof appendConversationPair === 'function') {
        appendConversationPair({
          segmentId: item.id,
          direction: isIncoming ? 'incoming' : 'outgoing',
          sourceText: item.text,
          translatedText,
        });
      }
      writeEvent('segment_translated', {
        segment_id: item.id,
        source_language: sourceLanguage,
        target_language: targetLanguage,
        source_text: item.text,
        translated_text: translatedText,
        direction: isIncoming ? 'incoming' : 'outgoing',
      });

      event.sender.send('transcript', {
        segmentId: item.id,
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

  async function processDirectionQueue(direction) {
    const isIncoming = direction === 'incoming';
    const queue = isIncoming ? incomingQueue : outgoingQueue;
    const processing = isIncoming ? incomingQueueProcessing : outgoingQueueProcessing;
    if (processing || queue.length === 0) return;

    if (isIncoming) incomingQueueProcessing = true;
    else outgoingQueueProcessing = true;

    try {
      while (queue.length > 0) {
        const item = queue.shift();
        await processQueueItem(item);
      }
    } finally {
      if (isIncoming) incomingQueueProcessing = false;
      else outgoingQueueProcessing = false;
      if (queue.length > 0) {
        processDirectionQueue(direction).catch((err) => logError(`QUEUE ERROR: ${err.message}`));
      }
    }
  }

  function push(item) {
    const isIncoming = item && item.direction === 'in';
    if (isIncoming) {
      incomingQueue.push(item);
      processDirectionQueue('incoming').catch((err) => logError(`QUEUE ERROR(incoming): ${err.message}`));
      return;
    }
    outgoingQueue.push(item);
    processDirectionQueue('outgoing').catch((err) => logError(`QUEUE ERROR(outgoing): ${err.message}`));
  }

  return {
    push,
    processTranscriptQueue: async () => Promise.all([processDirectionQueue('outgoing'), processDirectionQueue('incoming')]),
    getQueue: () => [...outgoingQueue, ...incomingQueue],
  };
}

module.exports = {
  createTranscriptQueueService,
};
