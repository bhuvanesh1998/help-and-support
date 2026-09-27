/**
 * providers/index.ts — Provider registry.
 */

import { anthropicProvider } from './anthropic.provider.js';
import { geminiProvider } from './gemini.provider.js';
import { openaiProvider } from './openai.provider.js';
import type { ProviderId, VisionProvider } from './types.js';

const REGISTRY: Record<ProviderId, VisionProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
};

export function getProvider(id: ProviderId): VisionProvider {
  return REGISTRY[id];
}

export * from './types.js';
