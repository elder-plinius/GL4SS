import type { ViewMode } from '../types';
import type { SceneDirection } from './promptcraft';
import {
  buildSceneDirectionPrompt,
  sceneDirectionFromText,
} from './openrouter';
import type {
  CreateVideoParams,
  KeyStatus,
  ModelOption,
  ModelSelection,
} from './openrouter';

const VENICE_ORIGIN = 'https://api.venice.ai';
const API_ROOT = `${VENICE_ORIGIN}/api/v1`;
const CHAT_ENDPOINT = `${API_ROOT}/chat/completions`;
const IMAGE_ENDPOINT = `${API_ROOT}/image/generate`;
const VIDEO_QUEUE_ENDPOINT = `${API_ROOT}/video/queue`;
const VIDEO_RETRIEVE_ENDPOINT = `${API_ROOT}/video/retrieve`;
const BALANCE_ENDPOINT = `${API_ROOT}/billing/balance`;

const TEXT_TIMEOUT_MS = 45_000;
const IMAGE_TIMEOUT_MS = 120_000;

/**
 * Consecutive retrieve failures tolerated before a render is given up on.
 *
 * A video job keeps running on Venice's side regardless of whether our poll
 * reached it, so a single transient blip must not throw away a clip the user
 * has already paid several minutes for. Mirrors the OpenRouter path.
 */
const MAX_POLL_FAILURES = 3;

/** Retrieve statuses where retrying cannot help — fail fast rather than waste the deadline. */
const TERMINAL_POLL_STATUSES = new Set([400, 401, 402, 403, 404, 422]);

export const DEFAULT_VENICE_MODELS: ModelSelection = {
  text: 'gemini-3-6-flash',
  wideField: 'grok-imagine-image',
  chronoSelfie: 'nano-banana-2',
  // HappyHorse is anonymized and covers the app's 4/8/12s film lengths with audio.
  cinematic: 'happyhorse-1-1-image-to-video',
  cinematicText: 'happyhorse-1-1-text-to-video',
  animate: 'happyhorse-1-1-image-to-video',
};

export const VENICE_STILL_MODELS: ModelOption[] = [
  { id: 'grok-imagine-image', label: 'Grok Imagine', blurb: 'Default — fast, private, photoreal' },
  { id: 'grok-imagine-image-quality', label: 'Grok Imagine HQ', blurb: 'Higher detail, slower' },
  { id: 'flux-2-max', label: 'FLUX 2 Max', blurb: 'Strong composition' },
  { id: 'nano-banana-2', label: 'Nano Banana 2', blurb: 'Excellent prompt grounding' },
  { id: 'qwen-image-2-pro', label: 'Qwen Image 2 Pro', blurb: 'Detailed and flexible' },
];

export const VENICE_VIDEO_MODELS: ModelOption[] = [
  {
    id: 'happyhorse-1-1-image-to-video',
    textModelId: 'happyhorse-1-1-text-to-video',
    label: 'HappyHorse 1.1',
    blurb: 'Default — with audio, all film lengths',
  },
  {
    id: 'kling-o3-pro-image-to-video',
    textModelId: 'kling-o3-pro-text-to-video',
    label: 'Kling O3 Pro',
    blurb: 'Cinematic, with audio',
  },
  {
    id: 'kling-v3-pro-image-to-video',
    textModelId: 'kling-v3-pro-text-to-video',
    label: 'Kling V3 Pro',
    blurb: 'Photoreal, with audio',
  },
  {
    id: 'kling-o3-standard-image-to-video',
    textModelId: 'kling-o3-standard-text-to-video',
    label: 'Kling O3 Standard',
    blurb: 'Lower-cost cinematic option, with audio',
  },
  {
    id: 'grok-imagine-1-5-image-to-video-private',
    textModelId: 'grok-imagine-1-5-text-to-video-private',
    label: 'Grok Imagine 1.5',
    blurb: 'Private, photoreal, with audio',
  },
];

/**
 * Venice validates model-specific options rather than silently ignoring them.
 * These capabilities come from GET /api/v1/models. Models absent from a set
 * receive the provider default instead of an unsupported field.
 */
