function normalizeSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function deterministicCleanup(inputText) {
  let text = normalizeSpaces(inputText);
  if (!text) return '';
  text = text.replace(/[’]/g, "'");
  text = text.replace(/(^|\s)(um+|uh+|erm+|hmm+)(\s|$)/gi, ' ');
  text = normalizeSpaces(text);
  text = text.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
  text = text.replace(/\bi\b/g, 'I');
  text = text.replace(/\bim\b/gi, "I'm");
  text = text.replace(/\bive\b/gi, "I've");
  text = text.replace(/\bill\b/gi, "I'll");
  text = text.replace(/\bid\b/gi, "I'd");
  text = text.replace(/\byoure\b/gi, "you're");
  text = text.replace(/\bwere\b/gi, "we're");
  text = text.replace(/\btheyre\b/gi, "they're");
  text = text.replace(/\bthats\b/gi, "that's");
  text = text.replace(/\bwhats\b/gi, "what's");
  text = text.replace(/\bdont\b/gi, "don't");
  text = text.replace(/\bcant\b/gi, "can't");
  text = text.replace(/\bwont\b/gi, "won't");
  text = text.replace(/\s+([,.;!?])/g, '$1');
  text = text.replace(/([,.;!?])([^\s])/g, '$1 $2');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  const isQuestion = /^(who|what|when|where|why|how|can|could|would|should|is|are|do|does|did)\b/i.test(text);
  if (!/[.!?]$/.test(text)) text = `${text}${isQuestion ? '?' : '.'}`;
  return text;
}

function createCleanupService({
  env,
  logInfo,
  logError,
  fetchWithTimeout,
}) {
  async function cleanupWithLlm(rawText, contextLines, languageHint) {
    const endpoint = env('STT_CLEANUP_LLM_ENDPOINT', 'https://api.openai.com/v1/chat/completions');
    const apiKey = env('STT_CLEANUP_LLM_API_KEY', '');
    const model = env('STT_CLEANUP_LLM_MODEL', 'gpt-4o-mini');
    if (!apiKey) return '';

    const contextBlock = (contextLines || []).map((line, idx) => `${idx + 1}. ${line}`).join('\n');
    const body = {
      model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You clean up real-time speech-to-text transcripts. Keep meaning unchanged. ' +
            'Fix punctuation, casing, spacing, obvious ASR errors, and filler words. ' +
            'Return only the final cleaned sentence, no explanation.',
        },
        {
          role: 'user',
          content:
            `Language hint: ${languageHint || 'unknown'}\n` +
            `Recent context:\n${contextBlock || '(none)'}\n\n` +
            `Current text:\n${rawText}`,
        },
      ],
    };
    const timeoutMs = Number(env('STT_CLEANUP_TIMEOUT_MS', '2500'));
    const resp = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }, timeoutMs);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`LLM cleanup failed (${resp.status}): ${errBody.slice(0, 160)}`);
    }
    const json = await resp.json();
    const cleaned = String(json?.choices?.[0]?.message?.content || '').trim();
    return cleaned;
  }

  async function cleanupTranscriptText({
    text,
    languageHint,
    recentContextLines,
  }) {
    const raw = normalizeSpaces(text);
    if (!raw) return '';

    const deterministic = deterministicCleanup(raw);
    const useLlm = env('STT_CLEANUP_USE_LLM', 'false').toLowerCase() === 'true';
    if (!useLlm) return deterministic;

    try {
      const llmCleaned = await cleanupWithLlm(raw, recentContextLines, languageHint);
      const normalized = normalizeSpaces(llmCleaned);
      if (!normalized) return deterministic;
      logInfo(`STT cleanup via LLM success len=${normalized.length}`);
      return normalized;
    } catch (err) {
      logError(`STT cleanup via LLM failed, using deterministic: ${err.message}`);
      return deterministic;
    }
  }

  return {
    cleanupTranscriptText,
  };
}

module.exports = {
  createCleanupService,
};
