# Gnani Translator Desktop Pro

This is a **new structured folder** for the desktop app, created to replace the monolithic single-file pattern with a professional layout.

## Structure

```text
gnani-translator-desktop-pro/
  src/
    main/
      config/       # environment + config helpers
      ipc/          # all ipcMain registrations
      services/     # business logic/services
      utils/        # shared utilities (logging, etc.)
      windows/      # BrowserWindow construction
      index.js      # Electron bootstrap only
    renderer/
      index.html
      preload.js
      renderer.js
```

## Run

```bash
cd gnani-translator-desktop-pro
npm install
npm start
```

## Genesys Cloud CX integration env

Set these keys in your repo `.env` when using Genesys mode:

- `GENESYS_CLIENT_ID` - Genesys Cloud OAuth client id
- `GENESYS_CLIENT_SECRET` - Genesys Cloud OAuth client secret
- `GENESYS_REGION` - region hostname shorthand (for example `mypurecloud.com`)
- `GENESYS_INTEGRATION_MODE` - default mode: `assist`, `inject`, or `both`
- `GENESYS_STREAM_ENDPOINT` - WebSocket endpoint for bridge media/transcript stream
- `GENESYS_BRIDGE_API_KEY` - optional bearer key for your bridge endpoint
- `GENESYS_BRIDGE_RECONNECT_MAX_MS` - max reconnect backoff in ms (default `30000`)

## Colloquial translation (natural spoken output)

To avoid overly formal translations (for example very "pure" Hindi), enable the colloquial rewrite layer:

- `ENABLE_COLLOQUIAL_TRANSLATION=true`
- `COLLOQUIAL_API_ENDPOINT=<openai-compatible chat completions endpoint>`
- `COLLOQUIAL_API_KEY=<bearer token>`
- `COLLOQUIAL_MODEL=openai/gpt-oss-120b`
- Optional tuning:
  - `COLLOQUIAL_REWRITE_TIMEOUT_MS=900`
  - `COLLOQUIAL_REWRITE_TEMPERATURE=0.1`
  - `COLLOQUIAL_REWRITE_MAX_TOKENS=140`

This runs after base translation (Google or Vachana) and rewrites into more natural, everyday spoken language while preserving meaning.

## Phase 1 (implemented)

The app now boots the **full existing working pipeline** from
`gnani-translator-desktop/main.js` through:

- `src/main/pipeline/legacy/resolveLegacyEntry.js`
- `src/main/pipeline/legacy/bootLegacyPipeline.js`
- `src/main/index.js` (entrypoint)

This keeps behavior identical while starting migration in a structured codebase.

## Why this setup

- Keeps Electron bootstrap thin and maintainable.
- Separates UI, IPC, and service logic into focused modules.
- Makes future migration from legacy `main.js` easier (incremental extraction by feature).

## Next migration steps (Phase 2+)

1. Move language mapping + normalization helpers into `src/main/services/language/`.
2. Move Google clients (translate/stt/tts) into `src/main/services/google/`.
3. Move queue and pipeline orchestration into `src/main/services/pipeline/`.
4. Move transcript and artifact writers into `src/main/services/session/`.
5. Add tests for helpers and pure services.
