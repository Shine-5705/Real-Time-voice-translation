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