const VIDEO_MODELS_WITH_RESOLUTION = new Set([
  'happyhorse-1-1-image-to-video',
  'happyhorse-1-1-text-to-video',
  'grok-imagine-1-5-image-to-video-private',
  'grok-imagine-1-5-text-to-video-private',
]);

const VIDEO_MODELS_WITH_AUDIO_CONFIG = new Set([
  'kling-o3-pro-image-to-video',
  'kling-o3-pro-text-to-video',
  'kling-v3-pro-image-to-video',
  'kling-v3-pro-text-to-video',
  'kling-o3-standard-image-to-video',
  'kling-o3-standard-text-to-video',
]);

export class VeniceError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Venice API error (${status}): ${body}`);
    this.name = 'VeniceError';
    this.status = status;
    this.body = body;
  }
}

function headers(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function checkedJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new VeniceError(response.status, await response.text());
  return (await response.json()) as T;
}

export async function verifyVeniceKey(apiKey: string, signal?: AbortSignal): Promise<KeyStatus> {
  const data = await checkedJson<{
    canConsume?: boolean;
    consumptionCurrency?: 'USD' | 'DIEM' | 'VCU' | 'BUNDLED_CREDITS' | null;
    balances?: { usd?: number | null; diem?: number | null };
  }>(
    await fetch(BALANCE_ENDPOINT, {
      headers: headers(apiKey),
      signal,
    }),
  );
  const currency = data.consumptionCurrency === 'DIEM' ? 'DIEM' : 'USD';
  const remaining =
    currency === 'DIEM' ? data.balances?.diem ?? undefined : data.balances?.usd ?? undefined;
  return {
    label: 'Venice',
    usage: 0,
    limit: null,
    remaining,
    currency,
    freeTier: false,
    canConsume: data.canConsume,
  };
}

export async function generateVeniceSceneDirection(
  apiKey: string,
  location: string,
  coordinates: { lat: number; lng: number },
  year: number,
  mode: ViewMode,
  model: string,
  styleSuffix?: string | null,
  options: {
    signal?: AbortSignal;
    neighbours?: { earlier: number; later: number };
    phase?: string;
  } = {},
): Promise<SceneDirection> {
  const prompt = buildSceneDirectionPrompt(
    location,
    coordinates,
    year,
    mode,
    styleSuffix,
    options.neighbours,
    options.phase,
  );
  const data = await checkedJson<{
    choices?: { message?: { content?: string | { type?: string; text?: string }[] } }[];
  }>(
    await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 1600,
        venice_parameters: {
          include_venice_system_prompt: false,
          // Reasoning models otherwise prepend their thinking to the body,
          // which breaks JSON.parse and drops every scene to the generic
          // fallback. Ask Venice to strip it so the response is just the JSON.
          strip_thinking_response: true,
        },
      }),
      signal: signalWithTimeout(options.signal, TEXT_TIMEOUT_MS),
    }),
  );
  const content = data.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.find((block) => block.type === 'text')?.text ?? ''
        : '';
  return sceneDirectionFromText(text, model, location);
}

export async function generateVeniceImage(
  apiKey: string,
  prompt: string,
  model: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const data = await checkedJson<{ images?: string[] }>(
    await fetch(IMAGE_ENDPOINT, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model,
        prompt,
        aspect_ratio: '16:9',
        format: 'webp',
        return_binary: false,
        // Safe mode blurs "adult" content and returns HTTP 200 with a blur
        // header rather than an error — so a legitimate historical scene (a
        // battle, an execution) comes back blurred with nothing for the
        // moderation-fallback path to catch. This app is explicitly BYOK and
        // uncensored by design, so it is off; the provider still refuses
        // genuinely disallowed content with a real error.
        safe_mode: false,
      }),
      signal: signalWithTimeout(options.signal, IMAGE_TIMEOUT_MS),
    }),
  );
  const image = data.images?.[0];
  if (!image) throw new Error(`No image data in Venice response: ${JSON.stringify(data).slice(0, 400)}`);
  if (image.startsWith('data:') || image.startsWith('http')) return image;
  return `data:image/webp;base64,${image}`;
}

export function isVeniceModerationError(err: unknown): boolean {
  return (
    err instanceof VeniceError &&
    (err.status === 400 || err.status === 403) &&
    /moderat|content.?(policy|violation)|safety|blurred/i.test(err.body)
  );
}

export function isVeniceSourceFrameRejection(err: unknown): boolean {
  return (
    err instanceof VeniceError &&
    /image_url|reference image|source image|input image|sensitive|content.?violation/i.test(err.body)
  );
}

async function blobUrl(response: Response): Promise<string> {
  const blob = await response.blob();
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(blob);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || 'video/mp4'};base64,${btoa(binary)}`;
}

