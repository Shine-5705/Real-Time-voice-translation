const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startTranslation: (config) => ipcRenderer.send('start-translation', config),
  stopTranslation: () => ipcRenderer.send('stop-translation'),
  sendAudioChunk: (chunkBytes) => ipcRenderer.send('audio-chunk', chunkBytes),
  sendAudioChunkReturn: (chunkBytes) => ipcRenderer.send('audio-chunk-return', chunkBytes),
  sendMicActivity: (payload) => ipcRenderer.send('mic-activity', payload),
  onTranslationStatus: (callback) => {
    ipcRenderer.on('translation-status', (_event, payload) => callback(payload));
  },
  onTranscript: (callback) => {
    ipcRenderer.on('transcript', (_event, payload) => callback(payload));
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
});