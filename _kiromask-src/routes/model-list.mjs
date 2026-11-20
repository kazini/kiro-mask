// Build the model list Kiro's picker shows: Kiro's own models + configured custom models.

const CUSTOM_CACHING = { maximumCacheCheckpointsPerRequest: null, minimumTokensPerCacheCheckpoint: null, supportsPromptCaching: false };

export function customModelEntry(e) {
  return {
    description: e.description || `${e.displayName} via ${e.provider.name}`,
    modelId: e.id,
    modelName: e.displayName,
    promptCaching: CUSTOM_CACHING,
    rateMultiplier: null,
    rateUnit: null,
    supportedInputTypes: e.supportsImages === false ? ['TEXT'] : ['TEXT', 'IMAGE'],
    tokenLimits: { maxInputTokens: e.contextWindow, maxOutputTokens: e.maxTokens ?? null },
  };
}

/**
 * @param {object|null} upstream  parsed ListAvailableModels response from AWS (or cached), or null when unavailable
 * @param {import('../config/load.mjs').Config} cfg
 * @param {{includeNative: boolean}} opts
 * A custom model whose id equals a Kiro model's id *replaces* it in place (model override).
 */
export function buildModelList(upstream, cfg, { includeNative = true } = {}) {
  const ml = cfg.get('model_list', {});
  const unit = ml.kiro_rate_unit;
  let native = includeNative && Array.isArray(upstream?.models)
    ? upstream.models.map((m) => (unit && m.rateUnit === 'Credit' ? { ...m, rateUnit: unit } : m))
    : [];

  const custom = cfg.customModels.map(customModelEntry);
  const customIds = new Set(custom.map((c) => c.modelId));
  const overridden = new Map(custom.map((c) => [c.modelId, c]));

  native = native.map((m) => overridden.get(m.modelId) ?? m);
  const nativeIds = new Set(native.map((m) => m.modelId));
  const extra = custom.filter((c) => !nativeIds.has(c.modelId));
  const models = ml.order === 'custom-first' ? [...extra, ...native] : [...native, ...extra];

  const { models: _drop, ...rest } = upstream && typeof upstream === 'object' ? upstream : {};
  const out = { ...rest, models };

  // Optional: pick which model the picker starts on (only if the user asked for it).
  const wanted = ml.default_model && cfg.resolve(ml.default_model);
  if (wanted && wanted !== 'native' && customIds.has(wanted.id)) {
    out.defaultModel = typeof upstream?.defaultModel === 'string' ? wanted.id : { modelId: wanted.id }; // Kiro's real shape: {modelId}
  }
  return out;
}
