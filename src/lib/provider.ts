import type { ViewMode } from '../types';
import type { SceneDirection } from './promptcraft';
import {
  DEFAULT_MODEL_SELECTION,
  VIDEO_MODELS,
  WIDE_FIELD_MODELS,
  generateImage as generateOpenRouterImage,
  generateImageWithFallback as generateOpenRouterImageWithFallback,
  generateSceneDirection as generateOpenRouterSceneDirection,
  generateVideoBlocking as generateOpenRouterVideoBlocking,
  isSourceFrameRejection as isOpenRouterSourceFrameRejection,
  verifyKey as verifyOpenRouterKey,
} from './openrouter';
import type {
  CreateVideoParams,
  KeyStatus,
  ModelOption,
  ModelSelection,
} from './openrouter';
import {
  DEFAULT_VENICE_MODELS,
  VENICE_STILL_MODELS,
  VENICE_VIDEO_MODELS,
  generateVeniceImage,
  generateVeniceSceneDirection,
  generateVeniceVideoBlocking,
  isVeniceModerationError,
  isVeniceSourceFrameRejection,
  verifyVeniceKey,
} from './venice';

export type ProviderId = 'openrouter' | 'venice';

export interface ProviderConfig {
  provider: ProviderId;
  apiKey: string;
  models: ModelSelection;
}

export const PROVIDERS: { id: ProviderId; label: string; blurb: string }[] = [
  { id: 'openrouter', label: 'OpenRouter', blurb: 'Broad model marketplace' },
  { id: 'venice', label: 'Venice', blurb: 'Private inference API' },
];

export function providerLabel(provider: ProviderId): string {
  return provider === 'venice' ? 'Venice' : 'OpenRouter';
}

export function defaultModelsFor(provider: ProviderId): ModelSelection {
  return provider === 'venice' ? { ...DEFAULT_VENICE_MODELS } : { ...DEFAULT_MODEL_SELECTION };
}

export function stillModelsFor(provider: ProviderId): ModelOption[] {
  return provider === 'venice' ? VENICE_STILL_MODELS : WIDE_FIELD_MODELS;
}

export function videoModelsFor(provider: ProviderId): ModelOption[] {
  return provider === 'venice' ? VENICE_VIDEO_MODELS : VIDEO_MODELS;
}

export function keyUrlFor(provider: ProviderId): string {
  return provider === 'venice'
    ? 'https://venice.ai/settings/api'
    : 'https://openrouter.ai/keys';
}

export function verifyProviderKey(
  provider: ProviderId,
  apiKey: string,
  signal?: AbortSignal,
): Promise<KeyStatus> {
  return provider === 'venice'
    ? verifyVeniceKey(apiKey, signal)
    : verifyOpenRouterKey(apiKey, signal);
}

export function generateProviderSceneDirection(
  config: ProviderConfig,
  location: string,
  coordinates: { lat: number; lng: number },
  year: number,
  mode: ViewMode,
  styleSuffix?: string | null,
  options: {
    signal?: AbortSignal;
    neighbours?: { earlier: number; later: number };
    phase?: string;
  } = {},
): Promise<SceneDirection> {
  const args = [
    config.apiKey,
    location,
    coordinates,
    year,
    mode,
    config.models.text,
    styleSuffix,
    options,
  ] as const;
  return config.provider === 'venice'
    ? generateVeniceSceneDirection(...args)
    : generateOpenRouterSceneDirection(...args);
}

export async function generateProviderImageWithFallback(
  config: ProviderConfig,
  prompts: string[],
  model: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ url: string; promptIndex: number; moderatedCount: number; modelUsed: string }> {
  if (config.provider === 'openrouter') {
    return generateOpenRouterImageWithFallback(config.apiKey, prompts, model, options);
  }

  let moderatedCount = 0;
  let lastModeration: unknown;
  const models = model === 'nano-banana-2' ? [model] : [model, 'nano-banana-2'];
  for (const candidateModel of models) {
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      if (!prompt) continue;
      try {
        const url = await generateVeniceImage(config.apiKey, prompt, candidateModel, options);
        return { url, promptIndex: i, moderatedCount, modelUsed: candidateModel };
      } catch (err) {
        if (!isVeniceModerationError(err)) throw err;
        moderatedCount++;
        lastModeration = err;
      }
    }
  }
  throw lastModeration instanceof Error
    ? lastModeration
    : new Error('every candidate prompt was moderated');
}

export function generateProviderImage(
  config: ProviderConfig,
  prompt: string,
  model: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  if (config.provider === 'venice') {
    return generateVeniceImage(config.apiKey, prompt, model, options);
  }
  return generateOpenRouterImage(config.apiKey, prompt, model, options);
}

export function generateProviderVideoBlocking(
  config: ProviderConfig,
  params: CreateVideoParams,
  options: {
    onStatus?: (job: { status: string }) => void;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<string> {
  return config.provider === 'venice'
    ? generateVeniceVideoBlocking(config.apiKey, params, options)
    : generateOpenRouterVideoBlocking(config.apiKey, params, options as Parameters<typeof generateOpenRouterVideoBlocking>[2]);
}

export function isProviderSourceFrameRejection(provider: ProviderId, err: unknown): boolean {
  return provider === 'venice'
    ? isVeniceSourceFrameRejection(err)
    : isOpenRouterSourceFrameRejection(err);
}
