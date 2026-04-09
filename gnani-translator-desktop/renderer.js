const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const micSelect = document.getElementById('micSelect');
const outputSelect = document.getElementById('outputSelect');
const sourceLangSelect = document.getElementById('sourceLang');
const targetLangSelect = document.getElementById('targetLang');
const transcriptBox = document.getElementById('transcriptBox');
const passthroughToggle = document.getElementById('passthroughToggle');
const guestSpeakerToggle = document.getElementById('guestSpeakerToggle');

let inputStream = null;
let monitorAudio = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentGainNode = null;
let highpassNode = null;
let lowpassNode = null;
let pcmBuffer = new Int16Array(0);
let selectedOutputSinkId = '';
const playbackQueue = [];
let playbackActive = false;
let sttFrameQueue = [];
let sttSendTimer = null;
let lastMicTelemetryTs = 0;
let inputDeviceById = new Map();
let outputDeviceById = new Map();
const TARGET_SAMPLE_RATE = 16000;
const PREAMP_GAIN = 1.35;
const TTS_CHUNK_AGGREGATE_MS = 150;
const ENFORCE_TARGET_ONLY_AUDIO = true;
const MIC_ECHO_CANCELLATION = true;
const MIC_NOISE_SUPPRESSION = true;
const MIC_AUTO_GAIN_CONTROL = true;
const MIC_NOISE_GATE_THRESHOLD = 0.0095;
const MIC_NOISE_GATE_SOFT_GAIN = 0.12;
const MIC_HIGHPASS_HZ = 120;
const MIC_LOWPASS_HZ = 3800;
let ttsChunkBytesQueue = [];
let ttsChunkMeta = { sampleRate: 16000, numChannels: 1, sampleWidth: 2 };
let ttsAggregateTimer = null;

const LANGUAGES = [
  ['bn-IN', 'Bengali'],
  ['en-IN', 'English'],
  ['gu-IN', 'Gujarati'],
  ['hi-IN', 'Hindi'],
  ['kn-IN', 'Kannada'],
  ['ml-IN', 'Malayalam'],
  ['mr-IN', 'Marathi'],
  ['pa-IN', 'Punjabi'],
  ['ta-IN', 'Tamil'],
  ['te-IN', 'Telugu'],
  ['en-hi-IN-latn', 'Hinglish (Latin)'],
];

