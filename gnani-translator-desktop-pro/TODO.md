### TODO

1. ~~Organise the code to go with the flow of the business logic~~ ✓
2. ~~Organise STT / TTS providers~~ ✓

### Completed

- Refactored `runtime.js` around the two-pipeline architecture (Customer Pipeline + Agent Pipeline)
- Created pluggable provider factories:
  - `stt/sttProviderFactory.js` — STT_PROVIDER (google|vachana) + VACHANA_STT_MODE (ws|rest)
  - `translation/translationProviderFactory.js` — TRANSLATION_PROVIDER (google|vachana)
  - `tts/ttsProviderFactory.js` — TTS_PROVIDER (google|vachana) + ENABLE_TTS_REALTIME_WS
- Organized code sections in data-flow order matching the architecture diagram