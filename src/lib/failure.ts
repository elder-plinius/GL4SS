import type { ProviderId } from './provider';

/**
 * WHAT WENT WRONG, IN WORDS.
 *
 * Every failure in this app arrives as an HTTP status and a JSON blob, and for a
 * long time the user got shown exactly that:
 *
 *     OpenRouter API error (402): {"error":{"message":"Insufficient credits...
 *
 * Which is not information. It does not say whose fault it is, whether trying
 * again will help, or what to press. The five things that actually go wrong —
 * no key, wrong key, no money, too fast, model gone — are all trivially
 * distinguishable from the status code, and each one has exactly one sensible
 * next move. So classify once, here, and let every surface render the same
 * verdict.
 *
 * `title` is the sentence. `detail` is the why. `action` is the button. `retry`
 * says whether pulling the lever again could plausibly work — which is what the
 * difference between "try again" and "fix your key" comes down to.
 */

export type FailureKind =
  | 'no-key'
  | 'bad-key'
  | 'no-credit'
  | 'rate-limit'
  | 'moderation'
  | 'no-model'
  | 'timeout'
  | 'offline'
  | 'provider'
  | 'empty'
  | 'unknown';

export interface Failure {
  kind: FailureKind;
  /** One sentence, plain language, no status codes. */
  title: string;
  /** The why, and what to do. Still a sentence, still no jargon. */
  detail: string;
  /** True when throwing the lever again is a reasonable thing to do. */
  retry: boolean;
  action?: { label: string; href?: string; openSettings?: boolean };
}

/** The raw provider text, for the details line. Never the primary message. */
function rawMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const match = err.message.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1]!;
    }
  }
  return err.message;
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

export function explainFailure(err: unknown, provider: ProviderId = 'openrouter'): Failure {
  const status = statusOf(err);
  const raw = rawMessage(err);
  const lower = raw.toLowerCase();
  const name = provider === 'venice' ? 'Venice' : 'OpenRouter';
  const host = provider === 'venice' ? 'api.venice.ai' : 'openrouter.ai';
  const keysUrl =
    provider === 'venice' ? 'https://venice.ai/settings/api' : 'https://openrouter.ai/keys';
  const creditsUrl =
    provider === 'venice' ? 'https://venice.ai/settings/api' : 'https://openrouter.ai/credits';

  // A fetch that never reached a server throws TypeError with no status. This is
  // the offline case, and it is the one where telling the user to check their
  // key would send them off to debug something that is not broken.
  if (status === undefined && err instanceof TypeError) {
    return {
      kind: 'offline',
      title: `Could not reach ${name}.`,
      detail:
        `The request never left the building — check your connection. If you are online, a VPN, an ad blocker or a corporate proxy may be blocking ${host}.`,
      retry: true,
    };
  }

  if (status === undefined && err instanceof Error && err.name === 'AbortError') {
    return {
      kind: 'timeout',
      title: 'That took too long and was cancelled.',
      detail: 'The model did not answer in time. Trying again usually works; a different model in Settings works more often.',
      retry: true,
      action: { label: 'open settings', openSettings: true },
    };
  }

  if (provider === 'venice' && status === 422) {
    return {
      kind: 'moderation',
      title: 'The provider refused this scene.',
      detail:
        'The selected model rejected the scene under its content policy. Try another style or choose a different model in Settings.',
      retry: false,
      action: { label: 'open settings', openSettings: true },
    };
  }

  switch (status) {
    case 401:
      return {
        kind: 'bad-key',
        title: 'That key was rejected.',
        detail:
          provider === 'venice'
            ? 'Venice did not recognise it. Paste the Venice API key again, or make a new one.'
            : 'OpenRouter did not recognise it. Keys start with sk-or-v1- — an OpenAI or Anthropic key will not work here. Paste it again, or make a new one.',
        retry: false,
        action: { label: 'get a key ↗', href: keysUrl },
      };
    case 402:
      return {
        kind: 'no-credit',
        title: `Your ${name} account is out of credit.`,
        detail:
          'The key is valid, there is just nothing left on it. Image and video models are paid — add credit and the same pull will work.',
        retry: false,
        action: { label: 'add credit ↗', href: creditsUrl },
      };
    case 403:
      if (lower.includes('moderat') || lower.includes('flag') || lower.includes('safety')) {
        return {
          kind: 'moderation',
          title: 'The provider refused this scene.',
          detail:
            'Something in the place, year or style tripped the image model’s safety filter. Battles, executions and famine scenes are the usual causes. Nudging the year or switching style in STYLES normally clears it.',
          retry: false,
        };
      }
      return {
        kind: 'bad-key',
        title: 'That key is not allowed to do this.',
        detail:
          'The key exists but lacks permission for this model — often a key scoped to specific models, or one restricted by your region.',
        retry: false,
        action: { label: 'check your key ↗', href: keysUrl },
      };
    case 404:
      return {
        kind: 'no-model',
        title: 'That model is no longer available.',
        detail:
          `${name} has no endpoint for the selected model — providers retire preview models without notice. Pick a different one in Settings.`,
        retry: false,
        action: { label: 'open settings', openSettings: true },
      };
    case 408:
    case 504:
      return {
        kind: 'timeout',
        title: 'The model timed out.',
        detail: 'The provider took too long. This is usually transient — pull the lever again.',
        retry: true,
      };
    case 429:
      return {
        kind: 'rate-limit',
        title: 'Too many requests, too quickly.',
        detail:
          `${name} is throttling this key. Wait a few seconds and pull again. If it keeps happening, account rate limits may need time to reset.`,
        retry: true,
      };
    case 413:
      return {
        kind: 'unknown',
        title: 'The request was too large.',
        detail: 'The meta-prompt is longer than the model accepts. Trim it in Settings, or reset it to the default.',
        retry: false,
        action: { label: 'open settings', openSettings: true },
      };
  }

  if (status !== undefined && status >= 500) {
    return {
      kind: 'provider',
      title: 'The provider is having a bad day.',
      detail: `${name} returned ${status}. Nothing is wrong on your side — wait a moment and pull again, or switch models in Settings.`,
      retry: true,
    };
  }

  // Not an HTTP failure: the call succeeded and the response was unusable. Worth
  // its own kind, because "no image came back" and "the server said no" want
  // completely different advice.
  if (lower.includes('no image data')) {
    return {
      kind: 'empty',
      title: 'The model answered without an image.',
      detail:
        'Usually a silent content refusal, or a text model selected where an image model belongs. Try another style, or a different stills model in Settings.',
      retry: true,
      action: { label: 'open settings', openSettings: true },
    };
  }

  return {
    kind: 'unknown',
    title: 'That did not work.',
    detail: raw.slice(0, 220) || 'No further detail was returned.',
    retry: true,
  };
}

/** One line for cramped surfaces — the status strip under the frame. */
export function shortFailure(err: unknown): string {
  return explainFailure(err).title;
}
