function normalizeLangCode(langCode) {
  if (!langCode) return 'en';
  const lower = String(langCode).toLowerCase();
  if (lower === 'en-hi-in-latn') return 'hi';
  const parts = lower.split('-');
  return parts[0] || 'en';
}

function toVachanaLanguageCode(langCode) {
  const normalized = String(langCode || '').trim();
  if (!normalized) return 'en-IN';
  const lower = normalized.toLowerCase();
  if (lower.includes('-in') || lower === 'en-hi-in-latn') return normalized;

  const map = {
    en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', gu: 'gu-IN', kn: 'kn-IN',
    ml: 'ml-IN', mr: 'mr-IN', pa: 'pa-IN', ta: 'ta-IN', te: 'te-IN',
  };
  return map[lower] || normalized;
}

function sttRealtimeLangCode(sourceLanguage) {
  const lower = String(sourceLanguage || '').trim().toLowerCase();
  if (lower.includes('latn') || lower === 'en-hi-in-latn') return 'en-IN';
  return toVachanaLanguageCode(sourceLanguage);
}

function candidateEndpoints(csvValue, singleValue, defaults) {
  const out = [];
  const add = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    let normalized = trimmed;
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://') && !normalized.startsWith('/')) {
      normalized = `/${normalized}`;
    }
    if (!out.includes(normalized)) out.push(normalized);
  };

  let explicit = false;
  for (const part of String(csvValue || '').split(',')) {
    if (part.trim()) {
      explicit = true;
      add(part);
    }
  }
  if (String(singleValue || '').trim()) {
    explicit = true;
    add(singleValue);
  }
  if (!explicit) {
    for (const fallback of defaults) add(fallback);
  }
  return out;
}

function buildWavFromPcm16(pcmBytes, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBytes.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBytes.copy(buffer, 44);
  return buffer;
}

function parseTranslationText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return (
    payload.translation ||
    payload.translated_text ||
    payload.translatedText ||
    payload.text ||
    payload.output ||
    (payload.data && (payload.data.translated_text || payload.data.text)) ||
    ''
  );
}

module.exports = {
  normalizeLangCode,
  toVachanaLanguageCode,
  sttRealtimeLangCode,
  candidateEndpoints,
  buildWavFromPcm16,
  parseTranslationText,
};
