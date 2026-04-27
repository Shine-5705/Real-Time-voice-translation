const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startTranslation: (config) => ipcRenderer.send('start-translation', config),
  stopTranslation: () => ipcRenderer.send('stop-translation'),
  sendAudioChunk: (chunkBytes) => ipcRenderer.send('audio-chunk', chunkBytes),
  sendAudioChunkReturn: (chunkBytes) => ipcRenderer.send('audio-chunk-return', chunkBytes),
  sendMicActivity: (payload) => ipcRenderer.send('mic-activity', payload),
  startGenesysBridge: (config) => ipcRenderer.invoke('genesys-bridge-start', config || {}),
  stopGenesysBridge: () => ipcRenderer.invoke('genesys-bridge-stop'),
  getGenesysBridgeStatus: () => ipcRenderer.invoke('genesys-bridge-status'),
  onTranslationStatus: (callback) => {
    ipcRenderer.on('translation-status', (_event, payload) => callback(payload));
  },
  onGenesysBridgeStatus: (callback) => {
    ipcRenderer.on('genesys-bridge-status', (_event, payload) => callback(payload));
  },
  onTranscript: (callback) => {
    ipcRenderer.on('transcript', (_event, payload) => callback(payload));
  },
  onTranscriptInterim: (callback) => {
    ipcRenderer.on('transcript-interim', (_event, payload) => callback(payload));
  },
  onTranslatedAudio: (callback) => {
    ipcRenderer.on('translated-audio', (_event, payload) => callback(payload));
  },
  onTranslatedAudioChunk: (callback) => {
    ipcRenderer.on('translated-audio-chunk', (_event, payload) => callback(payload));
  },
  onTranslatedAudioDone: (callback) => {
    ipcRenderer.on('translated-audio-done', (_event, payload) => callback(payload));
  },
  enrollVoice: (wavBase64) => ipcRenderer.invoke('enroll-voice', wavBase64),
  onEnrollStatus: (callback) => {
    ipcRenderer.on('enroll-status', (_event, payload) => callback(payload));
  },
});