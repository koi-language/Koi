/**
 * Auto Model Selector — pick the cheapest capable model for a task.
 *
 * Task profile (type + difficulty) is determined by a fast LLM call in LLMProvider._inferTaskProfile().
 * This module only handles provider discovery and model selection logic.
 */

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const modelsData = _require('./models.json');

/** Default profile used as fallback when LLM classification is unavailable. */
export const DEFAULT_TASK_PROFILE = { taskType: 'code', difficulty: 5 };

/**
 * Returns a list of provider names that have an API key configured.
 * @returns {string[]}
 */
export function getAvailableProviders() {
  const providers = [];
  if (process.env.OPENAI_API_KEY)    providers.push('openai');
  if (process.env.ANTHROPIC_API_KEY) providers.push('anthropic');
  if (process.env.GEMINI_API_KEY)    providers.push('gemini');
  return providers;
}

/**
 * Select the cheapest text-output model whose score for taskType >= difficulty.
 * Models without capability scores are excluded (not rated for auto selection).
 *
 * @param {'code'|'planning'|'reasoning'} taskType
 * @param {number} difficulty - 1 (trivial) to 10 (expert)
 * @param {string[]} availableProviders - providers with API keys
 * @returns {{ provider: string, model: string } | null}
 */
export function selectAutoModel(taskType, difficulty, availableProviders) {
  const candidates = [];

  for (const provider of availableProviders) {
    const providerModels = modelsData[provider];
    if (!providerModels) continue;

    for (const [modelName, caps] of Object.entries(providerModels)) {
      if (caps.outputType !== 'text') continue;
      const taskScore = caps[taskType] ?? 0;
      if (taskScore < difficulty) continue;
      const totalCost = (caps.inputPer1M || 0) + (caps.outputPer1M || 0);
      candidates.push({ provider, model: modelName, totalCost, speed: caps.speed || 5 });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const costDiff = a.totalCost - b.totalCost;
    if (Math.abs(costDiff) > 0.0001) return costDiff;
    return b.speed - a.speed;
  });

  return { provider: candidates[0].provider, model: candidates[0].model };
}
