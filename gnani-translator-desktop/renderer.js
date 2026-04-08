const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const micSelect = document.getElementById('micSelect');
const outputSelect = document.getElementById('outputSelect');
const sourceLangSelect = document.getElementById('sourceLang');
const targetLangSelect = document.getElementById('targetLang');
const transcriptBox = document.getElementById('transcriptBox');

let inputStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentGainNode = null;
let pcmBuffer = new Int16Array(0);
let selectedOutputSinkId = '';
const playbackQueue = [];
let playbackActive = false;

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
    window.electronAPI.sendAudioChunk(bytes);
  }
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || 'audio/wav' });
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
  } finally {
    URL.revokeObjectURL(item.url);
    playbackActive = false;
    if (playbackQueue.length > 0) {
      playNextAudioInQueue();
    }
  }
}

function isVirtualLabel(label) {
  return /cable|blackhole|virtual/i.test(label);
}

function teardownAudioGraph() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  silentGainNode = null;

  if (inputStream) {
    inputStream.getTracks().forEach((t) => t.stop());
    inputStream = null;
  }

  pcmBuffer = new Int16Array(0);
  playbackQueue.splice(0, playbackQueue.length);
  playbackActive = false;
}

async function startRealtimePipeline(inputDeviceId, outputDeviceId) {
  teardownAudioGraph();
  selectedOutputSinkId = outputDeviceId;

  inputStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: inputDeviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 16000,
    },
    video: false,
  });

  audioContext = new AudioContext({ sampleRate: 16000 });
  sourceNode = audioContext.createMediaStreamSource(inputStream);
  processorNode = audioContext.createScriptProcessor(1024, 1, 1);
  silentGainNode = audioContext.createGain();
  silentGainNode.gain.value = 0;

  processorNode.onaudioprocess = (e) => {
    const channel = e.inputBuffer.getChannelData(0);
    sendPCMToSTT(toInt16(channel));
  };

  // Keep callback running while preventing local speaker feedback.
  sourceNode.connect(processorNode);
  processorNode.connect(silentGainNode);
  silentGainNode.connect(audioContext.destination);

  // Do not pass raw mic to VB-CABLE in translation mode.
  // Only translated TTS chunks are routed to selected output sink.
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

  if (!validateLanguages()) {
    return;
  }

  startRealtimePipeline(selectedMic, selectedOutput)
    .then(() => {
      window.electronAPI.startTranslation({
        sourceLanguage: sourceLangSelect.value,
        targetLanguage: targetLangSelect.value,
      });
      startBtn.disabled = true;
      stopBtn.disabled = false;
      clearTranscript();
      appendTranscriptLine('Listening for speech...', 'line-muted');
      statusEl.textContent = 'Status: Realtime translation active. In app choose CABLE Input; in Teams choose CABLE Output as microphone.';
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
  if (payload.translated) {
    appendTranscriptLine(`Translated: ${payload.text}`);
  } else {
    appendTranscriptLine(`Source: ${payload.text}`);
  }
});

window.electronAPI.onTranslatedAudio((payload) => {
  const blob = base64ToBlob(payload.audioBase64, payload.mimeType);
  const url = URL.createObjectURL(blob);
  playbackQueue.push({ url });
  playNextAudioInQueue();
});

window.addEventListener('beforeunload', () => {
  teardownAudioGraph();
});

buildLanguageOptions();
loadDevices();