function appendTranscriptLine(text, cssClass = '') {
  const line = document.createElement('div');
  line.textContent = text;
  if (cssClass) {
    line.classList.add(cssClass);
  }
  transcriptBox.appendChild(line);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function clearTranscript() {
  transcriptBox.innerHTML = '';
}

function buildLanguageOptions() {
  sourceLangSelect.innerHTML = '';
  targetLangSelect.innerHTML = '';

  LANGUAGES.forEach(([code, label]) => {
    const sourceOpt = document.createElement('option');
    sourceOpt.value = code;
    sourceOpt.textContent = `${label} (${code})`;
    sourceLangSelect.appendChild(sourceOpt);

    const targetOpt = document.createElement('option');
    targetOpt.value = code;
    targetOpt.textContent = `${label} (${code})`;
    targetLangSelect.appendChild(targetOpt);
  });

  sourceLangSelect.value = 'en-IN';
  targetLangSelect.value = 'hi-IN';
}

function toInt16(floatArray) {
  const int16 = new Int16Array(floatArray.length);
  for (let i = 0; i < floatArray.length; i++) {
    const s = Math.max(-1, Math.min(1, floatArray[i]));
    int16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return int16;
}

function applyGain(floatArray, gain) {
  if (gain === 1) {
    return floatArray;
  }
  const out = new Float32Array(floatArray.length);
  for (let i = 0; i < floatArray.length; i++) {
    const v = floatArray[i] * gain;
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

function applySoftNoiseGate(floatArray) {
  const rms = computeRms(floatArray);
  if (rms < MIC_NOISE_GATE_THRESHOLD * 0.5) {
    return new Float32Array(floatArray.length);
  }

  if (rms < MIC_NOISE_GATE_THRESHOLD) {
    const out = new Float32Array(floatArray.length);
    for (let i = 0; i < floatArray.length; i++) {
      out[i] = floatArray[i] * MIC_NOISE_GATE_SOFT_GAIN;
    }
    return out;
  }

  return floatArray;
}

function resampleTo16k(input, inputSampleRate) {
  if (!inputSampleRate || inputSampleRate === TARGET_SAMPLE_RATE) {
    return input;
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const newLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(newLength);

  // Linear interpolation resampler; lightweight and good enough for STT input.
  for (let i = 0; i < newLength; i++) {
    const srcPos = i * ratio;
    const left = Math.floor(srcPos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = srcPos - left;
    output[i] = input[left] * (1 - frac) + input[right] * frac;
  }

  return output;
}

function concatInt16(a, b) {
  const merged = new Int16Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

function sendPCMToSTT(newPCM) {
  pcmBuffer = concatInt16(pcmBuffer, newPCM);
  while (pcmBuffer.length >= 512) {
    const frame = pcmBuffer.slice(0, 512);
    pcmBuffer = pcmBuffer.slice(512);
    const bytes = new Uint8Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
    sttFrameQueue.push(bytes);
  }
}

function computeRms(floatArray) {
  let sumSquares = 0;
  for (let i = 0; i < floatArray.length; i++) {
    sumSquares += floatArray[i] * floatArray[i];
  }
  return Math.sqrt(sumSquares / Math.max(1, floatArray.length));
}

function emitMicTelemetry(floatArray) {
  const now = performance.now();
  if (now - lastMicTelemetryTs < 1000) {
    return;
  }
  lastMicTelemetryTs = now;

  const rms = computeRms(floatArray);
  const speaking = rms > 0.01;
  window.electronAPI.sendMicActivity({
    rms,
    speaking,
    queuedFrames: sttFrameQueue.length,
    sourceLang: sourceLangSelect.value,
    targetLang: targetLangSelect.value,
  });
}

function startPacedSttSender() {
  stopPacedSttSender();
  // Vachana STT requires steady 32ms frames (512 samples @16kHz => 1024 bytes).
  sttSendTimer = setInterval(() => {
    if (sttFrameQueue.length === 0) {
      return;
    }
    const frame = sttFrameQueue.shift();
    window.electronAPI.sendAudioChunk(frame);
  }, 32);
}

function stopPacedSttSender() {
  if (sttSendTimer) {
    clearInterval(sttSendTimer);
    sttSendTimer = null;
  }
  sttFrameQueue = [];
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || 'audio/wav' });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function pcm16ChunkToWavBlob(base64Pcm, sampleRate = 16000, channels = 1, sampleWidth = 2) {
  const pcmBytes = base64ToBytes(base64Pcm);
  const bitsPerSample = sampleWidth * 8;
  const byteRate = sampleRate * channels * sampleWidth;
  const blockAlign = channels * sampleWidth;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, pcmBytes.length, true);

  return new Blob([header, pcmBytes], { type: 'audio/wav' });
}

async function playNextAudioInQueue() {
  if (playbackActive || playbackQueue.length === 0) {
    return;
  }

  playbackActive = true;
  const item = playbackQueue.shift();
  const audioEl = new Audio();
  audioEl.src = item.url;

  try {
    if (typeof audioEl.setSinkId === 'function' && selectedOutputSinkId) {
      await audioEl.setSinkId(selectedOutputSinkId);
    }

    await audioEl.play();
    await new Promise((resolve) => {
      audioEl.onended = resolve;
      audioEl.onerror = resolve;
    });
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Status: Failed to route translated audio. Re-select CABLE Input as output and restart.';
  } finally {
    URL.revokeObjectURL(item.url);
    playbackActive = false;
    if (playbackQueue.length > 0) {
      playNextAudioInQueue();
    }
  }
}

function startTtsAggregateTimer() {
  stopTtsAggregateTimer();
  ttsAggregateTimer = setInterval(() => {
    flushAggregatedTtsChunks();
  }, TTS_CHUNK_AGGREGATE_MS);
}

function stopTtsAggregateTimer() {
  if (ttsAggregateTimer) {
    clearInterval(ttsAggregateTimer);
    ttsAggregateTimer = null;
  }
}

function flushAggregatedTtsChunks(force = false) {
  if (ttsChunkBytesQueue.length === 0) {
    return;
  }

  if (!force && ttsChunkBytesQueue.length < 2) {
    // Keep a tiny buffer to reduce micro-gaps between consecutive chunks.
    return;
  }

  const totalLen = ttsChunkBytesQueue.reduce((sum, arr) => sum + arr.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of ttsChunkBytesQueue) {
    merged.set(arr, offset);
    offset += arr.length;
  }

  ttsChunkBytesQueue = [];
  const base64Merged = bytesToBase64(merged);
  const blob = pcm16ChunkToWavBlob(
    base64Merged,
    ttsChunkMeta.sampleRate,
    ttsChunkMeta.numChannels,
    ttsChunkMeta.sampleWidth
  );
  const url = URL.createObjectURL(blob);
  playbackQueue.push({ url });
  playNextAudioInQueue();
}

function isVirtualLabel(label) {
  return /cable|blackhole|virtual/i.test(label);
}

function teardownAudioGraph() {
  stopPacedSttSender();
  stopTtsAggregateTimer();
  ttsChunkBytesQueue = [];

  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (highpassNode) {
    highpassNode.disconnect();
    highpassNode = null;
  }

  if (lowpassNode) {
    lowpassNode.disconnect();
    lowpassNode = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  silentGainNode = null;

  if (monitorAudio) {
    monitorAudio.pause();
    monitorAudio.srcObject = null;
    monitorAudio = null;
  }

  if (inputStream) {
    inputStream.getTracks().forEach((t) => t.stop());
    inputStream = null;
  }

  pcmBuffer = new Int16Array(0);
  playbackQueue.splice(0, playbackQueue.length);
  playbackActive = false;
}

async function startMonitorPassthrough(outputDeviceId) {
  if (!inputStream) {
    return;
  }

  if (monitorAudio) {
    monitorAudio.pause();
    monitorAudio.srcObject = null;
    monitorAudio = null;
  }

  monitorAudio = new Audio();
  monitorAudio.autoplay = false;
  monitorAudio.muted = false;
  monitorAudio.volume = 1.0;
  monitorAudio.srcObject = inputStream;

  if (typeof monitorAudio.setSinkId !== 'function') {
    throw new Error('Output routing not supported (setSinkId unavailable)');
  }

  await monitorAudio.setSinkId(outputDeviceId);
  await monitorAudio.play();
}

async function startRealtimePipeline(inputDeviceId, outputDeviceId) {
  teardownAudioGraph();
  selectedOutputSinkId = outputDeviceId;
  startPacedSttSender();
  startTtsAggregateTimer();

  const supported = (navigator.mediaDevices && navigator.mediaDevices.getSupportedConstraints)
    ? navigator.mediaDevices.getSupportedConstraints()
    : {};
  const audioConstraints = {
    deviceId: { exact: inputDeviceId },
    echoCancellation: MIC_ECHO_CANCELLATION,
    noiseSuppression: MIC_NOISE_SUPPRESSION,
    autoGainControl: MIC_AUTO_GAIN_CONTROL,
    channelCount: 1,
    sampleRate: 16000,
  };
  if (supported.voiceIsolation) {
    audioConstraints.voiceIsolation = true;
  }

  inputStream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
    video: false,
  });

  audioContext = new AudioContext({ sampleRate: 16000 });
  sourceNode = audioContext.createMediaStreamSource(inputStream);
  highpassNode = audioContext.createBiquadFilter();
  highpassNode.type = 'highpass';
  highpassNode.frequency.value = MIC_HIGHPASS_HZ;

  lowpassNode = audioContext.createBiquadFilter();
  lowpassNode.type = 'lowpass';
  lowpassNode.frequency.value = MIC_LOWPASS_HZ;

  processorNode = audioContext.createScriptProcessor(1024, 1, 1);
  silentGainNode = audioContext.createGain();
  silentGainNode.gain.value = 0;

  processorNode.onaudioprocess = (e) => {
    const inputRate = e.inputBuffer.sampleRate || audioContext.sampleRate || TARGET_SAMPLE_RATE;
    const channel = e.inputBuffer.getChannelData(0);
    const resampled = resampleTo16k(channel, inputRate);
    const gated = applySoftNoiseGate(resampled);
    const boosted = applyGain(gated, PREAMP_GAIN);
    emitMicTelemetry(boosted);
    sendPCMToSTT(toInt16(boosted));
  };

  // Keep callback running while preventing local speaker feedback.
  sourceNode.connect(highpassNode);
  highpassNode.connect(lowpassNode);
  lowpassNode.connect(processorNode);
  processorNode.connect(silentGainNode);
  silentGainNode.connect(audioContext.destination);

  // Do not pass raw mic to VB-CABLE in translation mode.
  // Only translated TTS chunks are routed to selected output sink.
  if (!ENFORCE_TARGET_ONLY_AUDIO && passthroughToggle && passthroughToggle.checked) {
    await startMonitorPassthrough(outputDeviceId);
  }
}

function validateLanguages() {
  if (!sourceLangSelect.value || !targetLangSelect.value) {
    statusEl.textContent = 'Status: Select both source and target language';
    return false;
  }

  if (sourceLangSelect.value === targetLangSelect.value) {
    statusEl.textContent = 'Status: Source and target language should be different';
    return false;
  }

  return true;
}

startBtn.addEventListener('click', () => {
  const selectedMic = micSelect.value;
  const selectedOutput = outputSelect.value;
  if (!selectedMic || !selectedOutput) {
    statusEl.textContent = 'Status: Select both microphone and output device';
    return;
  }

  const selectedMicLabel = inputDeviceById.get(selectedMic) || '';
  if (isVirtualLabel(selectedMicLabel)) {
    statusEl.textContent = 'Status: Choose your physical microphone as input. Do not select CABLE Output as mic.';
    return;
  }

  const selectedOutputLabel = outputDeviceById.get(selectedOutput) || '';
  if (!isVirtualLabel(selectedOutputLabel)) {
    statusEl.textContent = 'Status: Choose CABLE Input/BlackHole as output so meeting gets only translated voice.';
    return;
  }

  if (!validateLanguages()) {
    return;
  }

  startRealtimePipeline(selectedMic, selectedOutput)
    .then(() => {
      window.electronAPI.startTranslation({
        sourceLanguage: sourceLangSelect.value,
        targetLanguage: targetLangSelect.value,
        speakerPreferenceMode: guestSpeakerToggle && guestSpeakerToggle.checked ? 'lock_first' : 'off',
      });
      startBtn.disabled = true;
      stopBtn.disabled = false;
      clearTranscript();
      appendTranscriptLine('Listening for speech...', 'line-muted');
      statusEl.textContent = 'Status: Realtime translation active (target-only). Teams Mic must be CABLE Output.';
    })
    .catch((err) => {
      console.error(err);
      statusEl.textContent = `Status: Failed to start pipeline (${err.message || 'unknown error'})`;
      teardownAudioGraph();
    });
});

stopBtn.addEventListener('click', () => {
  teardownAudioGraph();
  window.electronAPI.stopTranslation();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = 'Status: Stopped';
});

async function loadDevices() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    inputDeviceById = new Map(mics.map((d) => [d.deviceId, d.label || '']));
    outputDeviceById = new Map(outputs.map((d) => [d.deviceId, d.label || '']));

    micSelect.innerHTML = '<option value="">-- Select Physical Mic --</option>';
    outputSelect.innerHTML = '<option value="">-- Select Virtual Output --</option>';

    mics.forEach((dev) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      const label = dev.label || `Microphone ${dev.deviceId.slice(0, 8)}...`;
      opt.textContent = isVirtualLabel(label) ? `Virtual Device: ${label}` : label;
      micSelect.appendChild(opt);
    });

    outputs.forEach((dev) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      const label = dev.label || `Speaker ${dev.deviceId.slice(0, 8)}...`;
      opt.textContent = isVirtualLabel(label) ? `Virtual Device: ${label}` : label;
      outputSelect.appendChild(opt);
    });

    const preferredOutput = outputs.find((d) => isVirtualLabel(d.label || ''));
    const preferredCableInput = outputs.find((d) => /cable input/i.test(d.label || ''));
    if (preferredCableInput) {
      outputSelect.value = preferredCableInput.deviceId;
    } else if (preferredOutput) {
      outputSelect.value = preferredOutput.deviceId;
    }

    const preferredMic = mics.find((d) => !isVirtualLabel(d.label || ''));
    if (preferredMic) {
      micSelect.value = preferredMic.deviceId;
    }

    if (mics.length === 0 || outputs.length === 0) {
      statusEl.textContent = 'Status: No microphone devices found';
    }
  } catch (err) {
    statusEl.textContent = 'Status: Microphone permission denied. Allow mic access and retry.';
    console.error(err);
  }
}