export async function generateVeniceVideoBlocking(
  apiKey: string,
  params: CreateVideoParams,
  options: {
    onStatus?: (job: { status: string }) => void;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<string> {
  const queueBody: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    duration: `${params.duration ?? 8}s`,
    aspect_ratio: params.source_image ? undefined : params.aspect_ratio ?? '16:9',
    image_url: params.source_image?.url,
  };
  if (VIDEO_MODELS_WITH_RESOLUTION.has(params.model)) {
    queueBody.resolution = params.resolution ?? '720p';
  }
  if (VIDEO_MODELS_WITH_AUDIO_CONFIG.has(params.model)) {
    queueBody.audio = params.generate_audio ?? true;
  }

  const queued = await checkedJson<{ queue_id?: string; id?: string; download_url?: string }>(
    await fetch(VIDEO_QUEUE_ENDPOINT, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(queueBody),
    }),
  );
  const queueId = queued.queue_id ?? queued.id;
  if (!queueId) throw new VeniceError(502, 'video queue response did not include a job id');

  const interval = options.pollIntervalMs ?? 4000;
  const deadline = Date.now() + (options.maxWaitMs ?? 5 * 60 * 1000);
  let downloadUrl = queued.download_url;
  let pollFailures = 0;
  options.onStatus?.({ status: 'processing' });

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    // A POLL FAILURE IS NOT A LOST FILM. The job keeps rendering on Venice's
    // side; only our handle on it dropped. Tolerate a few transient failures
    // before giving up, and reset the counter on any success. Genuine client
    // errors (bad key, no credit, unknown job) are terminal and rethrown at
    // once rather than burning the whole deadline retrying the unretryable.
    let response: Response;
    try {
      response = await fetch(VIDEO_RETRIEVE_ENDPOINT, {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({ model: params.model, queue_id: queueId }),
      });
    } catch (err) {
      if (++pollFailures > MAX_POLL_FAILURES) {
        throw new VeniceError(
          504,
          `lost contact with video job ${queueId} after ${pollFailures} failed polls: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      continue;
    }

    if (!response.ok) {
      if (TERMINAL_POLL_STATUSES.has(response.status)) {
        throw new VeniceError(response.status, await response.text());
      }
      if (++pollFailures > MAX_POLL_FAILURES) {
        throw new VeniceError(response.status, await response.text());
      }
      continue;
    }
    pollFailures = 0;

    const contentType = response.headers.get('content-type') ?? '';
    if (/video\//i.test(contentType)) {
      options.onStatus?.({ status: 'completed' });
      return blobUrl(response);
    }
    const status = (await response.json()) as {
      status?: string;
      download_url?: string;
      error?: string;
    };
    downloadUrl = status.download_url ?? downloadUrl;
    const normalized = status.status?.toLowerCase() ?? 'processing';
    options.onStatus?.({ status: normalized });
    if (normalized === 'completed') {
      if (!downloadUrl) throw new VeniceError(502, 'completed video had no downloadable content');
      const parsed = new URL(downloadUrl);
      if (parsed.protocol !== 'https:') {
        throw new VeniceError(502, 'video download URL was not HTTPS');
      }
      // Hand the pre-signed URL directly to <video>. Fetching it here would be
      // blocked by connect-src, while media-src deliberately permits HTTPS.
      return parsed.href;
    }
    if (['failed', 'cancelled', 'expired'].includes(normalized)) {
      throw new VeniceError(502, status.error ?? `video job ${normalized}`);
    }
  }
  throw new VeniceError(504, 'video job timed out');
}
