/**
 * Indic-script language codes (ISO 639-1 roots).
 * Vachana STT is trained on these Indic languages.
 *
 * NOTE: English (en/en-IN) is NOT here — routed to Deepgram in auto mode.
 */
const INDIC_LANG_ROOTS = new Set([
  'hi',  // Hindi
  'bn',  // Bengali
  'gu',  // Gujarati
  'kn',  // Kannada
  'ml',  // Malayalam
  'mr',  // Marathi
  'pa',  // Punjabi
  'ta',  // Tamil
  'te',  // Telugu
  'as',  // Assamese
  'or',  // Odia
  'ur',  // Urdu
  'ks',  // Kashmiri
  'ne',  // Nepali
  'sa',  // Sanskrit
  'sd',  // Sindhi
  'mai', // Maithili
]);

/**
 * Returns true when the language is an Indic-script language (→ Vachana STT),
 * false for English and other foreign languages (→ Deepgram STT in auto mode).
 *
 * Rules:
 *   1. English is always false (en-IN, en-US, en-GB… all go to Deepgram in auto mode)
 *   2. Hinglish/Tanglish (code-mixed) → true (Vachana handles these)
 *   3. If the ISO 639 root is in INDIC_LANG_ROOTS → true
 *   4. If the BCP-47 tag ends with -IN and root isn't 'en' → true
 *   5. Otherwise → false (Deepgram in auto mode)
 */
function isIndicLanguage(langCode) {
  const lc = String(langCode || '').toLowerCase().trim();
  if (!lc) return false;
  const root = lc.split('-')[0];

  // English always goes to Google — Vachana WS doesn't return transcripts for en
  if (root === 'en') return false;

  // Code-mixed Indian English varieties → Vachana handles these
  if (lc === 'en-hi-in-latn' || lc === 'tanglish' || lc === 'hinglish') return true;

  // Indic language roots
  if (INDIC_LANG_ROOTS.has(root)) return true;

  // Any -IN tagged language that isn't English
  if (lc.includes('-in')) return true;

  return false;
}

/**
 * Resolve which STT provider to use for a given language.
 *
 * Priority order:
 *   1. STT_PROVIDER=google   → always google
 *   2. STT_PROVIDER=deepgram → always deepgram
 *   3. STT_PROVIDER=vachana  → always vachana
 *   3. STT_PROVIDER=auto (default):
 *      Indic languages (hi, bn, ta, te, …) → vachana
 *      English + foreign (en-IN, en-US, fr, de, …) → deepgram
 */
function sttProviderForLanguage(langCode, envFn) {
  const globalPref = String(envFn('STT_PROVIDER', 'auto')).toLowerCase();
  if (globalPref === 'google') return 'google';
  if (globalPref === 'deepgram') return 'deepgram';
  if (globalPref === 'vachana') return 'vachana';
  // auto mode
  return isIndicLanguage(langCode) ? 'vachana' : 'deepgram';
}

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
  isIndicLanguage,
  sttProviderForLanguage,
  normalizeLangCode,
  toVachanaLanguageCode,
  sttRealtimeLangCode,
  candidateEndpoints,
  buildWavFromPcm16,
  parseTranslationText,
};
