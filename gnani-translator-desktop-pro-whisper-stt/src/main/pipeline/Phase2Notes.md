# Phase 2 Extraction (New Folder Only)

This extraction is intentionally added only under `gnani-translator-desktop-pro/`.
No further changes are required in `gnani-translator-desktop/` for these modules.

## Added modules

- `src/main/services/common/pipelineUtils.js`
- `src/main/services/stt/transcribeService.js`
- `src/main/services/stt/realtimeWsService.js`
- `src/main/services/stt/restLoopService.js`
- `src/main/services/artifacts/artifactService.js`
- `src/main/pipeline/queue/transcriptQueueService.js`
- `src/main/pipeline/queue/ttsQueueService.js`

## Coverage

- Google + REST STT transcription
- STT websocket paths (outgoing + return)
- REST STT looping paths (outgoing + return)
- Session artifacts + pipeline/event logging
- Transcript queue orchestration
- TTS job queue orchestration

## Next wiring step

Create a `pipeline/runtime.js` in `gnani-translator-desktop-pro` that instantiates these modules and routes IPC events through them, replacing legacy boot progressively.
