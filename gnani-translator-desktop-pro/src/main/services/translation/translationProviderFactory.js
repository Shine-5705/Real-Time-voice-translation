/**
 * Translation Provider Factory
 *
 * Selects the Translation implementation based on environment variable:
 *
 *   TRANSLATION_PROVIDER = 'google' | 'vachana'   (default: 'google')
 *
 * Provider behavior:
 *   google  → Google Cloud Translate v2 (with optional hedged public fallback)
 *   vachana → Vachana REST Translation API (with optional public fallback)
 *
 * Both pipelines share the same provider; language direction differs:
 *   Customer Pipeline: sourceLanguage → targetLanguage
 *   Agent Pipeline:    targetLanguage → sourceLanguage
 */

function createTranslationProviderFactory({ env, translator }) {
  function resolve() {
    return String(env('TRANSLATION_PROVIDER', 'google')).toLowerCase() === 'google' ? 'google' : 'vachana';
  }

  /**
   * Customer Pipeline translation: customer's language → agent's language.
   * Customer spoke in sourceLanguage, translate to targetLanguage for the agent.
   */
  function translateForAgent(text, sourceLanguage, targetLanguage, contextHint) {
    return translator.translateText(text, sourceLanguage, targetLanguage, contextHint);
  }

  /**
   * Agent Pipeline translation: agent's language → customer's language.
   * Agent spoke in targetLanguage, translate to sourceLanguage for the customer.
   */
  function translateForCustomer(text, targetLanguage, sourceLanguage, contextHint) {
    return translator.translateText(text, targetLanguage, sourceLanguage, contextHint);
  }

  return {
    resolve,
    translateForAgent,
    translateForCustomer,
    translateText: translator.translateText,
  };
}

module.exports = { createTranslationProviderFactory };
