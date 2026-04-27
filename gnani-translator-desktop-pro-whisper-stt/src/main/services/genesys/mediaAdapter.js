function asBuffer(value) {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }
  return Buffer.alloc(0);
}

function normalizePcm16Frame(input, expectedFrameBytes = 1024) {
  const buf = asBuffer(input);
  if (!buf.length) return null;
  if (buf.length === expectedFrameBytes) return buf;
  if (buf.length > expectedFrameBytes) return buf.subarray(0, expectedFrameBytes);
  return null;
}

function toChunkPayload(chunkBuffer, meta = {}) {
  const chunk = asBuffer(chunkBuffer);
  if (!chunk.length) return null;
  return {
    audioBase64: chunk.toString('base64'),
    sampleRate: Number(meta.sampleRate || 16000),
    numChannels: Number(meta.numChannels || 1),
    sampleWidth: Number(meta.sampleWidth || 2),
    channel: String(meta.channel || 'meeting'),
  };
}

function normalizeTranscriptMessage(msg = {}) {
  const text = String(msg.text || '').trim();
  if (!text) return null;
  return {
    type: 'transcript',
    text,
    detected_language: String(msg.detectedLanguage || msg.detected_language || 'en-IN'),
    speaker_id: String(msg.speakerId || msg.speaker_id || ''),
    direction: String(msg.direction || 'out'),
    latency: String(msg.latency || 'genesys-bridge'),
    sttElapsedMs: Number(msg.sttElapsedMs || 0),
  };
}

module.exports = {
  normalizePcm16Frame,
  toChunkPayload,
  normalizeTranscriptMessage,
};
