/**
 * TTS Provider Factory
 *
 * Selects the Text-to-Speech implementation based on environment variables:
 *
 *   TTS_PROVIDER          = 'google' | 'vachana'   (default: 'google')
 *   ENABLE_TTS_REALTIME_WS = 'true'  | 'false'     (default: 'false')
 *
 * Provider matrix:
 *   google  → Google Cloud TTS v1beta1 streaming (with sync fallback)
 *   vachana → Vachana REST TTS
 *   vachana + ENABLE_TTS_REALTIME_WS=true → Vachana WebSocket TTS (real-time)
 *
 * Both pipelines share the same provider; language/voice differs:
 *   Customer Pipeline TTS: speaks in targetLanguage  → played to Agent
 *   Agent Pipeline TTS:    speaks in sourceLanguage   → sent to Genesys/Phone
 */

function createTtsProviderFactory({ env, ttsService }) {
  function resolve() {
    const provider = String(env('TTS_PROVIDER', 'google')).toLowerCase() === 'google' ? 'google' : 'vachana';
    const realtimeWs = provider !== 'google'
      && String(env('ENABLE_TTS_REALTIME_WS', 'false')).toLowerCase() === 'true';
    return { provider, realtimeWs };
  }

  /**
   * Customer Pipeline TTS: synthesize translated text in agent's language.
   * Output is played to the Agent via meeting audio channel.
   */
  function synthesizeForAgent(text, targetLanguage, opts) {
    return ttsService.synthesizeTTS(text, targetLanguage, opts);
  }

  /**
   * Agent Pipeline TTS: synthesize translated text in customer's language.
   * Output is sent to Blackhole 2ch → Genesys → Phone via local audio channel.
   */
  function synthesizeForCustomer(text, sourceLanguage, opts) {
    return ttsService.synthesizeTTS(text, sourceLanguage, opts);
  }

  return {
    resolve,
    synthesizeForAgent,
    synthesizeForCustomer,
    synthesizeTTS: ttsService.synthesizeTTS,
    synthesizeRestTtsSequentialToRenderer: ttsService.synthesizeRestTtsSequentialToRenderer,
    streamTTSRealtime: ttsService.streamTTSRealtime,
    toBcp47: ttsService.toBcp47,
  };
}

module.exports = { createTtsProviderFactory };
