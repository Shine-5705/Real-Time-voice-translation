/**
 * STT Provider Factory
 *
 * Selects the Speech-to-Text implementation per language and per pipeline.
 *
 * Resolution order (highest priority first):
 *   STT_PROVIDER=google   → Google Cloud Speech for ALL languages
 *   STT_PROVIDER=deepgram → Deepgram STT for ALL languages
 *   STT_PROVIDER=vachana  → Vachana STT for ALL languages
 *   STT_PROVIDER=auto    → Per-language auto-selection (default):
 *       Indic languages (hi-IN, bn-IN, ta-IN, …) → Vachana STT
 *       Foreign languages (en-US, fr-FR, de-DE, …) → Deepgram STT
 *
 * Mode (applies within the selected provider):
 *   VACHANA_STT_MODE=ws   → WebSocket streaming (default)
 *   VACHANA_STT_MODE=rest → REST batch polling
 *   (Google/Deepgram always use streaming; REST fallback via ENABLE_STT_REST_FALLBACK)
 *
 * Customer Pipeline  = customer/phone speech (Blackhole 16ch → STT)
 * Agent Pipeline     = agent speech (Agent Mic → STT)
 *
 * Each pipeline tracks its own provider so Customer and Agent can use
 * different engines (e.g. Customer speaks Hindi → Vachana,
 * Agent speaks French → Deepgram).
 */

const { sttProviderForLanguage } = require('../common/pipelineUtils');