window.electronAPI.onTranslationStatus((payload) => {
  statusEl.textContent = `Status: ${payload.message}`;

  if (!payload.running && /Failed to start pipeline|STT disconnected|STT error/i.test(payload.message)) {
    teardownAudioGraph();
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

window.electronAPI.onTranscript((payload) => {
  const spk = payload.speakerId ? ` [${payload.speakerId}]` : '';
  if (payload.translated) {
    appendTranscriptLine(`Translated${spk}: ${payload.text}`);
  } else {
    appendTranscriptLine(`Source${spk}: ${payload.text}`);
  }
});

window.electronAPI.onTranslatedAudio((payload) => {
  const blob = base64ToBlob(payload.audioBase64, payload.mimeType);
  const url = URL.createObjectURL(blob);
  playbackQueue.push({ url });
  playNextAudioInQueue();
});

window.electronAPI.onTranslatedAudioChunk((payload) => {
  const bytes = base64ToBytes(payload.audioBase64);
  ttsChunkMeta = {
    sampleRate: payload.sampleRate || 16000,
    numChannels: payload.numChannels || 1,
    sampleWidth: payload.sampleWidth || 2,
  };
  ttsChunkBytesQueue.push(bytes);
  flushAggregatedTtsChunks(false);
});

window.electronAPI.onTranslatedAudioDone(() => {
  flushAggregatedTtsChunks(true);
});

window.addEventListener('beforeunload', () => {
  teardownAudioGraph();
});

if (passthroughToggle && ENFORCE_TARGET_ONLY_AUDIO) {
  passthroughToggle.checked = false;
  passthroughToggle.disabled = true;
  passthroughToggle.title = 'Disabled in target-only mode to prevent source audio leakage.';
}

buildLanguageOptions();
loadDevices();