function createSttProviderFactory({
  env,
  logInfo,
  logError,
  sendStatus,
  realtimeWs,
  googleStreamingStt,
  deepgramStreamingStt,
  restLoops,
  getState,
  setState,
}) {
  function normalizeProvider(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'google' || raw === 'deepgram' || raw === 'vachana') return raw;
    return '';
  }

  /**
   * Resolve the best STT provider for a given language code.
   * Returns 'google' | 'deepgram' | 'vachana'.
   */
  function resolveProviderForLang(langCode, overrideEnvKey = '') {
    if (overrideEnvKey) {
      const forced = normalizeProvider(env(overrideEnvKey, ''));
      if (forced) return forced;
    }
    return normalizeProvider(sttProviderForLanguage(langCode, env)) || 'vachana';
  }

  /**
   * Resolve the STT transport mode.
   * Only Vachana supports switching between WS and REST in this pipeline.
   * Deepgram/Google are always streaming WS.
   */
  function resolveMode(provider = 'vachana') {
    if (provider !== 'vachana') return 'ws';
    return String(env('VACHANA_STT_MODE', 'ws')).toLowerCase() === 'rest' ? 'rest' : 'ws';
  }

  /**
   * Convenience: resolve both provider and mode for a language.
   */
  function resolveForLang(langCode) {
    const provider = resolveProviderForLang(langCode);
    return {
      provider,
      mode: resolveMode(provider),
    };
  }

  function providerForRest(provider) {
    // Never fall back to Google STT in this integration.
    // For non-Vachana providers, REST fallback uses Vachana REST.
    return provider === 'vachana' ? 'vachana' : 'vachana';
  }

  /* ─── Customer Pipeline ─────────────────────────────────────────────────
   *
   *  Phone → Genesys → Blackhole 16ch → [STT] → enqueueTranscript
   *
   *  Language = sourceLanguage (what the customer speaks).
   * ────────────────────────────────────────────────────────────────────── */

  async function connectCustomerStt(event, sourceLanguage, { enqueueTranscript, state }) {
    const provider = resolveProviderForLang(sourceLanguage, 'STT_PROVIDER_CUSTOMER');
    const mode = resolveMode(provider);
    logInfo(`[CustomerPipeline] STT provider=${provider} mode=${mode} lang=${sourceLanguage}`);

    // Persist per-pipeline provider so audio routing knows where to send frames
    setState({ sttProviderCustomer: provider, sttMode: mode });

    if (mode === 'rest') {
      restLoops.startRestSttFallback({
        state, setState, event, sourceLanguage, enqueueTranscript,
        providerOverride: providerForRest(provider),
      });
      return { provider, mode: 'rest' };
    }

    const connector = provider === 'google'
      ? googleStreamingStt
      : provider === 'deepgram'
        ? deepgramStreamingStt
        : realtimeWs;
    await connector.connectSTT(event, sourceLanguage);
    return { provider, mode: 'ws' };
  }

  /* ─── Agent Pipeline ────────────────────────────────────────────────────
   *
   *  Agent Mic → [STT] → enqueueTranscriptIncoming → … → Genesys → Phone
   *
   *  Language = targetLanguage (what the agent speaks).
   * ────────────────────────────────────────────────────────────────────── */

  async function connectAgentStt(event, targetLanguage, { enqueueTranscriptIncoming, state }) {
    const provider = resolveProviderForLang(targetLanguage, 'STT_PROVIDER_AGENT');
    const mode = resolveMode(provider);
    logInfo(`[AgentPipeline] STT provider=${provider} mode=${mode} lang=${targetLanguage}`);

    setState({ sttProviderAgent: provider });

    if (mode === 'rest') {
      restLoops.startRestSttReturnPath({
        state, event, targetLanguage, enqueueTranscriptIncoming,
        providerOverride: providerForRest(provider),
      });
      return { provider, mode: 'rest' };
    }

    const connector = provider === 'google'
      ? googleStreamingStt
      : provider === 'deepgram'
        ? deepgramStreamingStt
        : realtimeWs;
    await connector.connectSTTReturn(event, targetLanguage);
    return { provider, mode: 'ws' };
  }

  /* ─── Audio routing ─────────────────────────────────────────────────────
   *
   *  Each pipeline checks its own provider field so they can differ.
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * Route a PCM frame from the Customer Pipeline (Blackhole 16ch) to STT.
   * @returns {boolean} true = forwarded, false = dropped (no active connection)
   */
  function routeCustomerAudio(buffer) {
    const state = getState();
    if (state.sttMode === 'rest') {
      state.restAudioBuffer.push(buffer);
      return true;
    }
    // Per-pipeline provider (falls back to global sttProvider for compatibility)
    const provider = state.sttProviderCustomer || state.sttProvider || 'vachana';
    if (provider === 'google') {
      if (!state.sttGoogleStream || state.sttGoogleStream.destroyed) return false;
      state.sttGoogleStream.write(buffer);
      return true;
    }
    if (!state.sttSocket || state.sttSocket.readyState !== 1) return false;
    state.sttSocket.send(buffer);
    return true;
  }

  /**
   * Route a PCM frame from the Agent Pipeline (Agent Mic) to STT.
   * @returns {boolean} true = forwarded, false = dropped (no active connection)
   */
  function routeAgentAudio(buffer) {
    const state = getState();
    if (state.sttMode === 'rest') {
      state.restAudioBufferReturn.push(buffer);
      return true;
    }
    const provider = state.sttProviderAgent || state.sttProvider || 'vachana';
    if (provider === 'google') {
      if (!state.sttGoogleStreamReturn || state.sttGoogleStreamReturn.destroyed) return false;
      state.sttGoogleStreamReturn.write(buffer);
      return true;
    }
    if (!state.sttSocketReturn || state.sttSocketReturn.readyState !== 1) return false;
    state.sttSocketReturn.send(buffer);
    return true;
  }

  /* ─── REST fallback ─────────────────────────────────────────────────── */

  /**
   * Switch Customer Pipeline to REST after WS/stream failure.
   * Respects the per-language provider for the REST transcription function too.
   */
  function fallbackCustomerToRest(event, sourceLanguage, { enqueueTranscript, state }) {
    const restFallback = env('ENABLE_STT_REST_FALLBACK', 'true').toLowerCase() === 'true';
    if (!restFallback) return false;

    const provider = resolveProviderForLang(sourceLanguage);
    logInfo(`[CustomerPipeline] STT falling back to REST (provider=${provider} lang=${sourceLanguage})`);
    restLoops.startRestSttFallback({
      state, setState, event, sourceLanguage, enqueueTranscript,
      providerOverride: providerForRest(provider),
    });
    setState({ sttProviderCustomer: provider });
    return true;
  }

  return {
    resolveForLang,
    resolveProviderForLang,
    resolveMode,
    connectCustomerStt,
    connectAgentStt,
    routeCustomerAudio,
    routeAgentAudio,
    fallbackCustomerToRest,
  };
}

module.exports = { createSttProviderFactory };
